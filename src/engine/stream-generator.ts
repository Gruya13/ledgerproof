import type { BankTransaction, Invoice, PaymentRequest, Vendor } from "../types"
import { formatMoney } from "./currency"

export type TrapKind =
	| "split_typo"
	| "partial_late_stale"
	| "duplicate_invoice"
	| "orphan_wire"
	| "bec_iban_change"
	| "write_skew_race"
	| "currency_mismatch"
	| "overpayment_anomaly"
	| "legit_high_value_sepa"
	| "legit_high_value_refund"
	| "false_positive_near_duplicate"

export const ALL_TRAP_KINDS: TrapKind[] = [
	"split_typo",
	"partial_late_stale",
	"duplicate_invoice",
	"orphan_wire",
	"bec_iban_change",
	"write_skew_race",
	"currency_mismatch",
	"overpayment_anomaly",
	"legit_high_value_sepa",
	"legit_high_value_refund",
	"false_positive_near_duplicate",
]

// Interleaved mix of real traps and benign/false-positive stress tests
const ROTATION_ORDER: TrapKind[] = [
	"split_typo",
	"legit_high_value_sepa",
	"bec_iban_change",
	"partial_late_stale",
	"false_positive_near_duplicate",
	"currency_mismatch",
	"write_skew_race",
	"legit_high_value_refund",
	"overpayment_anomaly",
	"duplicate_invoice",
	"orphan_wire",
]

function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function shuffleWithRng<T>(items: readonly T[], rand: () => number): T[] {
	const copy = [...items]
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1))
		;[copy[i], copy[j]] = [copy[j], copy[i]]
	}
	return copy
}

export interface StreamTickBatch {
	tickNumber: number
	trapKind: TrapKind | null
	label: string
	invoices: Invoice[]
	transactions: BankTransaction[]
	delayedTransactions: BankTransaction[]
	requests: PaymentRequest[]
	concurrentFraudAlerts: BankTransaction[]
}

function formatSpacedIban(iban: string): string {
	return iban.replace(/(.{4})/g, "$1 ").trim()
}

/**
 * Generates realistic continuous Black Friday financial traffic (invoices, payments, SEPA drafts)
 * starting at INV-2001 / TX-5001 / REQ-6001, with varied dynamic amounts and a mix of
 * real financial traps + benign false-positive edge cases.
 */
export class ContinuousStreamGenerator {
	readonly seed: number
	private readonly rand: () => number
	private trapDeck: TrapKind[] = []
	private lastAmountCents = 0
	private invSeq = 2000
	private txSeq = 5000
	private reqSeq = 6000
	private poSeq = 8000
	private tickSeq = 0
	private scenarioSeq = 0

	constructor(private readonly vendors: Vendor[], options: { seed?: number } = {}) {
		this.seed = (options.seed ?? (Date.now() ^ Math.floor(Math.random() * 0xffffffff))) >>> 0
		this.rand = mulberry32(this.seed)
	}

	private nextInvId(): string {
		return `INV-${++this.invSeq}`
	}

	private nextTxId(): string {
		return `TX-${++this.txSeq}`
	}

	private nextReqId(): string {
		return `REQ-${++this.reqSeq}`
	}

	private nextPo(): string {
		return `PO-${++this.poSeq}`
	}

	private pickVendor(_offset = 0): Vendor {
		return this.vendors[Math.floor(this.rand() * this.vendors.length)]
	}

	private drawTrapFromDeck(): TrapKind {
		if (this.trapDeck.length === 0) {
			this.trapDeck = shuffleWithRng(ROTATION_ORDER, this.rand)
		}
		return this.trapDeck.shift()!
	}

	/**
	 * Seeded PRNG amount generator ensuring truly random dollar figures across runs
	 * while avoiding consecutive duplicate amounts.
	 */
	private variedCents(minDollars: number, maxDollars: number, includeCents = true): number {
		const centsOptions = [0, 15, 25, 40, 50, 65, 75, 80, 90, 95]
		const span = Math.max(10, maxDollars - minDollars)
		let candidate = 0
		for (let attempt = 0; attempt < 5; attempt++) {
			this.scenarioSeq += 1
			const wholeDollars = minDollars + Math.floor(this.rand() * span)
			const centsPart = includeCents ? centsOptions[Math.floor(this.rand() * centsOptions.length)] : 0
			candidate = wholeDollars * 100 + centsPart
			if (candidate !== this.lastAmountCents) break
		}
		this.lastAmountCents = candidate
		return candidate
	}

