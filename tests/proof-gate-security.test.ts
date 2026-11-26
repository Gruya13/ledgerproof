import { describe, expect, it } from "vitest"
import {
	DeveloperMessageItem,
	FunctionCallItem,
	FunctionCallOutputItem,
	ModelContext,
	type ExecutableTransition,
	type InferenceInput,
} from "@mozaik-ai/core"
import { MockInferenceRunner } from "../src/engine/mock-runner"
import { ProofGateInterceptionHandler } from "../src/interception/proof-gate"
import { createPayoutAndRefundAgent } from "../src/participants/payout-refund"
import { ApprovalBroker, createLedgerRuntime, LedgerState } from "../src/runtime"
import { loadPack } from "../src/runner-setup"
import type { BlackFridayPack, PendingApproval } from "../src/types"

function makeHandlerSetup(pack: BlackFridayPack, broker: ApprovalBroker) {
	const rt = createLedgerRuntime()
	const state = new LedgerState(pack, broker)
	rt.initializeRuntime({
		state,
		inferenceRunnerConfig: { runner: new MockInferenceRunner() },
	})
	const agent = createPayoutAndRefundAgent(rt, "mock-model")
	rt.join(agent)

	const inferenceInput: InferenceInput = {
		model: "mock-model",
		context: ModelContext.create().addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage())),
		tools: agent.getTools(),
	}
	const handler = new ProofGateInterceptionHandler(agent.getId(), "PayoutAndRefund", inferenceInput, rt)
	return { rt, state, agent, inferenceInput, handler }
}

function makeToolTransition(name: string, args: Record<string, unknown>, inferenceInput: InferenceInput): ExecutableTransition {
	const call = FunctionCallItem.rehydrate({
		callId: `call-${name}-${Date.now()}`,
		name,
		args: JSON.stringify(args),
	})
	return {
		nextStateId: "function_call",
		input: { call, inferenceInput },
	}
}

