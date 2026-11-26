import { describe, expect, it } from "vitest"
import { createHuman, SemanticEvent, SituationSpecification } from "@mozaik-ai/core"
import { MockInferenceRunner } from "../src/engine/mock-runner"
import { matchTransactionStrict } from "../src/engine/strict-matcher"
import { createStrictMatcherParticipant } from "../src/participants/strict-matcher"
import { loadPack } from "../src/runner-setup"
import { createLedgerRuntime, LedgerState } from "../src/runtime"
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

	it("rejects vendor mismatch and null vendorId even when reference, currency, and amount match", () => {
		const wrongVendorTx: BankTransaction = {
			sourceId: "TX-WRONG-VND",
			kind: "bank_transfer",
			reference: "INV-1001",
			vendorId: "VND-06",
			amountCents: 14500,
			currency: "USD",
			bookedAt: "2026-11-26",
			memo: "Cross-vendor spoofing attempt INV-1001",
			late: false,
		}
		const wrongRes = matchTransactionStrict(wrongVendorTx, sampleInvoices)
		expect(wrongRes.matched).toBe(false)
		expect(wrongRes.reason).toContain("Vendor mismatch")

		const unknownVendorTx: BankTransaction = {
			...wrongVendorTx,
			sourceId: "TX-NULL-VND",
			vendorId: null,
		}
		const unknownRes = matchTransactionStrict(unknownVendorTx, sampleInvoices)
		expect(unknownRes.matched).toBe(false)
		expect(unknownRes.reason).toContain("Vendor mismatch")
	})

	it("rejects cross-vendor and currency-mismatched late settlements and routes them to match.ambiguous", async () => {
		const pack = loadPack()
		const rt = createLedgerRuntime()
		const state = new LedgerState(pack)
		rt.initializeRuntime({
			state,
			inferenceRunnerConfig: { runner: new MockInferenceRunner() },
		})

		const inv1007 = state.sourceStore.getInvoice("INV-1007")!
		state.markInvoiceArrived(inv1007.sourceId)
		const cell = state.getCell("INV-1007")!
		const snap = cell.read()
		cell.casWrite(snap.version, (cur) => ({
			...cur,
			paidAmountCents: 50000,
			matchedTxIds: ["TX-2008"],
			status: "PARTIAL",
		}))

		const ambiguousEvents: Array<{ txId: string; reason: string }> = []
		class AmbiguousSpySpec extends SituationSpecification {
			isSatisfiedBy(ctx: { event: SemanticEvent }): boolean {
				return ctx.event.type === "match.ambiguous"
			}
		}
		const spy = createHuman({
			name: "AmbiguousSpy",
			capabilities: ["test"],
			handlers: [
				{
					specification: new AmbiguousSpySpec() as never,
					processor: {
						apply(ctx) {
							const payload = ctx.event.payload as { transaction: BankTransaction; reason: string }
							ambiguousEvents.push({ txId: payload.transaction.sourceId, reason: payload.reason })
						},
					},
				},
			],
		})

		rt.join(createStrictMatcherParticipant(rt))
		rt.join(spy)
		const senderId = spy.getId()

		rt.sendEvent(
			SemanticEvent.create("settlement.late", senderId, {
				transaction: {
					sourceId: "TX-LATE-WRONG-VENDOR",
					kind: "bank_transfer",
					reference: "INV-1007",
					vendorId: "VND-06",
					amountCents: 30000,
					currency: "USD",
					bookedAt: "2026-11-27",
					memo: "Spoofed vendor late settlement",
					late: true,
				} satisfies BankTransaction,
			}),
			senderId,
		)

		rt.sendEvent(
			SemanticEvent.create("settlement.late", senderId, {
				transaction: {
					sourceId: "TX-LATE-WRONG-CCY",
					kind: "bank_transfer",
					reference: "INV-1007",
					vendorId: "VND-02",
					amountCents: 30000,
					currency: "EUR",
					bookedAt: "2026-11-27",
					memo: "Wrong currency late settlement",
					late: true,
				} satisfies BankTransaction,
			}),
			senderId,
		)

		await new Promise((r) => setTimeout(r, 40))

		expect(ambiguousEvents.some((e) => e.txId === "TX-LATE-WRONG-VENDOR" && e.reason.includes("vendor"))).toBe(true)
		expect(ambiguousEvents.some((e) => e.txId === "TX-LATE-WRONG-CCY" && e.reason.includes("currency"))).toBe(true)
		expect(state.getCell("INV-1007")!.read().value.paidAmountCents).toBe(50000)
		expect(state.getCell("INV-1007")!.read().value.status).toBe("PARTIAL")
		expect(state.auditLog.filter((a) => a.type === "settlement.late_rejected")).toHaveLength(2)
	})
})
