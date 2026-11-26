import {
	defineRuntime,
	RuntimeState,
	type Participant,
	type SemanticEvent,
} from "@mozaik-ai/core"
import type {
	AgentSpan,
	ApprovalDecision,
	AuditEntry,
	BankTransaction,
	BlackFridayPack,
	ClaimRecord,
	ConcurrencyMetrics,
	Invoice,
	LedgerRecord,
	PaymentRequest,
	PendingApproval,
	RejectedAttempt,
} from "./types"
import { SourceStore } from "./engine/source-store"
import type { SepaDraftArtifact } from "./engine/sepa-xml"
import { VersionedCell } from "./engine/versioned-cell"

export type ApprovalHandler = (approval: PendingApproval) => Promise<ApprovalDecision>

export interface ApprovedExecutionGrant {
	requestId: string
	invoiceId: string
	vendorId: string
	actionName: "propose_sepa_payout" | "propose_refund"
	approvedBy: "AUTO_POLICY" | "HUMAN"
	approvedVersion: number
	amountCents: number
	targetIban?: string
	grantedAt: string
}

export class ApprovalBroker {
	private handler: ApprovalHandler

	constructor(handler?: ApprovalHandler) {
		this.handler =
			handler ??
			(async (approval) => ({
				approved: false,
				reason: `Default safe policy rejected ${approval.actionName} on ${approval.invoiceId}`,
				decidedBy: "POLICY_AUTO",
			}))
	}

	setHandler(handler: ApprovalHandler): void {
		this.handler = handler
	}

	async requestApproval(approval: PendingApproval): Promise<ApprovalDecision> {
		return await this.handler(approval)
	}
}

export class LedgerState extends RuntimeState {
	readonly sourceStore: SourceStore
	readonly spendingLimitCents: number
	readonly cells = new Map<string, VersionedCell<LedgerRecord>>()
	readonly unmatchedTxIds = new Set<string>()
	readonly nonInvoiceFeeTxIds = new Set<string>()
	readonly claims: ClaimRecord[] = []
	readonly rejectedAttempts: RejectedAttempt[] = []
	readonly pendingApprovals = new Map<string, PendingApproval>()
	readonly sepaDraftXmls = new Map<string, SepaDraftArtifact>()
	readonly auditLog: AuditEntry[] = []
	private readonly executionGrants = new Map<string, ApprovedExecutionGrant>()
	readonly approvalBroker: ApprovalBroker
	readonly metrics: ConcurrencyMetrics = {
		activeLoops: 0,
		peakConcurrentLoops: 0,
		totalLoopsStarted: 0,
		totalLoopsFinished: 0,
		deterministicMatches: 0,
		llmCalls: 0,
		casConflictsPrevented: 0,
		uncitedNumbersBlocked: 0,
		inventedNumbersLeaked: 0,
		staleInvalidations: 0,
		humanApprovalsRouted: 0,
		spans: [],
	}

	private readonly arrivedInvoices = new Set<string>()
	private readonly arrivedTransactions = new Set<string>()
	private readonly arrivedRequests = new Set<string>()
	private readonly activeLoopsByKey = new Map<string, AgentSpan>()
	private readonly idleWaiters: Array<() => void> = []
	private readonly changeListeners = new Set<() => void>()
	private readonly maxLlmCalls?: number
	private pendingExternalWork = 0
	private auditSeq = 0

	constructor(
		pack: BlackFridayPack,
		approvalBroker?: ApprovalBroker,
		options: { seedInvoices?: boolean; maxLlmCalls?: number } = {},
	) {
		super()
		const seedInvoices = options.seedInvoices ?? true
		this.maxLlmCalls = options.maxLlmCalls
		this.sourceStore = seedInvoices
			? SourceStore.fromPack(pack)
			: SourceStore.fromPack({
					...pack,
					invoices: [],
					transactions: [],
					requests: [],
				})
		this.spendingLimitCents = pack.spendingLimitCents
		this.approvalBroker = approvalBroker ?? new ApprovalBroker()

		if (seedInvoices) {
			for (const inv of pack.invoices) {
				this.ensureInvoiceCell(inv)
			}
		}
	}

	private ensureInvoiceCell(inv: Invoice): void {
		if (this.cells.has(inv.sourceId)) return
		this.cells.set(
			inv.sourceId,
			new VersionedCell<LedgerRecord>({
				invoiceId: inv.sourceId,
				vendorId: inv.vendorId,
				expectedAmountCents: inv.amountCents,
				paidAmountCents: 0,
				currency: inv.currency,
				status: "OPEN",
				matchedTxIds: [],
				riskFlags: [],
				drafts: [],
				notes: [],
			}),
		)
	}

	registerInvoice(invoice: Invoice): void {
		this.sourceStore.addInvoice(invoice)
		this.ensureInvoiceCell(invoice)
		this.markInvoiceArrived(invoice.sourceId)
		this.notifyChange()
	}

