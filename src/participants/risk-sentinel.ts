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
import { normalizeIban, ProofGateInterceptionHandler } from "../interception/proof-gate"
import { CITATION_ARRAY_SCHEMA } from "./schemas"
import type { BankTransaction, Citation, ClaimRecord, Invoice, PaymentRequest, RiskFlag } from "../types"

class RiskTriggerSpec extends SituationSpecification {
	isSatisfiedBy(context: SituationContext): boolean {
		const t = context.event.type
		return t === "invoice.arrived" || t === "transaction.arrived" || t === "request.arrived"
	}
}

export function createRiskSentinelAgent(rt: LedgerRuntimeApi, modelName: string): Agent {
	let selfId = ""

	const flagRiskTool: Tool = {
		type: "function",
		name: "flag_risk",
		description: "Lock an invoice with a verified risk flag (duplicate invoice, BEC IBAN change, or fraud velocity).",
		strict: false,
		parameters: {
			type: "object",
			properties: {
				invoiceId: { type: "string" },
				riskFlag: {
					type: "string",
					enum: [
						"DUPLICATE_INVOICE",
						"BEC_IBAN_CHANGE",
						"FRAUD_VELOCITY",
						"CURRENCY_MISMATCH",
						"OVERPAYMENT_ANOMALY",
					],
				},
				severity: { type: "string", enum: ["HIGH", "CRITICAL"] },
				reason: { type: "string" },
				citations: CITATION_ARRAY_SCHEMA,
			},
			required: ["invoiceId", "riskFlag", "severity", "reason", "citations"],
		},
		invoke: async (args: {
			invoiceId: string
			riskFlag: RiskFlag
			severity: string
			reason: string
			citations: Citation[]
		}) => {
			const state = rt.resolveRuntime().state
			const cell = state.getCell(args.invoiceId)
			if (!cell) return { ok: false, reason: `Unknown invoice ${args.invoiceId}` }

			const snap = cell.read()
			const nextStatus = args.riskFlag === "DUPLICATE_INVOICE" ? "DUPLICATE" : "HOLD_RISK"
			const casRes = cell.casWrite(snap.version, (cur) => ({
				...cur,
				status: nextStatus,
				riskFlags: cur.riskFlags.includes(args.riskFlag) ? cur.riskFlags : [...cur.riskFlags, args.riskFlag],
				notes: [...cur.notes, `${args.riskFlag}: ${args.reason}`],
			}))

			if (!casRes.ok) {
				// Retry once against updated cell version so risk hold still lands safely
				const retrySnap = cell.read()
				cell.casWrite(retrySnap.version, (cur) => ({
					...cur,
					status: nextStatus,
					riskFlags: cur.riskFlags.includes(args.riskFlag) ? cur.riskFlags : [...cur.riskFlags, args.riskFlag],
					notes: [...cur.notes, `${args.riskFlag}: ${args.reason}`],
				}))
			}

			const invRecord = state.sourceStore.getInvoice(args.invoiceId)
			const claim: ClaimRecord = {
				claimId: `CLM-RISK-${args.invoiceId}-${args.riskFlag}`,
				invoiceId: args.invoiceId,
				producer: "RiskSentinel",
				kind: "RISK_FLAG",
				amountCents: invRecord?.amountCents ?? 0,
				currency: invRecord?.currency,
				summary: args.reason,
				citations: args.citations,
				auditStatus: "PENDING",
				createdAt: new Date().toISOString(),
			}
			state.addClaim(claim)
			rt.sendEvent(SemanticEvent.create("claim.proposed", selfId, { claim }), selfId)

			return { ok: true, invoiceId: args.invoiceId, status: nextStatus, riskFlag: args.riskFlag }
		},
	}

	const processor: SituationProcessor = {
		apply(context: SituationContext): void {
			const agent = context.participant as Agent
			selfId = agent.getId()
			const state = rt.resolveRuntime().state

			let shouldInvokeLlm = false
			let targetId = ""
			let eventLabel = context.event.type
			let payloadForPrompt: Record<string, unknown> = {}

			// Deterministic pre-screening avoids wasting LLM calls on clean normal traffic!
			if (context.event.type === "invoice.arrived") {
				const { invoice } = context.event.payload as { invoice: Invoice }
				state.markInvoiceArrived(invoice.sourceId)
				const duplicateOf = state
					.getArrivedInvoices()
					.find(
						(other) =>
							other.sourceId !== invoice.sourceId &&
							other.vendorId === invoice.vendorId &&
							other.poNumber === invoice.poNumber &&
							other.amountCents === invoice.amountCents,
					)
				if (duplicateOf) {
					shouldInvokeLlm = true
					targetId = invoice.sourceId
					eventLabel = `invoice.arrived:${invoice.sourceId}`
					payloadForPrompt = { invoice, duplicateOf }
				}
			} else if (context.event.type === "transaction.arrived") {
				const { transaction } = context.event.payload as { transaction: BankTransaction }
				if (transaction.kind === "fraud_alert") {
					shouldInvokeLlm = true
					targetId = transaction.sourceId
					eventLabel = `transaction.arrived:${transaction.sourceId}`
					payloadForPrompt = {
						transaction,
						invoice: state.sourceStore.getInvoice(transaction.reference),
					}
				} else if (transaction.kind === "bank_transfer" || transaction.kind === "card_capture") {
					const inv = state.sourceStore.getInvoice(transaction.reference.trim().toUpperCase())
					if (inv) {
						if (transaction.currency !== inv.currency) {
							shouldInvokeLlm = true
							targetId = transaction.sourceId
							eventLabel = `transaction.currency_mismatch:${transaction.sourceId}`
							payloadForPrompt = {
								currencyMismatch: { invoice: inv, transaction },
							}
						} else if (transaction.amountCents > inv.amountCents) {
							shouldInvokeLlm = true
							targetId = transaction.sourceId
							eventLabel = `transaction.overpayment:${transaction.sourceId}`
							payloadForPrompt = {
								overpayment: {
									invoice: inv,
									transaction,
									excessCents: transaction.amountCents - inv.amountCents,
								},
							}
						}
					}
				}
			} else if (context.event.type === "request.arrived") {
				const { request } = context.event.payload as { request: PaymentRequest }
				const vendor = state.sourceStore.getVendor(request.vendorId)
				if (
					request.targetIban &&
					vendor &&
					normalizeIban(request.targetIban) !== normalizeIban(vendor.masterIban)
				) {
					shouldInvokeLlm = true
					targetId = request.sourceId
					eventLabel = `request.arrived:${request.sourceId}`
					payloadForPrompt = {
						request,
						vendor,
						invoice: state.sourceStore.getInvoice(request.invoiceId),
					}
				}
			}

			if (!shouldInvokeLlm) return

			if (!state.canStartLlmLoop()) {
				state.logAudit("budget.paused", "RiskSentinel", targetId, { llmCalls: state.metrics.llmCalls })
				return
			}

			state.metrics.llmCalls += 1
			const spanId = state.beginLoop("RiskSentinel", context.event.type, targetId)
			const freshContext = ModelContext.create().addContextItem(
				DeveloperMessageItem.create(agent.getDeveloperMessage()),
			)
			const inferenceInput: InferenceInput = {
				model: modelName,
				context: freshContext,
				tools: agent.getTools(),
			}

			const prompt = [
				`[AGENT:RiskSentinel] [EVENT:${eventLabel}] [span:${spanId}]`,
				`Investigate suspicious financial signal ${targetId} and lock affected invoice with flag_risk + exact citations.`,
				"```json",
				JSON.stringify(payloadForPrompt),
				"```",
			].join("\n")

			rt.runLoop(
				agent.getId(),
				prompt,
				inferenceInput,
				new ProofGateInterceptionHandler(agent.getId(), "RiskSentinel", inferenceInput, rt),
			)
		},
	}

	const handler: SituationHandler = {
		specification: new RiskTriggerSpec(),
		processor,
	}

	const agent = createAgent({
		name: "RiskSentinel",
		capabilities: ["duplicate-detection", "bec-iban-guard", "fraud-velocity"],
		instruction: [
			"You are RiskSentinel, a concurrent financial risk agent.",
			"Rules:",
			"1. Duplicate invoice (same vendor, PO, amountCents): call flag_risk with riskFlag='DUPLICATE_INVOICE', severity='HIGH', citing poNumber and amountCents on both invoices.",
			"2. BEC IBAN mismatch (normalized request.targetIban != normalized vendor.masterIban): call flag_risk with riskFlag='BEC_IBAN_CHANGE', severity='CRITICAL', citing request.targetIban and vendor.masterIban.",
			"3. Fraud alert transaction (kind='fraud_alert'): call flag_risk with riskFlag='FRAUD_VELOCITY', severity='CRITICAL', citing transaction.amountCents and invoice.amountCents.",
			"4. Currency mismatch (payload.currencyMismatch): call flag_risk with riskFlag='CURRENCY_MISMATCH', severity='HIGH', citing invoice.currency, transaction.currency, and invoice.amountCents.",
			"5. Overpayment anomaly (payload.overpayment): call flag_risk with riskFlag='OVERPAYMENT_ANOMALY', severity='HIGH', citing invoice.amountCents and transaction.amountCents.",
			"6. All JSON amounts are integer cents — NEVER label raw amountCents as USD/EUR (write '$647.25 (64725 cents)' or '€195.00 (19500 cents)'). In your final text reply, include [src:ID] tags for every invoice/transaction/request/vendor and monetary amount mentioned.",
		].join("\n"),
		tools: [flagRiskTool],
		handlers: [handler],
	})
	selfId = agent.getId()
	return agent
}
