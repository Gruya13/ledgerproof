import { SemanticEvent } from "@mozaik-ai/core"
import { formatMoney } from "./engine/currency"
import { resolveLiveProviderFromEnv, resolveMockProvider } from "./engine/provider-factory"
import { ALL_TRAP_KINDS, ContinuousStreamGenerator, type TrapKind } from "./engine/stream-generator"
import { createIngestorParticipant } from "./participants/ingestor"
import { createObserverParticipant } from "./participants/observer"
import { createPayoutAndRefundAgent } from "./participants/payout-refund"
import { createReconcilerAgent } from "./participants/reconciler"
import { createRiskSentinelAgent } from "./participants/risk-sentinel"
import { createSkepticAuditorAgent } from "./participants/skeptic-auditor"
import { createStrictMatcherParticipant } from "./participants/strict-matcher"
import { loadPack } from "./runner-setup"
import {
	ApprovalBroker,
	createLedgerRuntime,
	LedgerState,
	type LedgerRuntimeApi,
} from "./runtime"
import type { ApprovalDecision, BlackFridayPack, PendingApproval } from "./types"

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export type SessionRunStatus = "IDLE" | "RUNNING" | "AWAITING_LATE_OR_APPROVAL" | "COMPLETED"

export interface StartRunOptions {
	mode?: "mock" | "live"
	manualLateSettlement?: boolean
	autoApprovePolicy?: boolean
	staggerMs?: number
}

export interface StartContinuousStreamOptions {
	mode?: "mock" | "live"
	intervalMs?: number
	trapCadence?: number
	autoApprovePolicy?: boolean
	maxLlmCalls?: number
	lateDelayMs?: number
	seed?: number
}

export interface SessionLogEntry {
	id: number
	ts: string
	text: string
}

export class SessionController {
	private readonly pack: BlackFridayPack
	private rt: LedgerRuntimeApi | null = null
	private ingestorId = ""
	private state: LedgerState
	private status: SessionRunStatus = "IDLE"
	private runId = 0
	private mode: "mock" | "live" = "mock"
	private providerLabel = "Offline MockInferenceRunner (0 API keys)"
	private manualLateSettlement = true
	private lateSettlementInjected = false
	private logs: SessionLogEntry[] = []
	private logSeq = 0
	private readonly listeners = new Set<() => void>()
	private readonly pendingApprovalResolvers = new Map<string, (decision: ApprovalDecision) => void>()
	private unsubscribeState: (() => void) | null = null

	// Continuous stream fields
	private isContinuousStream = false
	private streamRunning = false
	private streamPaused = false
	private streamTickCount = 0
	private trapsInjected = 0
	private streamIntervalMs = 1500
	private streamTrapCadence = 3
	private streamLateDelayMs = 3500
	private streamGenerator: ContinuousStreamGenerator | null = null
	private streamTimer: NodeJS.Timeout | null = null
	private readonly pendingTimers = new Set<NodeJS.Timeout>()

