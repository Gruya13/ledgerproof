import { describe, expect, it } from "vitest"
import { matchTransactionStrict } from "../src/engine/strict-matcher"
import type { BankTransaction, Invoice } from "../src/types"

const sampleInvoices: Invoice[] = [
	{
		sourceId: "INV-1",
		vendorId: "VND-01",
		poNumber: "PO-1",
		amountCents: 10000,
		currency: "USD",
		issuedAt: "2026-11-26",
		dueDate: "2026-12-01",
		description: "Invoice 1",
	},
	{
		sourceId: "INV-1001",
		vendorId: "VND-01",
		poNumber: "PO-7701",
		amountCents: 14500,
		currency: "USD",
		issuedAt: "2026-11-26",
		dueDate: "2026-12-03",
		description: "Cloud compute",
	},
]

describe("StrictMatcher regression & precision", () => {
	it("never false-matches INV-1 against INV-1001 or substring digits", () => {
		const tx: BankTransaction = {
			sourceId: "TX-2001",
			kind: "bank_transfer",
			reference: "INV-1001",
			vendorId: "VND-01",
			amountCents: 14500,
			currency: "USD",
			bookedAt: "2026-11-26",
			memo: "Settlement INV-1001",
			late: false,
		}
		const res = matchTransactionStrict(tx, sampleInvoices)
		expect(res.matched).toBe(true)
		expect(res.invoiceId).toBe("INV-1001")
	})

	it("rejects currency mismatch even when reference and numeric cents match", () => {
		const tx: BankTransaction = {
			sourceId: "TX-EUR",
			kind: "bank_transfer",
			reference: "INV-1001",
			vendorId: "VND-01",
			amountCents: 14500,
			currency: "EUR",
			bookedAt: "2026-11-26",
			memo: "INV-1001 in wrong currency",
			late: false,
		}
		const res = matchTransactionStrict(tx, sampleInvoices)
		expect(res.matched).toBe(false)
		expect(res.reason).toContain("Currency mismatch")
	})
})
