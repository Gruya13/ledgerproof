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
	})
})
