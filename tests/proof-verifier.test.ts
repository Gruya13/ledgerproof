import { describe, expect, it } from "vitest"
import { SourceStore } from "../src/engine/source-store"
import { verifyMessageCitations, verifyToolProposal } from "../src/engine/proof-verifier"
import { loadPack } from "../src/runner-setup"

describe("ProofVerifier L1 deterministic source & math gates", () => {
	const store = SourceStore.fromPack(loadPack())

	it("accepts valid split payment citations when exact integer cents sum matches", () => {
		const res = verifyToolProposal(
			"record_reconciliation",
			{
				invoiceId: "INV-1006",
				txIds: ["TX-2006", "TX-2007"],
				amountCents: 120000,
				citations: [
					{ sourceId: "INV-1006", field: "amountCents", expectedValue: 120000 },
					{ sourceId: "TX-2006", field: "amountCents", expectedValue: 70000 },
					{ sourceId: "TX-2007", field: "amountCents", expectedValue: 50000 },
				],
			},
			store,
		)
		expect(res.ok).toBe(true)
	})

	it("blocks invented amounts and bogus transaction citations", () => {
		const res = verifyToolProposal(
			"propose_refund",
			{
				requestId: "REQ-3003",
				invoiceId: "INV-1011",
				amountCents: 31999,
				citations: [
					{ sourceId: "REQ-3003", field: "amountCents", expectedValue: 31000 },
					{ sourceId: "TX-9999", field: "amountCents", expectedValue: 31999 },
				],
			},
			store,
		)
		expect(res.ok).toBe(false)
		expect(res.code).toBe("INVALID_CITATION")
	})

	it("blocks uncited or invented monetary figures in model prose while allowing policy limit when cited", () => {
		const uncited = verifyMessageCitations("Refund approved for $319.99 immediately.", store)
		expect(uncited.ok).toBe(false)

		const citedValid = verifyMessageCitations("Verified [src:INV-1011] for $310.00.", store)
		expect(citedValid.ok).toBe(true)

		const withPolicyLimit = verifyMessageCitations(
			"Payout [src:REQ-3004] ($195.00) is below the $250.00 policy limit.",
			store,
			new Set([25000]),
		)
		expect(withPolicyLimit.ok).toBe(true)

		// Overpayment delta: INV-1007 ($800.00) vs TX-2008 ($500.00) -> $300.00 difference allowed when both cited
		const withDelta = verifyMessageCitations(
			"Delta of $300.00 between [src:INV-1007] ($800.00) and [src:TX-2008] ($500.00).",
			store,
		)
		expect(withDelta.ok).toBe(true)

		// EUR formatting & policy limit
		const validEur = verifyMessageCitations(
			"SEPA payout [src:REQ-3004] (€195.00) is below the €250.00 policy limit.",
			store,
			new Set([25000]),
		)
		expect(validEur.ok).toBe(true)

		// Raw integer cents mislabeled as major USD/EUR units must be caught as INVENTED_PROSE_AMOUNT
		const rawCentsUsd = verifyMessageCitations(
			"Refund 31000 USD on [src:INV-1011] blocked.",
			store,
		)
		expect(rawCentsUsd.ok).toBe(false)
		expect(rawCentsUsd.code).toBe("INVENTED_PROSE_AMOUNT")
	})

	it("enforces request bindings (IBAN, vendor, requestId, kind, and EUR-only SEPA rail)", () => {
		// 1. Missing requestId on propose_sepa_payout and propose_refund
		const missingReq = verifyToolProposal(
			"propose_refund",
			{
				invoiceId: "INV-1011",
				amountCents: 31000,
				citations: [{ sourceId: "INV-1011", field: "amountCents", expectedValue: 31000 }],
			},
			store,
		)
		expect(missingReq.ok).toBe(false)
		expect(missingReq.code).toBe("MISSING_REQUEST_ID")

		// 2. Request kind mismatch (refund request passed to propose_sepa_payout & vice versa)
		const kindSepaOnRefund = verifyToolProposal(
			"propose_sepa_payout",
			{
				requestId: "REQ-3003",
				invoiceId: "INV-1011",
				vendorId: "VND-05",
				amountCents: 31000,
				targetIban: "NL91ABNA0417164300",
				citations: [
					{ sourceId: "INV-1011", field: "amountCents", expectedValue: 31000 },
					{ sourceId: "REQ-3003", field: "amountCents", expectedValue: 31000 },
				],
			},
			store,
		)
		expect(kindSepaOnRefund.ok).toBe(false)
		expect(kindSepaOnRefund.code).toBe("REQUEST_KIND_MISMATCH")

		const kindRefundOnSepa = verifyToolProposal(
			"propose_refund",
			{
				requestId: "REQ-3004",
				invoiceId: "INV-1012",
				amountCents: 19500,
				citations: [
					{ sourceId: "INV-1012", field: "amountCents", expectedValue: 19500 },
					{ sourceId: "REQ-3004", field: "amountCents", expectedValue: 19500 },
				],
			},
			store,
		)
		expect(kindRefundOnSepa.ok).toBe(false)
		expect(kindRefundOnSepa.code).toBe("REQUEST_KIND_MISMATCH")

		// 3. Target IBAN substitution must be rejected by L1
		const ibanSub = verifyToolProposal(
			"propose_sepa_payout",
			{
				requestId: "REQ-3004",
				invoiceId: "INV-1012",
				vendorId: "VND-06",
				amountCents: 19500,
				targetIban: "DE99000000000000000000",
				citations: [
					{ sourceId: "INV-1012", field: "amountCents", expectedValue: 19500 },
					{ sourceId: "REQ-3004", field: "amountCents", expectedValue: 19500 },
				],
			},
			store,
		)
		expect(ibanSub.ok).toBe(false)
		expect(ibanSub.code).toBe("TARGET_IBAN_MISMATCH")

		// 4. Vendor substitution must be rejected by L1
		const vendorSub = verifyToolProposal(
			"propose_sepa_payout",
			{
				requestId: "REQ-3004",
				invoiceId: "INV-1012",
				vendorId: "VND-01",
				amountCents: 19500,
				targetIban: "CZ6508000000192000145399",
				citations: [
					{ sourceId: "INV-1012", field: "amountCents", expectedValue: 19500 },
					{ sourceId: "REQ-3004", field: "amountCents", expectedValue: 19500 },
				],
			},
			store,
		)
		expect(vendorSub.ok).toBe(false)
		expect(vendorSub.code).toBe("VENDOR_MISMATCH")

		// 5. USD sepa_payout request must trigger SEPA_REQUIRES_EUR
		const usdStore = SourceStore.fromPack(loadPack())
		usdStore.addRequest({
			sourceId: "REQ-9991",
			kind: "sepa_payout",
			invoiceId: "INV-1011",
			vendorId: "VND-05",
			amountCents: 31000,
			currency: "USD",
			targetIban: "NL91ABNA0417164300",
			requestedBy: "ap-automation",
			reason: "Test USD SEPA rejection",
			concurrentWithAlert: false,
		})
		const eurOnly = verifyToolProposal(
			"propose_sepa_payout",
			{
				requestId: "REQ-9991",
				invoiceId: "INV-1011",
				vendorId: "VND-05",
				amountCents: 31000,
				targetIban: "NL91ABNA0417164300",
				citations: [
					{ sourceId: "INV-1011", field: "amountCents", expectedValue: 31000 },
					{ sourceId: "REQ-9991", field: "amountCents", expectedValue: 31000 },
				],
			},
			usdStore,
		)
		expect(eurOnly.ok).toBe(false)
		expect(eurOnly.code).toBe("SEPA_REQUIRES_EUR")
	})

	it("requires citations for both invoiceId and requestId on propose_sepa_payout and propose_refund", () => {
		const sepaIncomplete = verifyToolProposal(
			"propose_sepa_payout",
			{
				requestId: "REQ-3004",
				invoiceId: "INV-1012",
				vendorId: "VND-06",
				amountCents: 19500,
				targetIban: "CZ6508000000192000145399",
				citations: [{ sourceId: "INV-1001", field: "amountCents", expectedValue: 14500 }],
			},
			store,
		)
		expect(sepaIncomplete.ok).toBe(false)
		expect(sepaIncomplete.code).toBe("INCOMPLETE_CITATIONS")

		const refundIncomplete = verifyToolProposal(
			"propose_refund",
			{
				requestId: "REQ-3003",
				invoiceId: "INV-1011",
				amountCents: 31000,
				citations: [{ sourceId: "INV-1001", field: "amountCents", expectedValue: 14500 }],
			},
			store,
		)
		expect(refundIncomplete.ok).toBe(false)
		expect(refundIncomplete.code).toBe("INCOMPLETE_CITATIONS")
	})
})
