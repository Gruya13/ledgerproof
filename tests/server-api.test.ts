import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AddressInfo } from "node:net"
import { createLedgerServer } from "../src/server"

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollUntil<T>(fn: () => Promise<T>, pred: (val: T) => boolean, timeoutMs = 8000): Promise<T> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const val = await fn()
		if (pred(val)) return val
		await sleep(30)
	}
	throw new Error("Timed out polling condition in server-api.test.ts")
}

describe("HTTP & SSE Server API interactive flow", () => {
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

	it("supports interactive HITL approval and manual late settlement injection while peer agents converge", async () => {
		const healthRes = await fetch(`${baseUrl}/api/health`)
		expect(healthRes.status).toBe(200)
		const health = (await healthRes.json()) as { ok: boolean }
		expect(health.ok).toBe(true)

		// Start interactive run (manualLateSettlement=true, autoApprovePolicy=false)
		const runRes = await fetch(`${baseUrl}/api/run`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "mock", manualLateSettlement: true, autoApprovePolicy: false, staggerMs: 10 }),
		})
		expect(runRes.status).toBe(200)

		// Poll until REQ-3002 HITL approval is queued AND INV-1007 has ACTIVE chase draft AND peer INV-1011/INV-1006 already converged
		const stateDuringPause = await pollUntil(
			async () => (await (await fetch(`${baseUrl}/api/state`)).json()) as any,
			(s) => {
				const inv1007 = s.cells.find((c: any) => c.invoiceId === "INV-1007")
				const inv1006 = s.cells.find((c: any) => c.invoiceId === "INV-1006")
				return (
					s.pendingApprovals.length === 1 &&
					inv1007?.record.drafts.some((d: any) => d.status === "ACTIVE") &&
					inv1006?.record.status === "MATCHED"
				)
			},
		)

		expect(stateDuringPause.pendingApprovals[0].requestId).toBe("REQ-3002")
		expect(stateDuringPause.canInjectLateSettlement).toBe(true)

		// Reject REQ-3002 (BEC IBAN mismatch)
		const approvalId = stateDuringPause.pendingApprovals[0].approvalId
		const rejectRes = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(approvalId)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ approved: false, reason: "BEC IBAN change rejected in test" }),
		})
		expect(rejectRes.status).toBe(200)

		// Inject late settlement TX-2017 -> must settle INV-1007 and flip chase draft to STALE
		const injectRes = await fetch(`${baseUrl}/api/inject-late`, { method: "POST" })
		expect(injectRes.status).toBe(200)

		const finalState = await pollUntil(
			async () => (await (await fetch(`${baseUrl}/api/state`)).json()) as any,
			(s) => s.status === "COMPLETED",
		)

		const inv1007Final = finalState.cells.find((c: any) => c.invoiceId === "INV-1007")
		const inv1010Final = finalState.cells.find((c: any) => c.invoiceId === "INV-1010")
		expect(inv1007Final.record.status).toBe("MATCHED")
		expect(inv1007Final.record.drafts.some((d: any) => d.status === "STALE")).toBe(true)
		expect(inv1010Final.record.status).toBe("HOLD_RISK")
		expect(finalState.metrics.staleInvalidations).toBeGreaterThanOrEqual(1)
		expect(finalState.metrics.casConflictsPrevented).toBeGreaterThanOrEqual(1)
		expect(finalState.metrics.uncitedNumbersBlocked).toBeGreaterThanOrEqual(1)
		expect(finalState.metrics.inventedNumbersLeaked).toBe(0)

		// Check SourceStore inspection endpoint & JSONL export
		const srcRes = await fetch(`${baseUrl}/api/source/INV-1010`)
		expect(srcRes.status).toBe(200)
		const srcJson = (await srcRes.json()) as any
		expect(srcJson.entity.sha256).toBeTruthy()
		expect(srcJson.entity.data.amountCents).toBe(64000)

		const jsonlRes = await fetch(`${baseUrl}/api/audit.jsonl`)
		expect(jsonlRes.status).toBe(200)
		const jsonlText = await jsonlRes.text()
		const lines = jsonlText.trim().split("\n")
		expect(lines.length).toBeGreaterThan(5)
		expect(() => JSON.parse(lines[0])).not.toThrow()
	})
})
