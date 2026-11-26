import { describe, expect, it } from "vitest"
import { generateSepaPain001Draft } from "../src/engine/sepa-xml"
import type { Invoice, PaymentRequest, Vendor } from "../src/types"

describe("ISO 20022 SEPA pain.001.001.09 XML generator", () => {
	const baseVendor: Vendor = {
		sourceId: "VND-06",
		name: "Studio & Pixel <GmbH>",
		masterIban: "CZ6508000000192000145399",
		country: "CZ",
		verifiedAt: "2026-11-12",
	}

	const eurInvoice: Invoice = {
		sourceId: "INV-1012",
		vendorId: "VND-06",
		poNumber: "PO-7712",
		amountCents: 19500,
		currency: "EUR",
		issuedAt: "2026-11-26",
		dueDate: "2026-12-02",
		description: "Landing page motion kit",
	}

	const eurRequest: PaymentRequest = {
		sourceId: "REQ-3004",
		kind: "sepa_payout",
		invoiceId: "INV-1012",
		vendorId: "VND-06",
		amountCents: 19500,
		currency: "EUR",
		targetIban: "cz65 0800 0000 1920 0014 5399",
		requestedBy: "ap-automation",
		reason: "SEPA payout draft within €250 limit",
		concurrentWithAlert: false,
	}

	it("generates well-formed XML with synthetic warning, normalized IBAN, escaped entities, and sha256", () => {
		const artifact = generateSepaPain001Draft({
			invoice: eurInvoice,
			vendor: baseVendor,
			request: eurRequest,
			approvedBy: "AUTO_POLICY",
			cellVersion: 3,
			createdAt: "2026-11-26T20:00:00.000Z",
		})

		expect(artifact.messageId).toBe("LP-REQ-3004-INV-1012")
		expect(artifact.sha256).toMatch(/^[0-9a-f]{16}$/)
		expect(artifact.xml).toContain('xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"')
		expect(artifact.xml).toContain("SYNTHETIC TEST DATA ONLY - NOT FOR BANKING SUBMISSION")
		expect(artifact.xml).toContain('<InstdAmt Ccy="EUR">195.00</InstdAmt>')
		expect(artifact.xml).toContain("<IBAN>CZ6508000000192000145399</IBAN>")
		expect(artifact.xml).toContain("<Nm>Studio &amp; Pixel &lt;GmbH&gt;</Nm>")
		expect(artifact.xml).toContain("<Ustrd>SYNTHETIC INV-1012 PO-7712 v3 AUTO_POLICY</Ustrd>")
	})

	it("rejects non-EUR invoice or request", () => {
		expect(() =>
			generateSepaPain001Draft({
				invoice: { ...eurInvoice, currency: "USD" },
				vendor: baseVendor,
				request: eurRequest,
				approvedBy: "AUTO_POLICY",
				cellVersion: 2,
			}),
		).toThrow(/EUR/)
	})
})
