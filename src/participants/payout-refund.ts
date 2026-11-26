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
import { formatMoney } from "../engine/currency"
import { generateSepaPain001Draft } from "../engine/sepa-xml"
import { normalizeIban, ProofGateInterceptionHandler } from "../interception/proof-gate"
import { CITATION_ARRAY_SCHEMA } from "./schemas"
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
				citations: CITATION_ARRAY_SCHEMA,
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

			const inv = state.sourceStore.getInvoice(args.invoiceId)
			const req = state.sourceStore.getRequest(args.requestId)
			const vendor = state.sourceStore.getVendor(args.vendorId)
			if (!inv || !req || !vendor) {
				return { ok: false, reason: "Missing invoice, request, or vendor source record for SEPA XML generation" }
			}

			const snap = cell.read()
			const approvedBy = args.amountCents > state.spendingLimitCents ? "HUMAN" : "AUTO_POLICY"
			const casVersion = approvedBy === "HUMAN" ? snap.version : (args.expectedVersion ?? snap.version)
			const normalizedIban = normalizeIban(args.targetIban)
			const artifact = generateSepaPain001Draft({
				invoice: inv,
				vendor,
				request: { ...req, targetIban: normalizedIban },
				approvedBy,
				cellVersion: casVersion + 1,
			})

			const casRes = cell.casWrite(casVersion, (cur) => ({
				...cur,
				status: "SEPA_DRAFT_READY",
				sepaDraft: {
					requestId: args.requestId,
					amountCents: args.amountCents,
					currency: inv.currency,
					targetIban: normalizedIban,
					approvedBy,
					pain001MessageId: artifact.messageId,
					xmlSha256: artifact.sha256,
				},
				notes: [
					...cur.notes,
					`SEPA pain.001 draft ${args.requestId} (${formatMoney(args.amountCents, inv.currency)}, ${approvedBy}, msgId=${artifact.messageId})`,
				],
			}))

			if (!casRes.ok) {
				state.metrics.casConflictsPrevented += 1
				return { ok: false, reason: "cas.rejected", currentVersion: casRes.currentVersion }
			}

			state.setSepaDraftXml(artifact)
			state.logAudit("sepa.pain001_generated", "PayoutAndRefund", args.invoiceId, {
				requestId: args.requestId,
				messageId: artifact.messageId,
				xmlSha256: artifact.sha256,
				currency: inv.currency,
				amountCents: args.amountCents,
			})

			const claim: ClaimRecord = {
				claimId: `CLM-${args.requestId}`,
				invoiceId: args.invoiceId,
				producer: "PayoutAndRefund",
				kind: "SEPA_DRAFT",
				amountCents: args.amountCents,
				currency: inv.currency,
				summary: `SEPA pain.001 draft ${args.requestId} ready for ${args.invoiceId} (${formatMoney(args.amountCents, inv.currency)}, ${approvedBy})`,
				citations: args.citations,
				auditStatus: "PENDING",
				createdAt: new Date().toISOString(),
			}
			state.addClaim(claim)
			rt.sendEvent(SemanticEvent.create("claim.proposed", selfId, { claim }), selfId)

			return {
				ok: true,
				status: "SEPA_DRAFT_READY",
				approvedBy,
				pain001MessageId: artifact.messageId,
				xmlSha256: artifact.sha256,
			}
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
				citations: CITATION_ARRAY_SCHEMA,
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
			const isHumanApproved =
				args.amountCents > state.spendingLimitCents &&
				!snap.value.riskFlags.includes("FRAUD_VELOCITY") &&
				!snap.value.riskFlags.includes("DUPLICATE_INVOICE")
			const casVersion = isHumanApproved ? snap.version : (args.expectedVersion ?? snap.version)
			const casRes = cell.casWrite(casVersion, (cur) => ({
				...cur,
				status: "REFUNDED",
				notes: [...cur.notes, `Refund ${args.requestId} executed`],
			}))
			if (!casRes.ok) {
				state.metrics.casConflictsPrevented += 1
				return { ok: false, reason: "cas.rejected" }
			}
			const invCurrency = state.sourceStore.getInvoice(args.invoiceId)?.currency ?? snap.value.currency
			const claim: ClaimRecord = {
				claimId: `CLM-${args.requestId}`,
				invoiceId: args.invoiceId,
				producer: "PayoutAndRefund",
				kind: "REFUND",
				amountCents: args.amountCents,
				currency: invCurrency,
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
				citations: CITATION_ARRAY_SCHEMA,
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
			const invCurrency = state.sourceStore.getInvoice(args.invoiceId)?.currency ?? snap.value.currency
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
				notes: [...cur.notes, `Overdue chase draft prepared for ${formatMoney(args.amountCents, invCurrency)}`],
			}))
			if (!casRes.ok) return { ok: false, reason: "cas.rejected" }
			const claim: ClaimRecord = {
				claimId: `CLM-CHASE-${args.invoiceId}`,
				invoiceId: args.invoiceId,
				producer: "PayoutAndRefund",
				kind: "CHASE_DRAFT",
				amountCents: args.amountCents,
				currency: invCurrency,
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
					partialTxId?: string
					paidCents: number
					remainingCents: number
					expectedVersion: number
				}
				targetId = p.invoiceId
				promptJson = {
					...p,
					invoice: state.sourceStore.getInvoice(p.invoiceId),
					partialTransaction: p.partialTxId ? state.sourceStore.getTransaction(p.partialTxId) : undefined,
				}
			} else if (context.event.type === "claim.staled") {
				const p = context.event.payload as { invoiceId: string; txId: string; staledCount: number }
				targetId = p.invoiceId
				promptJson = p
			}

			if (!state.canStartLlmLoop()) {
				state.logAudit("budget.paused", "PayoutAndRefund", targetId, { llmCalls: state.metrics.llmCalls })
				return
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
		instruction: [
			"You are PayoutAndRefund, a controlled payment agent.",
			"Rules:",
			"1. All JSON amounts are integer cents (e.g. 23900 EUR = €239.00, 64725 USD = $647.25). NEVER write raw amountCents directly before USD or EUR (never '64725 USD' or '23900 EUR'); write '$647.25 (64725 cents)' or '€239.00 (23900 cents)'. SEPA payouts are EUR-only.",
			"2. On request.arrived with kind='sepa_payout', call propose_sepa_payout with exact amountCents, targetIban, expectedVersion, and citations for the request and invoice.",
			"3. On request.arrived with kind='refund', call propose_refund with exact amountCents, expectedVersion, and citations for the request and invoice.",
			"4. On invoice.partial, call draft_overdue_chase using remainingCents as amountCents, expectedVersion as basedOnVersion, and cite the invoice amountCents.",
			"5. On claim.staled, do NOT call any tool — simply confirm chase draft cancellation citing [src:<invoiceId>].",
			"6. Never invent amounts. In your final text reply, include [src:ID] tags for every invoice/request/amount mentioned.",
		].join("\n"),
		tools: [proposeSepaPayoutTool, proposeRefundTool, draftOverdueChaseTool],
		handlers: [handler],
	})
	selfId = agent.getId()
	return agent
}
