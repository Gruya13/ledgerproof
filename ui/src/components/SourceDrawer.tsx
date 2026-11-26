import type { SourceInspectPayload } from "../types"

export interface SepaXmlPreview {
	invoiceId: string
	requestId: string
	messageId: string
	sha256: string
	xml: string
}

interface Props {
	selectedSource: SourceInspectPayload | null
	selectedSepaXml: SepaXmlPreview | null
	loading: boolean
	error: string | null
	onInspectSource: (id: string) => void
}

const QUICK_IDS = ["INV-1006", "INV-1007", "INV-1009", "INV-1010", "INV-1011", "REQ-3002", "REQ-3003", "TX-2014", "TX-2016", "TX-2017", "VND-04"]

export function SourceDrawer({ selectedSource, selectedSepaXml, loading, error, onInspectSource }: Props) {
	return (
		<div className="card">
			<div className="card-header">
				<h2>{selectedSepaXml ? "ISO 20022 SEPA pain.001 Draft" : "Immutable SourceStore Inspector"}</h2>
				<span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
					{selectedSepaXml ? "pain.001.001.09 · Synthetic" : "SHA-256 Ground Truth"}
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

			{selectedSepaXml ? (
				<div>
					<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 12, marginTop: 6, flexWrap: "wrap" }}>
						<span>
							<strong className="mono">{selectedSepaXml.invoiceId}</strong> · {selectedSepaXml.messageId}
						</span>
						<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
							<span className="mono" style={{ color: "#6ee7b7" }} title={selectedSepaXml.sha256}>
								sha256:{selectedSepaXml.sha256.slice(0, 16)}…
							</span>
							<a
								className="src-pill mono"
								href={`/api/sepa/${encodeURIComponent(selectedSepaXml.invoiceId)}.xml`}
								download={`pain.001-${selectedSepaXml.invoiceId}.xml`}
							>
								Download XML
							</a>
						</div>
					</div>
					<pre className="source-json mono">{selectedSepaXml.xml}</pre>
				</div>
			) : selectedSource ? (
				<div>
					<div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginTop: 6 }}>
						<span>
							<strong className="mono">{selectedSource.sourceId}</strong> ({selectedSource.entity.kind})
						</span>
						<span className="mono" style={{ color: "#6ee7b7" }} title={selectedSource.entity.sha256}>
							sha256:{selectedSource.entity.sha256.slice(0, 16)}…
						</span>
					</div>
					<pre className="source-json mono">
						{JSON.stringify(selectedSource.entity.data, null, 2)}
					</pre>
				</div>
			) : (
				<div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 8 }}>
					Click any <span className="mono">[src:ID]</span> pill, invoice, transaction, or <span className="mono">Preview pain.001</span> to inspect raw SHA-256 records or ISO 20022 XML.
				</div>
			)}
		</div>
	)
}