	registerTransaction(tx: BankTransaction): void {
		this.sourceStore.addTransaction(tx)
		this.markTransactionArrived(tx.sourceId)
		this.notifyChange()
	}

	registerRequest(req: PaymentRequest): void {
		this.sourceStore.addRequest(req)
		this.markRequestArrived(req.sourceId)
		this.notifyChange()
	}

	canStartLlmLoop(): boolean {
		return this.maxLlmCalls === undefined || this.metrics.llmCalls < this.maxLlmCalls
	}

	isLlmBudgetExhausted(): boolean {
		return this.maxLlmCalls !== undefined && this.metrics.llmCalls >= this.maxLlmCalls
	}

	getMaxLlmCalls(): number | undefined {
		return this.maxLlmCalls
	}

	markInvoiceArrived(invoiceId: string): void {
		this.arrivedInvoices.add(invoiceId)
	}

	markTransactionArrived(txId: string): void {
		this.arrivedTransactions.add(txId)
	}

	markRequestArrived(requestId: string): void {
		this.arrivedRequests.add(requestId)
	}

	getArrivedInvoices() {
		return [...this.arrivedInvoices]
			.map((id) => this.sourceStore.getInvoice(id))
			.filter((inv): inv is NonNullable<typeof inv> => inv !== undefined)
	}

	getArrivedTransactions() {
		return [...this.arrivedTransactions]
			.map((id) => this.sourceStore.getTransaction(id))
			.filter((tx): tx is NonNullable<typeof tx> => tx !== undefined)
	}

	getCell(invoiceId: string): VersionedCell<LedgerRecord> | undefined {
		return this.cells.get(invoiceId)
	}

	setSepaDraftXml(artifact: SepaDraftArtifact): void {
		this.sepaDraftXmls.set(artifact.invoiceId, artifact)
		this.notifyChange()
	}

	getSepaDraftXml(invoiceId: string): SepaDraftArtifact | undefined {
		return this.sepaDraftXmls.get(invoiceId)
	}

	grantExecution(grant: ApprovedExecutionGrant): void {
		this.executionGrants.set(`${grant.actionName}:${grant.requestId}`, grant)
	}

	consumeExecutionGrant(
		actionName: "propose_sepa_payout" | "propose_refund",
		requestId: string,
	): ApprovedExecutionGrant | undefined {
		const key = `${actionName}:${requestId}`
		const grant = this.executionGrants.get(key)
		if (grant) {
			this.executionGrants.delete(key)
		}
		return grant
	}

	beginExternalWork(): void {
		this.pendingExternalWork += 1
	}

	endExternalWork(): void {
		this.pendingExternalWork = Math.max(0, this.pendingExternalWork - 1)
		this.checkIdle()
	}

	beginLoop(agentName: string, eventType: string, targetId: string): string {
		const spanId = `${agentName}-${++this.auditSeq}-${Date.now()}`
		const span: AgentSpan = {
			spanId,
			agentName,
			eventType,
			targetId,
			startMs: Date.now(),
		}
		this.metrics.activeLoops += 1
		this.metrics.totalLoopsStarted += 1
		if (this.metrics.activeLoops > this.metrics.peakConcurrentLoops) {
			this.metrics.peakConcurrentLoops = this.metrics.activeLoops
		}
		this.metrics.spans.push(span)
		this.activeLoopsByKey.set(spanId, span)
		this.notifyChange()
		return spanId
	}

	attachLoopId(spanId: string, loopId: string): void {
		const span = this.activeLoopsByKey.get(spanId)
		if (span) {
			span.loopId = loopId
			this.notifyChange()
		}
	}

	endLoopByLoopIdOrSpan(loopId: string | undefined, outcome: AgentSpan["outcome"] = "COMPLETED"): void {
		let span: AgentSpan | undefined
		if (loopId) {
			for (const candidate of this.activeLoopsByKey.values()) {
				if (candidate.loopId === loopId) {
					span = candidate
					break
				}
			}
		}
		if (!span) return
		span.endMs = Date.now()
		span.outcome = outcome
		this.activeLoopsByKey.delete(span.spanId)
		this.metrics.activeLoops = Math.max(0, this.metrics.activeLoops - 1)
		this.metrics.totalLoopsFinished += 1
		this.notifyChange()
		this.checkIdle()
	}

