import type { AgentSpan, LedgerRecord, PendingApproval, RejectedAttempt } from "../types"
import { formatMoney } from "./currency"

const USE_COLOR =
	(Boolean(process.stdout.isTTY) || process.env.FORCE_COLOR === "1") &&
	!("NO_COLOR" in process.env) &&
	process.env.TERM !== "dumb"

const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[38;5;45m",
	blue: "\x1b[38;5;75m",
	green: "\x1b[38;5;48m",
	amber: "\x1b[38;5;220m",
	red: "\x1b[38;5;203m",
	purple: "\x1b[38;5;177m",
	slate: "\x1b[38;5;245m",
	white: "\x1b[38;5;255m",
	bgPanel: "\x1b[48;5;235m",
}

const ANSI_RE = /\x1b\[[0-9;]*m/g

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "")
}

function paint(code: string, text: string): string {
	return USE_COLOR ? `${code}${text}${ANSI.reset}` : text
}

export const c = {
	bold: (t: string) => paint(ANSI.bold, t),
	dim: (t: string) => paint(ANSI.dim, t),
	cyan: (t: string) => paint(ANSI.cyan, t),
	blue: (t: string) => paint(ANSI.blue, t),
	green: (t: string) => paint(ANSI.green, t),
	amber: (t: string) => paint(ANSI.amber, t),
	red: (t: string) => paint(ANSI.red, t),
	purple: (t: string) => paint(ANSI.purple, t),
	slate: (t: string) => paint(ANSI.slate, t),
	white: (t: string) => paint(ANSI.white, t),
}

export function padVisible(text: string, width: number, align: "left" | "right" = "left"): string {
	const vis = stripAnsi(text).length
	if (vis >= width) return text
	const spaces = " ".repeat(width - vis)
	return align === "right" ? `${spaces}${text}` : `${text}${spaces}`
}

function truncatePlain(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text
	return `${text.slice(0, Math.max(0, maxLen - 1))}…`
}

export function renderBanner(opts: {
	title: string
	subtitle: string
	badges: string[]
	disclaimer?: string
}): string {
	const innerWidth = 76
	const top = c.cyan(`╭─ LedgerProof ${"─".repeat(innerWidth - 14)}╮`)
	const bot = c.cyan(`╰${"─".repeat(innerWidth + 1)}╯`)
	const line = (content: string) => `${c.cyan("│")} ${padVisible(content, innerWidth)} ${c.cyan("│")}`

	const badgeLine = opts.badges.map((b) => c.dim(`[`) + c.cyan(b) + c.dim(`]`)).join("  ")
	const disclaimer = opts.disclaimer ?? "100% Synthetic Data Only · Not Financial Advice"

	return [
		top,
		line(`${c.bold(c.white(opts.title))}`),
		line(`${c.slate(opts.subtitle)}`),
		line(badgeLine),
		line(`${c.amber("▲")} ${c.amber(disclaimer)}`),
		bot,
	].join("\n")
}

export function renderSection(title: string, meta?: string): string {
	const right = meta ? ` ${c.slate(`(${meta})`)}` : ""
	const ruleLen = Math.max(8, 68 - title.length - (meta ? meta.length + 3 : 0))
	return `\n${c.cyan("▸")} ${c.bold(c.white(title))}${right} ${c.dim("─".repeat(ruleLen))}`
}

export interface KpiItem {
	label: string
	value: string
	tone?: "cyan" | "green" | "amber" | "red" | "purple" | "neutral"
}

function colorByTone(tone: KpiItem["tone"], text: string): string {
	switch (tone) {
		case "cyan":
			return c.cyan(text)
		case "green":
			return c.green(text)
		case "amber":
			return c.amber(text)
		case "red":
			return c.red(text)
		case "purple":
			return c.purple(text)
		default:
			return c.white(text)
	}
}

export function renderKpiGrid(items: KpiItem[], columns = 3): string {
	const cellWidth = 24
	const lines: string[] = []
	for (let i = 0; i < items.length; i += columns) {
		const row = items.slice(i, i + columns)
		const topBorder = row.map(() => c.slate(`┌${"─".repeat(cellWidth)}┐`)).join(" ")
		const labelRow = row
			.map((item) => {
				const lbl = c.slate(truncatePlain(item.label.toUpperCase(), cellWidth - 2))
				return `${c.slate("│")} ${padVisible(lbl, cellWidth - 2)} ${c.slate("│")}`
			})
			.join(" ")
		const valRow = row
			.map((item) => {
				const val = c.bold(colorByTone(item.tone, truncatePlain(item.value, cellWidth - 2)))
				return `${c.slate("│")} ${padVisible(val, cellWidth - 2)} ${c.slate("│")}`
			})
			.join(" ")
		const botBorder = row.map(() => c.slate(`└${"─".repeat(cellWidth)}┘`)).join(" ")
		lines.push(topBorder, labelRow, valRow, botBorder)
	}
	return lines.join("\n")
}

