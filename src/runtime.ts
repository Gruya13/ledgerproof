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
	BlackFridayPack,
	ClaimRecord,
	ConcurrencyMetrics,
	LedgerRecord,
	PendingApproval,
	RejectedAttempt,
} from "./types"
import { SourceStore } from "./engine/source-store"
import { VersionedCell } from "./engine/versioned-cell"

export type ApprovalHandler = (approval: PendingApproval) => Promise<ApprovalDecision>

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
	readonly auditLog: AuditEntry[] = []
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
	private pendingExternalWork = 0
	private auditSeq = 0

	constructor(pack: BlackFridayPack, approvalBroker?: ApprovalBroker) {
		super()
		this.sourceStore = SourceStore.fromPack(pack)
		this.spendingLimitCents = pack.spendingLimitCents
		this.approvalBroker = approvalBroker ?? new ApprovalBroker()

		for (const inv of pack.invoices) {
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
		return spanId
	}

	attachLoopId(spanId: string, loopId: string): void {
		const span = this.activeLoopsByKey.get(spanId)
		if (span) {
			span.loopId = loopId
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
		this.checkIdle()
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
