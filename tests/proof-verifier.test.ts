import { describe, expect, it } from "vitest"
import { SourceStore } from "../src/engine/source-store"
import { verifyClaimConfirmation, verifyMessageCitations, verifyToolProposal } from "../src/engine/proof-verifier"
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

	it("blocks propose_refund when request vendorId does not match invoice vendorId", () => {
		const crossVendorStore = SourceStore.fromPack(loadPack())
		crossVendorStore.addRequest({
			sourceId: "REQ-9992",
			kind: "refund",
			invoiceId: "INV-1011",
			vendorId: "VND-01",
			amountCents: 31000,
			currency: "USD",
			targetIban: null,
			requestedBy: "attacker@invalid",
			reason: "Cross-vendor refund attempt",
			concurrentWithAlert: false,
		})
		const res = verifyToolProposal(
			"propose_refund",
			{
				requestId: "REQ-9992",
				invoiceId: "INV-1011",
				amountCents: 31000,
				citations: [
					{ sourceId: "INV-1011", field: "amountCents", expectedValue: 31000 },
					{ sourceId: "REQ-9992", field: "amountCents", expectedValue: 31000 },
				],
			},
			crossVendorStore,
		)
		expect(res.ok).toBe(false)
		expect(res.code).toBe("VENDOR_MISMATCH")
	})

	it("blocks record_reconciliation on vendor mismatch and requires valid basedOnVersion on draft_overdue_chase", () => {
		const crossVendorTxStore = SourceStore.fromPack(loadPack())
		crossVendorTxStore.addTransaction({
			sourceId: "TX-CROSS-99",
			kind: "bank_transfer",
			reference: "INV-1001",
			vendorId: "VND-06",
			amountCents: 14500,
			currency: "EUR",
			bookedAt: "2026-11-26",
			memo: "Cross vendor wire",
			late: false,
		})
		const recRes = verifyToolProposal(
			"record_reconciliation",
			{
				invoiceId: "INV-1001",
				txIds: ["TX-CROSS-99"],
				amountCents: 14500,
				citations: [
					{ sourceId: "INV-1001", field: "amountCents", expectedValue: 14500 },
					{ sourceId: "TX-CROSS-99", field: "amountCents", expectedValue: 14500 },
				],
			},
			crossVendorTxStore,
		)
		expect(recRes.ok).toBe(false)
		expect(recRes.code).toBe("VENDOR_MISMATCH")

		const noVersionChase = verifyToolProposal(
			"draft_overdue_chase",
			{
				invoiceId: "INV-1007",
				amountCents: 30000,
				citations: [{ sourceId: "INV-1007", field: "amountCents", expectedValue: 80000 }],
			},
			store,
		)
		expect(noVersionChase.ok).toBe(false)
		expect(noVersionChase.code).toBe("MISSING_BASED_ON_VERSION")

		const zeroAmountChase = verifyToolProposal(
			"draft_overdue_chase",
			{
				invoiceId: "INV-1007",
				amountCents: 0,
				basedOnVersion: 2,
				citations: [{ sourceId: "INV-1007", field: "amountCents", expectedValue: 80000 }],
			},
			store,
		)
		expect(zeroAmountChase.ok).toBe(false)
		expect(zeroAmountChase.code).toBe("INVALID_CHASE_AMOUNT")
	})

	it("mathematically validates SkepticAuditor claim confirmations against SourceStore", () => {
		const validSplit = verifyClaimConfirmation(
			{
				claimId: "CLM-SPLIT-VALID",
				invoiceId: "INV-1006",
				producer: "Reconciler",
				kind: "SPLIT_MATCH",
				amountCents: 120000,
				summary: "TX-2006 + TX-2007 = INV-1006",
				citations: [],
				auditStatus: "PENDING",
				createdAt: new Date().toISOString(),
			},
			[
				{ sourceId: "INV-1006", field: "amountCents", expectedValue: 120000 },
				{ sourceId: "TX-2006", field: "amountCents", expectedValue: 70000 },
				{ sourceId: "TX-2007", field: "amountCents", expectedValue: 50000 },
			],
			store,
		)
		expect(validSplit.ok).toBe(true)

		// Citations valid in SourceStore, but sum of cited TX (70000) != claimed amount (120000)
		const badMathSplit = verifyClaimConfirmation(
			{
				claimId: "CLM-SPLIT-BAD-MATH",
				invoiceId: "INV-1006",
				producer: "Reconciler",
				kind: "SPLIT_MATCH",
				amountCents: 120000,
				summary: "Incomplete split",
				citations: [],
				auditStatus: "PENDING",
				createdAt: new Date().toISOString(),
			},
			[
				{ sourceId: "INV-1006", field: "amountCents", expectedValue: 120000 },
				{ sourceId: "TX-2006", field: "amountCents", expectedValue: 70000 },
			],
			store,
		)
		expect(badMathSplit.ok).toBe(false)
		expect(badMathSplit.code).toBe("ARITHMETIC_MISMATCH")

		// Bad CHASE_DRAFT delta (claims $400 instead of $800 - $500 = $300)
		const badChase = verifyClaimConfirmation(
			{
				claimId: "CLM-CHASE-BAD",
				invoiceId: "INV-1007",
				producer: "PayoutAndRefund",
				kind: "CHASE_DRAFT",
				amountCents: 40000,
				summary: "Wrong chase balance",
				citations: [],
				auditStatus: "PENDING",
				createdAt: new Date().toISOString(),
			},
			[
				{ sourceId: "INV-1007", field: "amountCents", expectedValue: 80000 },
				{ sourceId: "TX-2008", field: "amountCents", expectedValue: 50000 },
			],
			store,
		)
		expect(badChase.ok).toBe(false)
		expect(badChase.code).toBe("ARITHMETIC_MISMATCH")
	})
})
