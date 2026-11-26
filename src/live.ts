import "dotenv/config"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import {
	c,
	formatStreamLog,
	renderBanner,
	renderHitlBox,
	renderKpiGrid,
	renderLedgerTable,
	renderRejectedClaims,
	renderSection,
} from "./engine/cli-ui"
import { resolveLiveProviderFromEnv } from "./engine/provider-factory"
import { evaluateAgainstGroundTruth } from "./proof"
import { loadGroundTruth, runBlackFridayScenario } from "./runner-setup"
import { SessionController } from "./session-controller"

function sleep(ms: number): Promise<void> {
	return new Promise((resolveFn) => setTimeout(resolveFn, ms))
}

function getNumericFlag(flag: string, fallback: number): number {
	const idx = process.argv.indexOf(flag)
	if (idx < 0) return fallback
	const parsed = Number(process.argv[idx + 1])
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

async function runLiveContinuousStream(
	providerLabel: string,
	maxTicks: number,
	maxLlmCalls: number,
): Promise<void> {
	console.log(
		renderBanner({
			title: `LIVE Randomized Chaos Stream (${maxTicks} ticks)`,
			subtitle: `Live Multi-Agent Stress Test on ${providerLabel}`,
			badges: [providerLabel, `Budget: ${maxLlmCalls} calls`, `Ticks: ${maxTicks}`],
		}),
	)

	const controller = new SessionController()
	let seenLogs = 0
	const handledApprovals = new Set<string>()
	const trapCounts: Record<string, number> = {}

	const unsub = controller.subscribe(() => {
		const snap = controller.getSnapshot()
		while (seenLogs < snap.logs.length) {
			const text = snap.logs[seenLogs].text
			console.log(formatStreamLog(text))
			const trapMatch = text.match(/\[Stream #\d+\]\s+(?:TRAP|BENIGN)\s+\[([^\]]+)\]/)
			if (trapMatch) {
				trapCounts[trapMatch[1]] = (trapCounts[trapMatch[1]] ?? 0) + 1
			}
			seenLogs += 1
		}

		for (const approval of snap.pendingApprovals) {
			if (handledApprovals.has(approval.approvalId)) continue
			handledApprovals.add(approval.approvalId)
			// Wait briefly so concurrent RiskSentinel loops over live network can land risk holds before policy decides
			setTimeout(() => {
				const latestSnap = controller.getSnapshot()
				const latestCell = latestSnap.cells.find((c) => c.invoiceId === approval.invoiceId)
				const activeRiskFlags = latestCell?.record.riskFlags ?? approval.riskFlags
				const hasRiskFlags = activeRiskFlags.length > 0 || approval.riskFlags.length > 0
				const shouldApprove = !hasRiskFlags
				controller.resolveApproval(
					approval.approvalId,
					shouldApprove,
					shouldApprove
						? `Live policy approved benign >$250 transfer (${approval.requestId})`
						: `Live policy rejected risky payout (${[...new Set([...approval.riskFlags, ...activeRiskFlags])].join(", ")})`,
				)
			}, 1500)
		}
	})

	const lateDelayMs = 7000
	const res = controller.startContinuousStream({
		mode: "live",
		intervalMs: 650,
		trapCadence: 3,
		autoApprovePolicy: false,
		maxLlmCalls,
		lateDelayMs,
	})

	if (!res.ok) {
		unsub()
		throw new Error(res.error)
	}

	const deadline = Date.now() + 300_000
	while (Date.now() < deadline) {
		const snap = controller.getSnapshot()
		if (snap.stream.tickCount >= maxTicks || snap.llmBudgetExhausted) {
			break
		}
		await sleep(80)
	}

	controller.stopContinuousStream()
	// Allow delayed late settlements (TX-*) and active DeepSeek loops to settle cleanly
	await sleep(lateDelayMs + 500)
	await controller.waitForCurrentIdle(60000)
	unsub()

	const finalSnap = controller.getSnapshot({ full: true })
	const statusCounts: Record<string, number> = {}
	const unfinishedIds: string[] = []
	for (const cell of finalSnap.cells) {
		statusCounts[cell.record.status] = (statusCounts[cell.record.status] ?? 0) + 1
		if (cell.record.status === "OPEN" || cell.record.status === "PARTIAL") {
			unfinishedIds.push(`${cell.record.invoiceId}(${cell.record.status})`)
		}
	}

	console.log(renderSection(`LIVE ${maxTicks}-TICK RANDOMIZED STREAM SUMMARY`, `seed ${finalSnap.stream.seed ?? "n/a"}`))
	console.log(
		renderKpiGrid(
			[
				{
					label: "Ticks / Scenarios",
					value: `${finalSnap.stream.tickCount} / ${finalSnap.stream.trapsInjected}`,
					tone: "cyan",
				},
				{ label: "Total Invoices", value: `${finalSnap.totalCellsCount}`, tone: "green" },
				{ label: "Peak Concurrent", value: `${finalSnap.metrics.peakConcurrentLoops}`, tone: "cyan" },
				{ label: "Loops Completed", value: `${finalSnap.metrics.totalLoopsFinished}/${finalSnap.metrics.totalLoopsStarted}`, tone: "green" },
				{ label: "LLM / 0-Token Match", value: `${finalSnap.metrics.llmCalls} / ${finalSnap.metrics.deterministicMatches}`, tone: "green" },
				{ label: "CAS Stopped", value: `${finalSnap.metrics.casConflictsPrevented}`, tone: "amber" },
				{ label: "L1 Blocked / Leaked", value: `${finalSnap.metrics.uncitedNumbersBlocked} / ${finalSnap.metrics.inventedNumbersLeaked}`, tone: "red" },
				{ label: "Stale / HITL", value: `${finalSnap.metrics.staleInvalidations} / ${finalSnap.metrics.humanApprovalsRouted}`, tone: "purple" },
				{ label: "Unfinished Inv", value: `${unfinishedIds.length}`, tone: unfinishedIds.length === 0 ? "green" : "amber" },
			],
			3,
		),
	)
	console.log(`\n${c.slate("Unmatched orphan TXs:")} ${finalSnap.unmatchedTxIds.join(", ") || c.dim("none")}`)
	console.log(`${c.slate("Unfinished invoices :")} ${unfinishedIds.join(", ") || c.green("none")}`)
	console.log(`${c.slate("Invoice statuses    :")} ${JSON.stringify(statusCounts)}`)
	console.log(`${c.slate("Scenario breakdown  :")} ${JSON.stringify(trapCounts)}`)

	console.log(renderSection("BLOCKED / REJECTED CLAIMS", `${finalSnap.rejectedAttempts.length} blocked`))
	console.log(renderRejectedClaims(finalSnap.rejectedAttempts))

	const outDir = resolve(process.cwd(), "out")
	mkdirSync(outDir, { recursive: true })
	const outPath = resolve(outDir, `live-stream-${maxTicks}-audit.jsonl`)
	writeFileSync(outPath, controller.getAuditJsonl(), "utf8")
	console.log(`\n${c.green("✔")} Live stream audit trace exported to ${c.cyan(`out/live-stream-${maxTicks}-audit.jsonl`)} ${c.dim(`(${finalSnap.auditLog.length} entries)`)}.`)
}

async function main(): Promise<void> {
	const resolved = resolveLiveProviderFromEnv()
	if (!resolved) {
		console.log("No live LLM API key is configured in .env.")
		console.log("Supported keys (checked in order): DEEPSEEK_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY.")
		console.log("Copy .env.example to .env and set one key, or run zero-key mode right now:")
		console.log("  npm run proof")
		console.log("  npm run demo -- --auto")
		console.log("  npm run ui")
		return
	}

	if (process.argv.includes("--stream")) {
		const maxTicks = getNumericFlag("--ticks", 40)
		const maxLlmCalls = getNumericFlag("--max-llm-calls", Math.max(120, maxTicks * 3))
		await runLiveContinuousStream(resolved.label, maxTicks, maxLlmCalls)
		return
	}

	console.log(
		renderBanner({
			title: "LIVE Mode — Black Friday Fixed Pack",
			subtitle: `Real-time Multi-Agent Execution via ${resolved.label}`,
			badges: [resolved.label, "Live Policy Safe-Reject"],
		}),
	)

	const state = await runBlackFridayScenario({
		runner: resolved.runner,
		useNativeRunner: resolved.useNativeRunner,
		modelName: resolved.modelName,
		log: (line) => console.log(formatStreamLog(line)),
		approvalHandler: async (approval) => {
			console.log(`\n${renderHitlBox(approval)}`)
			return {
				approved: false,
				reason: `Safe policy rejected ${approval.requestId}: ${approval.reason}`,
				decidedBy: "POLICY_AUTO",
			}
		},
	})

	const gt = loadGroundTruth()
	const evaluation = evaluateAgainstGroundTruth(state, gt)

	console.log(renderSection("LIVE VERIFIED LEDGER", `${state.cells.size} invoices`))
	const ledgerRows = [...state.cells.entries()].map(([invoiceId, cell]) => {
		const snap = cell.read()
		return { invoiceId, version: snap.version, record: snap.value }
	})
	console.log(renderLedgerTable(ledgerRows))

	console.log(renderSection("BLOCKED / REJECTED CLAIMS", `${state.rejectedAttempts.length} blocked`))
	console.log(renderRejectedClaims(state.rejectedAttempts))

	console.log(renderSection("LIVE CONCURRENCY & GROUND-TRUTH SUMMARY"))
	console.log(
		renderKpiGrid(
			[
				{
					label: "GT Invoices Matched",
					value: `${evaluation.casesPassed}/${evaluation.casesTotal}`,
					tone: evaluation.casesPassed === evaluation.casesTotal ? "green" : "amber",
				},
				{ label: "Peak Concurrent Loops", value: `${state.metrics.peakConcurrentLoops}`, tone: "cyan" },
				{ label: "Loops Completed", value: `${state.metrics.totalLoopsFinished}/${state.metrics.totalLoopsStarted}`, tone: "green" },
				{ label: "CAS Stopped", value: `${state.metrics.casConflictsPrevented}`, tone: "amber" },
				{ label: "L1 Blocked / Leaked", value: `${state.metrics.uncitedNumbersBlocked} / ${state.metrics.inventedNumbersLeaked}`, tone: "red" },
				{ label: "Stale / HITL", value: `${state.metrics.staleInvalidations} / ${state.metrics.humanApprovalsRouted}`, tone: "purple" },
			],
			3,
		),
	)
	if (evaluation.failures.length > 0) {
		console.log(`\n${c.amber("Notes / deltas vs mock proof:")}`)
		for (const f of evaluation.failures) {
			console.log(`  ${c.amber("•")} ${f}`)
		}
	}

	const outDir = resolve(process.cwd(), "out")
	mkdirSync(outDir, { recursive: true })
	const jsonl = state.auditLog.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
	writeFileSync(resolve(outDir, "live-audit-trace.jsonl"), jsonl, "utf8")
	console.log(`\n${c.green("✔")} Live audit trace exported to ${c.cyan("out/live-audit-trace.jsonl")} ${c.dim(`(${state.auditLog.length} entries)`)}.`)
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
