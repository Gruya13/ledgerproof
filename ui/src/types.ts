export interface Citation {
	sourceId: string
	field: string
	expectedValue: string | number
}

export type LedgerStatus =
	| "OPEN"
	| "PARTIAL"
	| "MATCHED"
	| "DUPLICATE"
	| "HOLD_RISK"
	| "SEPA_DRAFT_READY"
	| "REFUNDED"
	| "NEEDS_HUMAN"

export interface PendingDraft {
	draftId: string
	kind: string
	amountCents: number
	basedOnVersion: number
	status: "ACTIVE" | "STALE" | "EXECUTED" | "REJECTED"
	staleReason?: string
}

export interface LedgerRecord {
	invoiceId: string
	vendorId: string
	expectedAmountCents: number
	paidAmountCents: number
	currency: string
	status: LedgerStatus
	matchedTxIds: string[]
	riskFlags: string[]
	sepaDraft?: {
		requestId: string
		amountCents: number
		currency: string
		targetIban: string
		approvedBy: string
		pain001MessageId: string
		xmlSha256: string
	}
	drafts: PendingDraft[]
	notes: string[]
}

export interface CellSnapshot {
	invoiceId: string
	version: number
	record: LedgerRecord
}

export interface ClaimRecord {
	claimId: string
	invoiceId?: string
	txId?: string
	producer: string
	kind: string
	amountCents: number
	currency?: string
	summary: string
	citations: Citation[]
	auditStatus: "PENDING" | "CONFIRMED" | "REFUTED" | "NEEDS_HUMAN"
	auditorNote?: string
	createdAt: string
}

export interface RejectedAttempt {
	id: string
	level: string
	code: string
	agentName: string
	actionName: string
	reason: string
	rawArgs?: unknown
	timestamp: string
}

export interface PendingApproval {
	approvalId: string
	invoiceId: string
	requestId: string
	agentName: string
	actionName: string
	amountCents: number
	currency?: string
	reason: string
	riskFlags: string[]
	citations: Citation[]
}

export interface AgentSpan {
	spanId: string
	loopId?: string
	agentName: string
	eventType: string
	targetId: string
	startMs: number
	endMs?: number
	outcome?: string
}

export interface SessionSnapshot {
	runId: number
	status: "IDLE" | "RUNNING" | "AWAITING_LATE_OR_APPROVAL" | "COMPLETED"
	mode: "mock" | "live"
	providerLabel: string
	availableLiveProvider: { provider: string; label: string } | null
	manualLateSettlement: boolean
	lateSettlementInjected: boolean
	canInjectLateSettlement: boolean
	totalCellsCount: number
	maxLlmCalls: number | null
	llmBudgetExhausted: boolean
	stream: {
		active: boolean
		running: boolean
		paused: boolean
		tickCount: number
		trapsInjected: number
		intervalMs: number
	}
	disclaimer: string
	spendingLimitCents: number
	logs: Array<{ id: number; ts: string; text: string }>
	cells: CellSnapshot[]
	unmatchedTxIds: string[]
	nonInvoiceFeeTxIds: string[]
	claims: ClaimRecord[]
	rejectedAttempts: RejectedAttempt[]
	pendingApprovals: PendingApproval[]
	metrics: {
		activeLoops: number
		peakConcurrentLoops: number
		totalLoopsStarted: number
		totalLoopsFinished: number
		deterministicMatches: number
		llmCalls: number
		casConflictsPrevented: number
		uncitedNumbersBlocked: number
		inventedNumbersLeaked: number
		staleInvalidations: number
		humanApprovalsRouted: number
		spans: AgentSpan[]
	}
}

export interface SourceInspectPayload {
	ok: boolean
	sourceId: string
	entity: {
		kind: string
		sha256: string
		data: Record<string, unknown>
	}
}
