import { useEffect, useState } from "react"
import { SourceDrawer, type SepaXmlPreview } from "./components/SourceDrawer"
import { SwimlaneChart } from "./components/SwimlaneChart"
import type { SessionSnapshot, SourceInspectPayload } from "./types"

type LedgerFilter = "ALL" | "MATCHED" | "SEPA_DRAFT_READY" | "HOLD_RISK" | "DUPLICATE" | "OTHER"

function formatMoney(cents: number, currency = "USD"): string {
	const formatted = (cents / 100).toFixed(2)
	if (currency === "EUR") return `€${formatted}`
	if (currency === "USD") return `$${formatted}`
	return `${currency} ${formatted}`
}

function statusBadgeClass(status: string): string {
	switch (status) {
		case "MATCHED":
			return "badge badge-matched"
		case "SEPA_DRAFT_READY":
			return "badge badge-sepa"
		case "REFUNDED":
			return "badge badge-stale"
		case "PARTIAL":
			return "badge badge-partial"
		case "DUPLICATE":
		case "HOLD_RISK":
		case "NEEDS_HUMAN":
			return "badge badge-risk"
		default:
			return "badge badge-open"
	}
}

function logToneClass(text: string): string {
	if (text.includes("[ProofGate BLOCKED]") || text.includes("REJECTED") || text.includes("[Budget Guard]")) {
		return "tone-risk"
	}
	if (text.includes("[ProofGate CAS]") || text.includes("[ProofGate HITL]") || text.includes("TRAP [")) {
		return "tone-warn"
	}
	if (text.includes("[Palimpsest STALE]")) return "tone-stale"
	if (text.includes("[Human Approver] APPROVED") || text.includes("[SkepticAuditor]")) return "tone-good"
	if (text.includes("BENIGN [") || text.includes("[Reconciler]")) return "tone-info"
	return ""
}

