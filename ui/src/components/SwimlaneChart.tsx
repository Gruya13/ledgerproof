import type { AgentSpan } from "../types"

interface Props {
	spans: AgentSpan[]
	peakConcurrentLoops: number
	onInspectSource: (id: string) => void
}

interface PlacedSpan {
	span: AgentSpan
	rowIndex: number
}

const LANES: Array<{ name: string; color: string; role: string }> = [
	{ name: "RiskSentinel", color: "#fb7185", role: "Duplicates / BEC / Fraud" },
	{ name: "Reconciler", color: "#38bdf8", role: "Split / Partial / Orphan" },
	{ name: "PayoutAndRefund", color: "#fbbf24", role: "SEPA / Refund / Chase" },
	{ name: "SkepticAuditor", color: "#34d399", role: "Adversarial L2 Audit" },
]

function packLaneSpans(laneSpans: AgentSpan[], now: number): { placed: PlacedSpan[]; rowCount: number } {
	const sorted = [...laneSpans].sort((a, b) => a.startMs - b.startMs)
	const rowEnds: number[] = []
	const placed: PlacedSpan[] = []

	for (const span of sorted) {
		const end = span.endMs ?? now
		let assignedRow = -1
		for (let i = 0; i < rowEnds.length; i++) {
			if (span.startMs >= rowEnds[i]) {
				assignedRow = i
				rowEnds[i] = end
				break
			}
		}
		if (assignedRow < 0) {
			assignedRow = rowEnds.length
			rowEnds.push(end)
		}
		placed.push({ span, rowIndex: assignedRow })
	}

	return { placed, rowCount: Math.max(1, rowEnds.length) }
}

export function SwimlaneChart({ spans, peakConcurrentLoops, onInspectSource }: Props) {
	if (spans.length === 0) {
		return (
			<div className="card swimlane-box">
				<div className="card-header">
					<h2>Concurrent Mozaik Agent Swimlanes</h2>
					<span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
						Ready — click Start Interactive Stream or Start Continuous Stream
					</span>
				</div>
				<div style={{ color: "var(--muted)", fontSize: 13 }}>
					Each concurrent <span className="mono">runLoop()</span> receives an isolated <span className="mono">ModelContext</span> and its own <span className="mono">ProofGate</span> interception handler.
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

			<div className="swimlane-axis mono">
				<div>Agent Role</div>
				<div className="swimlane-axis-ticks">
					<span>0ms</span>
					<span>{Math.round(totalMs * 0.25)}ms</span>
					<span>{Math.round(totalMs * 0.5)}ms</span>
					<span>{Math.round(totalMs * 0.75)}ms</span>
					<span>{totalMs}ms</span>
				</div>
			</div>

			<div>
				{LANES.map((lane) => {
					const laneSpans = spans.filter((s) => s.agentName === lane.name)
					const activeCount = laneSpans.filter((s) => s.endMs === undefined).length
					const { placed, rowCount } = packLaneSpans(laneSpans, now)
					const trackHeight = rowCount * 21 + 6

					return (
						<div key={lane.name} className="swimlane-row">
							<div>
								<div className="swimlane-label">
									<span className="dot" style={{ background: lane.color }} />
									<span>{lane.name}</span>
									{activeCount > 0 && (
										<span className="badge badge-sepa mono">{activeCount} live</span>
									)}
								</div>
								<div style={{ fontSize: 11, color: "var(--muted)", marginLeft: 15 }}>
									{lane.role} ({laneSpans.length})
								</div>
							</div>

							<div className="swimlane-track" style={{ height: trackHeight }}>
								{placed.map(({ span, rowIndex }) => {
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
												top: 4 + rowIndex * 21,
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
