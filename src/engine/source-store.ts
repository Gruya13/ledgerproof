import { createHash } from "node:crypto"
import type {
	BankTransaction,
	BlackFridayPack,
	Citation,
	Invoice,
	PaymentRequest,
	SourceEntity,
	Vendor,
} from "../types"

function canonicalSha256(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export class SourceStore {
	private readonly entities = new Map<string, SourceEntity>()

	static fromPack(pack: BlackFridayPack): SourceStore {
		const store = new SourceStore()
		for (const vendor of pack.vendors) {
			store.addVendor(vendor)
		}
		for (const invoice of pack.invoices) {
			store.addInvoice(invoice)
		}
		for (const tx of pack.transactions) {
			store.addTransaction(tx)
		}
		for (const req of pack.requests) {
			store.addRequest(req)
		}
		return store
	}

	private putImmutable(sourceId: string, entry: SourceEntity): void {
		const existing = this.entities.get(sourceId)
		if (existing) {
			if (existing.sha256 === entry.sha256) {
				return
			}
			throw new Error(
				`Immutable SourceStore violation: cannot overwrite ${sourceId} with modified content`,
			)
		}
		this.entities.set(sourceId, entry)
	}

	addVendor(vendor: Vendor): void {
		this.putImmutable(vendor.sourceId, {
			kind: "vendor",
			data: structuredClone(vendor),
			sha256: canonicalSha256(vendor),
		})
	}

	addInvoice(invoice: Invoice): void {
		this.putImmutable(invoice.sourceId, {
			kind: "invoice",
			data: structuredClone(invoice),
			sha256: canonicalSha256(invoice),
		})
	}

	addTransaction(tx: BankTransaction): void {
		this.putImmutable(tx.sourceId, {
			kind: "transaction",
			data: structuredClone(tx),
			sha256: canonicalSha256(tx),
		})
	}

	addRequest(req: PaymentRequest): void {
		this.putImmutable(req.sourceId, {
			kind: "request",
			data: structuredClone(req),
			sha256: canonicalSha256(req),
		})
	}

	has(sourceId: string): boolean {
		return this.entities.has(sourceId)
	}

	get(sourceId: string): SourceEntity | undefined {
		const entry = this.entities.get(sourceId)
		return entry ? structuredClone(entry) : undefined
	}

	getVendor(vendorId: string): Vendor | undefined {
		const entry = this.entities.get(vendorId)
		return entry?.kind === "vendor" ? structuredClone(entry.data) : undefined
	}

	getInvoice(invoiceId: string): Invoice | undefined {
		const entry = this.entities.get(invoiceId)
		return entry?.kind === "invoice" ? structuredClone(entry.data) : undefined
	}

	getTransaction(txId: string): BankTransaction | undefined {
		const entry = this.entities.get(txId)
		return entry?.kind === "transaction" ? structuredClone(entry.data) : undefined
	}

	getRequest(reqId: string): PaymentRequest | undefined {
		const entry = this.entities.get(reqId)
		return entry?.kind === "request" ? structuredClone(entry.data) : undefined
	}

	listInvoices(): Invoice[] {
		return [...this.entities.values()]
			.filter((e): e is Extract<SourceEntity, { kind: "invoice" }> => e.kind === "invoice")
			.map((e) => structuredClone(e.data))
	}

	listTransactions(): BankTransaction[] {
		return [...this.entities.values()]
			.filter((e): e is Extract<SourceEntity, { kind: "transaction" }> => e.kind === "transaction")
			.map((e) => structuredClone(e.data))
	}

	listAllMonetaryAmounts(): Set<number> {
		const amounts = new Set<number>()
		for (const entity of this.entities.values()) {
			if (entity.kind !== "vendor") {
				amounts.add(entity.data.amountCents)
			}
		}
		return amounts
	}

	verifyCitation(citation: Citation): { ok: boolean; actualValue?: unknown; reason?: string } {
		const entity = this.entities.get(citation.sourceId)
		if (!entity) {
			return { ok: false, reason: `Unknown sourceId "${citation.sourceId}"` }
		}

		const record = entity.data as unknown as Record<string, unknown>
		if (!(citation.field in record)) {
			return {
				ok: false,
				reason: `Field "${citation.field}" does not exist on ${citation.sourceId}`,
			}
		}

		const actualValue = record[citation.field]
		if (actualValue !== citation.expectedValue) {
			return {
				ok: false,
				actualValue,
				reason: `Citation mismatch on ${citation.sourceId}.${citation.field}: expected ${JSON.stringify(citation.expectedValue)}, actual ${JSON.stringify(actualValue)}`,
			}
		}

		return { ok: true, actualValue }
	}
}
