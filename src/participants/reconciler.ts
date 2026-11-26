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
import { CITATION_ARRAY_SCHEMA } from "./schemas"
import type { BankTransaction, Citation, ClaimRecord } from "../types"

class AmbiguousMatchSpec extends SituationSpecification {
	isSatisfiedBy(context: SituationContext): boolean {
		return context.event.type === "match.ambiguous"
	}
}

export function createReconcilerAgent(rt: LedgerRuntimeApi, modelName: string): Agent {
	let selfId = ""

	const recordReconciliationTool: Tool = {
		type: "function",
		name: "record_reconciliation",
		description:
			"Record a split match, partial match, or orphan unmatched transaction with verified source citations.",
		strict: false,
		parameters: {
			type: "object",
			properties: {
				invoiceId: { type: "string" },
				txId: { type: "string" },
				txIds: { type: "array", items: { type: "string" } },
				amountCents: { type: "number" },
				matchKind: { type: "string", enum: ["SPLIT_MATCH", "PARTIAL_MATCH", "ORPHAN_TX"] },
				explanation: { type: "string" },
				citations: CITATION_ARRAY_SCHEMA,
			},
			required: ["amountCents", "matchKind", "explanation", "citations"],
		},
		invoke: async (args: {
			invoiceId?: string
			txId?: string
			txIds?: string[]
			amountCents: number
			matchKind: "SPLIT_MATCH" | "PARTIAL_MATCH" | "ORPHAN_TX"
			explanation: string
			citations: Citation[]
		}) => {
			const state = rt.resolveRuntime().state

			if (args.matchKind === "ORPHAN_TX" && args.txId) {
				state.unmatchedTxIds.add(args.txId)
				const claim: ClaimRecord = {
					claimId: `CLM-ORPHAN-${args.txId}`,
					txId: args.txId,
					producer: "Reconciler",
					kind: "ORPHAN_TX",
					amountCents: args.amountCents,
					summary: args.explanation,
					citations: args.citations,
					auditStatus: "PENDING",
					createdAt: new Date().toISOString(),
				}
				state.addClaim(claim)
				rt.sendEvent(SemanticEvent.create("claim.proposed", selfId, { claim }), selfId)
				return { ok: true, status: "UNMATCHED", txId: args.txId }
			}

			if (!args.invoiceId) {
				return { ok: false, reason: "invoiceId required for split/partial reconciliation" }
			}

			const cell = state.getCell(args.invoiceId)
			const inv = state.sourceStore.getInvoice(args.invoiceId)
			if (!cell || !inv) {
				return { ok: false, reason: `Invoice ${args.invoiceId} not found` }
			}

			const txIds = args.txIds ?? (args.txId ? [args.txId] : [])
			const snap = cell.read()
			if (txIds.every((id) => snap.value.matchedTxIds.includes(id))) {
				return {
					ok: true,
					idempotent: true,
					invoiceId: args.invoiceId,
					status: snap.value.status,
					paidAmountCents: snap.value.paidAmountCents,
				}
			}

			const totalPaid = snap.value.paidAmountCents + args.amountCents
			const status = totalPaid >= inv.amountCents ? "MATCHED" : "PARTIAL"

			const casRes = cell.casWrite(snap.version, (cur) => {
				const mergedTxIds = [...new Set([...cur.matchedTxIds, ...txIds])]
				const recomputedPaid = mergedTxIds.reduce(
					(acc, id) => acc + (state.sourceStore.getTransaction(id)?.amountCents ?? 0),
					0,
				)
				const nextStatus = recomputedPaid >= inv.amountCents ? "MATCHED" : "PARTIAL"
				return {
					...cur,
					paidAmountCents: recomputedPaid,
					matchedTxIds: mergedTxIds,
					status: cur.riskFlags.length > 0 ? cur.status : nextStatus,
					notes: [...cur.notes, args.explanation],
				}
			})

			if (!casRes.ok) {
				return { ok: false, reason: "cas.rejected", currentVersion: casRes.currentVersion }
			}

			const claim: ClaimRecord = {
				claimId: `CLM-${args.invoiceId}-${txIds.join("+")}`,
				invoiceId: args.invoiceId,
				producer: "Reconciler",
				kind: args.matchKind,
				amountCents: casRes.value.paidAmountCents,
				summary: args.explanation,
				citations: args.citations,
				auditStatus: "PENDING",
				createdAt: new Date().toISOString(),
			}
			state.addClaim(claim)
			rt.sendEvent(SemanticEvent.create("claim.proposed", selfId, { claim }), selfId)

			if (status === "PARTIAL") {
				rt.sendEvent(
					SemanticEvent.create("invoice.partial", selfId, {
						invoiceId: args.invoiceId,
						partialTxId: txIds[0],
						paidCents: casRes.value.paidAmountCents,
						remainingCents: inv.amountCents - casRes.value.paidAmountCents,
						expectedVersion: casRes.version,
					}),
					selfId,
				)
			}

			return {
				ok: true,
				invoiceId: args.invoiceId,
				status: casRes.value.status,
				paidAmountCents: casRes.value.paidAmountCents,
			}
		},
	}

	const processor: SituationProcessor = {
		apply(context: SituationContext): void {
			const agent = context.participant as Agent
			selfId = agent.getId()
			const state = rt.resolveRuntime().state
			const payload = context.event.payload as { transaction: BankTransaction; reason: string }
			const tx = payload.transaction

			if (!state.canStartLlmLoop()) {
				state.logAudit("budget.paused", "Reconciler", tx.sourceId, { llmCalls: state.metrics.llmCalls })
				return
			}

			state.metrics.llmCalls += 1
			const spanId = state.beginLoop("Reconciler", context.event.type, tx.sourceId)

			const freshContext = ModelContext.create().addContextItem(
				DeveloperMessageItem.create(agent.getDeveloperMessage()),
			)
			const inferenceInput: InferenceInput = {
				model: modelName,
				context: freshContext,
				tools: agent.getTools(),
			}

			const prompt = [
				`[AGENT:Reconciler] [EVENT:match.ambiguous:${tx.sourceId}] [span:${spanId}]`,
				`Investigate unmatched transaction ${tx.sourceId} (${tx.amountCents} ${tx.currency}, memo: "${tx.memo}").`,
				`Use record_reconciliation ONLY if you can prove a split match, partial match, or orphan unmatched transaction with exact citations.`,
				"```json",
				JSON.stringify({
					transaction: tx,
					arrivedInvoices: state.getArrivedInvoices(),
					arrivedTransactions: state.getArrivedTransactions(),
				}),
				"```",
			].join("\n")

			rt.runLoop(
				agent.getId(),
				prompt,
				inferenceInput,
				new ProofGateInterceptionHandler(agent.getId(), "Reconciler", inferenceInput, rt),
			)
		},
	}

	const handler: SituationHandler = {
		specification: new AmbiguousMatchSpec(),
		processor,
	}

	const agent = createAgent({
		name: "Reconciler",
		capabilities: ["semantic-reconciliation", "split-matching"],
		instruction: [
			"You are Reconciler, a concurrent financial reconciliation agent.",
			"Rules:",
			"1. All monetary amounts are integer amountCents (e.g. 120000 for $1,200.00). Never invent numbers or IDs.",
			"2. Only match transactions to an invoice if the exact sum of transaction amountCents equals the invoice amount (SPLIT_MATCH, even with memo typos like INV10O6 -> INV-1006) OR clearly references an invoice as a partial tranche (PARTIAL_MATCH).",
			"3. If a single split transaction arrives before its counterpart, wait without calling record_reconciliation.",
			"4. If an unreferenced wire has no matching invoice or vendor in arrivedInvoices, classify it with matchKind='ORPHAN_TX' and txId.",
			"5. Every tool call MUST include exact citations [{ sourceId, field: 'amountCents', expectedValue }] for the invoice (if matched) and every transaction.",
			"6. In your final text reply, include [src:ID] tags for every invoice/transaction and dollar figure mentioned.",
		].join("\n"),
		tools: [recordReconciliationTool],
		handlers: [handler],
	})
	selfId = agent.getId()
	return agent
}