function formatStatusLabel(status: string): string {
	switch (status) {
		case "MATCHED":
			return c.green("✓ MATCHED")
		case "SEPA_DRAFT_READY":
			return c.cyan("⚡ SEPA_DRAFT_READY")
		case "HOLD_RISK":
			return c.red("⛔ HOLD_RISK")
		case "DUPLICATE":
			return c.red("✕ DUPLICATE")
		case "REFUNDED":
			return c.purple("↺ REFUNDED")
		case "PARTIAL":
			return c.amber("◔ PARTIAL")
		case "NEEDS_HUMAN":
			return c.amber("! NEEDS_HUMAN")
		default:
			return c.slate(`○ ${status}`)
	}
}

export function renderLedgerTable(
	rows: Array<{ invoiceId: string; version: number; record: LedgerRecord }>,
): string {
	const cols = [
		{ title: "Invoice", width: 14 },
		{ title: "Status", width: 20 },
		{ title: "Paid / Expected", width: 23 },
		{ title: "Transactions", width: 19 },
		{ title: "Risks & Drafts", width: 28 },
	]
	const divider = (left: string, mid: string, right: string) =>
		c.slate(`${left}${cols.map((col) => "─".repeat(col.width + 2)).join(mid)}${right}`)

	const header =
		c.slate("│") +
		cols.map((col) => ` ${c.bold(c.slate(padVisible(col.title, col.width)))} ${c.slate("│")}`).join("")

	const bodyLines = rows.map(({ invoiceId, version, record }) => {
		const invCol = `${c.bold(c.white(invoiceId))} ${c.dim(`v${version}`)}`
		const statusCol = formatStatusLabel(record.status)
		const cur = record.currency || "USD"
		const paidStr = formatMoney(record.paidAmountCents, cur)
		const expStr = formatMoney(record.expectedAmountCents, cur)
		const amtCol = `${paidStr} / ${expStr} ${c.dim(cur)}`
		const txCol = truncatePlain(record.matchedTxIds.join(", ") || "—", cols[3].width)

		const details: string[] = []
		if (record.riskFlags.length > 0) {
			details.push(c.red(record.riskFlags.join(",")))
		}
		const staled = record.drafts.filter((d) => d.status === "STALE").length
		const active = record.drafts.filter((d) => d.status === "ACTIVE").length
		if (staled > 0) details.push(c.purple(`STALE×${staled}`))
		if (active > 0) details.push(c.amber(`CHASE×${active}`))
		if (record.sepaDraft) details.push(c.cyan(`pain.001:${record.sepaDraft.requestId}`))
		const riskCol = details.length > 0 ? details.join(" ") : c.dim("clean")

		const cells = [
			padVisible(invCol, cols[0].width),
			padVisible(statusCol, cols[1].width),
			padVisible(amtCol, cols[2].width),
			padVisible(txCol, cols[3].width),
			padVisible(riskCol, cols[4].width),
		]
		return c.slate("│") + cells.map((cell) => ` ${cell} ${c.slate("│")}`).join("")
	})

	return [divider("┌", "┬", "┐"), header, divider("├", "┼", "┤"), ...bodyLines, divider("└", "┴", "┘")].join("\n")
}

export function renderRejectedClaims(attempts: RejectedAttempt[]): string {
	if (attempts.length === 0) {
		return c.dim("  No blocked or rejected claims recorded.")
	}
	return attempts
		.map((rej) => {
			const tag =
				rej.level === "L1_SOURCE_OR_MATH"
					? c.red(`[${rej.id} L1 SOURCE/MATH]`)
					: rej.level === "L2_CAS_WRITE_SKEW"
						? c.amber(`[${rej.id} L2 CAS SKEW]`)
						: c.purple(`[${rej.id} L3 HITL]`)
			return `  ${tag} ${c.bold(`${rej.agentName}.${rej.actionName}`)} ${c.dim(`(${rej.code})`)}\n    ${c.slate("↳")} ${rej.reason}`
		})
		.join("\n")
}

