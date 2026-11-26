import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createInterface } from "node:readline/promises"
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
import { runBlackFridayScenario } from "./runner-setup"
import { SessionController } from "./session-controller"

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

async function interactiveApprovalPrompt(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout })
	try {
		while (true) {
			const ans = (await rl.question(question)).trim().toLowerCase()
			if (ans === "y" || ans === "yes") return true
			if (ans === "n" || ans === "no") return false
			console.log("Please enter y or n.")
		}
	} finally {
		rl.close()
	}
}

async function runContinuousCliDemo(maxTicks: number): Promise<void> {
	console.log(
		renderBanner({
			title: `Continuous Chaos Stream CLI (${maxTicks} ticks)`,
			subtitle: "Randomized Synthetic Black Friday Stream · Trap & Benign Injector",
			badges: ["MockInferenceRunner", "0 API Keys", `Ticks: ${maxTicks}`],
		}),
	)

	const controller = new SessionController()
	let seenLogs = 0
	const unsub = controller.subscribe(() => {
		const snap = controller.getSnapshot()
		while (seenLogs < snap.logs.length) {
			console.log(formatStreamLog(snap.logs[seenLogs].text))
			seenLogs += 1
		}
	})

	const res = controller.startContinuousStream({
		mode: "mock",
		intervalMs: 180,
		trapCadence: 2,
		autoApprovePolicy: true,
		lateDelayMs: 280,
	})
	if (!res.ok) {
		throw new Error(res.error)
	}

	const deadline = Date.now() + 15000
	while (Date.now() < deadline) {
		const snap = controller.getSnapshot()
		if (snap.stream.tickCount >= maxTicks) break
		await sleep(50)
	}

	controller.stopContinuousStream()
	await sleep(350)
	await controller.waitForCurrentIdle(10000)
	unsub()

	const finalSnap = controller.getSnapshot({ full: true })
	console.log(renderSection("CONTINUOUS STREAM SUMMARY", `seed ${finalSnap.stream.seed ?? "n/a"}`))
	console.log(
		renderKpiGrid(
			[
				{ label: "Ticks / Traps", value: `${finalSnap.stream.tickCount} / ${finalSnap.stream.trapsInjected}`, tone: "cyan" },
				{ label: "Ledger Invoices", value: `${finalSnap.totalCellsCount}`, tone: "green" },
				{ label: "Peak Concurrent", value: `${finalSnap.metrics.peakConcurrentLoops}`, tone: "cyan" },
				{ label: "0-Token Matches", value: `${finalSnap.metrics.deterministicMatches}`, tone: "green" },
				{ label: "CAS Stopped", value: `${finalSnap.metrics.casConflictsPrevented}`, tone: "amber" },
				{ label: "L1 / Leaked", value: `${finalSnap.metrics.uncitedNumbersBlocked} / ${finalSnap.metrics.inventedNumbersLeaked}`, tone: "red" },
				{ label: "STALE Invalidations", value: `${finalSnap.metrics.staleInvalidations}`, tone: "purple" },
				{ label: "HITL Routed", value: `${finalSnap.metrics.humanApprovalsRouted}`, tone: "amber" },
				{ label: "Loops Done", value: `${finalSnap.metrics.totalLoopsFinished}/${finalSnap.metrics.totalLoopsStarted}`, tone: "green" },
			],
			3,
		),
	)
}

async function main(): Promise<void> {
	if (process.argv.includes("--stream")) {
		const ticksIdx = process.argv.indexOf("--ticks")
		const ticksVal = ticksIdx >= 0 ? Number(process.argv[ticksIdx + 1]) : 6
		const maxTicks = Number.isFinite(ticksVal) && ticksVal > 0 ? ticksVal : 6
		await runContinuousCliDemo(maxTicks)
		return
	}

	const autoMode = process.argv.includes("--auto") || !process.stdin.isTTY

	console.log(
		renderBanner({
			title: "Evidence-First Black Friday Finance Agents",
			subtitle: "Concurrent Mozaik Multi-Agent Reconciliation, Risk & Controlled SEPA Payouts",
			badges: ["MockInferenceRunner", "0 API Keys", autoMode ? "Auto Mode" : "Interactive TTY"],
		}),
	)

	const state = await runBlackFridayScenario({
		log: (line) => console.log(formatStreamLog(line)),
		approvalHandler: async (approval) => {
			console.log(`\n${renderHitlBox(approval)}`)

			if (autoMode) {
				console.log(c.amber("  [--auto] Rejecting suspicious IBAN change / high-risk payout.\n"))
				return {
					approved: false,
					reason: `Auto-demo rejected ${approval.requestId}: ${approval.reason}`,
					decidedBy: "POLICY_AUTO",
				}
			}

			const approved = await interactiveApprovalPrompt("Approve this payment? [y/n] ")
			return {
				approved,
				reason: approved ? "Approved by operator" : `Rejected by operator: ${approval.reason}`,
				decidedBy: "HUMAN_INTERACTIVE",
			}
		},
	})

	console.log(renderSection("FINAL VERIFIED LEDGER", `${state.cells.size} invoices`))
	const ledgerRows = [...state.cells.entries()].map(([invoiceId, cell]) => {
		const snap = cell.read()
		return { invoiceId, version: snap.version, record: snap.value }
	})
	console.log(renderLedgerTable(ledgerRows))

	console.log(renderSection("BLOCKED / REJECTED CLAIMS", "ProofGate L1/L2/L3 Audit"))
	console.log(renderRejectedClaims(state.rejectedAttempts))

	console.log(renderSection("CONCURRENCY & EVIDENCE METRICS"))
	console.log(
		renderKpiGrid(
			[
				{ label: "Peak Concurrent Loops", value: `${state.metrics.peakConcurrentLoops}`, tone: "cyan" },
				{ label: "Loops Completed", value: `${state.metrics.totalLoopsFinished}/${state.metrics.totalLoopsStarted}`, tone: "green" },
				{ label: "0-Token Matches", value: `${state.metrics.deterministicMatches}`, tone: "green" },
				{ label: "L2 CAS Stopped", value: `${state.metrics.casConflictsPrevented}`, tone: "amber" },
				{ label: "L1 Blocked / Leaked", value: `${state.metrics.uncitedNumbersBlocked} / ${state.metrics.inventedNumbersLeaked}`, tone: "red" },
				{ label: "STALE Invalidations", value: `${state.metrics.staleInvalidations}`, tone: "purple" },
			],
			3,
		),
	)

	const outDir = resolve(process.cwd(), "out")
	mkdirSync(outDir, { recursive: true })
	const jsonl = state.auditLog.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
	writeFileSync(resolve(outDir, "audit-trace.jsonl"), jsonl, "utf8")
	console.log(`\n${c.green("✔")} Audit trace exported to ${c.cyan("out/audit-trace.jsonl")} ${c.dim(`(${state.auditLog.length} entries)`)}.`)
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
