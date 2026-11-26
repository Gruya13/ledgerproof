import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { runBlackFridayScenario } from "./runner-setup"
import { SessionController } from "./session-controller"

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

async function interactiveApprovalPrompt(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout })
	try {
		while (true) {
			const ans = (await rl.question(question)).trim().toLowerCase()
			if (ans === "y" || ans === "yes") return true
			if (ans === "n" || ans === "no") return false
			console.log("Please enter y or n.")
		}
	} finally {
		rl.close()
	}
}

async function runContinuousCliDemo(maxTicks: number): Promise<void> {
	console.log("============================================================")
	console.log(`  LedgerProof — Continuous Chaos Stream CLI (${maxTicks} ticks)`)
	console.log("  Mode: Offline MockInferenceRunner (0 API keys required)")
	console.log("  Disclaimer: Synthetic data only. Not financial advice.")
	console.log("============================================================\n")

	const controller = new SessionController()
	let seenLogs = 0
	const unsub = controller.subscribe(() => {
		const snap = controller.getSnapshot()
		while (seenLogs < snap.logs.length) {
			console.log(snap.logs[seenLogs].text)
			seenLogs += 1
		}
	})

	const res = controller.startContinuousStream({
		mode: "mock",
		intervalMs: 180,
		trapCadence: 2,
		autoApprovePolicy: true,
		lateDelayMs: 280,
	})
	if (!res.ok) {
		throw new Error(res.error)
	}

	const deadline = Date.now() + 15000
	while (Date.now() < deadline) {
		const snap = controller.getSnapshot()
		if (snap.stream.tickCount >= maxTicks) break
		await sleep(50)
	}

	controller.stopContinuousStream()
	await sleep(350)
	await controller.waitForCurrentIdle(10000)
	unsub()

	const finalSnap = controller.getSnapshot()
	console.log("\n=== CONTINUOUS STREAM SUMMARY ===")
	console.log(
		JSON.stringify(
			{
				ticks: finalSnap.stream.tickCount,
				trapsInjected: finalSnap.stream.trapsInjected,
				totalInvoices: finalSnap.totalCellsCount,
				peakConcurrentLoops: finalSnap.metrics.peakConcurrentLoops,
				deterministicMatches: finalSnap.metrics.deterministicMatches,
				casConflictsPrevented: finalSnap.metrics.casConflictsPrevented,
				uncitedNumbersBlocked: finalSnap.metrics.uncitedNumbersBlocked,
				inventedNumbersLeaked: finalSnap.metrics.inventedNumbersLeaked,
				staleInvalidations: finalSnap.metrics.staleInvalidations,
				humanApprovalsRouted: finalSnap.metrics.humanApprovalsRouted,
			},
			null,
			2,
		),
	)
}

async function main(): Promise<void> {
	if (process.argv.includes("--stream")) {
		const ticksIdx = process.argv.indexOf("--ticks")
		const ticksVal = ticksIdx >= 0 ? Number(process.argv[ticksIdx + 1]) : 6
		const maxTicks = Number.isFinite(ticksVal) && ticksVal > 0 ? ticksVal : 6
		await runContinuousCliDemo(maxTicks)
		return
	}

	const autoMode = process.argv.includes("--auto") || !process.stdin.isTTY

	console.log("============================================================")
	console.log("  LedgerProof — Evidence-First Black Friday Finance Agents")
	console.log("  Mode: Offline MockInferenceRunner (0 API keys required)")
	console.log("  Disclaimer: Synthetic data only. Not financial advice.")
	console.log("============================================================\n")

	const state = await runBlackFridayScenario({
		log: (line) => console.log(line),
		approvalHandler: async (approval) => {
			console.log("\n--- HUMAN APPROVAL REQUIRED (other Mozaik loops continue) ---")
			console.log(`  Request : ${approval.requestId} (${approval.actionName})`)
			console.log(`  Invoice : ${approval.invoiceId} | Amount: $${(approval.amountCents / 100).toFixed(2)}`)
			console.log(`  Reason  : ${approval.reason}`)
			console.log(`  Flags   : ${approval.riskFlags.join(", ") || "none"}`)

			if (autoMode) {
				console.log("  [--auto] Rejecting suspicious IBAN change / high-risk payout.\n")
				return {
					approved: false,
					reason: `Auto-demo rejected ${approval.requestId}: ${approval.reason}`,
					decidedBy: "POLICY_AUTO",
				}
			}

			const approved = await interactiveApprovalPrompt("Approve this payment? [y/n] ")
			return {
				approved,
				reason: approved ? "Approved by operator" : `Rejected by operator: ${approval.reason}`,
				decidedBy: "HUMAN_INTERACTIVE",
			}
		},
	})

	console.log("\n=== FINAL VERIFIED LEDGER ===")
	for (const [id, cell] of state.cells.entries()) {
		const snap = cell.read()
		const rec = snap.value
		const txs = rec.matchedTxIds.join(", ") || "-"
		const flags = rec.riskFlags.join(", ") || "-"
		const staled = rec.drafts.filter((d) => d.status === "STALE").length
		console.log(
			`${id} (v${snap.version}) | ${rec.status.padEnd(16)} | $${(rec.paidAmountCents / 100).toFixed(2).padStart(7)} / $${(rec.expectedAmountCents / 100).toFixed(2).padStart(7)} | tx:[${txs}] | flags:[${flags}] | staleDrafts:${staled}`,
		)
	}

	console.log("\n=== BLOCKED / REJECTED CLAIMS (CodeProof Audit Trail) ===")
	for (const rej of state.rejectedAttempts) {
		console.log(`- [${rej.id}] (${rej.level} / ${rej.code}) ${rej.agentName}.${rej.actionName}: ${rej.reason}`)
	}

	console.log("\n=== CONCURRENCY & EVIDENCE METRICS ===")
	console.log(
		JSON.stringify(
			{
				peakConcurrentLoops: state.metrics.peakConcurrentLoops,
				totalLoopsCompleted: `${state.metrics.totalLoopsFinished}/${state.metrics.totalLoopsStarted}`,
				deterministicMatches: state.metrics.deterministicMatches,
				casConflictsPrevented: state.metrics.casConflictsPrevented,
				uncitedNumbersBlocked: state.metrics.uncitedNumbersBlocked,
				inventedNumbersLeaked: state.metrics.inventedNumbersLeaked,
				staleInvalidations: state.metrics.staleInvalidations,
				humanApprovalsRouted: state.metrics.humanApprovalsRouted,
			},
			null,
			2,
		),
	)

	const outDir = resolve(process.cwd(), "out")
	mkdirSync(outDir, { recursive: true })
	const jsonl = state.auditLog.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
	writeFileSync(resolve(outDir, "audit-trace.jsonl"), jsonl, "utf8")
	console.log(`\nAudit trace exported to out/audit-trace.jsonl (${state.auditLog.length} entries).`)
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