	nextTick(opts: { forceTrap?: TrapKind; trapCadence?: number } = {}): StreamTickBatch {
		this.tickSeq += 1
		const cadence = Math.max(2, opts.trapCadence ?? 3)
		const trapKind =
			opts.forceTrap ?? (this.tickSeq % cadence === 0 ? this.drawTrapFromDeck() : null)

		if (!trapKind) {
			return this.buildCleanTick()
		}

		switch (trapKind) {
			case "split_typo":
				return this.buildSplitTypoTrap()
			case "partial_late_stale":
				return this.buildPartialLateStaleTrap()
			case "duplicate_invoice":
				return this.buildDuplicateInvoiceTrap()
			case "orphan_wire":
				return this.buildOrphanWireTrap()
			case "bec_iban_change":
				return this.buildBecIbanChangeTrap()
			case "write_skew_race":
				return this.buildWriteSkewRaceTrap()
			case "currency_mismatch":
				return this.buildCurrencyMismatchTrap()
			case "overpayment_anomaly":
				return this.buildOverpaymentAnomalyTrap()
			case "legit_high_value_sepa":
				return this.buildLegitHighValueSepa()
			case "legit_high_value_refund":
				return this.buildLegitHighValueRefund()
			case "false_positive_near_duplicate":
				return this.buildFalsePositiveNearDuplicate()
		}
	}

	private buildCleanTick(): StreamTickBatch {
		const vendor = this.pickVendor()
		const invId = this.nextInvId()
		const txId = this.nextTxId()
		const amountCents = this.variedCents(65, 240)
		const includeSepa = this.rand() < 0.3
		const currency = includeSepa ? "EUR" : "USD"
		const inv: Invoice = {
			sourceId: invId,
			vendorId: vendor.sourceId,
			poNumber: this.nextPo(),
			amountCents,
			currency,
			issuedAt: "2026-11-26",
			dueDate: "2026-12-05",
			description: `Stream Black Friday order batch #${this.tickSeq}`,
		}
		const tx: BankTransaction = {
			sourceId: txId,
			kind: "bank_transfer",
			reference: invId,
			vendorId: vendor.sourceId,
			amountCents,
			currency,
			bookedAt: "2026-11-26",
			memo: `Auto-settled ${invId} ${vendor.name}`,
			late: false,
		}

		const requests: PaymentRequest[] = []
		if (includeSepa) {
			requests.push({
				sourceId: this.nextReqId(),
				kind: "sepa_payout",
				invoiceId: invId,
				vendorId: vendor.sourceId,
				amountCents,
				currency: "EUR",
				targetIban: vendor.masterIban,
				requestedBy: "ap-automation",
				reason: "Routine Black Friday SEPA vendor payout within €250 limit",
				concurrentWithAlert: false,
			})
		}

		return {
			tickNumber: this.tickSeq,
			trapKind: null,
			label: `Clean settlement ${invId} ⇄ ${txId} (${formatMoney(amountCents, currency)})`,
			invoices: [inv],
			transactions: [tx],
			delayedTransactions: [],
			requests,
			concurrentFraudAlerts: [],
		}
	}

	private buildSplitTypoTrap(): StreamTickBatch {
		const vendor = this.pickVendor(1)
		const invId = this.nextInvId()
		const total = this.variedCents(540, 1680)
		const ratio = 0.4 + this.rand() * 0.3
		const part1 = Math.round((total * ratio) / 100) * 100
		const part2 = total - part1
		const typoRef = invId.replace(/0/, "O")

		const inv: Invoice = {
			sourceId: invId,
			vendorId: vendor.sourceId,
			poNumber: this.nextPo(),
			amountCents: total,
			currency: "USD",
			issuedAt: "2026-11-26",
			dueDate: "2026-12-02",
			description: `Split shipment allocation (${invId})`,
		}
		const tx1: BankTransaction = {
			sourceId: this.nextTxId(),
			kind: "bank_transfer",
			reference: `SPLIT-A-${invId}`,
			vendorId: vendor.sourceId,
			amountCents: part1,
			currency: "USD",
			bookedAt: "2026-11-26",
			memo: `BF tranche 1 ${typoRef}`,
			late: false,
		}
		const tx2: BankTransaction = {
			sourceId: this.nextTxId(),
			kind: "bank_transfer",
			reference: `SPLIT-B-${invId}`,
			vendorId: vendor.sourceId,
			amountCents: part2,
			currency: "USD",
			bookedAt: "2026-11-26",
			memo: `BF tranche 2 ${typoRef}`,
			late: false,
		}

		return {
			tickNumber: this.tickSeq,
			trapKind: "split_typo",
			label: `TRAP [Split + Typo]: ${invId} ($${(total / 100).toFixed(2)}) via ${tx1.sourceId}+${tx2.sourceId}`,
			invoices: [inv],
			transactions: [tx1, tx2],
			delayedTransactions: [],
			requests: [],
			concurrentFraudAlerts: [],
		}
	}

