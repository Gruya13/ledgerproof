import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AddressInfo } from "node:net"
import { ALL_TRAP_KINDS, ContinuousStreamGenerator } from "../src/engine/stream-generator"
import { loadPack } from "../src/runner-setup"
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

	it("runs continuous stream ticks while injecting all 11 scenarios (real traps + benign false-positives) and keeping HITL non-blocking", async () => {
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

		// Inject every real trap + benign scenario, plus a second BEC IBAN change to verify varied dynamic amounts
		for (const kind of [...ALL_TRAP_KINDS, "bec_iban_change" as const]) {
			const trapRes = await fetch(`${baseUrl}/api/stream/inject-trap`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind }),
			})
			expect(trapRes.status).toBe(200)
			await sleep(55)
		}

		// Wait until multiple HITLs appear (both benign 0-flag and BEC IBAN flagged) while ticks keep advancing
		const pausedSnap = await pollUntil(
			async () => (await (await fetch(`${baseUrl}/api/state`)).json()) as any,
			(s) =>
				s.pendingApprovals.some((a: any) => a.riskFlags.length === 0) &&
				s.pendingApprovals.some((a: any) => a.riskFlags.includes("BEC_IBAN_CHANGE")) &&
				s.stream.tickCount >= 12,
		)
		const ticksAtPause = pausedSnap.stream.tickCount
		await sleep(260)
		const laterSnap = (await (await fetch(`${baseUrl}/api/state`)).json()) as any
		expect(laterSnap.stream.tickCount).toBeGreaterThan(ticksAtPause)

		// Verify varied amounts across the two BEC IBAN traps
		const becApprovals = laterSnap.pendingApprovals.filter((a: any) => a.riskFlags.includes("BEC_IBAN_CHANGE"))
		if (becApprovals.length >= 2) {
			expect(becApprovals[0].amountCents).not.toBe(becApprovals[1].amountCents)
		}

		// Approve benign 0-risk-flag requests, reject BEC IBAN traps!
		for (const approval of laterSnap.pendingApprovals) {
			const shouldApprove = approval.riskFlags.length === 0
			const actRes = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(approval.approvalId)}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					approved: shouldApprove,
					reason: shouldApprove ? "Approved benign policy threshold check" : "Rejected BEC IBAN trap",
				}),
			})
			expect(actRes.status).toBe(200)
		}

		// Wait for all traps & approved benign actions + delayed late settlement to converge
		const converged = await pollUntil(
			async () => (await (await fetch(`${baseUrl}/api/state`)).json()) as any,
			(s) =>
				s.metrics.staleInvalidations >= 1 &&
				s.metrics.casConflictsPrevented >= 1 &&
				s.metrics.uncitedNumbersBlocked >= 1 &&
				s.unmatchedTxIds.length >= 1 &&
				s.cells.some((c: any) => c.record.status === "REFUNDED") &&
				s.cells.some((c: any) => c.record.status === "SEPA_DRAFT_READY") &&
				s.cells.some((c: any) => c.record.riskFlags.includes("CURRENCY_MISMATCH")) &&
				s.cells.some((c: any) => c.record.riskFlags.includes("OVERPAYMENT_ANOMALY")),
		)

		const stopRes = await fetch(`${baseUrl}/api/stream/stop`, { method: "POST" })
		expect(stopRes.status).toBe(200)

		// Verify false-positive near-duplicate (same vendor + same amount, different PO) closed cleanly as MATCHED with 0 risk flags
		const nearDupCells = converged.cells.filter(
			(c: any) =>
				c.record.status === "MATCHED" &&
				c.record.riskFlags.length === 0 &&
				c.record.matchedTxIds.length === 1 &&
				c.record.expectedAmountCents >= 31000,
		)
		expect(nearDupCells.length).toBeGreaterThanOrEqual(2)

		expect(converged.metrics.peakConcurrentLoops).toBeGreaterThanOrEqual(3)
		expect(converged.metrics.deterministicMatches).toBeGreaterThanOrEqual(1)
		expect(converged.metrics.inventedNumbersLeaked).toBe(0)
		expect(converged.metrics.humanApprovalsRouted).toBeGreaterThanOrEqual(3)
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

	it("generates randomized scenarios across different seeds and deterministic batches for identical seeds", () => {
		const { vendors } = loadPack()
		const genA1 = new ContinuousStreamGenerator(vendors, { seed: 101 })
		const genA2 = new ContinuousStreamGenerator(vendors, { seed: 101 })
		const genB = new ContinuousStreamGenerator(vendors, { seed: 202 })

		const seqA1 = Array.from({ length: 15 }, () => genA1.nextTick({ trapCadence: 2 }))
		const seqA2 = Array.from({ length: 15 }, () => genA2.nextTick({ trapCadence: 2 }))
		const seqB = Array.from({ length: 15 }, () => genB.nextTick({ trapCadence: 2 }))

		expect(seqA1).toEqual(seqA2)
		const trapsA = seqA1.map((b) => b.trapKind).filter(Boolean)
		const trapsB = seqB.map((b) => b.trapKind).filter(Boolean)
		expect(trapsA).not.toEqual(trapsB)

		const amountsA = seqA1.flatMap((b) => b.invoices.map((i) => i.amountCents))
		const amountsB = seqB.flatMap((b) => b.invoices.map((i) => i.amountCents))
		expect(amountsA).not.toEqual(amountsB)
	})
})
