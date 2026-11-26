import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { SemanticEvent, type InferenceRunner } from "@mozaik-ai/core"
import { ApprovalBroker, createLedgerRuntime, LedgerState, type ApprovalHandler } from "./runtime"
import { MockInferenceRunner } from "./engine/mock-runner"
import { createIngestorParticipant } from "./participants/ingestor"
import { createObserverParticipant, type StreamLogger } from "./participants/observer"
import { createStrictMatcherParticipant } from "./participants/strict-matcher"
import { createReconcilerAgent } from "./participants/reconciler"
import { createPayoutAndRefundAgent } from "./participants/payout-refund"
import { createRiskSentinelAgent } from "./participants/risk-sentinel"
import { createSkepticAuditorAgent } from "./participants/skeptic-auditor"
import type { BlackFridayPack, GroundTruthSpec } from "./types"

function sleep(ms: number): Promise<void> {
	return new Promise((resolveFn) => setTimeout(resolveFn, ms))
}

export function loadPack(packPath = resolve(process.cwd(), "data/black-friday-pack.json")): BlackFridayPack {
	return JSON.parse(readFileSync(packPath, "utf8")) as BlackFridayPack
}

export function loadGroundTruth(
	gtPath = resolve(process.cwd(), "data/ground-truth.json"),
): GroundTruthSpec {
	return JSON.parse(readFileSync(gtPath, "utf8")) as GroundTruthSpec
}

export interface ScenarioOptions {
	runner?: InferenceRunner
	useNativeRunner?: boolean
	modelName?: string
	approvalHandler?: ApprovalHandler
	log?: StreamLogger
	pack?: BlackFridayPack
}

export async function runBlackFridayScenario(options: ScenarioOptions = {}): Promise<LedgerState> {
	const pack = options.pack ?? loadPack()
	const runner = options.useNativeRunner ? undefined : (options.runner ?? new MockInferenceRunner())
	const modelName = options.modelName ?? "deepseek-chat"
	const approvalBroker = new ApprovalBroker(options.approvalHandler)
	const rt = createLedgerRuntime()
	const state = new LedgerState(pack, approvalBroker)

	rt.initializeRuntime({
		state,
		inferenceRunnerConfig: runner ? { runner } : undefined,
	})

	const ingestor = createIngestorParticipant()
	const observer = createObserverParticipant(rt, options.log)
	const strictMatcher = createStrictMatcherParticipant(rt)
	const reconciler = createReconcilerAgent(rt, modelName)
	const payoutRefund = createPayoutAndRefundAgent(rt, modelName)
	const riskSentinel = createRiskSentinelAgent(rt, modelName)
	const skepticAuditor = createSkepticAuditorAgent(rt, modelName)

	rt.join(ingestor)
	rt.join(observer)
	rt.join(strictMatcher)
	rt.join(reconciler)
	rt.join(payoutRefund)
	rt.join(riskSentinel)
	rt.join(skepticAuditor)

	const ingestorId = ingestor.getId()
	state.beginExternalWork()

	try {
		// Wave 1: Invoices + standard/split/partial/orphan/fee transactions
		for (const invoice of pack.invoices) {
			state.markInvoiceArrived(invoice.sourceId)
			rt.sendEvent(SemanticEvent.create("invoice.arrived", ingestorId, { invoice }), ingestorId)
		}

		for (const tx of pack.transactions) {
			if (tx.late || tx.kind === "fraud_alert") continue
			rt.sendEvent(SemanticEvent.create("transaction.arrived", ingestorId, { transaction: tx }), ingestorId)
		}

		// Tiny yield so StrictMatcher settles clean baseline invoices before requests fire,
		// while Wave 1's LLM loops (INV-1009 duplicate, TX-2006/2007 split, TX-2008 partial, TX-2014 orphan) stay concurrently in flight.
		await sleep(30)

		// Wave 2: Concurrent payout/refund requests + simultaneous fraud velocity alert TX-2016
		for (const request of pack.requests) {
			state.markRequestArrived(request.sourceId)
			rt.sendEvent(SemanticEvent.create("request.arrived", ingestorId, { request }), ingestorId)
			if (request.concurrentWithAlert) {
				const fraudTx = pack.transactions.find((t) => t.kind === "fraud_alert" && t.reference === request.invoiceId)
				if (fraudTx) {
					rt.sendEvent(
						SemanticEvent.create("transaction.arrived", ingestorId, { transaction: fraudTx }),
						ingestorId,
					)
				}
			}
		}

		// Wait until the partial chase draft on INV-1007 has been created before injecting late settlement TX-2017
		const chaseWaitMs = options.runner === undefined && !options.useNativeRunner ? 3000 : 15000
		const deadline = Date.now() + chaseWaitMs
		while (Date.now() < deadline) {
			const inv1007 = state.getCell("INV-1007")?.read().value
			if (inv1007 && inv1007.drafts.some((d) => d.status === "ACTIVE")) {
				break
			}
			await sleep(25)
		}

		// Wave 3: Late settlement arrives -> settles INV-1007 & invalidates overdue chase draft to STALE
		for (const tx of pack.transactions.filter((t) => t.late)) {
			rt.sendEvent(SemanticEvent.create("settlement.late", ingestorId, { transaction: tx }), ingestorId)
		}
	} finally {
		state.endExternalWork()
	}

	await state.waitForIdle(60000)
	return state
}
