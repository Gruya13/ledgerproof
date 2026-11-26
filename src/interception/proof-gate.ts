import {
	FunctionCallItem,
	FunctionCallOutputItem,
	ModelMessageItem,
	SemanticEvent,
	type ExecutableTransition,
	type InferenceInput,
	type InterceptionHandler,
} from "@mozaik-ai/core"
import type { LedgerRuntimeApi } from "../runtime"
import { formatMoney } from "../engine/currency"
import {
	normalizeIban,
	verifyMessageCitations,
	verifyToolProposal,
	type ToolProposalArgs,
} from "../engine/proof-verifier"
import type { PendingApproval, RiskFlag } from "../types"

export { normalizeIban }

const HARD_RISK_FLAGS: readonly RiskFlag[] = [
	"FRAUD_VELOCITY",
	"DUPLICATE_INVOICE",
	"CURRENCY_MISMATCH",
	"OVERPAYMENT_ANOMALY",
]

function hasHardRiskFlag(flags: readonly RiskFlag[]): boolean {
	return flags.some((flag) => HARD_RISK_FLAGS.includes(flag))
}

function parseArgs(raw: string): unknown {
	try {
		return JSON.parse(raw)
	} catch {
		return undefined
	}
}

export class ProofGateInterceptionHandler implements InterceptionHandler {
	private proseRetried = false
	private toolRejections = 0
	private readonly maxToolRejections = 3

	constructor(
		private readonly agentId: string,
		private readonly agentName: string,
		private readonly inferenceInput: InferenceInput,
		private readonly rt: LedgerRuntimeApi,
	) {}

	isSatisfiedBy(transition: ExecutableTransition): boolean {
		return transition.nextStateId === "function_call" || (transition.nextStateId === "model_message" && !this.proseRetried)
	}