	endLoopBySpan(spanId: string, outcome: AgentSpan["outcome"] = "COMPLETED"): void {
		const span = this.activeLoopsByKey.get(spanId)
		if (!span) return
		span.endMs = Date.now()
		span.outcome = outcome
		this.activeLoopsByKey.delete(spanId)
		this.metrics.activeLoops = Math.max(0, this.metrics.activeLoops - 1)
		this.metrics.totalLoopsFinished += 1
		this.notifyChange()
		this.checkIdle()
	}

	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener)
		return () => {
			this.changeListeners.delete(listener)
		}
	}

	notifyChange(): void {
		for (const listener of this.changeListeners) {
			try {
				listener()
			} catch {
				// ignore listener errors
			}
		}
	}

	toSnapshot(opts: { maxCells?: number; maxSpans?: number; maxAudit?: number; newestFirst?: boolean } = {}) {
		let cellEntries = [...this.cells.entries()]
		const totalCellsCount = cellEntries.length
		if (opts.newestFirst) {
			cellEntries = cellEntries.reverse()
		}
		if (opts.maxCells !== undefined && cellEntries.length > opts.maxCells) {
			cellEntries = cellEntries.slice(0, opts.maxCells)
		}
		const cells = cellEntries.map(([invoiceId, cell]) => {
			const snap = cell.read()
			return {
				invoiceId,
				version: snap.version,
				record: snap.value,
			}
		})

		const spans =
			opts.maxSpans !== undefined && this.metrics.spans.length > opts.maxSpans
				? structuredClone(this.metrics.spans.slice(-opts.maxSpans))
				: structuredClone(this.metrics.spans)

		const auditLog =
			opts.maxAudit !== undefined && this.auditLog.length > opts.maxAudit
				? structuredClone(this.auditLog.slice(-opts.maxAudit))
				: structuredClone(this.auditLog)

		return {
			spendingLimitCents: this.spendingLimitCents,
			totalCellsCount,
			maxLlmCalls: this.maxLlmCalls ?? null,
			llmBudgetExhausted: this.isLlmBudgetExhausted(),
			cells,
			unmatchedTxIds: [...this.unmatchedTxIds],
			nonInvoiceFeeTxIds: [...this.nonInvoiceFeeTxIds],
			claims: structuredClone(this.claims),
			rejectedAttempts: structuredClone(this.rejectedAttempts),
			pendingApprovals: [...this.pendingApprovals.values()].map((a) => structuredClone(a)),
			metrics: {
				...structuredClone(this.metrics),
				spans,
			},
			auditLog,
		}
	}

	async waitForIdle(timeoutMs = 15000): Promise<void> {
		if (this.isIdle()) return
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(
					new Error(
						`Timed out waiting for LedgerRuntime idle (activeLoops=${this.metrics.activeLoops}, pendingWork=${this.pendingExternalWork})`,
					),
				)
			}, timeoutMs)

			this.idleWaiters.push(() => {
				clearTimeout(timer)
				resolve()
			})
		})
	}

	isIdle(): boolean {
		return this.metrics.activeLoops === 0 && this.pendingExternalWork === 0
	}

	private checkIdle(): void {
		if (!this.isIdle()) return
		while (this.idleWaiters.length > 0) {
			const waiter = this.idleWaiters.shift()
			waiter?.()
		}
	}

	addClaim(claim: ClaimRecord): void {
		this.claims.push(claim)
		this.logAudit("claim.recorded", claim.producer, claim.invoiceId ?? claim.txId, {
			claimId: claim.claimId,
			kind: claim.kind,
			amountCents: claim.amountCents,
			citations: claim.citations.map((c) => `${c.sourceId}.${c.field}`),
		})
	}

	recordRejection(attempt: Omit<RejectedAttempt, "id" | "timestamp">): RejectedAttempt {
		const entry: RejectedAttempt = {
			...attempt,
			id: `REJ-${this.rejectedAttempts.length + 1}`,
			timestamp: new Date().toISOString(),
		}
		this.rejectedAttempts.push(entry)
		this.logAudit("claim.rejected", entry.agentName, undefined, {
			level: entry.level,
			code: entry.code,
			actionName: entry.actionName,
			reason: entry.reason,
		})
		return entry
	}

	invalidateStaleDrafts(invoiceId: string, newVersion: number, reason: string): number {
		const cell = this.cells.get(invoiceId)
		if (!cell) return 0
		const snap = cell.read()
		let staledCount = 0
		const res = cell.casWrite(snap.version, (current) => {
			const nextDrafts = current.drafts.map((draft) => {
				if (draft.status === "ACTIVE" && draft.basedOnVersion < newVersion) {
					staledCount += 1
					return {
						...draft,
						status: "STALE" as const,
						staleReason: reason,
					}
				}
				return draft
			})
			return {
				...current,
				drafts: nextDrafts,
				notes: staledCount > 0 ? [...current.notes, `STALE: ${reason}`] : current.notes,
			}
		})
		if (res.ok && staledCount > 0) {
			this.metrics.staleInvalidations += staledCount
			this.logAudit("draft.staled", "StrictMatcher", invoiceId, {
				staledCount,
				reason,
				newVersion: res.version,
			})
		}
		return staledCount
	}

	logAudit(type: string, actor: string, targetId: string | undefined, detail: Record<string, unknown>): void {
		this.auditLog.push({
			seq: ++this.auditSeq,
			timestamp: new Date().toISOString(),
			type,
			actor,
			targetId,
			detail,
		})
		this.notifyChange()
	}
}

export function createLedgerRuntime() {
	return defineRuntime<LedgerState>()
}

export type LedgerRuntimeApi = ReturnType<typeof createLedgerRuntime>
export type LedgerEventHandlerContext = {
	event: SemanticEvent
	participant: Participant
}
