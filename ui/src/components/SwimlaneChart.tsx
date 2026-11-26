import type { AgentSpan } from "../types"

interface Props {
	spans: AgentSpan[]
	peakConcurrentLoops: number
	onInspectSource: (id: string) => void
}

const LANES: Array<{ name: string; color: string; role: string }> = [
	{ name: "RiskSentinel", color: "#fb7185", role: "Duplicates / BEC / Fraud" },
	{ name: "Reconciler", color: "#38bdf8", role: "Split / Partial / Orphan" },
	{ name: "PayoutAndRefund", color: "#fbbf24", role: "SEPA / Refund / Chase" },
	{ name: "SkepticAuditor", color: "#34d399", role: "Adversarial L2 Audit" },
]

export function SwimlaneChart({ spans, peakConcurrentLoops, onInspectSource }: Props) {
	if (spans.length === 0) {
		return (
			<div className="card swimlane-box">
				<div className="card-header">
					<h2>Concurrent Mozaik Agent Swimlanes</h2>
					<span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
						Ready — press Start Black Friday Stream
					</span>
				</div>
				<div style={{ color: "var(--muted)", fontSize: 13 }}>
					Each concurrent <span className="mono">runLoop()</span> gets an isolated <span className="mono">ModelContext</span> and its own <span className="mono">ProofGate</span> interception handler.
				</div>
			</div>
		)
	}

	const minStart = Math.min(...spans.map((s) => s.startMs))
	const now = Date.now()
	const maxEnd = Math.max(...spans.map((s) => s.endMs ?? now), minStart + 50)
	const totalMs = Math.max(maxEnd - minStart, 100)

	return (
		<div className="card swimlane-box">
			<div className="card-header">
				<h2>Concurrent Mozaik Agent Swimlanes (Real-Time Overlap)</h2>
				<span className="mono" style={{ fontSize: 12, color: "#7dd3fc" }}>
					Window: {totalMs} ms · Peak simultaneous loops: {peakConcurrentLoops}
				</span>
			</div>

			<div>
				{LANES.map((lane) => {
					const laneSpans = spans.filter((s) => s.agentName === lane.name)
					return (
						<div key={lane.name} className="swimlane-row">
							<div>
								<div className="swimlane-label">
									<span className="dot" style={{ background: lane.color }} />
									<span>{lane.name}</span>
								</div>
								<div style={{ fontSize: 11, color: "var(--muted)", marginLeft: 14 }}>
									{lane.role} ({laneSpans.length})
								</div>
							</div>

							<div className="swimlane-track">
								{laneSpans.map((span) => {
									const leftPct = ((span.startMs - minStart) / totalMs) * 100
									const end = span.endMs ?? now
									const widthPct = Math.max(((end - span.startMs) / totalMs) * 100, 2.2)
									const isRunning = span.endMs === undefined
									const duration = end - span.startMs
									const canClick = /^(INV|TX|REQ|VND)-\d+/.test(span.targetId)

									return (
										<div
											key={span.spanId}
											className={`span-bar mono ${isRunning ? "running" : ""}`}
											style={{
												left: `${Math.min(leftPct, 97.5)}%`,
												width: `${Math.min(widthPct, 100 - Math.min(leftPct, 97.5))}%`,
												background: lane.color,
											}}
											title={`${span.agentName} | ${span.eventType} (${span.targetId}) | +${span.startMs - minStart}ms -> +${end - minStart}ms (${duration}ms)`}
											onClick={() => {
												if (canClick) onInspectSource(span.targetId)
											}}
										>
											{span.targetId}
										</div>
									)
								})}
							</div>
						</div>
					)
				})}
			</div>
		</div>
	)
}