	private buildPartialLateStaleTrap(): StreamTickBatch {
		const vendor = this.pickVendor(2)
		const invId = this.nextInvId()
		const invNum = invId.split("-")[1]
		const total = this.variedCents(480, 1250)
		const partialRatio = 0.45 + this.rand() * 0.25
		const paidNow = Math.round((total * partialRatio) / 100) * 100
		const lateAmount = total - paidNow

		const inv: Invoice = {
			sourceId: invId,
			vendorId: vendor.sourceId,
			poNumber: this.nextPo(),
			amountCents: total,
			currency: "USD",
			issuedAt: "2026-11-25",
			dueDate: "2026-11-26",
			description: `Partial + delayed clearing test (${invId})`,
		}
		const txPartial: BankTransaction = {
			sourceId: this.nextTxId(),
			kind: "bank_transfer",
			reference: `PARTIAL-${invNum}`,
			vendorId: vendor.sourceId,
			amountCents: paidNow,
			currency: "USD",
			bookedAt: "2026-11-26",
			memo: `Partial payment 1 for ${invId}`,
			late: false,
		}
		const txLate: BankTransaction = {
			sourceId: this.nextTxId(),
			kind: "bank_transfer",
			reference: invId,
			vendorId: vendor.sourceId,
			amountCents: lateAmount,
			currency: "USD",
			bookedAt: "2026-11-27",
			memo: `Late clearing tranche for ${invId}`,
			late: true,
		}

		return {
			tickNumber: this.tickSeq,
			trapKind: "partial_late_stale",
			label: `TRAP [Partial -> Late STALE]: ${invId} ($${(total / 100).toFixed(2)}), late ${txLate.sourceId} queued`,
			invoices: [inv],
			transactions: [txPartial],
			delayedTransactions: [txLate],
			requests: [],
			concurrentFraudAlerts: [],
		}
	}

	private buildDuplicateInvoiceTrap(): StreamTickBatch {
		const vendor = this.pickVendor(3)
		const po = this.nextPo()
		const amountCents = this.variedCents(290, 920)
		const invOrig: Invoice = {
			sourceId: this.nextInvId(),
			vendorId: vendor.sourceId,
			poNumber: po,
			amountCents,
			currency: "USD",
			issuedAt: "2026-11-25",
			dueDate: "2026-12-04",
			description: `Original vendor invoice (${po})`,
		}
		const invDup: Invoice = {
			sourceId: this.nextInvId(),
			vendorId: vendor.sourceId,
			poNumber: po,
			amountCents,
			currency: "USD",
			issuedAt: "2026-11-26",
			dueDate: "2026-12-04",
			description: `Duplicate re-submission (${po})`,
		}
		const txOrig: BankTransaction = {
			sourceId: this.nextTxId(),
			kind: "bank_transfer",
			reference: invOrig.sourceId,
			vendorId: vendor.sourceId,
			amountCents,
			currency: "USD",
			bookedAt: "2026-11-26",
			memo: `Payment ${invOrig.sourceId} ${po}`,
			late: false,
		}

		return {
			tickNumber: this.tickSeq,
			trapKind: "duplicate_invoice",
			label: `TRAP [Duplicate Invoice]: ${invDup.sourceId} duplicates ${invOrig.sourceId} ($${(amountCents / 100).toFixed(2)}, ${po})`,
			invoices: [invOrig, invDup],
			transactions: [txOrig],
			delayedTransactions: [],
			requests: [],
			concurrentFraudAlerts: [],
		}
	}

