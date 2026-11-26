export interface Vendor {
	sourceId: string
	name: string
	masterIban: string
	country: string
	verifiedAt: string
}

export interface Invoice {
	sourceId: string
	vendorId: string
	poNumber: string
	amountCents: number
	currency: string
	issuedAt: string
	dueDate: string
	description: string
}

export type TransactionKind =
	| "bank_transfer"
	| "card_capture"
	| "gateway_fee"
	| "wire"
	| "payout_settlement"
	| "fraud_alert"

export interface BankTransaction {
	sourceId: string
	kind: TransactionKind
	reference: string
	vendorId: string | null
	amountCents: number
	currency: string
	bookedAt: string
	memo: string
	late: boolean
}

export type RequestKind = "sepa_payout" | "refund"

export interface PaymentRequest {
	sourceId: string
	kind: RequestKind
	invoiceId: string
	vendorId: string
	amountCents: number
	currency: string
	targetIban: string | null
	requestedBy: string
	reason: string
	concurrentWithAlert: boolean
}

export interface BlackFridayPack {
	packId: string
	disclaimer: string
	spendingLimitCents: number
	vendors: Vendor[]
	invoices: Invoice[]
	transactions: BankTransaction[]
	requests: PaymentRequest[]
}

export type SourceEntity =
	| { kind: "vendor"; data: Vendor; sha256: string }
	| { kind: "invoice"; data: Invoice; sha256: string }
	| { kind: "transaction"; data: BankTransaction; sha256: string }
	| { kind: "request"; data: PaymentRequest; sha256: string }

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

export type RiskFlag =
	| "DUPLICATE_INVOICE"
	| "BEC_IBAN_CHANGE"
	| "FRAUD_VELOCITY"
	| "WRITE_SKEW_COLLISION"

export interface PendingDraft {
	draftId: string
	kind: "overdue_chase" | "sepa_draft" | "refund_draft"
	amountCents: number
	basedOnVersion: number
	status: "ACTIVE" | "STALE" | "EXECUTED" | "REJECTED"
	staleReason?: string
	createdBy: string
	createdAt: string
	citations: Citation[]
}

export interface LedgerRecord {
	invoiceId: string
	vendorId: string
	expectedAmountCents: number
	paidAmountCents: number
	currency: string
	status: LedgerStatus
	matchedTxIds: string[]
	riskFlags: RiskFlag[]
	sepaDraft?: {
		requestId: string
		amountCents: number
		targetIban: string
		approvedBy: "AUTO_POLICY" | "HUMAN"
	}
	drafts: PendingDraft[]
	notes: string[]
}

export interface ClaimRecord {
	claimId: string
	invoiceId?: string
	txId?: string
	producer: string
	kind: "EXACT_MATCH" | "SPLIT_MATCH" | "PARTIAL_MATCH" | "ORPHAN_TX" | "RISK_FLAG" | "SEPA_DRAFT" | "REFUND" | "CHASE_DRAFT"
	amountCents: number
	summary: string
	citations: Citation[]
	auditStatus: "PENDING" | "CONFIRMED" | "REFUTED" | "NEEDS_HUMAN"
	auditorNote?: string
	createdAt: string
}

export interface RejectedAttempt {
	id: string
	level: "L1_SOURCE_OR_MATH" | "L2_CAS_WRITE_SKEW" | "L3_HUMAN_REJECTED" | "L2_ADVERSARIAL_REFUTED"
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
	reason: string
	riskFlags: RiskFlag[]
	citations: Citation[]
}

export interface ApprovalDecision {
	approved: boolean
	reason: string
	decidedBy: "HUMAN_INTERACTIVE" | "POLICY_AUTO"
}

export interface AgentSpan {
	spanId: string
	loopId?: string
	agentName: string
	eventType: string
	targetId: string
	startMs: number
	endMs?: number
	outcome?: "COMPLETED" | "BLOCKED" | "CONFLICT" | "ERROR"
}

export interface AuditEntry {
	seq: number
	timestamp: string
	type: string
	actor: string
	targetId?: string
	detail: Record<string, unknown>
}

export interface ConcurrencyMetrics {
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

export interface GroundTruthSpec {
	expectedInvoices: Record<
		string,
		{
			allowedStatuses: LedgerStatus[]
			requiredTxIds: string[]
			requiredRiskFlag?: RiskFlag
		}
	>
	expectedUnmatchedTxIds: string[]
	requiredMetrics: {
		minPeakConcurrentLoops: number
		minCasConflictsPrevented: number
		minUncitedNumbersBlocked: number
		maxInventedNumbersLeaked: number
		minStaleInvalidations: number
		minHumanApprovalsRouted: number
	}
}
