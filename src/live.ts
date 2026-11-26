import "dotenv/config"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { resolveLiveProviderFromEnv } from "./engine/provider-factory"
import { evaluateAgainstGroundTruth } from "./proof"
import { loadGroundTruth, runBlackFridayScenario } from "./runner-setup"
import { SessionController } from "./session-controller"

function sleep(ms: number): Promise<void> {
	return new Promise((resolveFn) => setTimeout(resolveFn, ms))
}

function getNumericFlag(flag: string, fallback: number): number {
	const idx = process.argv.indexOf(flag)
	if (idx < 0) return fallback
	const parsed = Number(process.argv[idx + 1])
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

async function runLiveContinuousStream(
	providerLabel: string,
	maxTicks: number,
	maxLlmCalls: number,
): Promise<void> {
	console.log("============================================================")
	console.log(`  LedgerProof — LIVE Randomized Chaos Stream (${maxTicks} ticks)`)
	console.log(`  Engine: ${providerLabel} | Max LLM Budget: ${maxLlmCalls} calls`)
	console.log("  100% Synthetic Data | Not Financial Advice")
	console.log("============================================================\n")

	const controller = new SessionController()
	let seenLogs = 0
	const handledApprovals = new Set<string>()
	const trapCounts: Record<string, number> = {}

	const unsub = controller.subscribe(() => {
		const snap = controller.getSnapshot()
		while (seenLogs < snap.logs.length) {
			const text = snap.logs[seenLogs].text
			console.log(text)
			const trapMatch = text.match(/\[Stream #\d+\]\s+(?:TRAP|BENIGN)\s+\[([^\]]+)\]/)
			if (trapMatch) {
				trapCounts[trapMatch[1]] = (trapCounts[trapMatch[1]] ?? 0) + 1
			}
			seenLogs += 1
		}

		for (const approval of snap.pendingApprovals) {
			if (handledApprovals.has(approval.approvalId)) continue
			handledApprovals.add(approval.approvalId)
			// Wait briefly so concurrent RiskSentinel loops over live network can land risk holds before policy decides
			setTimeout(() => {
				const latestSnap = controller.getSnapshot()
				const latestCell = latestSnap.cells.find((c) => c.invoiceId === approval.invoiceId)
				const activeRiskFlags = latestCell?.record.riskFlags ?? approval.riskFlags
				const hasRiskFlags = activeRiskFlags.length > 0 || approval.riskFlags.length > 0
				const shouldApprove = !hasRiskFlags
				controller.resolveApproval(
					approval.approvalId,
					shouldApprove,
					shouldApprove
						? `Live policy approved benign >$250 transfer (${approval.requestId})`
						: `Live policy rejected risky payout (${[...new Set([...approval.riskFlags, ...activeRiskFlags])].join(", ")})`,
				)
			}, 1500)
		}
	})

	const lateDelayMs = 7000
	const res = controller.startContinuousStream({
		mode: "live",
		intervalMs: 650,
		trapCadence: 3,
		autoApprovePolicy: false,
		maxLlmCalls,
		lateDelayMs,
	})

	if (!res.ok) {
		unsub()
		throw new Error(res.error)
	}

	const deadline = Date.now() + 300_000
	while (Date.now() < deadline) {
		const snap = controller.getSnapshot()
		if (snap.stream.tickCount >= maxTicks || snap.llmBudgetExhausted) {
			break
		}
		await sleep(80)
	}

	controller.stopContinuousStream()
	// Allow delayed late settlements (TX-*) and active DeepSeek loops to settle cleanly
	await sleep(lateDelayMs + 500)
	await controller.waitForCurrentIdle(60000)
	unsub()

	const finalSnap = controller.getSnapshot({ full: true })
	const statusCounts: Record<string, number> = {}
	const unfinishedIds: string[] = []
	for (const cell of finalSnap.cells) {
		statusCounts[cell.record.status] = (statusCounts[cell.record.status] ?? 0) + 1
		if (cell.record.status === "OPEN" || cell.record.status === "PARTIAL") {
			unfinishedIds.push(`${cell.record.invoiceId}(${cell.record.status})`)
		}
	}

	console.log(`\n=== LIVE ${maxTicks}-TICK RANDOMIZED STREAM SUMMARY ===`)
	console.log(`Seed                  : ${finalSnap.stream.seed}`)
	console.log(`Ticks generated       : ${finalSnap.stream.tickCount} (${finalSnap.stream.trapsInjected} scenario injections)`)
	console.log(`Total ledger invoices : ${finalSnap.totalCellsCount}`)
	console.log(`Peak concurrent loops : ${finalSnap.metrics.peakConcurrentLoops}`)
	console.log(`Loops completed       : ${finalSnap.metrics.totalLoopsFinished}/${finalSnap.metrics.totalLoopsStarted}`)
	console.log(`LLM calls used        : ${finalSnap.metrics.llmCalls}${finalSnap.llmBudgetExhausted ? " (budget cap reached)" : ""}`)
	console.log(`Deterministic matches : ${finalSnap.metrics.deterministicMatches} (0 LLM tokens)`)
	console.log(`CAS conflicts stopped : ${finalSnap.metrics.casConflictsPrevented}`)
	console.log(`L1 uncited blocked    : ${finalSnap.metrics.uncitedNumbersBlocked}`)
	console.log(`Invented nums leaked  : ${finalSnap.metrics.inventedNumbersLeaked}`)
	console.log(`Stale invalidations   : ${finalSnap.metrics.staleInvalidations}`)
	console.log(`Human HITL routed     : ${finalSnap.metrics.humanApprovalsRouted}`)
	console.log(`Unmatched orphan TXs  : ${finalSnap.unmatchedTxIds.join(", ") || "none"}`)
	console.log(`Unfinished invoices   : ${unfinishedIds.join(", ") || "none"}`)
	console.log(`Invoice statuses      : ${JSON.stringify(statusCounts)}`)
	console.log(`Scenario breakdown    : ${JSON.stringify(trapCounts)}`)

	console.log("\n=== BLOCKED / REJECTED CLAIMS ===")
	for (const rej of finalSnap.rejectedAttempts) {
		console.log(`- [${rej.id}] (${rej.level} / ${rej.code}) ${rej.agentName}.${rej.actionName}: ${rej.reason}`)
	}

	const outDir = resolve(process.cwd(), "out")
	mkdirSync(outDir, { recursive: true })
	const outPath = resolve(outDir, `live-stream-${maxTicks}-audit.jsonl`)
	writeFileSync(outPath, controller.getAuditJsonl(), "utf8")
	console.log(`\nLive stream audit trace exported to out/live-stream-${maxTicks}-audit.jsonl (${finalSnap.auditLog.length} entries).`)
}

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

	if (process.argv.includes("--stream")) {
		const maxTicks = getNumericFlag("--ticks", 40)
		const maxLlmCalls = getNumericFlag("--max-llm-calls", Math.max(120, maxTicks * 3))
		await runLiveContinuousStream(resolved.label, maxTicks, maxLlmCalls)
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