function agentColor(agentName: string, text: string): string {
	switch (agentName) {
		case "RiskSentinel":
			return c.red(text)
		case "Reconciler":
			return c.cyan(text)
		case "PayoutAndRefund":
			return c.amber(text)
		case "SkepticAuditor":
			return c.green(text)
		default:
			return c.white(text)
	}
}

export function renderGanttTimeline(spans: AgentSpan[], peakConcurrent: number): string {
	if (spans.length === 0) {
		return c.dim("  No agent spans captured.")
	}
	const minStart = Math.min(...spans.map((s) => s.startMs))
	const maxEnd = Math.max(...spans.map((s) => s.endMs ?? s.startMs), minStart + 1)
	const totalMs = Math.max(maxEnd - minStart, 1)
	const barWidth = 28

	const header = c.slate(
		`  Window: 0ms → +${totalMs}ms | Peak Simultaneous Loops: ${c.bold(c.cyan(String(peakConcurrent)))}`,
	)
	const rows = spans.map((span) => {
		const relStart = span.startMs - minStart
		const relEnd = (span.endMs ?? span.startMs) - minStart
		const leftCols = Math.min(barWidth - 1, Math.floor((relStart / totalMs) * barWidth))
		const spanCols = Math.max(1, Math.min(barWidth - leftCols, Math.ceil(((relEnd - relStart) / totalMs) * barWidth)))
		const rightCols = Math.max(0, barWidth - leftCols - spanCols)
		const track = `${c.dim("·".repeat(leftCols))}${agentColor(span.agentName, "█".repeat(spanCols))}${c.dim("·".repeat(rightCols))}`
		const timing = c.dim(`+${String(relStart).padStart(4)}→+${String(relEnd).padStart(4)}ms`)
		const agent = padVisible(agentColor(span.agentName, span.agentName), 16)
		return `  ${timing} │${track}│ ${agent} ${c.dim(span.eventType)} ${c.white(`(${span.targetId})`)}`
	})
	return [header, ...rows].join("\n")
}

export function renderHitlBox(approval: PendingApproval): string {
	const amt = formatMoney(approval.amountCents, approval.currency)
	const flags = approval.riskFlags.length > 0 ? c.red(approval.riskFlags.join(", ")) : c.green("0 risk flags (limit only)")
	return [
		c.amber("┌─ HUMAN APPROVAL REQUIRED (other Mozaik loops keep running) ────────────┐"),
		`  Request : ${c.bold(approval.requestId)} ${c.dim(`(${approval.actionName})`)}`,
		`  Invoice : ${c.bold(approval.invoiceId)} · Amount: ${c.bold(amt)}`,
		`  Flags   : ${flags}`,
		`  Reason  : ${approval.reason}`,
		c.amber("└───────────────────────────────────────────────────────────────────────────┘"),
	].join("\n")
}

export function formatStreamLog(line: string): string {
	if (line.includes("[ProofGate BLOCKED]")) return c.red(line)
	if (line.includes("[ProofGate CAS]")) return c.amber(line)
	if (line.includes("[ProofGate HITL]")) return c.amber(line)
	if (line.includes("[Palimpsest STALE]")) return c.purple(line)
	if (line.includes("[Human Approver] APPROVED")) return c.green(line)
	if (line.includes("[Human Approver] REJECTED")) return c.red(line)
	if (line.includes("[Budget Guard]")) return c.red(line)
	if (line.startsWith("[Stream #")) {
		if (line.includes("TRAP [")) return c.amber(line)
		if (line.includes("BENIGN [")) return c.cyan(line)
		return c.slate(line)
	}
	if (line.startsWith("[RiskSentinel]")) return `${c.red("[RiskSentinel]")}${line.slice("[RiskSentinel]".length)}`
	if (line.startsWith("[Reconciler]")) return `${c.cyan("[Reconciler]")}${line.slice("[Reconciler]".length)}`
	if (line.startsWith("[PayoutAndRefund]")) return `${c.amber("[PayoutAndRefund]")}${line.slice("[PayoutAndRefund]".length)}`
	if (line.startsWith("[SkepticAuditor]")) return `${c.green("[SkepticAuditor]")}${line.slice("[SkepticAuditor]".length)}`
	return line
}
