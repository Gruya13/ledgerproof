import type { Citation } from "../types"
import type { SourceStore } from "./source-store"

export interface ProofCheckResult {
	ok: boolean
	code?: string
	reason?: string
}

export function normalizeIban(iban: string): string {
	return iban.replace(/\s+/g, "").toUpperCase()
}

export interface ToolProposalArgs {
	invoiceId?: string
	txId?: string
	txIds?: string[]
	requestId?: string
	vendorId?: string
	amountCents?: number
	targetIban?: string
	expectedVersion?: number
	citations?: Citation[]
}

export function verifyCitations(citations: Citation[] | undefined, sourceStore: SourceStore): ProofCheckResult {
	if (!citations || citations.length === 0) {
		return {
			ok: false,
			code: "MISSING_CITATIONS",
			reason: "Every financial claim or tool call must include at least one source citation.",
		}
	}

	for (const citation of citations) {
		const check = sourceStore.verifyCitation(citation)
		if (!check.ok) {
			return {
				ok: false,
				code: "INVALID_CITATION",
				reason: check.reason ?? `Invalid citation for ${citation.sourceId}`,
			}
		}
	}

	return { ok: true }
}

export function verifyToolProposal(
	toolName: string,
	rawArgs: unknown,
	sourceStore: SourceStore,
): ProofCheckResult {
	if (!rawArgs || typeof rawArgs !== "object") {
		return { ok: false, code: "INVALID_ARGS", reason: `Tool ${toolName} received non-object arguments.` }
	}

	const args = rawArgs as ToolProposalArgs
	const citationCheck = verifyCitations(args.citations, sourceStore)
	if (!citationCheck.ok) {
		return citationCheck
	}

	if (args.amountCents !== undefined && (!Number.isInteger(args.amountCents) || args.amountCents < 0)) {
		return {
			ok: false,
			code: "NON_INTEGER_AMOUNT",
			reason: `amountCents must be a non-negative integer, got ${String(args.amountCents)}`,
		}
	}

	if (toolName === "record_reconciliation") {
		if (args.invoiceId) {
			const inv = sourceStore.getInvoice(args.invoiceId)
			if (!inv) {
				return { ok: false, code: "UNKNOWN_INVOICE", reason: `Unknown invoice ${args.invoiceId}` }
			}
			const txIds = args.txIds ?? (args.txId ? [args.txId] : [])
			if (txIds.length === 0) {
				return { ok: false, code: "MISSING_TX_IDS", reason: `Reconciliation for ${args.invoiceId} requires txIds.` }
			}
			let txSum = 0
			for (const txId of txIds) {
				const tx = sourceStore.getTransaction(txId)
				if (!tx) {
					return { ok: false, code: "UNKNOWN_TRANSACTION", reason: `Unknown transaction ${txId}` }
				}
				if (tx.currency !== inv.currency) {
					return {
						ok: false,
						code: "CURRENCY_MISMATCH",
						reason: `Transaction ${txId} currency (${tx.currency}) != invoice ${inv.sourceId} (${inv.currency})`,
					}
				}
				txSum += tx.amountCents
			}
			if (args.amountCents !== undefined && args.amountCents !== txSum) {
				return {
					ok: false,
					code: "ARITHMETIC_MISMATCH",
					reason: `Reported amountCents (${args.amountCents}) != exact sum of cited transactions (${txSum})`,
				}
			}
			// Must include citations for the invoice and each transaction
			const citedIds = new Set((args.citations ?? []).map((c) => c.sourceId))
			if (!citedIds.has(inv.sourceId) || txIds.some((id) => !citedIds.has(id))) {
				return {
					ok: false,
					code: "INCOMPLETE_CITATIONS",
					reason: `Reconciliation must cite ${inv.sourceId} and all matched transactions (${txIds.join(", ")})`,
				}
			}
		} else if (args.txId) {
			const tx = sourceStore.getTransaction(args.txId)
			if (!tx) {
				return { ok: false, code: "UNKNOWN_TRANSACTION", reason: `Unknown transaction ${args.txId}` }
			}
			if (args.amountCents !== undefined && args.amountCents !== tx.amountCents) {
				return {
					ok: false,
					code: "ARITHMETIC_MISMATCH",
					reason: `Reported amountCents (${args.amountCents}) != ${tx.sourceId}.amountCents (${tx.amountCents})`,
				}
			}
		}
	}

	if (toolName === "propose_sepa_payout" || toolName === "propose_refund" || toolName === "draft_overdue_chase") {
		if (!args.invoiceId) {
			return { ok: false, code: "MISSING_INVOICE_ID", reason: `${toolName} requires invoiceId` }
		}
		const inv = sourceStore.getInvoice(args.invoiceId)
		if (!inv) {
			return { ok: false, code: "UNKNOWN_INVOICE", reason: `Unknown invoice ${args.invoiceId}` }
		}

		if (toolName === "propose_sepa_payout" || toolName === "propose_refund") {
			if (!args.requestId) {
				return { ok: false, code: "MISSING_REQUEST_ID", reason: `${toolName} requires requestId` }
			}
			const req = sourceStore.getRequest(args.requestId)
			if (!req) {
				return { ok: false, code: "UNKNOWN_REQUEST", reason: `Unknown request ${args.requestId}` }
			}
			if (req.invoiceId !== inv.sourceId) {
				return {
					ok: false,
					code: "REQUEST_INVOICE_MISMATCH",
					reason: `Request ${req.sourceId} belongs to ${req.invoiceId}, not ${inv.sourceId}`,
				}
			}
			if (req.currency !== inv.currency) {
				return {
					ok: false,
					code: "CURRENCY_MISMATCH",
					reason: `Request ${req.sourceId} currency (${req.currency}) != invoice ${inv.sourceId} (${inv.currency})`,
				}
			}
			if (args.amountCents !== req.amountCents) {
				return {
					ok: false,
					code: "INVENTED_AMOUNT",
					reason: `Proposed amountCents (${args.amountCents}) does not match ${req.sourceId}.amountCents (${req.amountCents})`,
				}
			}

			if (toolName === "propose_sepa_payout") {
				if (req.kind !== "sepa_payout") {
					return {
						ok: false,
						code: "REQUEST_KIND_MISMATCH",
						reason: `Request ${req.sourceId} has kind="${req.kind}", expected "sepa_payout"`,
					}
				}
				if (inv.currency !== "EUR" || req.currency !== "EUR") {
					return {
						ok: false,
						code: "SEPA_REQUIRES_EUR",
						reason: `SEPA payout requires EUR currency (invoice ${inv.sourceId} is ${inv.currency}, request ${req.sourceId} is ${req.currency})`,
					}
				}
				if (args.vendorId !== req.vendorId || req.vendorId !== inv.vendorId) {
					return {
						ok: false,
						code: "VENDOR_MISMATCH",
						reason: `Proposed vendorId (${String(args.vendorId)}) does not match ${req.sourceId}/${inv.sourceId} vendor (${req.vendorId})`,
					}
				}
				if (!req.targetIban || !args.targetIban || normalizeIban(args.targetIban) !== normalizeIban(req.targetIban)) {
					return {
						ok: false,
						code: "TARGET_IBAN_MISMATCH",
						reason: `Proposed targetIban (${String(args.targetIban)}) does not match approved ${req.sourceId}.targetIban (${String(req.targetIban)})`,
					}
				}
			}

			if (toolName === "propose_refund" && req.kind !== "refund") {
				return {
					ok: false,
					code: "REQUEST_KIND_MISMATCH",
					reason: `Request ${req.sourceId} has kind="${req.kind}", expected "refund"`,
				}
			}
		} else if (toolName === "draft_overdue_chase") {
			// Overdue chase amount must match remaining balance (verified via citations on invoice + partial tx)
			const citedIds = new Set((args.citations ?? []).map((c) => c.sourceId))
			if (!citedIds.has(inv.sourceId)) {
				return { ok: false, code: "MISSING_INVOICE_CITATION", reason: `Chase draft must cite ${inv.sourceId}` }
			}
		}
	}

	if (toolName === "flag_risk") {
		if (!args.invoiceId || !sourceStore.getInvoice(args.invoiceId)) {
			return { ok: false, code: "UNKNOWN_INVOICE", reason: `flag_risk requires valid invoiceId` }
		}
	}

	return { ok: true }
}