	private buildOrphanWireTrap(): StreamTickBatch {
		const amountCents = this.variedCents(112, 648)
		const txOrphan: BankTransaction = {
			sourceId: this.nextTxId(),
			kind: "wire",
			reference: `UNREF-${this.txSeq}`,
			vendorId: null,
			amountCents,
			currency: "USD",
			bookedAt: "2026-11-26",
			memo: `UNREF WIRE #${this.txSeq} missing invoice reference`,
			late: false,
		}

		return {
			tickNumber: this.tickSeq,
			trapKind: "orphan_wire",
			label: `TRAP [Orphan Wire]: ${txOrphan.sourceId} ($${(amountCents / 100).toFixed(2)})`,
			invoices: [],
			transactions: [txOrphan],
			delayedTransactions: [],
			requests: [],
			concurrentFraudAlerts: [],
		}
	}

	private buildBecIbanChangeTrap(): StreamTickBatch {
		const vendor = this.pickVendor(4)
		const invId = this.nextInvId()
		const txId = this.nextTxId()
		const reqId = this.nextReqId()
		const amountCents = this.variedCents(315, 1490)
		const spoofSuffix = String(100000 + Math.floor(this.rand() * 899999))
		const spoofedIban = `${vendor.country}99000099${spoofSuffix}`

		const inv: Invoice = {
			sourceId: invId,
			vendorId: vendor.sourceId,
			poNumber: this.nextPo(),
			amountCents,
			currency: "EUR",
			issuedAt: "2026-11-26",
			dueDate: "2026-12-01",
			description: `High-value hardware batch (${invId})`,
		}
		const tx: BankTransaction = {
			sourceId: txId,
			kind: "card_capture",
			reference: invId,
			vendorId: vendor.sourceId,
			amountCents,
			currency: "EUR",
			bookedAt: "2026-11-26",
			memo: `Gateway capture ${invId}`,
			late: false,
		}
		const req: PaymentRequest = {
			sourceId: reqId,
			kind: "sepa_payout",
			invoiceId: invId,
			vendorId: vendor.sourceId,
			amountCents,
			currency: "EUR",
			targetIban: spoofedIban,
			requestedBy: `billing-override-${this.scenarioSeq}@vendor-update.invalid`,
			reason: "Urgent Black Friday bank account override",
			concurrentWithAlert: false,
		}

		return {
			tickNumber: this.tickSeq,
			trapKind: "bec_iban_change",
			label: `TRAP [BEC IBAN HITL]: ${reqId} on ${invId} (${formatMoney(amountCents, "EUR")})`,
			invoices: [inv],
			transactions: [tx],
			delayedTransactions: [],
			requests: [req],
			concurrentFraudAlerts: [],
		}
	}

	private buildWriteSkewRaceTrap(): StreamTickBatch {
		const vendor = this.pickVendor(5)
		const invId = this.nextInvId()
		const txCaptureId = this.nextTxId()
		const reqId = this.nextReqId()
		const alertTxId = this.nextTxId()
		const amountCents = this.variedCents(275, 780)

		const inv: Invoice = {
			sourceId: invId,
			vendorId: vendor.sourceId,
			poNumber: this.nextPo(),
			amountCents,
			currency: "USD",
			issuedAt: "2026-11-26",
			dueDate: "2026-12-01",
			description: `Black Friday bundle under concurrent race (${invId})`,
		}
		const txCapture: BankTransaction = {
			sourceId: txCaptureId,
			kind: "card_capture",
			reference: invId,
			vendorId: vendor.sourceId,
			amountCents,
			currency: "USD",
			bookedAt: "2026-11-26",
			memo: `Initial capture ${invId}`,
			late: false,
		}
		const reqRefund: PaymentRequest = {
			sourceId: reqId,
			kind: "refund",
			invoiceId: invId,
			vendorId: vendor.sourceId,
			amountCents,
			currency: "USD",
			targetIban: null,
			requestedBy: "customer-portal",
			reason: "Immediate Black Friday refund request",
			concurrentWithAlert: true,
		}
		const fraudAlert: BankTransaction = {
			sourceId: alertTxId,
			kind: "fraud_alert",
			reference: invId,
			vendorId: vendor.sourceId,
			amountCents,
			currency: "USD",
			bookedAt: "2026-11-26",
			memo: `VELOCITY ALERT: mismatched BIN retries on ${invId}`,
			late: false,
		}

		return {
			tickNumber: this.tickSeq,
			trapKind: "write_skew_race",
			label: `TRAP [CAS Write-Skew + L1]: ${reqId} vs ${alertTxId} on ${invId} ($${(amountCents / 100).toFixed(2)})`,
			invoices: [inv],
			transactions: [txCapture],
			delayedTransactions: [],
			requests: [reqRefund],
			concurrentFraudAlerts: [fraudAlert],
		}
	}

