import { describe, expect, it } from "vitest"
import { evaluateAgainstGroundTruth } from "../src/proof"
import { loadGroundTruth, runBlackFridayScenario } from "../src/runner-setup"

describe("LedgerProof E2E concurrent Mozaik runtime", () => {
	it("passes all 7 planted Black Friday cases and concurrency/proof invariants", async () => {
		const gt = loadGroundTruth()
		const state = await runBlackFridayScenario({
			approvalHandler: async (approval) => ({
				approved: false,
				reason: `Test policy rejected ${approval.requestId}`,
				decidedBy: "POLICY_AUTO",
			}),
		})

		const evaluation = evaluateAgainstGroundTruth(state, gt)
		expect(evaluation.failures).toEqual([])
		expect(evaluation.passed).toBe(true)
		expect(evaluation.casesPassed).toBe(evaluation.casesTotal)
		expect(state.metrics.peakConcurrentLoops).toBeGreaterThanOrEqual(3)
		expect(state.metrics.casConflictsPrevented).toBeGreaterThanOrEqual(1)
		expect(state.metrics.uncitedNumbersBlocked).toBeGreaterThanOrEqual(1)
		expect(state.metrics.inventedNumbersLeaked).toBe(0)
		expect(state.metrics.staleInvalidations).toBeGreaterThanOrEqual(1)
		expect(state.metrics.humanApprovalsRouted).toBeGreaterThanOrEqual(1)
	})
})