	async handle(transition: ExecutableTransition): Promise<ExecutableTransition> {
		const runtime = this.rt.resolveRuntime()
		const state = runtime.state

		if (transition.nextStateId === "model_message") {
			const { answer } = transition.input as { answer: ModelMessageItem }
			const check = verifyMessageCitations(
				answer.content.text,
				state.sourceStore,
				new Set([state.spendingLimitCents]),
			)
			if (check.ok) {
				return transition
			}

			this.proseRetried = true
			state.metrics.uncitedNumbersBlocked += 1
			const rejection = state.recordRejection({
				level: "L1_SOURCE_OR_MATH",
				code: check.code ?? "UNCITED_PROSE_FIGURE",
				agentName: this.agentName,
				actionName: "model_message",
				reason: check.reason ?? "Prose contained uncited or unverified monetary figure",
				rawArgs: answer.content.text,
			})
			this.rt.sendEvent(SemanticEvent.create("proof.blocked", this.agentId, rejection), this.agentId)

			return {
				nextStateId: "message_received",
				input: {
					content: `ProofGate L1 blocked your message (${check.code}): ${check.reason}. Rewrite your response citing only verified [src:ID] records and exact amounts from SourceStore.`,
					input: this.inferenceInput,
				},
			}
		}

		// function_call interception
		const { call, inferenceInput } = transition.input as {
			call: FunctionCallItem
			inferenceInput: InferenceInput
		}

		const parsed = parseArgs(call.args)

		// L1: Deterministic Source & Math Gate
		const l1 = verifyToolProposal(call.name, parsed, state.sourceStore)
		if (!l1.ok) {
			state.metrics.uncitedNumbersBlocked += 1
			const rejection = state.recordRejection({
				level: "L1_SOURCE_OR_MATH",
				code: l1.code ?? "L1_FAILED",
				agentName: this.agentName,
				actionName: call.name,
				reason: l1.reason ?? "Failed L1 source/math proof check",
				rawArgs: parsed,
			})
			this.rt.sendEvent(SemanticEvent.create("proof.blocked", this.agentId, rejection), this.agentId)

			return this.rejectToolCall(
				call,
				inferenceInput,
				JSON.stringify({
					ok: false,
					blockedBy: "ProofGate-L1",
					code: l1.code,
					reason: l1.reason,
				}),
			)
		}

		const args = parsed as ToolProposalArgs

		// L2: CAS Write-Skew Gate for payment/refund state mutations
		if (call.name === "propose_refund" || call.name === "propose_sepa_payout") {
			const cell = args.invoiceId ? state.getCell(args.invoiceId) : undefined
			if (!cell) {
				return this.rejectToolCall(
					call,
					inferenceInput,
					JSON.stringify({
						ok: false,
						blockedBy: "ProofGate-L2",
						code: "MISSING_CELL",
						reason: `No ledger cell found for ${args.invoiceId}`,
					}),
				)
			}

			const snap = cell.read()
			const req = args.requestId ? state.sourceStore.getRequest(args.requestId) : undefined
			if (!req) {
				return this.rejectToolCall(
					call,
					inferenceInput,
					JSON.stringify({
						ok: false,
						blockedBy: "ProofGate-L2",
						code: "MISSING_REQUEST",
						reason: `${call.name} requires a valid PaymentRequest`,
					}),
				)
			}

			if (call.name === "propose_refund") {
				if (snap.value.status === "REFUNDED") {
					state.metrics.uncitedNumbersBlocked += 1
					const rejection = state.recordRejection({
						level: "L1_SOURCE_OR_MATH",
						code: "ALREADY_REFUNDED",
						agentName: this.agentName,
						actionName: call.name,
						reason: `Invoice ${args.invoiceId} is already REFUNDED`,
						rawArgs: parsed,
					})
					this.rt.sendEvent(SemanticEvent.create("proof.blocked", this.agentId, rejection), this.agentId)
					return this.rejectToolCall(
						call,
						inferenceInput,
						JSON.stringify({
							ok: false,
							blockedBy: "ProofGate-L1",
							code: "ALREADY_REFUNDED",
							reason: rejection.reason,
						}),
					)
				}
				if (snap.value.paidAmountCents <= 0 || req.amountCents > snap.value.paidAmountCents) {
					state.metrics.uncitedNumbersBlocked += 1
					const rejection = state.recordRejection({
						level: "L1_SOURCE_OR_MATH",
						code: "REFUND_EXCEEDS_PAID",
						agentName: this.agentName,
						actionName: call.name,
						reason: `Refund ${req.sourceId} (${req.amountCents} cents) exceeds settled paidAmountCents (${snap.value.paidAmountCents} cents) on ${args.invoiceId}`,
						rawArgs: parsed,
					})
					this.rt.sendEvent(SemanticEvent.create("proof.blocked", this.agentId, rejection), this.agentId)
					return this.rejectToolCall(
						call,
						inferenceInput,
						JSON.stringify({
							ok: false,
							blockedBy: "ProofGate-L1",
							code: "REFUND_EXCEEDS_PAID",
							reason: rejection.reason,
						}),
					)
				}
			}

			if (call.name === "propose_sepa_payout" && snap.value.status === "SEPA_DRAFT_READY") {
				state.metrics.casConflictsPrevented += 1
				const rejection = state.recordRejection({
					level: "L2_CAS_WRITE_SKEW",
					code: "SEPA_ALREADY_DRAFTED",
					agentName: this.agentName,
					actionName: call.name,
					reason: `Invoice ${args.invoiceId} already has SEPA_DRAFT_READY`,
					rawArgs: parsed,
				})
				this.rt.sendEvent(
					SemanticEvent.create("conflict.prevented", this.agentId, {
						invoiceId: args.invoiceId,
						requestId: req.sourceId,
						rejection,
					}),
					this.agentId,
				)
				return this.rejectToolCall(
					call,
					inferenceInput,
					JSON.stringify({
						ok: false,
						blockedBy: "ProofGate-L2-CAS",
						code: "SEPA_ALREADY_DRAFTED",
						reason: rejection.reason,
					}),
				)
			}

			const vendor = state.sourceStore.getVendor(req.vendorId)
			const ibanMismatch =
				Boolean(req.targetIban) &&
				Boolean(vendor?.masterIban) &&
				normalizeIban(req.targetIban!) !== normalizeIban(vendor!.masterIban)
			const overLimit = req.amountCents > state.spendingLimitCents
			const hasHardRiskBlock = hasHardRiskFlag(snap.value.riskFlags)

			// A concurrent state change on non-IBAN-policy cases (e.g. fraud/duplicate lock or stale version) is a CAS write-skew.
			const versionStale = args.expectedVersion !== undefined && args.expectedVersion !== snap.version
			const isWriteSkew =
				hasHardRiskBlock || (versionStale && !(call.name === "propose_sepa_payout" && (ibanMismatch || overLimit)))

			if (isWriteSkew) {
				state.metrics.casConflictsPrevented += 1
				const conflictReason = versionStale
					? `CAS write-skew on ${args.invoiceId}: expected version ${args.expectedVersion}, current version ${snap.version} (status=${snap.value.status}, riskFlags=[${snap.value.riskFlags.join(", ")}])`
					: `Concurrent risk hold active on ${args.invoiceId}: status=${snap.value.status}, riskFlags=[${snap.value.riskFlags.join(", ")}]`

				const rejection = state.recordRejection({
					level: "L2_CAS_WRITE_SKEW",
					code: "WRITE_SKEW_PREVENTED",
					agentName: this.agentName,
					actionName: call.name,
					reason: conflictReason,
					rawArgs: parsed,
				})

				// Escalate invoice to NEEDS_HUMAN if not already locked at HOLD_RISK
				cell.casWrite(snap.version, (cur) => {
					const flags: RiskFlag[] = cur.riskFlags.includes("WRITE_SKEW_COLLISION")
						? cur.riskFlags
						: [...cur.riskFlags, "WRITE_SKEW_COLLISION"]
					return {
						...cur,
						status: cur.status === "HOLD_RISK" ? "HOLD_RISK" : "NEEDS_HUMAN",
						riskFlags: flags,
						notes: [...cur.notes, `ProofGate L2 prevented write-skew on ${call.name} (${args.requestId ?? "n/a"})`],
					}
				})

				this.rt.sendEvent(
					SemanticEvent.create("conflict.prevented", this.agentId, {
						invoiceId: args.invoiceId,
						requestId: args.requestId,
						rejection,
					}),
					this.agentId,
				)

				return this.rejectToolCall(
					call,
					inferenceInput,
					JSON.stringify({
						ok: false,
						blockedBy: "ProofGate-L2-CAS",
						code: "WRITE_SKEW_PREVENTED",
						reason: conflictReason,
					}),
				)
			}

			// L3: Controlled Payment Agent — Spending Limit & Vendor Master IBAN Routing
			if (ibanMismatch || overLimit) {
				const flags: RiskFlag[] = [...snap.value.riskFlags]
				if (ibanMismatch && !flags.includes("BEC_IBAN_CHANGE")) {
					flags.push("BEC_IBAN_CHANGE")
				}

				const currency = req?.currency ?? snap.value.currency
				const reasons: string[] = []
				if (overLimit && !ibanMismatch && flags.length === 0) {
					reasons.push(
						`Amount ${formatMoney(args.amountCents ?? 0, currency)} exceeds auto-approve limit ${formatMoney(state.spendingLimitCents, currency)} (IBAN verified / no fraud flags — safe to approve if authorized)`,
					)
				} else {
					if (overLimit) {
						reasons.push(
							`Amount ${formatMoney(args.amountCents ?? 0, currency)} exceeds auto-approve limit ${formatMoney(state.spendingLimitCents, currency)}`,
						)
					}
					if (ibanMismatch) {
						reasons.push(
							`Target IBAN ${req?.targetIban} does not match vendor master IBAN ${vendor?.masterIban} (${vendor?.sourceId})`,
						)
					}
				}

				const approval: PendingApproval = {
					approvalId: `HITL-${args.invoiceId}-${Date.now()}`,
					invoiceId: args.invoiceId!,
					requestId: args.requestId ?? "manual",
					agentName: this.agentName,
					actionName: call.name,
					amountCents: args.amountCents ?? 0,
					currency,
					reason: reasons.join("; "),
					riskFlags: flags,
					citations: args.citations ?? [],
				}

				state.pendingApprovals.set(approval.approvalId, approval)
				state.metrics.humanApprovalsRouted += 1
				state.notifyChange()
				this.rt.sendEvent(SemanticEvent.create("human.required", this.agentId, approval), this.agentId)

				const decision = await state.approvalBroker.requestApproval(approval)
				state.pendingApprovals.delete(approval.approvalId)
				state.notifyChange()
				state.logAudit("human.decision", decision.decidedBy, args.invoiceId, {
					approvalId: approval.approvalId,
					approved: decision.approved,
					reason: decision.reason,
				})

				if (!decision.approved) {
					const rejection = state.recordRejection({
						level: "L3_HUMAN_REJECTED",
						code: "HUMAN_REJECTED_PAYOUT",
						agentName: this.agentName,
						actionName: call.name,
						reason: decision.reason,
						rawArgs: parsed,
					})
					const curSnap = cell.read()
					cell.casWrite(curSnap.version, (cur) => ({
						...cur,
						status: "HOLD_RISK",
						riskFlags: flags,
						notes: [...cur.notes, `Human approver rejected ${args.requestId ?? call.name}: ${decision.reason}`],
					}))
					this.rt.sendEvent(SemanticEvent.create("proof.blocked", this.agentId, rejection), this.agentId)

					return this.rejectToolCall(
						call,
						inferenceInput,
						JSON.stringify({
							ok: false,
							blockedBy: "ProofGate-L3-HITL",
							code: "HUMAN_REJECTED_PAYOUT",
							reason: decision.reason,
						}),
					)
				}

				const postSnap = cell.read()
				const postReq = state.sourceStore.getRequest(req.sourceId)
				const ibanStillMatches =
					call.name !== "propose_sepa_payout" ||
					(Boolean(postReq?.targetIban) &&
						Boolean(req.targetIban) &&
						normalizeIban(postReq!.targetIban!) === normalizeIban(req.targetIban!))
				const hardRiskNow = hasHardRiskFlag(postSnap.value.riskFlags)
				const onlyBecRiskFlags =
					postSnap.value.riskFlags.length > 0 && postSnap.value.riskFlags.every((f) => f === "BEC_IBAN_CHANGE")
				const incompatibleStatus =
					postSnap.value.status === "DUPLICATE" ||
					postSnap.value.status === "REFUNDED" ||
					postSnap.value.status === "SEPA_DRAFT_READY" ||
					(postSnap.value.status === "HOLD_RISK" &&
						!(call.name === "propose_sepa_payout" && ibanMismatch && onlyBecRiskFlags))
				const allowedBecVersionBump =
					call.name === "propose_sepa_payout" &&
					ibanMismatch &&
					onlyBecRiskFlags &&
					postSnap.value.paidAmountCents === snap.value.paidAmountCents &&
					postSnap.value.expectedAmountCents === snap.value.expectedAmountCents
				const staleVersionChanged = postSnap.version !== snap.version && !allowedBecVersionBump
				const refundStillValid =
					call.name !== "propose_refund" ||
					(req.amountCents <= postSnap.value.paidAmountCents && postSnap.value.status !== "REFUNDED")

				if (
					!postReq ||
					postReq.amountCents !== req.amountCents ||
					!ibanStillMatches ||
					hardRiskNow ||
					incompatibleStatus ||
					staleVersionChanged ||
					!refundStillValid
				) {
					state.metrics.casConflictsPrevented += 1
					const staleReason = `Post-HITL state invalidated ${args.invoiceId}: status=${postSnap.value.status}, riskFlags=[${postSnap.value.riskFlags.join(", ")}], version=${postSnap.version} (approved at v${snap.version})`
					const rejection = state.recordRejection({
						level: "L2_CAS_WRITE_SKEW",
						code: "STALE_POST_HITL_STATE",
						agentName: this.agentName,
						actionName: call.name,
						reason: staleReason,
						rawArgs: parsed,
					})
					state.logAudit("hitl.stale_rejected", this.agentName, args.invoiceId, {
						requestId: req.sourceId,
						approvedAtVersion: snap.version,
						currentVersion: postSnap.version,
						status: postSnap.value.status,
						riskFlags: postSnap.value.riskFlags,
					})
					this.rt.sendEvent(
						SemanticEvent.create("conflict.prevented", this.agentId, {
							invoiceId: args.invoiceId,
							requestId: req.sourceId,
							rejection,
						}),
						this.agentId,
					)
					return this.rejectToolCall(
						call,
						inferenceInput,
						JSON.stringify({
							ok: false,
							blockedBy: "ProofGate-L3-PostHITL",
							code: "STALE_POST_HITL_STATE",
							reason: staleReason,
						}),
					)
				}

				state.grantExecution({
					requestId: req.sourceId,
					invoiceId: args.invoiceId!,
					actionName: call.name,
					approvedBy: "HUMAN",
					approvedVersion: postSnap.version,
					amountCents: req.amountCents,
					targetIban: req.targetIban ? normalizeIban(req.targetIban) : undefined,
					grantedAt: new Date().toISOString(),
				})
			} else {
				state.grantExecution({
					requestId: req.sourceId,
					invoiceId: args.invoiceId!,
					actionName: call.name,
					approvedBy: "AUTO_POLICY",
					approvedVersion: snap.version,
					amountCents: req.amountCents,
					targetIban: req.targetIban ? normalizeIban(req.targetIban) : undefined,
					grantedAt: new Date().toISOString(),
				})
			}
		}

		return transition
	}

	private rejectToolCall(
		call: FunctionCallItem,
		inferenceInput: InferenceInput,
		outputJson: string,
	): ExecutableTransition {
		this.toolRejections += 1
		const payload =
			this.toolRejections > this.maxToolRejections
				? JSON.stringify({
						ok: false,
						blockedBy: "ProofGate-Cap",
						reason:
							"Max tool retries (3) reached for this loop. Do NOT call any more tools; produce a concise final summary citing only verified [src:ID] sources.",
					})
				: outputJson
		const output = FunctionCallOutputItem.create(call.callId, payload)
		inferenceInput.context.addContextItems([call, output])
		return {
			nextStateId: inferenceInput.streaming ? "inference_streaming" : "inference",
			input: inferenceInput,
		}
	}
}