	private buildCurrencyMismatchTrap(): StreamTickBatch {
		const vendor = this.pickVendor(2)
		const invId = this.nextInvId()
		const txId = this.nextTxId()
		const amountCents = this.variedCents(320, 890)

		const inv: Invoice = {
			sourceId: invId,
			vendorId: vendor.sourceId,
			poNumber: this.nextPo(),
			amountCents,
			currency: "USD",
			issuedAt: "2026-11-26",
			dueDate: "2026-12-03",
			description: `Cross-border settlement (${invId})`,
		}
		const tx: BankTransaction = {
			sourceId: txId,
			kind: "bank_transfer",
			reference: invId,
			vendorId: vendor.sourceId,
			amountCents,
			currency: "EUR",
			bookedAt: "2026-11-26",
			memo: `Cross-currency transfer ${invId} in EUR instead of USD`,
			late: false,
		}

		return {
			tickNumber: this.tickSeq,
			trapKind: "currency_mismatch",
			label: `TRAP [Currency Mismatch]: ${invId} USD vs ${txId} EUR ($${(amountCents / 100).toFixed(2)})`,
			invoices: [inv],
			transactions: [tx],
			delayedTransactions: [],
			requests: [],
			concurrentFraudAlerts: [],
		}
	}

	private buildOverpaymentAnomalyTrap(): StreamTickBatch {
		const vendor = this.pickVendor(1)
		const invId = this.nextInvId()
		const txId = this.nextTxId()
		const invoiceCents = this.variedCents(260, 610)
		const excessCents = this.variedCents(45, 140)
		const paidCents = invoiceCents + excessCents

		const inv: Invoice = {
			sourceId: invId,
			vendorId: vendor.sourceId,
			poNumber: this.nextPo(),
			amountCents: invoiceCents,
			currency: "USD",
			issuedAt: "2026-11-26",
			dueDate: "2026-12-03",
			description: `Equipment invoice (${invId})`,
		}
		const tx: BankTransaction = {
			sourceId: txId,
			kind: "bank_transfer",
			reference: invId,
			vendorId: vendor.sourceId,
			amountCents: paidCents,
			currency: "USD",
			bookedAt: "2026-11-26",
			memo: `Overpaid remittance for ${invId} (+$${(excessCents / 100).toFixed(2)} excess)`,
			late: false,
		}

		return {
			tickNumber: this.tickSeq,
			trapKind: "overpayment_anomaly",
			label: `TRAP [Overpayment]: ${txId} ($${(paidCents / 100).toFixed(2)}) > ${invId} ($${(invoiceCents / 100).toFixed(2)})`,
			invoices: [inv],
			transactions: [tx],
			delayedTransactions: [],
			requests: [],
			concurrentFraudAlerts: [],
		}
	}

	private buildLegitHighValueSepa(): StreamTickBatch {
		const vendor = this.pickVendor(0)
		const invId = this.nextInvId()
		const txId = this.nextTxId()
		const reqId = this.nextReqId()
		const amountCents = this.variedCents(285, 1740)
		// Format with spaces randomly to stress-test whitespace IBAN normalization
		const targetIban = this.rand() < 0.5 ? formatSpacedIban(vendor.masterIban) : vendor.masterIban

		const inv: Invoice = {
			sourceId: invId,
			vendorId: vendor.sourceId,
			poNumber: this.nextPo(),
			amountCents,
			currency: "EUR",
			issuedAt: "2026-11-26",
			dueDate: "2026-12-04",
			description: `Authorized Black Friday capacity upgrade (${invId})`,
		}
		const tx: BankTransaction = {
			sourceId: txId,
			kind: "bank_transfer",
			reference: invId,
			vendorId: vendor.sourceId,
			amountCents,
			currency: "EUR",
			bookedAt: "2026-11-26",
			memo: `Verified settlement ${invId} ${vendor.name}`,
			late: false,
		}
		const req: PaymentRequest = {
			sourceId: reqId,
			kind: "sepa_payout",
			invoiceId: invId,
			vendorId: vendor.sourceId,
			amountCents,
			currency: "EUR",
			targetIban,
			requestedBy: "cfo-approved@ledgerproof.internal",
			reason: "Legitimate high-value SEPA payout (master IBAN verified, requires >€250 sign-off)",
			concurrentWithAlert: false,
		}

		return {
			tickNumber: this.tickSeq,
			trapKind: "legit_high_value_sepa",
			label: `BENIGN [Legit High-Value SEPA HITL]: ${reqId} on ${invId} (${formatMoney(amountCents, "EUR")})`,
			invoices: [inv],
			transactions: [tx],
			delayedTransactions: [],
			requests: [req],
			concurrentFraudAlerts: [],
		}
	}

