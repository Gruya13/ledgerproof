import type { BankTransaction, Invoice } from "../types"

export interface StrictMatchResult {
	matched: boolean
	kind: "EXACT" | "PARTIAL_EXACT_REF" | "NON_INVOICE_FEE" | "NONE"
	invoiceId?: string
	reason: string
}

const INVOICE_TOKEN_RE = /\bINV-\d+\b/gi

/**
 * Normalizes an invoice or transaction reference token strictly.
 * Avoids loose substring matching (e.g. invoice "1" matching "TX-1001").
 */
export function extractExactInvoiceTokens(text: string): string[] {
	const matches = text.match(INVOICE_TOKEN_RE)
	if (!matches) return []
	return [...new Set(matches.map((m) => m.toUpperCase()))]
}

export function matchTransactionStrict(tx: BankTransaction, invoices: Invoice[]): StrictMatchResult {
	if (tx.kind === "gateway_fee") {
		return {
			matched: false,
			kind: "NON_INVOICE_FEE",
			reason: `Operational gateway fee ${tx.sourceId} (${tx.reference}) does not map to a vendor invoice`,
		}
	}

	if (tx.kind === "fraud_alert" || tx.kind === "payout_settlement") {
		return {
			matched: false,
			kind: "NONE",
			reason: `Transaction ${tx.sourceId} (${tx.kind}) is routed to risk/settlement tracking rather than direct invoice match`,
		}
	}

	const refUpper = tx.reference.trim().toUpperCase()
	const refTokens = extractExactInvoiceTokens(`${tx.reference} ${tx.memo}`)

	// Exact reference equality takes priority; otherwise single unambiguous INV-XXXX token in ref/memo.
	const candidates = invoices.filter((inv) => {
		const invUpper = inv.sourceId.toUpperCase()
		if (refUpper === invUpper) return true
		return refTokens.length === 1 && refTokens[0] === invUpper
	})

	if (candidates.length !== 1) {
		return {
			matched: false,
			kind: "NONE",
			reason: `No unique strict invoice reference found in ${tx.sourceId} (ref="${tx.reference}")`,
		}
	}

	const invoice = candidates[0]
	if (invoice.currency !== tx.currency) {
		return {
			matched: false,
			kind: "NONE",
			reason: `Currency mismatch between ${tx.sourceId} (${tx.currency}) and ${invoice.sourceId} (${invoice.currency})`,
		}
	}

	if (invoice.amountCents === tx.amountCents) {
		return {
			matched: true,
			kind: "EXACT",
			invoiceId: invoice.sourceId,
			reason: `Exact strict match: ${tx.sourceId} == ${invoice.sourceId} (${tx.amountCents} ${tx.currency})`,
		}
	}

	if (tx.amountCents > 0 && tx.amountCents < invoice.amountCents && refUpper === invoice.sourceId.toUpperCase()) {
		return {
			matched: true,
			kind: "PARTIAL_EXACT_REF",
			invoiceId: invoice.sourceId,
			reason: `Exact reference partial/tranche match: ${tx.sourceId} (${tx.amountCents}) toward ${invoice.sourceId} (${invoice.amountCents})`,
		}
	}

	return {
		matched: false,
		kind: "NONE",
		reason: `Amount mismatch for ${tx.sourceId} (${tx.amountCents}) vs ${invoice.sourceId} (${invoice.amountCents})`,
	}
}
