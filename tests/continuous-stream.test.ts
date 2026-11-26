import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AddressInfo } from "node:net"
import { ALL_TRAP_KINDS } from "../src/engine/stream-generator"
import { createLedgerServer } from "../src/server"
import { SessionController } from "../src/session-controller"

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollUntil<T>(fn: () => Promise<T>, pred: (val: T) => boolean, timeoutMs = 10000): Promise<T> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const val = await fn()
		if (pred(val)) return val
		await sleep(30)
	}
	throw new Error("Timed out polling condition in continuous-stream.test.ts")
}

describe("Continuous Chaos Stream & Trap Injection", () => {
	const { server } = createLedgerServer()
	let baseUrl = ""

	beforeAll(async () => {
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address() as AddressInfo
				baseUrl = `http://127.0.0.1:${addr.port}`
				resolve()
			})
		})
	})

	afterAll(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()))
		})
	})

	it("runs continuous stream ticks while injecting all 6 traps and keeping HITL non-blocking", async () => {
		const startRes = await fetch(`${baseUrl}/api/stream/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mode: "mock",
				intervalMs: 120,
				trapCadence: 4,
				autoApprovePolicy: false,
				lateDelayMs: 250,
			}),
		})
		expect(startRes.status).toBe(200)

		for (const kind of ALL_TRAP_KINDS) {
			const trapRes = await fetch(`${baseUrl}/api/stream/inject-trap`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind }),
			})
			expect(trapRes.status).toBe(200)
			await sleep(60)
		}

		// Wait until BEC HITL appears while ticks continue advancing
		const pausedSnap = await pollUntil(
			async () => (await (await fetch(`${baseUrl}/api/state`)).json()) as any,
			(s) => s.pendingApprovals.length >= 1 && s.stream.tickCount >= 8,
		)
		const ticksAtPause = pausedSnap.stream.tickCount
		await sleep(260)
		const laterSnap = (await (await fetch(`${baseUrl}/api/state`)).json()) as any
		expect(laterSnap.stream.tickCount).toBeGreaterThan(ticksAtPause)

		// Resolve all pending HITL approvals safely
		for (const approval of laterSnap.pendingApprovals) {
			const rejRes = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(approval.approvalId)}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ approved: false, reason: "Rejected BEC IBAN in stream test" }),
			})
			expect(rejRes.status).toBe(200)
		}

		// Wait for delayed late settlement + traps to converge
		const converged = await pollUntil(
			async () => (await (await fetch(`${baseUrl}/api/state`)).json()) as any,
			(s) =>
				s.metrics.staleInvalidations >= 1 &&
				s.metrics.casConflictsPrevented >= 1 &&
				s.metrics.uncitedNumbersBlocked >= 1 &&
				s.unmatchedTxIds.length >= 1,
		)

		const stopRes = await fetch(`${baseUrl}/api/stream/stop`, { method: "POST" })
		expect(stopRes.status).toBe(200)

		expect(converged.metrics.peakConcurrentLoops).toBeGreaterThanOrEqual(3)
		expect(converged.metrics.deterministicMatches).toBeGreaterThanOrEqual(1)
		expect(converged.metrics.inventedNumbersLeaked).toBe(0)
		expect(converged.metrics.humanApprovalsRouted).toBeGreaterThanOrEqual(1)
	})

	it("auto-pauses continuous stream when maxLlmCalls budget cap is reached", async () => {
		const controller = new SessionController()
		controller.startContinuousStream({
			mode: "mock",
			intervalMs: 80,
			trapCadence: 2,
			autoApprovePolicy: true,
			maxLlmCalls: 2,
			lateDelayMs: 200,
		})

		const deadline = Date.now() + 8000
		let snap = controller.getSnapshot()
		while (Date.now() < deadline && !snap.llmBudgetExhausted) {
			await sleep(40)
			snap = controller.getSnapshot()
		}

		controller.stopContinuousStream()
		await controller.waitForCurrentIdle(8000)

		expect(snap.llmBudgetExhausted).toBe(true)
		expect(snap.metrics.llmCalls).toBeLessThanOrEqual(2)
	})
})