	private buildLegitHighValueRefund(): StreamTickBatch {
		const vendor = this.pickVendor(3)
		const invId = this.nextInvId()
		const txId = this.nextTxId()
		const reqId = this.nextReqId()
		const amountCents = this.variedCents(270, 695)

		const inv: Invoice = {
			sourceId: invId,
			vendorId: vendor.sourceId,
			poNumber: this.nextPo(),
			amountCents,
			currency: "USD",
			issuedAt: "2026-11-26",
			dueDate: "2026-12-04",
			description: `Black Friday enterprise bundle (${invId})`,
		}
		const tx: BankTransaction = {
			sourceId: txId,
			kind: "card_capture",
			reference: invId,
			vendorId: vendor.sourceId,
			amountCents,
			currency: "USD",
			bookedAt: "2026-11-26",
			memo: `Clean checkout capture ${invId}`,
			late: false,
		}
		const req: PaymentRequest = {
			sourceId: reqId,
			kind: "refund",
			invoiceId: invId,
			vendorId: vendor.sourceId,
			amountCents,
			currency: "USD",
			targetIban: null,
			requestedBy: "support-rma-verified@ledgerproof.internal",
			reason: "Verified RMA warehouse return (no fraud flags, requires >$250 sign-off)",
			concurrentWithAlert: false,
		}

		return {
			tickNumber: this.tickSeq,
			trapKind: "legit_high_value_refund",
			label: `BENIGN [Legit High-Value Refund HITL]: ${reqId} on ${invId} ($${(amountCents / 100).toFixed(2)})`,
			invoices: [inv],
			transactions: [tx],
			delayedTransactions: [],
			requests: [req],
			concurrentFraudAlerts: [],
		}
	}

	private buildFalsePositiveNearDuplicate(): StreamTickBatch {
		const vendor = this.pickVendor(4)
		const amountCents = this.variedCents(310, 740)
		const invAId = this.nextInvId()
		const invBId = this.nextInvId()
		const txAId = this.nextTxId()
		const txBId = this.nextTxId()
		const poA = this.nextPo()
		const poB = this.nextPo()

		const invA: Invoice = {
			sourceId: invAId,
			vendorId: vendor.sourceId,
			poNumber: poA,
			amountCents,
			currency: "USD",
			issuedAt: "2026-11-26",
			dueDate: "2026-12-04",
			description: `Storefront A replenishment (${poA})`,
		}
		const invB: Invoice = {
			sourceId: invBId,
			vendorId: vendor.sourceId,
			poNumber: poB,
			amountCents,
			currency: "USD",
			issuedAt: "2026-11-26",
			dueDate: "2026-12-04",
			description: `Storefront B replenishment (${poB})`,
		}
		const txA: BankTransaction = {
			sourceId: txAId,
			kind: "bank_transfer",
			reference: invAId,
			vendorId: vendor.sourceId,
			amountCents,
			currency: "USD",
			bookedAt: "2026-11-26",
			memo: `Settlement ${invAId} ${poA}`,
			late: false,
		}
		const txB: BankTransaction = {
			sourceId: txBId,
			kind: "bank_transfer",
			reference: invBId,
			vendorId: vendor.sourceId,
			amountCents,
			currency: "USD",
			bookedAt: "2026-11-26",
			memo: `Settlement ${invBId} ${poB}`,
			late: false,
		}

		return {
			tickNumber: this.tickSeq,
			trapKind: "false_positive_near_duplicate",
			label: `BENIGN [Near-Duplicate False-Positive Test]: ${invAId} (${poA}) & ${invBId} (${poB}) both $${(amountCents / 100).toFixed(2)}`,
			invoices: [invA, invB],
			transactions: [txA, txB],
			delayedTransactions: [],
			requests: [],
			concurrentFraudAlerts: [],
		}
	}
}
