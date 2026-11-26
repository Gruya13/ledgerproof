import { loadGroundTruth, runBlackFridayScenario } from "./runner-setup"
import type { GroundTruthSpec } from "./types"
import type { LedgerState } from "./runtime"

export interface ProofEvaluation {
	passed: boolean
	casesPassed: number
	casesTotal: number
	failures: string[]
}

export function evaluateAgainstGroundTruth(state: LedgerState, gt: GroundTruthSpec): ProofEvaluation {
	const failures: string[] = []
	let casesPassed = 0
	const entries = Object.entries(gt.expectedInvoices)

	for (const [invoiceId, expected] of entries) {
		const cell = state.getCell(invoiceId)
		if (!cell) {
			failures.push(`${invoiceId}: missing cell`)
			continue
		}
		const rec = cell.read().value
		const statusOk = expected.allowedStatuses.includes(rec.status)
		const txOk = expected.requiredTxIds.every((txId) => rec.matchedTxIds.includes(txId))
		const flagOk = !expected.requiredRiskFlag || rec.riskFlags.includes(expected.requiredRiskFlag)

		if (statusOk && txOk && flagOk) {
			casesPassed += 1
		} else {
			failures.push(
				`${invoiceId}: status=${rec.status} (expected ${expected.allowedStatuses.join("|")}), matched=[${rec.matchedTxIds.join(",")}], flags=[${rec.riskFlags.join(",")}]`,
			)
		}
	}

	for (const txId of gt.expectedUnmatchedTxIds) {
		if (!state.unmatchedTxIds.has(txId)) {
			failures.push(`Unmatched tx ${txId} was not classified in unmatchedTxIds`)
		}
	}

	const m = state.metrics
	if (m.peakConcurrentLoops < gt.requiredMetrics.minPeakConcurrentLoops) {
		failures.push(
			`peakConcurrentLoops=${m.peakConcurrentLoops} < required ${gt.requiredMetrics.minPeakConcurrentLoops}`,
		)
	}
	if (m.casConflictsPrevented < gt.requiredMetrics.minCasConflictsPrevented) {
		failures.push(
			`casConflictsPrevented=${m.casConflictsPrevented} < required ${gt.requiredMetrics.minCasConflictsPrevented}`,
		)
	}
	if (m.uncitedNumbersBlocked < gt.requiredMetrics.minUncitedNumbersBlocked) {
		failures.push(
			`uncitedNumbersBlocked=${m.uncitedNumbersBlocked} < required ${gt.requiredMetrics.minUncitedNumbersBlocked}`,
		)
	}
	if (m.inventedNumbersLeaked > gt.requiredMetrics.maxInventedNumbersLeaked) {
		failures.push(
			`inventedNumbersLeaked=${m.inventedNumbersLeaked} > max ${gt.requiredMetrics.maxInventedNumbersLeaked}`,
		)
	}
	if (m.staleInvalidations < gt.requiredMetrics.minStaleInvalidations) {
		failures.push(
			`staleInvalidations=${m.staleInvalidations} < required ${gt.requiredMetrics.minStaleInvalidations}`,
		)
	}
	if (m.humanApprovalsRouted < gt.requiredMetrics.minHumanApprovalsRouted) {
		failures.push(
			`humanApprovalsRouted=${m.humanApprovalsRouted} < required ${gt.requiredMetrics.minHumanApprovalsRouted}`,
		)
	}

	return {
		passed: failures.length === 0,
		casesPassed,
		casesTotal: entries.length,
		failures,
	}
}

async function main(): Promise<void> {
	const gt = loadGroundTruth()
	const state = await runBlackFridayScenario({
		approvalHandler: async (approval) => ({
			approved: false,
			reason: `Safe policy rejected ${approval.requestId}: ${approval.reason}`,
			decidedBy: "POLICY_AUTO",
		}),
	})

	const evaluation = evaluateAgainstGroundTruth(state, gt)
	const m = state.metrics

	console.log("============================================================")
	console.log("  LedgerProof — Automated Concurrency & Evidence Proof")
	console.log("  100% Synthetic Data | Not Financial Advice")
	console.log("============================================================")
	console.log(`Ground-truth invoices : ${evaluation.casesPassed}/${evaluation.casesTotal}`)
	console.log(`Peak concurrent loops : ${m.peakConcurrentLoops} (min ${gt.requiredMetrics.minPeakConcurrentLoops})`)
	console.log(`Total loops completed : ${m.totalLoopsFinished}/${m.totalLoopsStarted}`)
	console.log(`Deterministic matches : ${m.deterministicMatches} (0 LLM tokens)`)
	console.log(`CAS conflicts stopped : ${m.casConflictsPrevented}`)
	console.log(`Uncited/fake blocked  : ${m.uncitedNumbersBlocked}`)
	console.log(`Invented nums leaked  : ${m.inventedNumbersLeaked}`)
	console.log(`Stale invalidations   : ${m.staleInvalidations}`)
	console.log(`Human HITL routed     : ${m.humanApprovalsRouted}`)
	console.log("------------------------------------------------------------")

	const baseMs = m.spans[0]?.startMs ?? 0
	console.log("Concurrent Agent Execution Timeline (relative ms):")
	for (const span of m.spans) {
		const start = span.startMs - baseMs
		const end = (span.endMs ?? span.startMs) - baseMs
		console.log(`  +${String(start).padStart(4)}ms -> +${String(end).padStart(4)}ms | ${span.agentName.padEnd(16)} | ${span.eventType} (${span.targetId})`)
	}
	console.log("------------------------------------------------------------")

	if (!evaluation.passed) {
		console.error("PROOF FAILED:")
		for (const f of evaluation.failures) {
			console.error(`  - ${f}`)
		}
		process.exitCode = 1
		return
	}

	console.log("PROOF PASSED: All 7 planted Black Friday finance scenarios & concurrency invariants verified.")
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
}