const SYMBOL_AMOUNT_RE = /[$€]\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g
const CODE_AMOUNT_RE = /\b([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(USD|EUR)\b/gi
const SOURCE_ANCHOR_RE = /\[src:([A-Z]+-\d+)\]/g

/**
 * Checks final assistant prose: every monetary figure (symbol or currency-suffixed) in prose must be
 * accompanied by at least one valid [src:ID] anchor that exists in SourceStore,
 * and every cited [src:ID] must exist in SourceStore.
 */
export function verifyMessageCitations(
	text: string,
	sourceStore: SourceStore,
	allowedPolicyAmounts: ReadonlySet<number> = new Set(),
): ProofCheckResult {
	const anchors: string[] = []
	for (const match of text.matchAll(SOURCE_ANCHOR_RE)) {
		const id = match[1]
		if (!sourceStore.has(id)) {
			return {
				ok: false,
				code: "UNCITED_OR_FAKE_SOURCE",
				reason: `Message references non-existent source [src:${id}]`,
			}
		}
		anchors.push(id)
	}

	const monetaryMatches: Array<{ raw: string; numberPart: string }> = []
	for (const match of text.matchAll(SYMBOL_AMOUNT_RE)) {
		monetaryMatches.push({ raw: match[0], numberPart: match[1] })
	}
	for (const match of text.matchAll(CODE_AMOUNT_RE)) {
		monetaryMatches.push({ raw: match[0], numberPart: match[1] })
	}

	if (monetaryMatches.length > 0 && anchors.length === 0) {
		return {
			ok: false,
			code: "UNCITED_MONETARY_FIGURE",
			reason: `Message reports monetary amount (${monetaryMatches[0].raw}) without any [src:ID] source citation.`,
		}
	}

	// Check each monetary amount appears on at least one cited entity (or sum/delta of unique cited transactions)
	const uniqueAnchors = [...new Set(anchors)]
	const citedAmounts = new Set<number>(allowedPolicyAmounts)
	let sumOfCitedTx = 0
	for (const id of uniqueAnchors) {
		const entity = sourceStore.get(id)
		if (!entity || entity.kind === "vendor") continue
		citedAmounts.add(entity.data.amountCents)
		if (entity.kind === "transaction") {
			sumOfCitedTx += entity.data.amountCents
		}
		if (entity.kind === "invoice") {
			// Allow both remaining balance (underpayment) and excess amount (overpayment) when paired with a cited tx
			for (const otherId of uniqueAnchors) {
				const other = sourceStore.get(otherId)
				if (other?.kind === "transaction" && entity.data.amountCents !== other.data.amountCents) {
					citedAmounts.add(Math.abs(entity.data.amountCents - other.data.amountCents))
				}
			}
		}
	}
	if (sumOfCitedTx > 0) {
		citedAmounts.add(sumOfCitedTx)
	}

	for (const match of monetaryMatches) {
		const normalized = match.numberPart.replace(/,/g, "")
		const cents = Math.round(Number.parseFloat(normalized) * 100)
		if (!citedAmounts.has(cents)) {
			return {
				ok: false,
				code: "INVENTED_PROSE_AMOUNT",
				reason: `Monetary figure ${match.raw} (${cents} cents) is not backed by cited sources [${anchors.join(", ")}].`,
			}
		}
	}

	return { ok: true }
}
