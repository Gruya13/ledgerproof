import {
	createHuman,
	SemanticEvent,
	SituationSpecification,
	type SituationContext,
	type SituationHandler,
	type SituationProcessor,
} from "@mozaik-ai/core"
import type { LedgerRuntimeApi } from "../runtime"
import { matchTransactionStrict } from "../engine/strict-matcher"
import type { BankTransaction, ClaimRecord } from "../types"

class StrictMatcherSpec extends SituationSpecification {
	isSatisfiedBy(context: SituationContext): boolean {
		return (
			context.event.type === "transaction.arrived" ||
			context.event.type === "settlement.late"
		)
	}
}

export function createStrictMatcherParticipant(rt: LedgerRuntimeApi) {
	const processor: SituationProcessor = {
		apply(context: SituationContext): void {
			const runtime = rt.resolveRuntime()
			const state = runtime.state
			const payload = context.event.payload as { transaction: BankTransaction }
			const tx = payload.transaction
			if (!tx) return

			state.markTransactionArrived(tx.sourceId)
			const matcherId = context.participant.getId()

			// Late settlement path (e.g. TX-2017 completing partial INV-1007 and staling overdue chase draft)
			if (context.event.type === "settlement.late") {
				const invoices = state.getArrivedInvoices()
				const targetInv = invoices.find((inv) => inv.sourceId === tx.reference)
				if (!targetInv) return

				const cell = state.getCell(targetInv.sourceId)
				if (!cell) return

				const snap = cell.read()
				const newPaid = snap.value.paidAmountCents + tx.amountCents
				const isSettled = newPaid === targetInv.amountCents && tx.currency === targetInv.currency
				const nextStatus = isSettled ? "MATCHED" : "PARTIAL"

				const casRes = cell.casWrite(snap.version, (cur) => ({
					...cur,
					paidAmountCents: cur.paidAmountCents + tx.amountCents,
					matchedTxIds: cur.matchedTxIds.includes(tx.sourceId)
						? cur.matchedTxIds
						: [...cur.matchedTxIds, tx.sourceId],
					status: nextStatus,
					notes: [...cur.notes, `Late settlement ${tx.sourceId} (${tx.amountCents} cents) applied`],
				}))

				if (casRes.ok) {
					state.metrics.deterministicMatches += 1
					const staled = state.invalidateStaleDrafts(
						targetInv.sourceId,
						casRes.version,
						`Late settlement ${tx.sourceId} ($${(tx.amountCents / 100).toFixed(2)}) closed balance`,
					)

					const claim: ClaimRecord = {
						claimId: `CLM-${targetInv.sourceId}-${tx.sourceId}`,
						invoiceId: targetInv.sourceId,
						txId: tx.sourceId,
						producer: "StrictMatcher",
						kind: "EXACT_MATCH",
						amountCents: tx.amountCents,
						summary: `Late settlement ${tx.sourceId} settled ${targetInv.sourceId}`,
						citations: [
							{ sourceId: targetInv.sourceId, field: "amountCents", expectedValue: targetInv.amountCents },
							{ sourceId: tx.sourceId, field: "amountCents", expectedValue: tx.amountCents },
						],
						auditStatus: "CONFIRMED",
						createdAt: new Date().toISOString(),
					}
					state.addClaim(claim)

					if (staled > 0) {
						rt.sendEvent(
							SemanticEvent.create("claim.staled", matcherId, {
								invoiceId: targetInv.sourceId,
								txId: tx.sourceId,
								staledCount: staled,
							}),
							matcherId,
						)
					}
				}
				return
			}

			// Normal transaction arrival
			if (tx.kind === "fraud_alert" || tx.kind === "payout_settlement") {
				return
			}

			const match = matchTransactionStrict(tx, state.getArrivedInvoices())
			if (match.kind === "NON_INVOICE_FEE") {
				state.nonInvoiceFeeTxIds.add(tx.sourceId)
				state.logAudit("fee.classified", "StrictMatcher", tx.sourceId, {
					reference: tx.reference,
					amountCents: tx.amountCents,
				})
				return
			}

			if (match.matched && match.kind === "EXACT" && match.invoiceId) {
				const cell = state.getCell(match.invoiceId)
				const inv = state.sourceStore.getInvoice(match.invoiceId)
				if (!cell || !inv) return

				const snap = cell.read()
				const casRes = cell.casWrite(snap.version, (cur) => ({
					...cur,
					paidAmountCents: cur.paidAmountCents + tx.amountCents,
					matchedTxIds: cur.matchedTxIds.includes(tx.sourceId)
						? cur.matchedTxIds
						: [...cur.matchedTxIds, tx.sourceId],
					status: cur.riskFlags.length > 0 ? cur.status : "MATCHED",
					notes: [...cur.notes, match.reason],
				}))

				if (casRes.ok) {
					state.metrics.deterministicMatches += 1
					const claim: ClaimRecord = {
						claimId: `CLM-${inv.sourceId}-${tx.sourceId}`,
						invoiceId: inv.sourceId,
						txId: tx.sourceId,
						producer: "StrictMatcher",
						kind: "EXACT_MATCH",
						amountCents: tx.amountCents,
						summary: match.reason,
						citations: [
							{ sourceId: inv.sourceId, field: "amountCents", expectedValue: inv.amountCents },
							{ sourceId: tx.sourceId, field: "amountCents", expectedValue: tx.amountCents },
						],
						auditStatus: "CONFIRMED",
						createdAt: new Date().toISOString(),
					}
					state.addClaim(claim)
					rt.sendEvent(SemanticEvent.create("claim.proposed", matcherId, { claim }), matcherId)
				}
				return
			}

			// Unresolved by strict rules -> emit match.ambiguous for concurrent LLM Reconciler
			rt.sendEvent(
				SemanticEvent.create("match.ambiguous", matcherId, {
					transaction: tx,
					reason: match.reason,
				}),
				matcherId,
			)
		},
	}

	const handler: SituationHandler = {
		specification: new StrictMatcherSpec(),
		processor,
	}

	return createHuman({
		name: "StrictMatcher",
		capabilities: ["deterministic-reconciliation"],
		handlers: [handler],
	})
}