function getClientSessionId(): string {
	try {
		const existing = window.sessionStorage.getItem("ledgerproof_session_id")
		if (existing && /^[a-zA-Z0-9_-]{1,64}$/.test(existing)) {
			return existing
		}
		const generated =
			typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
				? crypto.randomUUID()
				: `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
		window.sessionStorage.setItem("ledgerproof_session_id", generated)
		return generated
	} catch {
		return `sess-${Date.now().toString(36)}`
	}
}

function withSession(path: string, sessionId: string): string {
	const sep = path.includes("?") ? "&" : "?"
	return `${path}${sep}session=${encodeURIComponent(sessionId)}`
}

export function App() {
	const [sessionId] = useState(getClientSessionId)
	const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null)
	const [sseConnected, setSseConnected] = useState(false)
	const [mode, setMode] = useState<"mock" | "live">("mock")
	const [tab, setTab] = useState<"ledger" | "rejected" | "claims">("ledger")
	const [ledgerFilter, setLedgerFilter] = useState<LedgerFilter>("ALL")
	const [ledgerQuery, setLedgerQuery] = useState("")
	const [trapKind, setTrapKind] = useState<string>("")
	const [actionError, setActionError] = useState<string | null>(null)
	const [selectedSource, setSelectedSource] = useState<SourceInspectPayload | null>(null)
	const [selectedSepaXml, setSelectedSepaXml] = useState<SepaXmlPreview | null>(null)
	const [sourceLoading, setSourceLoading] = useState(false)
	const [sourceError, setSourceError] = useState<string | null>(null)

	useEffect(() => {
		let active = true
		fetch(withSession("/api/state", sessionId))
			.then((r) => r.json())
			.then((data: SessionSnapshot) => {
				if (active) setSnapshot(data)
			})
			.catch((err) => {
				if (active) setActionError(String(err))
			})

		const es = new EventSource(withSession("/api/events", sessionId))
		es.onopen = () => {
			if (active) setSseConnected(true)
		}
		es.onerror = () => {
			if (active) setSseConnected(false)
		}
		es.addEventListener("snapshot", (ev) => {
			if (!active) return
			setSseConnected(true)
			try {
				setSnapshot(JSON.parse((ev as MessageEvent).data) as SessionSnapshot)
			} catch {
				// ignore malformed SSE packet
			}
		})

		return () => {
			active = false
			es.close()
		}
	}, [sessionId])

	async function inspectSource(id: string) {
		setSourceLoading(true)
		setSourceError(null)
		setSelectedSepaXml(null)
		try {
			const res = await fetch(withSession(`/api/source/${encodeURIComponent(id)}`, sessionId))
			const data = (await res.json()) as SourceInspectPayload & { error?: string }
			if (!res.ok) {
				setSourceError(data.error ?? `Source ${id} not found`)
			} else {
				setSelectedSource(data)
			}
		} catch (err) {
			setSourceError(String(err))
		} finally {
			setSourceLoading(false)
		}
	}

	async function inspectSepaXml(
		invoiceId: string,
		sepaDraft: { requestId: string; pain001MessageId: string; xmlSha256: string },
	) {
		setSourceLoading(true)
		setSourceError(null)
		setSelectedSource(null)
		try {
			const res = await fetch(withSession(`/api/sepa/${encodeURIComponent(invoiceId)}.xml?inline=1`, sessionId))
			if (!res.ok) {
				const errJson = (await res.json().catch(() => ({}))) as { error?: string }
				setSourceError(errJson.error ?? `Failed to load SEPA pain.001 XML for ${invoiceId}`)
			} else {
				const xml = await res.text()
				setSelectedSepaXml({
					invoiceId,
					requestId: sepaDraft.requestId,
					messageId: sepaDraft.pain001MessageId,
					sha256: sepaDraft.xmlSha256,
					xml,
				})
			}
		} catch (err) {
			setSourceError(String(err))
		} finally {
			setSourceLoading(false)
		}
	}

	async function startRun(manualLateSettlement: boolean, autoApprovePolicy: boolean) {
		setActionError(null)
		const res = await fetch(withSession("/api/run", sessionId), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mode,
				manualLateSettlement,
				autoApprovePolicy,
			}),
		})
		const data = (await res.json()) as { ok: boolean; error?: string }
		if (!res.ok || !data.ok) {
			setActionError(data.error ?? "Failed to start run")
		}
	}

	async function handleApproval(approvalId: string, approved: boolean) {
		setActionError(null)
		const res = await fetch(withSession(`/api/approvals/${encodeURIComponent(approvalId)}`, sessionId), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				approved,
				reason: approved
					? "Operator approved in LedgerProof Web UI"
					: "Operator rejected due to BEC IBAN mismatch / risk",
			}),
		})
		const data = (await res.json()) as { ok: boolean; error?: string }
		if (!res.ok || !data.ok) {
			setActionError(data.error ?? "Failed to submit approval")
		}
	}

	async function handleInjectLate() {
		setActionError(null)
		const res = await fetch(withSession("/api/inject-late", sessionId), { method: "POST" })
		const data = (await res.json()) as { ok: boolean; error?: string }
		if (!res.ok || !data.ok) {
			setActionError(data.error ?? "Failed to inject late settlement")
		}
	}

	async function callStreamApi(endpoint: string, body?: Record<string, unknown>) {
		setActionError(null)
		const res = await fetch(withSession(endpoint, sessionId), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body ?? {}),
		})
		const data = (await res.json()) as { ok: boolean; error?: string }
		if (!res.ok || !data.ok) {
			setActionError(data.error ?? `Stream action ${endpoint} failed`)
		}
	}

	function renderLogWithCitations(text: string) {
		const parts = text.split(/(\[src:[A-Z]+-\d+\])/g)
		return parts.map((part, idx) => {
			const match = part.match(/^\[src:([A-Z]+-\d+)\]$/)
			if (match) {
				return (
					<button
						key={idx}
						type="button"
						className="src-pill mono"
						onClick={() => void inspectSource(match[1])}
					>
						{match[1]}
					</button>
				)
			}
			return <span key={idx}>{part}</span>
		})
	}

	const m = snapshot?.metrics
	const cells = snapshot?.cells ?? []
	const normalizedQuery = ledgerQuery.trim().toLowerCase()

	const filterCounts: Record<LedgerFilter, number> = {
		ALL: cells.length,
		MATCHED: cells.filter((c) => c.record.status === "MATCHED").length,
		SEPA_DRAFT_READY: cells.filter((c) => c.record.status === "SEPA_DRAFT_READY").length,
		HOLD_RISK: cells.filter((c) => c.record.status === "HOLD_RISK" || c.record.status === "NEEDS_HUMAN").length,
		DUPLICATE: cells.filter((c) => c.record.status === "DUPLICATE").length,
		OTHER: cells.filter((c) => c.record.status === "PARTIAL" || c.record.status === "REFUNDED" || c.record.status === "OPEN").length,
	}

	const filteredCells = cells.filter(({ invoiceId, record }) => {
		const statusMatches =
			ledgerFilter === "ALL" ||
			(ledgerFilter === "HOLD_RISK"
				? record.status === "HOLD_RISK" || record.status === "NEEDS_HUMAN"
				: ledgerFilter === "OTHER"
					? record.status === "PARTIAL" || record.status === "REFUNDED" || record.status === "OPEN"
					: record.status === ledgerFilter)
		if (!statusMatches) return false
		if (!normalizedQuery) return true
		return (
			invoiceId.toLowerCase().includes(normalizedQuery) ||
			record.vendorId.toLowerCase().includes(normalizedQuery) ||
			record.matchedTxIds.some((tx) => tx.toLowerCase().includes(normalizedQuery)) ||
			record.status.toLowerCase().includes(normalizedQuery)
		)
	})

	const budgetMax = snapshot?.maxLlmCalls ?? null
	const budgetUsed = m?.llmCalls ?? 0
	const budgetPct = budgetMax ? Math.min(100, Math.round((budgetUsed / budgetMax) * 100)) : 0

	return (
		<div className="app-shell">
			<div className="disclaimer-bar">
				<span>
					<strong>Compliance Notice:</strong> {snapshot?.disclaimer ?? "100% synthetic data only. Not financial advice."}
				</span>
				<span className="status-cluster mono">
					<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
						<span className={`live-dot ${sseConnected ? "" : "offline"}`} />
						SSE {sseConnected ? "LIVE" : "RECONNECTING"}
					</span>
					<span>·</span>
					<span>
						Status: <strong>{snapshot?.status ?? "CONNECTING"}</strong>
					</span>
					<span>·</span>
					<span>{snapshot?.providerLabel ?? "Mozaik @6.0.0"}</span>
				</span>
			</div>

			<header className="topbar">
				<div className="brand-wrap">
					<div className="brand-icon" aria-hidden="true">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
							<path
								d="M12 2.5L20 6V11.8C20 16.9 16.6 21.1 12 22.5C7.4 21.1 4 16.9 4 11.8V6L12 2.5Z"
								stroke="#38bdf8"
								strokeWidth="1.8"
							/>
							<path
								d="M8.5 12.2L10.8 14.5L15.8 9.5"
								stroke="#10b981"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</div>
					<div className="brand">
						<h1>
							LedgerProof <span className="brand-tag">Mozaik @6.0.0 · ProofGate Treasury</span>
						</h1>
						<p>
							Concurrent Black Friday reconciliation, BEC/fraud risk locks, CAS write-skew defense &amp; ISO 20022 SEPA <span className="mono">pain.001</span>.
						</p>
					</div>
				</div>

				<div className="controls">
					<div className="mode-switch">
						<button
							type="button"
							className={`mode-btn ${mode === "mock" ? "active" : ""}`}
							onClick={() => setMode("mock")}
						>
							Mock Mode (0 keys)
						</button>
						<button
							type="button"
							className={`mode-btn ${mode === "live" ? "active" : ""}`}
							disabled={!snapshot?.availableLiveProvider}
							title={
								snapshot?.availableLiveProvider
									? `Use ${snapshot.availableLiveProvider.label}`
									: "Set DEEPSEEK_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY in .env"
							}
							onClick={() => setMode("live")}
						>
							{snapshot?.availableLiveProvider
								? `Live: ${snapshot.availableLiveProvider.provider.toUpperCase()}`
								: "Live LLM (no key)"}
						</button>
					</div>

					<button
						type="button"
						className="btn btn-primary"
						onClick={() => void startRun(true, false)}
					>
						Start Interactive Stream
					</button>

					<button
						type="button"
						className="btn"
						onClick={() => void startRun(false, true)}
					>
						Run Full Auto
					</button>

					<button
						type="button"
						className={`btn ${snapshot?.canInjectLateSettlement ? "btn-amber" : ""}`}
						disabled={!snapshot?.canInjectLateSettlement}
						onClick={() => void handleInjectLate()}
					>
						{snapshot?.lateSettlementInjected ? "TX-2017 Settled" : "Inject Late Settlement (TX-2017)"}
					</button>

					<a className="btn" href={withSession("/api/audit.jsonl", sessionId)} download="ledgerproof-audit-trace.jsonl">
						Export JSONL
					</a>
				</div>
			</header>

			{actionError && <div className="error-banner">{actionError}</div>}

			<section className="stream-bar">
				<div className="stream-group">
					<span className="stream-title">Continuous Chaos Stream</span>
					<button
						type="button"
						className="btn btn-primary"
						onClick={() => void callStreamApi("/api/stream/start", { mode, intervalMs: 1500, trapCadence: 3 })}
					>
						Start Continuous Stream
					</button>
					{snapshot?.stream.running && (
						<>
							<button
								type="button"
								className="btn"
								onClick={() =>
									void callStreamApi(snapshot.stream.paused ? "/api/stream/resume" : "/api/stream/pause")
								}
							>
								{snapshot.stream.paused ? "Resume" : "Pause"}
							</button>
							<button
								type="button"
								className="btn btn-danger"
								onClick={() => void callStreamApi("/api/stream/stop")}
							>
								Stop
							</button>
						</>
					)}
					<select
						className="select-input"
						value={trapKind}
						onChange={(e) => setTrapKind(e.target.value)}
						aria-label="Select trap or scenario kind"
					>
						<option value="">Next Scheduled Scenario (Mixed Cycle)</option>
						<optgroup label="Real Financial Traps">
							<option value="split_typo">Split Payment + Memo Typo</option>
							<option value="partial_late_stale">Partial -&gt; Late Settlement (STALE)</option>
							<option value="duplicate_invoice">Duplicate Invoice</option>
							<option value="orphan_wire">Orphan Bank Wire</option>
							<option value="bec_iban_change">BEC IBAN Change (HITL - Reject)</option>
							<option value="write_skew_race">Write-Skew Race + L1 Trap</option>
							<option value="currency_mismatch">Currency Mismatch (USD vs EUR)</option>
							<option value="overpayment_anomaly">Overpayment Anomaly</option>
						</optgroup>
						<optgroup label="False-Positive &amp; Benign Tests">
							<option value="legit_high_value_sepa">Legit High-Value SEPA (HITL - Approve)</option>
							<option value="legit_high_value_refund">Legit High-Value Refund (HITL - Approve)</option>
							<option value="false_positive_near_duplicate">Near-Duplicate Different PO (Benign)</option>
						</optgroup>
					</select>
					<button
						type="button"
						className="btn btn-amber"
						disabled={!snapshot?.stream.active}
						onClick={() =>
							void callStreamApi("/api/stream/inject-trap", trapKind ? { kind: trapKind } : {})
						}
					>
						Inject Trap Now
					</button>
				</div>

				<div className="stream-group mono" style={{ fontSize: 12, color: "var(--muted)" }}>
					{snapshot?.stream.seed !== null && snapshot?.stream.seed !== undefined && (
						<span className="badge badge-open">Seed: {snapshot.stream.seed}</span>
					)}
					<span>
						Ticks: <strong style={{ color: "var(--text)" }}>{snapshot?.stream.tickCount ?? 0}</strong> · Traps:{" "}
						<strong style={{ color: "var(--text)" }}>{snapshot?.stream.trapsInjected ?? 0}</strong> · Ledger:{" "}
						<strong style={{ color: "var(--text)" }}>{snapshot?.totalCellsCount ?? cells.length}</strong>
					</span>
					{budgetMax !== null && (
						<div className="budget-meter" title="Live LLM API call safety cap">
							<span>
								LLM: <strong>{budgetUsed}</strong>/{budgetMax}
							</span>
							<div className="budget-track">
								<div
									className={`budget-fill ${budgetPct >= 80 ? "warn" : ""}`}
									style={{ width: `${budgetPct}%` }}
								/>
							</div>
						</div>
					)}
				</div>
			</section>

			<section className="kpi-grid">
				<div className="kpi-card" style={{ ["--kpi-tone" as string]: "#38bdf8" }}>
					<div className="kpi-label">Peak Concurrent Loops</div>
					<div className="kpi-value mono" style={{ color: "#38bdf8" }}>
						{m?.peakConcurrentLoops ?? 0}
					</div>
					<div className="kpi-sub">
						{m ? `${m.totalLoopsFinished}/${m.totalLoopsStarted} loops finished` : "waiting"}
					</div>
				</div>
				<div className="kpi-card" style={{ ["--kpi-tone" as string]: "#10b981" }}>
					<div className="kpi-label">Deterministic Matches</div>
					<div className="kpi-value mono" style={{ color: "#34d399" }}>
						{m?.deterministicMatches ?? 0}
					</div>
					<div className="kpi-sub">0 LLM tokens used</div>
				</div>
				<div className="kpi-card" style={{ ["--kpi-tone" as string]: "#f43f5e" }}>
					<div className="kpi-label">L1 Blocked / Leaked</div>
					<div className="kpi-value mono" style={{ color: "#fb7185" }}>
						{m?.uncitedNumbersBlocked ?? 0} / {m?.inventedNumbersLeaked ?? 0}
					</div>
					<div className="kpi-sub">0 invented numbers leaked</div>
				</div>
				<div className="kpi-card" style={{ ["--kpi-tone" as string]: "#f59e0b" }}>
					<div className="kpi-label">L2 CAS Write-Skew</div>
					<div className="kpi-value mono" style={{ color: "#fbbf24" }}>
						{m?.casConflictsPrevented ?? 0}
					</div>
					<div className="kpi-sub">concurrent collisions stopped</div>
				</div>
				<div className="kpi-card" style={{ ["--kpi-tone" as string]: "#a855f7" }}>
					<div className="kpi-label">Palimpsest STALE</div>
					<div className="kpi-value mono" style={{ color: "#c084fc" }}>
						{m?.staleInvalidations ?? 0}
					</div>
					<div className="kpi-sub">chase drafts auto-invalidated</div>
				</div>
				<div className="kpi-card" style={{ ["--kpi-tone" as string]: "#eab308" }}>
					<div className="kpi-label">L3 Human HITL</div>
					<div className="kpi-value mono" style={{ color: "#fde68a" }}>
						{m?.humanApprovalsRouted ?? 0}
					</div>
					<div className="kpi-sub">limit {((snapshot?.spendingLimitCents ?? 25000) / 100).toFixed(0)} / IBAN guard</div>
				</div>
			</section>

			{(snapshot?.pendingApprovals ?? []).map((approval) => {
				const isBenignPolicyCheck = approval.riskFlags.length === 0
				return (
					<section
						key={approval.approvalId}
						className={`hitl-card ${isBenignPolicyCheck ? "benign" : ""}`}
					>
						<div className="hitl-meta">
							<h3>
								ProofGate L3 Human Approval Required — {approval.requestId} ({formatMoney(approval.amountCents, approval.currency)})
							</h3>
							<p>{approval.reason}</p>
							<div>
								<span
									className={`badge ${isBenignPolicyCheck ? "badge-matched" : "badge-risk"}`}
									style={{ marginRight: 6 }}
								>
									{isBenignPolicyCheck
										? "0 Risk Flags — Policy Limit Check Only"
										: `RISK FLAGS: ${approval.riskFlags.join(", ")}`}
								</span>
								<span className="badge badge-sepa" style={{ marginRight: 6 }}>
									Only this loop is paused — peer agents keep running
								</span>
								{approval.citations.map((c, idx) => (
									<button
										key={idx}
										type="button"
										className="src-pill mono"
										onClick={() => void inspectSource(c.sourceId)}
									>
										src:{c.sourceId}.{c.field}
									</button>
								))}
							</div>
						</div>
						<div className="hitl-actions">
							<button
								type="button"
								className="btn btn-danger"
								onClick={() => void handleApproval(approval.approvalId, false)}
							>
								Reject (Lock HOLD_RISK)
							</button>
							<button
								type="button"
								className="btn btn-success"
								onClick={() => void handleApproval(approval.approvalId, true)}
							>
								Approve Execution
							</button>
						</div>
					</section>
				)
			})}

			<SwimlaneChart
				spans={m?.spans ?? []}
				peakConcurrentLoops={m?.peakConcurrentLoops ?? 0}
				onInspectSource={(id) => void inspectSource(id)}
			/>

			<div className="workspace-grid">
				<div className="card">
					<div className="tabs">
						<button
							type="button"
							className={`tab-btn ${tab === "ledger" ? "active" : ""}`}
							onClick={() => setTab("ledger")}
						>
							Verified Ledger ({cells.length})
						</button>
						<button
							type="button"
							className={`tab-btn ${tab === "rejected" ? "active" : ""}`}
							onClick={() => setTab("rejected")}
						>
							Blocked / Rejected Claims ({snapshot?.rejectedAttempts.length ?? 0})
						</button>
						<button
							type="button"
							className={`tab-btn ${tab === "claims" ? "active" : ""}`}
							onClick={() => setTab("claims")}
						>
							Claims &amp; Skeptic Audit ({snapshot?.claims.length ?? 0})
						</button>
					</div>

					{tab === "ledger" && (
						<>
							<div className="ledger-toolbar">
								<div className="filter-pills">
									{(
										[
											["ALL", "All"],
											["MATCHED", "Matched"],
											["SEPA_DRAFT_READY", "SEPA XML"],
											["HOLD_RISK", "Hold Risk"],
											["DUPLICATE", "Duplicate"],
											["OTHER", "Partial / Refund"],
										] as Array<[LedgerFilter, string]>
									).map(([key, label]) => (
										<button
											key={key}
											type="button"
											className={`filter-pill mono ${ledgerFilter === key ? "active" : ""}`}
											onClick={() => setLedgerFilter(key)}
										>
											{label} ({filterCounts[key]})
										</button>
									))}
								</div>
								<input
									type="search"
									className="search-input mono"
									placeholder="Filter INV-, TX-, VND-…"
									value={ledgerQuery}
									onChange={(e) => setLedgerQuery(e.target.value)}
									aria-label="Filter verified ledger rows"
								/>
							</div>

							<div className="ledger-table-wrap">
								<table className="ledger-table">
									<thead>
										<tr>
											<th>Invoice</th>
											<th>Status</th>
											<th>Paid / Expected</th>
											<th>Matched Sources</th>
											<th>Risks &amp; Drafts</th>
										</tr>
									</thead>
									<tbody>
										{filteredCells.map(({ invoiceId, version, record }) => (
											<tr key={invoiceId}>
												<td className="mono">
													<button
														type="button"
														className="src-pill mono"
														onClick={() => void inspectSource(invoiceId)}
													>
														{invoiceId}
													</button>
													<div style={{ fontSize: 11, color: "var(--muted)" }}>
														v{version} · {record.vendorId}
													</div>
												</td>
												<td>
													<span className={statusBadgeClass(record.status)}>{record.status}</span>
												</td>
												<td className="mono">
													{formatMoney(record.paidAmountCents, record.currency)} / {formatMoney(record.expectedAmountCents, record.currency)}{" "}
													<span style={{ fontSize: 10, color: "var(--muted)" }}>{record.currency}</span>
												</td>
												<td>
													{record.matchedTxIds.length > 0 ? (
														record.matchedTxIds.map((txId) => (
															<button
																key={txId}
																type="button"
																className="src-pill mono"
																onClick={() => void inspectSource(txId)}
															>
																{txId}
															</button>
														))
													) : (
														<span style={{ color: "var(--muted)" }}>—</span>
													)}
												</td>
												<td>
													{record.riskFlags.map((flag) => (
														<span key={flag} className="badge badge-risk" style={{ marginRight: 4, marginBottom: 2 }}>
															{flag}
														</span>
													))}
													{record.sepaDraft && (
														<div style={{ fontSize: 11, color: "#7dd3fc", marginTop: 4 }}>
															<div>
																SEPA {record.sepaDraft.requestId} ({record.sepaDraft.approvedBy})
															</div>
															<div style={{ display: "flex", gap: 4, marginTop: 3, flexWrap: "wrap" }}>
																<button
																	type="button"
																	className="src-pill mono"
																	onClick={() => void inspectSepaXml(invoiceId, record.sepaDraft!)}
																>
																	Preview pain.001
																</button>
																<a
																	className="src-pill mono"
																	href={withSession(`/api/sepa/${encodeURIComponent(invoiceId)}.xml`, sessionId)}
																	download={`pain.001-${invoiceId}.xml`}
																>
																	Download XML
																</a>
															</div>
														</div>
													)}
													{record.drafts.map((d) => (
														<div key={d.draftId} style={{ marginTop: 3 }}>
															<span className={d.status === "STALE" ? "badge badge-stale" : "badge badge-partial"}>
																{d.kind}: {d.status}
															</span>
														</div>
													))}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>

							<div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12.5 }}>
								<div>
									<strong style={{ color: "#fcd34d" }}>Unmatched / Orphan Wires: </strong>
									{(snapshot?.unmatchedTxIds ?? []).length === 0 ? (
										<span style={{ color: "var(--muted)" }}>None yet</span>
									) : (
										snapshot!.unmatchedTxIds.map((id) => (
											<button
												key={id}
												type="button"
												className="src-pill mono"
												onClick={() => void inspectSource(id)}
											>
												{id}
											</button>
										))
									)}
								</div>
								<div>
									<strong style={{ color: "var(--muted)" }}>Operational Gateway Fees: </strong>
									{(snapshot?.nonInvoiceFeeTxIds ?? []).map((id) => (
										<button
											key={id}
											type="button"
											className="src-pill mono"
											onClick={() => void inspectSource(id)}
										>
											{id}
										</button>
									))}
								</div>
							</div>
						</>
					)}

					{tab === "rejected" && (
						<div className="list-stack">
							{(snapshot?.rejectedAttempts ?? []).length === 0 ? (
								<div style={{ color: "var(--muted)", fontSize: 13 }}>
									No blocked claims yet. Run the Black Friday stream to watch ProofGate L1/L2/L3 intercept unsafe actions.
								</div>
							) : (
								snapshot!.rejectedAttempts.map((rej) => (
									<div key={rej.id} className="item-box rejected">
										<div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
											<strong>
												<span className="mono">[{rej.id}]</span> {rej.agentName}.{rej.actionName}
											</strong>
											<span className="badge badge-risk">
												{rej.level} · {rej.code}
											</span>
										</div>
										<div style={{ color: "var(--text-soft)" }}>{rej.reason}</div>
									</div>
								))
							)}
						</div>
					)}

					{tab === "claims" && (
						<div className="list-stack">
							{(snapshot?.claims ?? []).map((claim) => (
								<div key={claim.claimId} className="item-box">
									<div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
										<strong>
											{claim.producer} · {claim.kind} ({formatMoney(claim.amountCents, claim.currency)})
										</strong>
										<span className={claim.auditStatus === "CONFIRMED" ? "badge badge-matched" : "badge badge-partial"}>
											Audit: {claim.auditStatus}
										</span>
									</div>
									<div style={{ marginBottom: 6, color: "var(--text-soft)" }}>{claim.summary}</div>
									<div>
										{claim.citations.map((c, idx) => (
											<button
												key={idx}
												type="button"
												className="src-pill mono"
												onClick={() => void inspectSource(c.sourceId)}
											>
												src:{c.sourceId}.{c.field}={String(c.expectedValue)}
											</button>
										))}
									</div>
								</div>
							))}
						</div>
					)}
				</div>

				<div className="right-col">
					<SourceDrawer
						sessionId={sessionId}
						selectedSource={selectedSource}
						selectedSepaXml={selectedSepaXml}
						loading={sourceLoading}
						error={sourceError}
						onInspectSource={(id) => void inspectSource(id)}
					/>

					<div className="card">
						<div className="card-header">
							<h2>Live Mozaik Event Stream</h2>
							<span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
								{snapshot?.logs.length ?? 0} events
							</span>
						</div>
						<div className="log-stream">
							{(snapshot?.logs ?? []).length === 0 ? (
								<div style={{ color: "var(--muted)" }}>
									Waiting for stream… click <strong>Start Interactive Stream</strong> above.
								</div>
							) : (
								snapshot!.logs.map((entry) => (
									<div key={entry.id} className={`log-line ${logToneClass(entry.text)}`}>
										{renderLogWithCitations(entry.text)}
									</div>
								))
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	)
}