	constructor(pack?: BlackFridayPack) {
		this.pack = pack ?? loadPack()
		this.state = new LedgerState(this.pack)
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	private emit(): void {
		for (const listener of this.listeners) {
			try {
				listener()
			} catch {
				// ignore SSE client write errors
			}
		}
	}

	private pushLog(text: string): void {
		this.logs.push({
			id: ++this.logSeq,
			ts: new Date().toISOString(),
			text,
		})
		if (this.logs.length > 250) {
			this.logs.shift()
		}
		this.emit()
	}

	private clearAllTimers(): void {
		if (this.streamTimer) {
			clearInterval(this.streamTimer)
			this.streamTimer = null
		}
		for (const t of this.pendingTimers) {
			clearTimeout(t)
		}
		this.pendingTimers.clear()
	}

	private clearPendingResolvers(reason: string): void {
		for (const [id, resolveFn] of this.pendingApprovalResolvers.entries()) {
			resolveFn({
				approved: false,
				reason,
				decidedBy: "POLICY_AUTO",
			})
			this.pendingApprovalResolvers.delete(id)
		}
	}

	private initializeMozaikSession(
		resolved: NonNullable<ReturnType<typeof resolveLiveProviderFromEnv>> | ReturnType<typeof resolveMockProvider>,
		autoApprovePolicy: boolean,
		stateOptions: { seedInvoices?: boolean; maxLlmCalls?: number } = {},
	): { rt: LedgerRuntimeApi; state: LedgerState; ingestorId: string } {
		const approvalBroker = new ApprovalBroker(async (approval: PendingApproval) => {
			if (autoApprovePolicy) {
				this.pushLog(`[HITL Policy] Auto-rejected ${approval.requestId} (${approval.reason})`)
				return {
					approved: false,
					reason: `Safe policy rejected ${approval.requestId}: ${approval.reason}`,
					decidedBy: "POLICY_AUTO",
				}
			}

			this.pushLog(
				`[ProofGate HITL] Paused ${approval.requestId} (${formatMoney(approval.amountCents, approval.currency)}) — awaiting operator decision`,
			)
			this.emit()

			return await new Promise<ApprovalDecision>((resolveFn) => {
				this.pendingApprovalResolvers.set(approval.approvalId, resolveFn)
			})
		})

		const rt = createLedgerRuntime()
		const state = new LedgerState(this.pack, approvalBroker, stateOptions)
		this.rt = rt
		this.state = state
		this.unsubscribeState = state.onChange(() => this.emit())

		rt.initializeRuntime({
			state,
			inferenceRunnerConfig: resolved.useNativeRunner
				? undefined
				: { runner: resolved.runner },
		})

		const ingestor = createIngestorParticipant()
		const observer = createObserverParticipant(rt, (line) => this.pushLog(line))
		const strictMatcher = createStrictMatcherParticipant(rt)
		const reconciler = createReconcilerAgent(rt, resolved.modelName)
		const payoutRefund = createPayoutAndRefundAgent(rt, resolved.modelName)
		const riskSentinel = createRiskSentinelAgent(rt, resolved.modelName)
		const skepticAuditor = createSkepticAuditorAgent(rt, resolved.modelName)

		rt.join(ingestor)
		rt.join(observer)
		rt.join(strictMatcher)
		rt.join(reconciler)
		rt.join(payoutRefund)
		rt.join(riskSentinel)
		rt.join(skepticAuditor)

		return { rt, state, ingestorId: ingestor.getId() }
	}

	startRun(options: StartRunOptions = {}): { ok: true; runId: number } | { ok: false; error: string } {
		const requestedMode = options.mode ?? "mock"
		const resolved =
			requestedMode === "live" ? resolveLiveProviderFromEnv() : resolveMockProvider()

		if (!resolved) {
			return {
				ok: false,
				error:
					"No live LLM API key found in .env (DEEPSEEK_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY). Switch to Mock Mode or configure .env.",
			}
		}

		this.clearAllTimers()
		this.clearPendingResolvers("Superseded by new run")
		this.unsubscribeState?.()

		const currentRunId = ++this.runId
		this.isContinuousStream = false
		this.streamRunning = false
		this.streamPaused = false
		this.streamTickCount = 0
		this.trapsInjected = 0
		this.streamGenerator = null
		this.mode = resolved.mode
		this.providerLabel = resolved.label
		this.manualLateSettlement = options.manualLateSettlement ?? true
		this.lateSettlementInjected = false
		this.logs = []
		this.status = "RUNNING"

		const { rt, state, ingestorId } = this.initializeMozaikSession(
			resolved,
			options.autoApprovePolicy ?? false,
			{ seedInvoices: true },
		)
		this.ingestorId = ingestorId

		const staggerMs = options.staggerMs ?? 90
		this.pushLog(`Started Black Friday stream (${resolved.label})`)
		this.emit()

		void this.executeWaves(currentRunId, rt, state, ingestorId, staggerMs)
		return { ok: true, runId: currentRunId }
	}

	startContinuousStream(
		options: StartContinuousStreamOptions = {},
	): { ok: true; runId: number } | { ok: false; error: string } {
		const requestedMode = options.mode ?? "mock"
		const resolved =
			requestedMode === "live" ? resolveLiveProviderFromEnv() : resolveMockProvider()

		if (!resolved) {
			return {
				ok: false,
				error:
					"No live LLM API key found in .env (DEEPSEEK_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY). Switch to Mock Mode or configure .env.",
			}
		}

		this.clearAllTimers()
		this.clearPendingResolvers("Superseded by continuous stream")
		this.unsubscribeState?.()

		const currentRunId = ++this.runId
		this.isContinuousStream = true
		this.streamRunning = true
		this.streamPaused = false
		this.streamTickCount = 0
		this.trapsInjected = 0
		this.streamIntervalMs = Math.max(80, options.intervalMs ?? 1500)
		this.streamTrapCadence = Math.max(2, options.trapCadence ?? 3)
		this.streamLateDelayMs = Math.max(80, options.lateDelayMs ?? (resolved.mode === "live" ? 7000 : 3500))
		this.manualLateSettlement = false
		this.lateSettlementInjected = false
		this.mode = resolved.mode
		this.providerLabel = resolved.label
		this.logs = []
		this.status = "RUNNING"
		this.streamGenerator = new ContinuousStreamGenerator(this.pack.vendors, { seed: options.seed })

		const maxLlmCalls =
			options.maxLlmCalls !== undefined
				? options.maxLlmCalls
				: resolved.mode === "live"
					? 40
					: undefined

		const { ingestorId } = this.initializeMozaikSession(
			resolved,
			options.autoApprovePolicy ?? false,
			{ seedInvoices: false, maxLlmCalls },
		)
		this.ingestorId = ingestorId

		this.pushLog(
			`Started Continuous Chaos Stream (${resolved.label}, seed=${this.streamGenerator.seed}, interval=${this.streamIntervalMs}ms, trap every ${this.streamTrapCadence} ticks${maxLlmCalls ? `, maxLlmCalls=${maxLlmCalls}` : ""})`,
		)

		// Fire initial tick immediately, then schedule interval ticks
		void this.runStreamTick(currentRunId)
		this.scheduleStreamInterval(currentRunId)
		this.emit()

		return { ok: true, runId: currentRunId }
	}

	private scheduleStreamInterval(expectedRunId: number): void {
		if (this.streamTimer) {
			clearInterval(this.streamTimer)
		}
		this.streamTimer = setInterval(() => {
			if (this.runId !== expectedRunId || !this.streamRunning || this.streamPaused) {
				return
			}
			void this.runStreamTick(expectedRunId)
		}, this.streamIntervalMs)
	}

	private async runStreamTick(expectedRunId: number, forceTrap?: TrapKind): Promise<void> {
		if (this.runId !== expectedRunId || !this.rt || !this.streamGenerator) return

		if (this.state.isLlmBudgetExhausted()) {
			this.streamPaused = true
			if (this.streamTimer) {
				clearInterval(this.streamTimer)
				this.streamTimer = null
			}
			this.pushLog(
				`[Budget Guard] Auto-paused Continuous Stream after reaching ${this.state.metrics.llmCalls}/${this.state.getMaxLlmCalls()} Live LLM calls.`,
			)
			this.emit()
			return
		}

		const batch = this.streamGenerator.nextTick({
			forceTrap,
			trapCadence: this.streamTrapCadence,
		})
		this.streamTickCount = batch.tickNumber
		if (batch.trapKind) {
			this.trapsInjected += 1
		}
		this.pushLog(`[Stream #${batch.tickNumber}] ${batch.label}`)

		const rt = this.rt
		const state = this.state
		const ingestorId = this.ingestorId

		for (const inv of batch.invoices) {
			if (this.runId !== expectedRunId) return
			state.registerInvoice(inv)
			rt.sendEvent(SemanticEvent.create("invoice.arrived", ingestorId, { invoice: inv }), ingestorId)
		}

		for (const tx of batch.transactions) {
			if (this.runId !== expectedRunId) return
			state.registerTransaction(tx)
			rt.sendEvent(SemanticEvent.create("transaction.arrived", ingestorId, { transaction: tx }), ingestorId)
		}

		if (batch.requests.length > 0 || batch.concurrentFraudAlerts.length > 0) {
			const timer = setTimeout(() => {
				this.pendingTimers.delete(timer)
				if (this.runId !== expectedRunId || !this.rt) return

				for (const req of batch.requests) {
					state.registerRequest(req)
					rt.sendEvent(SemanticEvent.create("request.arrived", ingestorId, { request: req }), ingestorId)
				}
				for (const alertTx of batch.concurrentFraudAlerts) {
					state.registerTransaction(alertTx)
					rt.sendEvent(
						SemanticEvent.create("transaction.arrived", ingestorId, { transaction: alertTx }),
						ingestorId,
					)
				}
			}, 20)
			this.pendingTimers.add(timer)
		}

		if (batch.delayedTransactions.length > 0) {
			const timer = setTimeout(() => {
				this.pendingTimers.delete(timer)
				if (this.runId !== expectedRunId || !this.rt) return
				for (const lateTx of batch.delayedTransactions) {
					state.registerTransaction(lateTx)
					this.pushLog(`[Stream Late] Injecting ${lateTx.sourceId} for ${lateTx.reference}`)
					rt.sendEvent(
						SemanticEvent.create("settlement.late", ingestorId, { transaction: lateTx }),
						ingestorId,
					)
				}
			}, this.streamLateDelayMs)
			this.pendingTimers.add(timer)
		}

		this.emit()
	}

	pauseContinuousStream(): { ok: boolean; error?: string } {
		if (!this.isContinuousStream || !this.streamRunning) {
			return { ok: false, error: "No active continuous stream to pause." }
		}
		this.streamPaused = true
		if (this.streamTimer) {
			clearInterval(this.streamTimer)
			this.streamTimer = null
		}
		this.pushLog("[Stream] Paused continuous generator (in-flight loops & HITL remain live).")
		this.emit()
		return { ok: true }
	}

	resumeContinuousStream(): { ok: boolean; error?: string } {
		if (!this.isContinuousStream || !this.streamRunning) {
			return { ok: false, error: "No active continuous stream to resume." }
		}
		if (this.state.isLlmBudgetExhausted()) {
			return { ok: false, error: "Live LLM call budget reached; start a new run or switch to Mock Mode." }
		}
		this.streamPaused = false
		this.scheduleStreamInterval(this.runId)
		this.pushLog("[Stream] Resumed continuous generator.")
		this.emit()
		return { ok: true }
	}

	stopContinuousStream(): { ok: boolean } {
		this.clearAllTimers()
		this.streamRunning = false
		this.streamPaused = false
		if (this.isContinuousStream) {
			this.status = "COMPLETED"
			this.pushLog("[Stream] Stopped continuous generator.")
		}
		this.emit()
		return { ok: true }
	}

	injectStreamTrap(kind?: TrapKind): { ok: boolean; trapKind?: TrapKind; error?: string } {
		if (!this.isContinuousStream || !this.rt || !this.streamGenerator) {
			return { ok: false, error: "Start Continuous Stream first before injecting a stream trap." }
		}
		const chosen = kind ?? ALL_TRAP_KINDS[this.trapsInjected % ALL_TRAP_KINDS.length]
		void this.runStreamTick(this.runId, chosen)
		return { ok: true, trapKind: chosen }
	}

	async waitForCurrentIdle(timeoutMs = 15000): Promise<void> {
		await this.state.waitForIdle(timeoutMs)
	}

	private async executeWaves(
		currentRunId: number,
		rt: LedgerRuntimeApi,
		state: LedgerState,
		ingestorId: string,
		staggerMs: number,
	): Promise<void> {
		state.beginExternalWork()
		try {
			for (const invoice of this.pack.invoices) {
				if (this.runId !== currentRunId) return
				state.markInvoiceArrived(invoice.sourceId)
				rt.sendEvent(SemanticEvent.create("invoice.arrived", ingestorId, { invoice }), ingestorId)
			}

			for (const tx of this.pack.transactions) {
				if (this.runId !== currentRunId) return
				if (tx.late || tx.kind === "fraud_alert") continue
				rt.sendEvent(SemanticEvent.create("transaction.arrived", ingestorId, { transaction: tx }), ingestorId)
				if (staggerMs > 0 && (tx.sourceId === "TX-2006" || tx.sourceId === "TX-2008")) {
					await sleep(staggerMs)
				}
			}

			await sleep(Math.max(30, staggerMs))
			if (this.runId !== currentRunId) return

			for (const request of this.pack.requests) {
				if (this.runId !== currentRunId) return
				state.markRequestArrived(request.sourceId)
				rt.sendEvent(SemanticEvent.create("request.arrived", ingestorId, { request }), ingestorId)
				if (request.concurrentWithAlert) {
					const fraudTx = this.pack.transactions.find(
						(t) => t.kind === "fraud_alert" && t.reference === request.invoiceId,
					)
					if (fraudTx) {
						rt.sendEvent(
							SemanticEvent.create("transaction.arrived", ingestorId, { transaction: fraudTx }),
							ingestorId,
						)
					}
				}
				if (staggerMs > 0) {
					await sleep(Math.round(staggerMs * 0.6))
				}
			}

			if (!this.manualLateSettlement) {
				const deadline = Date.now() + 4000
				while (Date.now() < deadline && this.runId === currentRunId) {
					const inv1007 = state.getCell("INV-1007")?.read().value
					if (inv1007 && inv1007.drafts.some((d) => d.status === "ACTIVE")) {
						break
					}
					await sleep(25)
				}
				if (this.runId === currentRunId) {
					this.dispatchLateSettlement(rt, state, ingestorId)
				}
			}
		} finally {
			state.endExternalWork()
		}

		try {
			await state.waitForIdle(60000)
			if (this.runId === currentRunId) {
				this.status =
					this.manualLateSettlement && !this.lateSettlementInjected
						? "AWAITING_LATE_OR_APPROVAL"
						: "COMPLETED"
				this.emit()
			}
		} catch (err) {
			if (this.runId === currentRunId) {
				this.pushLog(`Run error: ${err instanceof Error ? err.message : String(err)}`)
				this.status = "COMPLETED"
				this.emit()
			}
		}
	}

	private dispatchLateSettlement(rt: LedgerRuntimeApi, state: LedgerState, ingestorId: string): number {
		const lateTxs = this.pack.transactions.filter((t) => t.late)
		for (const tx of lateTxs) {
			rt.sendEvent(SemanticEvent.create("settlement.late", ingestorId, { transaction: tx }), ingestorId)
		}
		this.lateSettlementInjected = true
		this.pushLog(`[Ingestor] Injected late settlement ${lateTxs.map((t) => t.sourceId).join(", ")}`)
		state.notifyChange()
		return lateTxs.length
	}

	injectLateSettlement(): { ok: boolean; error?: string } {
		if (!this.rt || !this.ingestorId || this.isContinuousStream) {
			return { ok: false, error: "No active fixed-pack run. Start Interactive Stream first." }
		}
		if (this.lateSettlementInjected) {
			return { ok: false, error: "Late settlement TX-2017 was already injected in this run." }
		}

		this.dispatchLateSettlement(this.rt, this.state, this.ingestorId)

		const currentRunId = this.runId
		void this.state.waitForIdle(20000).then(() => {
			if (this.runId === currentRunId && this.pendingApprovalResolvers.size === 0) {
				this.status = "COMPLETED"
				this.emit()
			}
		})

		return { ok: true }
	}

	resolveApproval(
		approvalId: string,
		approved: boolean,
		reason?: string,
	): { ok: boolean; error?: string } {
		const resolver = this.pendingApprovalResolvers.get(approvalId)
		if (!resolver) {
			return { ok: false, error: `Pending approval "${approvalId}" not found` }
		}
		this.pendingApprovalResolvers.delete(approvalId)
		const finalReason =
			reason?.trim() || (approved ? "Approved by operator in Web UI" : "Rejected by operator in Web UI")
		this.pushLog(`[Human Approver] ${approved ? "APPROVED" : "REJECTED"} ${approvalId}: ${finalReason}`)
		resolver({
			approved,
			reason: finalReason,
			decidedBy: "HUMAN_INTERACTIVE",
		})
		this.emit()
		return { ok: true }
	}

	getSource(sourceId: string) {
		return this.state.sourceStore.get(sourceId)
	}

	getSepaDraftXml(invoiceId: string) {
		return this.state.getSepaDraftXml(invoiceId)
	}

	getAuditJsonl(): string {
		return this.state.auditLog.map((e) => JSON.stringify(e)).join("\n") + (this.state.auditLog.length ? "\n" : "")
	}

	getSnapshot(options: { full?: boolean } = {}) {
		const live = resolveLiveProviderFromEnv()
		const inv1007 = this.state.getCell("INV-1007")?.read().value
		const canInjectLateSettlement =
			!this.isContinuousStream &&
			this.rt !== null &&
			this.manualLateSettlement &&
			!this.lateSettlementInjected &&
			Boolean(inv1007?.drafts.some((d) => d.status === "ACTIVE"))

		const snapshotState =
			this.isContinuousStream && !options.full
				? this.state.toSnapshot({ maxCells: 60, maxSpans: 60, maxAudit: 120, newestFirst: true })
				: this.state.toSnapshot()

		return {
			runId: this.runId,
			status: this.status,
			mode: this.mode,
			providerLabel: this.providerLabel,
			availableLiveProvider: live ? { provider: live.provider, label: live.label } : null,
			manualLateSettlement: this.manualLateSettlement,
			lateSettlementInjected: this.lateSettlementInjected,
			canInjectLateSettlement,
			stream: {
				active: this.isContinuousStream,
				running: this.streamRunning,
				paused: this.streamPaused,
				tickCount: this.streamTickCount,
				trapsInjected: this.trapsInjected,
				intervalMs: this.streamIntervalMs,
				seed: this.streamGenerator?.seed ?? null,
			},
			disclaimer: this.pack.disclaimer,
			logs: [...this.logs],
			...snapshotState,
		}
	}
}
