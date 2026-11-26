import {
	c,
	renderBanner,
	renderGanttTimeline,
	renderKpiGrid,
	renderSection,
} from "./engine/cli-ui"
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

	console.log(
		renderBanner({
			title: "Automated Concurrency & Evidence Proof",
			subtitle: "Zero-Key MockInferenceRunner · 7 Planted Black Friday Scenarios",
			badges: ["@mozaik-ai/core@6.0.0", "L1+L2+L3 ProofGate", "Palimpsest STALE"],
		}),
	)

	console.log(renderSection("VERIFICATION KPI SUMMARY"))
	console.log(
		renderKpiGrid(
			[
				{
					label: "Ground-Truth Invoices",
					value: `${evaluation.casesPassed}/${evaluation.casesTotal}`,
					tone: evaluation.casesPassed === evaluation.casesTotal ? "green" : "red",
				},
				{ label: "Peak Concurrent Loops", value: `${m.peakConcurrentLoops} (min ${gt.requiredMetrics.minPeakConcurrentLoops})`, tone: "cyan" },
				{ label: "Loops Completed", value: `${m.totalLoopsFinished}/${m.totalLoopsStarted}`, tone: "green" },
				{ label: "0-Token Matches", value: `${m.deterministicMatches}`, tone: "green" },
				{ label: "L2 CAS Stopped", value: `${m.casConflictsPrevented}`, tone: "amber" },
				{ label: "L1 Blocked / Leaked", value: `${m.uncitedNumbersBlocked} / ${m.inventedNumbersLeaked}`, tone: "red" },
				{ label: "Palimpsest STALE", value: `${m.staleInvalidations}`, tone: "purple" },
				{ label: "L3 HITL Routed", value: `${m.humanApprovalsRouted}`, tone: "amber" },
				{
					label: "Orphan TXs Held",
					value: `${state.unmatchedTxIds.size}`,
					tone: "neutral",
				},
			],
			3,
		),
	)

	console.log(renderSection("CONCURRENT AGENT EXECUTION TIMELINE", `${m.spans.length} spans`))
	console.log(renderGanttTimeline(m.spans, m.peakConcurrentLoops))
	console.log("")

	if (!evaluation.passed) {
		console.error(c.red("✖ PROOF FAILED:"))
		for (const f of evaluation.failures) {
			console.error(`  ${c.red("•")} ${f}`)
		}
		process.exitCode = 1
		return
	}

	console.log(c.green("✔ PROOF PASSED: All 7 planted Black Friday finance scenarios & concurrency invariants verified."))
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
}
