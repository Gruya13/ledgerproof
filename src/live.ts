import "dotenv/config"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { resolveLiveProviderFromEnv } from "./engine/provider-factory"
import { evaluateAgainstGroundTruth } from "./proof"
import { loadGroundTruth, runBlackFridayScenario } from "./runner-setup"

async function main(): Promise<void> {
	const resolved = resolveLiveProviderFromEnv()
	if (!resolved) {
		console.log("No live LLM API key is configured in .env.")
		console.log("Supported keys (checked in order): DEEPSEEK_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY.")
		console.log("Copy .env.example to .env and set one key, or run zero-key mode right now:")
		console.log("  npm run proof")
		console.log("  npm run demo -- --auto")
		console.log("  npm run ui")
		return
	}

	console.log("============================================================")
	console.log(`  LedgerProof — LIVE Mode (${resolved.label})`)
	console.log("  100% Synthetic Data | Not Financial Advice")
	console.log("============================================================\n")

	const state = await runBlackFridayScenario({
		runner: resolved.runner,
		useNativeRunner: resolved.useNativeRunner,
		modelName: resolved.modelName,
		log: (line) => console.log(line),
		approvalHandler: async (approval) => {
			console.log(
				`\n[ProofGate HITL] Policy reviewing ${approval.requestId} ($${(approval.amountCents / 100).toFixed(2)}): ${approval.reason}`,
			)
			return {
				approved: false,
				reason: `Safe policy rejected ${approval.requestId}: ${approval.reason}`,
				decidedBy: "POLICY_AUTO",
			}
		},
	})

	const gt = loadGroundTruth()
	const evaluation = evaluateAgainstGroundTruth(state, gt)

	console.log("\n=== LIVE VERIFIED LEDGER ===")
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

	console.log("\n=== BLOCKED / REJECTED CLAIMS ===")
	for (const rej of state.rejectedAttempts) {
		console.log(`- [${rej.id}] (${rej.level} / ${rej.code}) ${rej.agentName}.${rej.actionName}: ${rej.reason}`)
	}

	console.log("\n=== LIVE CONCURRENCY & GROUND-TRUTH SUMMARY ===")
	console.log(`Invoices matched GT   : ${evaluation.casesPassed}/${evaluation.casesTotal}`)
	console.log(`Peak concurrent loops : ${state.metrics.peakConcurrentLoops}`)
	console.log(`Total loops completed : ${state.metrics.totalLoopsFinished}/${state.metrics.totalLoopsStarted}`)
	console.log(`CAS conflicts stopped : ${state.metrics.casConflictsPrevented}`)
	console.log(`Uncited/fake blocked  : ${state.metrics.uncitedNumbersBlocked}`)
	console.log(`Invented nums leaked  : ${state.metrics.inventedNumbersLeaked}`)
	console.log(`Stale invalidations   : ${state.metrics.staleInvalidations}`)
	console.log(`Human HITL routed     : ${state.metrics.humanApprovalsRouted}`)
	if (evaluation.failures.length > 0) {
		console.log("Notes / deltas vs mock proof:")
		for (const f of evaluation.failures) {
			console.log(`  - ${f}`)
		}
	}

	const outDir = resolve(process.cwd(), "out")
	mkdirSync(outDir, { recursive: true })
	const jsonl = state.auditLog.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
	writeFileSync(resolve(outDir, "live-audit-trace.jsonl"), jsonl, "utf8")
	console.log(`\nLive audit trace exported to out/live-audit-trace.jsonl (${state.auditLog.length} entries).`)
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
