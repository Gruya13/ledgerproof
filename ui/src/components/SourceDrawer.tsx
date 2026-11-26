import type { SourceInspectPayload } from "../types"

interface Props {
	selectedSource: SourceInspectPayload | null
	loading: boolean
	error: string | null
	onInspectSource: (id: string) => void
}

const QUICK_IDS = ["INV-1006", "INV-1007", "INV-1009", "INV-1010", "INV-1011", "REQ-3002", "REQ-3003", "TX-2014", "TX-2016", "TX-2017", "VND-04"]

export function SourceDrawer({ selectedSource, loading, error, onInspectSource }: Props) {
	return (
		<div className="card">
			<div className="card-header">
				<h2>Immutable SourceStore Inspector</h2>
				<span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
					SHA-256 Ground Truth
				</span>
			</div>

			<div style={{ marginBottom: 8 }}>
				{QUICK_IDS.map((id) => (
					<button
						key={id}
						type="button"
						className="src-pill mono"
						onClick={() => onInspectSource(id)}
					>
						{id}
					</button>
				))}
			</div>

			{loading && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Loading source record…</div>}
			{error && <div style={{ fontSize: 12.5, color: "#fda4af" }}>{error}</div>}

			{selectedSource ? (
				<div>
					<div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginTop: 6 }}>
						<span>
							<strong className="mono">{selectedSource.sourceId}</strong> ({selectedSource.entity.kind})
						</span>
						<span className="mono" style={{ color: "#6ee7b7" }}>
							sha256:{selectedSource.entity.sha256}
						</span>
					</div>
					<pre className="source-json mono">
						{JSON.stringify(selectedSource.entity.data, null, 2)}
					</pre>
				</div>
			) : (
				<div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 8 }}>
					Click any <span className="mono">[src:ID]</span> pill, invoice, or transaction to inspect the raw immutable record and its SHA-256 fingerprint.
				</div>
			)}
		</div>
	)
}