describe("ProofGate security invariants (HITL provenance, post-HITL staleness, refund balance)", () => {
	it("records approvedBy='HUMAN' for under-limit SEPA payouts approved via IBAN mismatch HITL", async () => {
		const basePack = loadPack()
		const pack: BlackFridayPack = {
			...basePack,
			invoices: [
				{
					sourceId: "INV-9001",
					vendorId: "VND-01",
					poNumber: "PO-9001",
					amountCents: 15000,
					currency: "EUR",
					issuedAt: "2026-11-26",
					dueDate: "2026-12-03",
					description: "Under-limit IBAN override test",
				},
			],
			transactions: [],
			requests: [
				{
					sourceId: "REQ-9001",
					kind: "sepa_payout",
					invoiceId: "INV-9001",
					vendorId: "VND-01",
					amountCents: 15000,
					currency: "EUR",
					targetIban: "DE99000000000000999999",
					requestedBy: "cfo-verified@ledgerproof.internal",
					reason: "Verified bank account migration under €250 limit",
					concurrentWithAlert: false,
				},
			],
		}

		let seenApproval: PendingApproval | undefined
		const broker = new ApprovalBroker(async (approval) => {
			seenApproval = approval
			return { approved: true, reason: "Operator verified bank migration", decidedBy: "HUMAN_INTERACTIVE" }
		})

		const { state, agent, inferenceInput, handler } = makeHandlerSetup(pack, broker)
		const args = {
			requestId: "REQ-9001",
			invoiceId: "INV-9001",
			vendorId: "VND-01",
			amountCents: 15000,
			targetIban: "DE99000000000000999999",
			expectedVersion: 1,
			citations: [
				{ sourceId: "INV-9001", field: "amountCents", expectedValue: 15000 },
				{ sourceId: "REQ-9001", field: "amountCents", expectedValue: 15000 },
			],
		}

		const next = await handler.handle(makeToolTransition("propose_sepa_payout", args, inferenceInput))
		expect(seenApproval?.riskFlags).toContain("BEC_IBAN_CHANGE")
		expect(next.nextStateId).toBe("function_call")

		const sepaTool = agent.getTools().find((t) => t.name === "propose_sepa_payout")!
		const res = (await sepaTool.invoke(args as never)) as { ok: boolean; approvedBy: string }
		expect(res.ok).toBe(true)
		expect(res.approvedBy).toBe("HUMAN")

		const cellSnap = state.getCell("INV-9001")!.read()
		expect(cellSnap.value.sepaDraft?.approvedBy).toBe("HUMAN")
		expect(state.getSepaDraftXml("INV-9001")?.xml).toContain("HUMAN</Ustrd>")
	})

	it("rejects stale HITL approval when FRAUD_VELOCITY arrives while waiting for human sign-off", async () => {
		const basePack = loadPack()
		const pack: BlackFridayPack = {
			...basePack,
			invoices: [
				{
					sourceId: "INV-9002",
					vendorId: "VND-01",
					poNumber: "PO-9002",
					amountCents: 40000,
					currency: "EUR",
					issuedAt: "2026-11-26",
					dueDate: "2026-12-03",
					description: "High-value SEPA race test",
				},
			],
			transactions: [],
			requests: [
				{
					sourceId: "REQ-9002",
					kind: "sepa_payout",
					invoiceId: "INV-9002",
					vendorId: "VND-01",
					amountCents: 40000,
					currency: "EUR",
					targetIban: "DE89370400440532013000",
					requestedBy: "cfo-approved@ledgerproof.internal",
					reason: "High-value SEPA payout",
					concurrentWithAlert: false,
				},
			],
		}

		let resolveApproval!: (decision: { approved: boolean; reason: string; decidedBy: "HUMAN_INTERACTIVE" }) => void
		const broker = new ApprovalBroker(
			() =>
				new Promise((res) => {
					resolveApproval = res
				}),
		)

		const { state, inferenceInput, handler } = makeHandlerSetup(pack, broker)
		const handlePromise = handler.handle(
			makeToolTransition(
				"propose_sepa_payout",
				{
					requestId: "REQ-9002",
					invoiceId: "INV-9002",
					vendorId: "VND-01",
					amountCents: 40000,
					targetIban: "DE89370400440532013000",
					expectedVersion: 1,
					citations: [
						{ sourceId: "INV-9002", field: "amountCents", expectedValue: 40000 },
						{ sourceId: "REQ-9002", field: "amountCents", expectedValue: 40000 },
					],
				},
				inferenceInput,
			),
		)

		// Wait one tick for ProofGate to pause on approvalBroker
		await new Promise((r) => setTimeout(r, 15))
		expect(state.pendingApprovals.size).toBe(1)

		// Concurrent RiskSentinel locks invoice with FRAUD_VELOCITY while HITL decision is in flight
		const cell = state.getCell("INV-9002")!
		const cur = cell.read()
		cell.casWrite(cur.version, (c) => ({
			...c,
			status: "HOLD_RISK",
			riskFlags: ["FRAUD_VELOCITY"],
			notes: [...c.notes, "Concurrent FRAUD_VELOCITY lock during HITL wait"],
		}))

		// Human approves stale snapshot
		resolveApproval({ approved: true, reason: "Approved before seeing alert", decidedBy: "HUMAN_INTERACTIVE" })
		const next = await handlePromise

		expect(next.nextStateId).toBe("inference")
		const outputs = inferenceInput.context
			.getItems()
			.filter((i): i is FunctionCallOutputItem => i instanceof FunctionCallOutputItem)
		expect(outputs.some((o) => o.output.text.includes("STALE_POST_HITL_STATE"))).toBe(true)
		expect(state.metrics.casConflictsPrevented).toBe(1)
		expect(state.getCell("INV-9002")!.read().value.status).toBe("HOLD_RISK")
		expect(state.getSepaDraftXml("INV-9002")).toBeUndefined()
	})

	it("blocks refunds exceeding settled paidAmountCents and duplicate refunds on REFUNDED invoices", async () => {
		const basePack = loadPack()
		const pack: BlackFridayPack = {
			...basePack,
			invoices: [
				{
					sourceId: "INV-9003",
					vendorId: "VND-05",
					poNumber: "PO-9003",
					amountCents: 18000,
					currency: "USD",
					issuedAt: "2026-11-26",
					dueDate: "2026-12-03",
					description: "Unpaid refund guard test",
				},
			],
			transactions: [],
			requests: [
				{
					sourceId: "REQ-9003",
					kind: "refund",
					invoiceId: "INV-9003",
					vendorId: "VND-05",
					amountCents: 18000,
					currency: "USD",
					targetIban: null,
					requestedBy: "customer-portal",
					reason: "Refund before payment settled",
					concurrentWithAlert: false,
				},
			],
		}

		const broker = new ApprovalBroker(async () => ({
			approved: true,
			reason: "ok",
			decidedBy: "POLICY_AUTO",
		}))

		const { state, inferenceInput, handler } = makeHandlerSetup(pack, broker)
		const refundArgs = {
			requestId: "REQ-9003",
			invoiceId: "INV-9003",
			amountCents: 18000,
			expectedVersion: 1,
			citations: [
				{ sourceId: "INV-9003", field: "amountCents", expectedValue: 18000 },
				{ sourceId: "REQ-9003", field: "amountCents", expectedValue: 18000 },
			],
		}

		// Case A: Invoice OPEN with paidAmountCents = 0 -> REFUND_EXCEEDS_PAID
		const firstRes = await handler.handle(makeToolTransition("propose_refund", refundArgs, inferenceInput))
		expect(firstRes.nextStateId).toBe("inference")
		expect(state.rejectedAttempts.some((r) => r.code === "REFUND_EXCEEDS_PAID")).toBe(true)

		// Case B: Invoice paid but already REFUNDED -> ALREADY_REFUNDED
		const cell = state.getCell("INV-9003")!
		const cur = cell.read()
		cell.casWrite(cur.version, (c) => ({
			...c,
			paidAmountCents: 18000,
			status: "REFUNDED",
		}))

		const secondRes = await handler.handle(
			makeToolTransition("propose_refund", { ...refundArgs, expectedVersion: cell.read().version }, inferenceInput),
		)
		expect(secondRes.nextStateId).toBe("inference")
		expect(state.rejectedAttempts.some((r) => r.code === "ALREADY_REFUNDED")).toBe(true)
	})

	it("rejects POLICY_AUTO on BEC_IBAN_CHANGE and preserves AUTO_POLICY provenance on policy-approved payouts", async () => {
		const basePack = loadPack()
		const pack: BlackFridayPack = {
			...basePack,
			invoices: [
				{
					sourceId: "INV-9004",
					vendorId: "VND-01",
					poNumber: "PO-9004",
					amountCents: 15000,
					currency: "EUR",
					issuedAt: "2026-11-26",
					dueDate: "2026-12-03",
					description: "IBAN mismatch POLICY_AUTO rejection test",
				},
				{
					sourceId: "INV-9005",
					vendorId: "VND-01",
					poNumber: "PO-9005",
					amountCents: 40000,
					currency: "EUR",
					issuedAt: "2026-11-26",
					dueDate: "2026-12-03",
					description: "Clean over-limit POLICY_AUTO provenance test",
				},
			],
			transactions: [],
			requests: [
				{
					sourceId: "REQ-9004",
					kind: "sepa_payout",
					invoiceId: "INV-9004",
					vendorId: "VND-01",
					amountCents: 15000,
					currency: "EUR",
					targetIban: "DE99000000000000888888",
					requestedBy: "spoof@invalid",
					reason: "IBAN change attempt",
					concurrentWithAlert: false,
				},
				{
					sourceId: "REQ-9005",
					kind: "sepa_payout",
					invoiceId: "INV-9005",
					vendorId: "VND-01",
					amountCents: 40000,
					currency: "EUR",
					targetIban: "DE89370400440532013000",
					requestedBy: "cfo-policy@ledgerproof.internal",
					reason: "Clean over-limit SEPA payout",
					concurrentWithAlert: false,
				},
			],
		}

		const autoBroker = new ApprovalBroker(async () => ({
			approved: true,
			reason: "Automated policy check",
			decidedBy: "POLICY_AUTO",
		}))

		const { state, agent, inferenceInput, handler } = makeHandlerSetup(pack, autoBroker)

		// Immutable SourceStore blocks overwriting an existing ID with modified content
		expect(() =>
			state.sourceStore.addRequest({
				...pack.requests[0],
				amountCents: 99999,
			}),
		).toThrow(/Immutable SourceStore violation/)

		// POLICY_AUTO must not approve BEC_IBAN_CHANGE
		const becNext = await handler.handle(
			makeToolTransition(
				"propose_sepa_payout",
				{
					requestId: "REQ-9004",
					invoiceId: "INV-9004",
					vendorId: "VND-01",
					amountCents: 15000,
					targetIban: "DE99000000000000888888",
					expectedVersion: 1,
					citations: [
						{ sourceId: "INV-9004", field: "amountCents", expectedValue: 15000 },
						{ sourceId: "REQ-9004", field: "amountCents", expectedValue: 15000 },
					],
				},
				inferenceInput,
			),
		)
		expect(becNext.nextStateId).toBe("inference")
		expect(state.rejectedAttempts.some((r) => r.code === "HUMAN_REQUIRED_FOR_IBAN_CHANGE")).toBe(true)

		// POLICY_AUTO approving clean over-limit transfer records AUTO_POLICY (not HUMAN)
		const cleanArgs = {
			requestId: "REQ-9005",
			invoiceId: "INV-9005",
			vendorId: "VND-01",
			amountCents: 40000,
			targetIban: "DE89370400440532013000",
			expectedVersion: 1,
			citations: [
				{ sourceId: "INV-9005", field: "amountCents", expectedValue: 40000 },
				{ sourceId: "REQ-9005", field: "amountCents", expectedValue: 40000 },
			],
		}
		const cleanNext = await handler.handle(makeToolTransition("propose_sepa_payout", cleanArgs, inferenceInput))
		expect(cleanNext.nextStateId).toBe("function_call")
		const sepaTool = agent.getTools().find((t) => t.name === "propose_sepa_payout")!
		const toolRes = (await sepaTool.invoke(cleanArgs as never)) as { ok: boolean; approvedBy: string }
		expect(toolRes.ok).toBe(true)
		expect(toolRes.approvedBy).toBe("AUTO_POLICY")
		expect(state.getCell("INV-9005")!.read().value.sepaDraft?.approvedBy).toBe("AUTO_POLICY")
	})
})
