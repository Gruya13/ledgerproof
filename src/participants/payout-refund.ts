import {
	createAgent,
	DeveloperMessageItem,
	ModelContext,
	SemanticEvent,
	SituationSpecification,
	type Agent,
	type InferenceInput,
	type SituationContext,
	type SituationHandler,
	type SituationProcessor,
	type Tool,
} from "@mozaik-ai/core"
import type { LedgerRuntimeApi } from "../runtime"
import { ProofGateInterceptionHandler } from "../interception/proof-gate"
import type { Citation, ClaimRecord, PaymentRequest } from "../types"

class PayoutRefundSpec extends SituationSpecification {
	isSatisfiedBy(context: SituationContext): boolean {
		return (
			context.event.type === "request.arrived" ||
			context.event.type === "invoice.partial" ||
			context.event.type === "claim.staled"
		)
	}
}

export function createPayoutAndRefundAgent(rt: LedgerRuntimeApi, modelName: string): Agent {
	let selfId = ""

	const proposeSepaPayoutTool: Tool = {
		type: "function",
		name: "propose_sepa_payout",
		description:
			"Prepare or execute a SEPA payout draft for an invoice. High-value or IBAN-changed payouts require human approval.",
		strict: false,
		parameters: {
			type: "object",
			properties: {
				requestId: { type: "string" },
				invoiceId: { type: "string" },
				vendorId: { type: "string" },
				amountCents: { type: "number" },
				targetIban: { type: "string" },
				expectedVersion: { type: "number" },
				citations: { type: "array", items: { type: "object" } },
			},
			required: ["requestId", "invoiceId", "vendorId", "amountCents", "targetIban", "citations"],
		},
		invoke: async (args: {
			requestId: string
			invoiceId: string
			vendorId: string
			amountCents: number
			targetIban: string
			expectedVersion?: number
			citations: Citation[]
		}) => {
			const state = rt.resolveRuntime().state
			const cell = state.getCell(args.invoiceId)
			if (!cell) return { ok: false, reason: "Unknown invoice" }

			const snap = cell.read()
			const approvedBy = args.amountCents > state.spendingLimitCents ? "HUMAN" : "AUTO_POLICY"
			const casVersion = approvedBy === "HUMAN" ? snap.version : (args.expectedVersion ?? snap.version)

			const casRes = cell.casWrite(casVersion, (cur) => ({
				...cur,
				status: "SEPA_DRAFT_READY",
				sepaDraft: {
					requestId: args.requestId,
					amountCents: args.amountCents,
					targetIban: args.targetIban,
					approvedBy,
				},
				notes: [...cur.notes, `SEPA draft ${args.requestId} ready (${approvedBy})`],
			}))

			if (!casRes.ok) {
				state.metrics.casConflictsPrevented += 1
				return { ok: false, reason: "cas.rejected", currentVersion: casRes.currentVersion }
			}

			const claim: ClaimRecord = {
				claimId: `CLM-${args.requestId}`,
				invoiceId: args.invoiceId,
				producer: "PayoutAndRefund",
				kind: "SEPA_DRAFT",
				amountCents: args.amountCents,
				summary: `SEPA payout draft ${args.requestId} ready for ${args.invoiceId} (${approvedBy})`,
				citations: args.citations,
				auditStatus: "PENDING",
				createdAt: new Date().toISOString(),
			}
			state.addClaim(claim)
			rt.sendEvent(SemanticEvent.create("claim.proposed", selfId, { claim }), selfId)

			return { ok: true, status: "SEPA_DRAFT_READY", approvedBy }
		},
	}

	const proposeRefundTool: Tool = {
		type: "function",
		name: "propose_refund",
		description: "Issue a Black Friday refund against an invoice and payment request.",
		strict: false,
		parameters: {
			type: "object",
			properties: {
				requestId: { type: "string" },
				invoiceId: { type: "string" },
				amountCents: { type: "number" },
				expectedVersion: { type: "number" },
				reason: { type: "string" },
				citations: { type: "array", items: { type: "object" } },
			},
			required: ["requestId", "invoiceId", "amountCents", "citations"],
		},
		invoke: async (args: {
			requestId: string
			invoiceId: string
			amountCents: number
			expectedVersion?: number
			reason?: string
			citations: Citation[]
		}) => {
			const state = rt.resolveRuntime().state
			const cell = state.getCell(args.invoiceId)
			if (!cell) return { ok: false, reason: "Unknown invoice" }
			const snap = cell.read()
			const casRes = cell.casWrite(args.expectedVersion ?? snap.version, (cur) => ({
				...cur,
				status: "REFUNDED",
				notes: [...cur.notes, `Refund ${args.requestId} executed`],
			}))
			if (!casRes.ok) {
				state.metrics.casConflictsPrevented += 1
				return { ok: false, reason: "cas.rejected" }
			}
			const claim: ClaimRecord = {
				claimId: `CLM-${args.requestId}`,
				invoiceId: args.invoiceId,
				producer: "PayoutAndRefund",
				kind: "REFUND",
				amountCents: args.amountCents,
				summary: args.reason ?? `Refund ${args.requestId}`,
				citations: args.citations,
				auditStatus: "PENDING",
				createdAt: new Date().toISOString(),
			}
			state.addClaim(claim)
			rt.sendEvent(SemanticEvent.create("claim.proposed", selfId, { claim }), selfId)
			return { ok: true, status: "REFUNDED" }
		},
	}

	const draftOverdueChaseTool: Tool = {
		type: "function",
		name: "draft_overdue_chase",
		description: "Prepare an overdue payment chase draft bound to the current invoice cell version.",
		strict: false,
		parameters: {
			type: "object",
			properties: {
				invoiceId: { type: "string" },
				amountCents: { type: "number" },
				basedOnVersion: { type: "number" },
				reason: { type: "string" },
				citations: { type: "array", items: { type: "object" } },
			},
			required: ["invoiceId", "amountCents", "basedOnVersion", "citations"],
		},
		invoke: async (args: {
			invoiceId: string
			amountCents: number
			basedOnVersion: number
			reason?: string
			citations: Citation[]
		}) => {
			const state = rt.resolveRuntime().state
			const cell = state.getCell(args.invoiceId)
			if (!cell) return { ok: false, reason: "Unknown invoice" }
			const snap = cell.read()
			const casRes = cell.casWrite(snap.version, (cur) => ({
				...cur,
				drafts: [
					...cur.drafts,
					{
						draftId: `CHASE-${args.invoiceId}-${cur.drafts.length + 1}`,
						kind: "overdue_chase",
						amountCents: args.amountCents,
						basedOnVersion: args.basedOnVersion,
						status: snap.value.status === "MATCHED" ? "STALE" : "ACTIVE",
						createdBy: "PayoutAndRefund",
						createdAt: new Date().toISOString(),
						citations: args.citations,
					},
				],
				notes: [...cur.notes, `Overdue chase draft prepared for $${(args.amountCents / 100).toFixed(2)}`],
			}))
			if (!casRes.ok) return { ok: false, reason: "cas.rejected" }
			const claim: ClaimRecord = {
				claimId: `CLM-CHASE-${args.invoiceId}`,
				invoiceId: args.invoiceId,
				producer: "PayoutAndRefund",
				kind: "CHASE_DRAFT",
				amountCents: args.amountCents,
				summary: args.reason ?? `Overdue chase draft for ${args.invoiceId}`,
				citations: args.citations,
				auditStatus: "PENDING",
				createdAt: new Date().toISOString(),
			}
			state.addClaim(claim)
			rt.sendEvent(SemanticEvent.create("claim.proposed", selfId, { claim }), selfId)
			return { ok: true, draftStatus: "ACTIVE", basedOnVersion: args.basedOnVersion }
		},
	}

	const processor: SituationProcessor = {
		apply(context: SituationContext): void {
			const agent = context.participant as Agent
			selfId = agent.getId()
			const state = rt.resolveRuntime().state

			let targetId = "unknown"
			let promptJson: Record<string, unknown> = {}

			if (context.event.type === "request.arrived") {
				const { request } = context.event.payload as { request: PaymentRequest }
				targetId = request.sourceId
				const cellSnap = state.getCell(request.invoiceId)?.read()
				promptJson = {
					request,
					invoice: state.sourceStore.getInvoice(request.invoiceId),
					vendor: state.sourceStore.getVendor(request.vendorId),
					expectedVersion: cellSnap?.version ?? 1,
					spendingLimitCents: state.spendingLimitCents,
				}
			} else if (context.event.type === "invoice.partial") {
				const p = context.event.payload as {
					invoiceId: string
					paidCents: number
					remainingCents: number
					expectedVersion: number
				}
				targetId = p.invoiceId
				promptJson = {
					...p,
					invoice: state.sourceStore.getInvoice(p.invoiceId),
				}
			} else if (context.event.type === "claim.staled") {
				const p = context.event.payload as { invoiceId: string; txId: string; staledCount: number }
				targetId = p.invoiceId
				promptJson = p
			}

			state.metrics.llmCalls += 1
			const spanId = state.beginLoop("PayoutAndRefund", context.event.type, targetId)

			const freshContext = ModelContext.create().addContextItem(
				DeveloperMessageItem.create(agent.getDeveloperMessage()),
			)
			const inferenceInput: InferenceInput = {
				model: modelName,
				context: freshContext,
				tools: agent.getTools(),
			}

			const prompt = [
				`[AGENT:PayoutAndRefund] [EVENT:${context.event.type}] [span:${spanId}]`,
				`Process ${context.event.type} for ${targetId}. Never invent numbers; cite exact sourceId values and expectedVersion.`,
				"```json",
				JSON.stringify(promptJson),
				"```",
			].join("\n")

			rt.runLoop(
				agent.getId(),
				prompt,
				inferenceInput,
				new ProofGateInterceptionHandler(agent.getId(), "PayoutAndRefund", inferenceInput, rt),
			)
		},
	}

	const handler: SituationHandler = {
		specification: new PayoutRefundSpec(),
		processor,
	}

	const agent = createAgent({
		name: "PayoutAndRefund",
		capabilities: ["sepa-payouts", "refunds", "chase-drafts"],
		instruction:
			"You are PayoutAndRefund, a controlled payment agent. Respect spending limits ($250 auto-approve), pass expectedVersion for CAS safety, never invent amounts, and include [src:ID] tags in your answer.",
		tools: [proposeSepaPayoutTool, proposeRefundTool, draftOverdueChaseTool],
		handlers: [handler],
	})
	selfId = agent.getId()
	return agent
}
