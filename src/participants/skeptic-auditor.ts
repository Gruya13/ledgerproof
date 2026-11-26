import {
	createAgent,
	DeveloperMessageItem,
	ModelContext,
	SemanticEvent,
	SituationSpecification,
	type Agent,
	type InferenceInput,
	type SituationContext,
	type SituationHandler,
	type SituationProcessor,
	type Tool,
} from "@mozaik-ai/core"
import type { LedgerRuntimeApi } from "../runtime"
import { verifyClaimConfirmation } from "../engine/proof-verifier"
import { ProofGateInterceptionHandler } from "../interception/proof-gate"
import { CITATION_ARRAY_SCHEMA } from "./schemas"
import type { Citation, ClaimRecord } from "../types"

class ClaimProposedSpec extends SituationSpecification {
	isSatisfiedBy(context: SituationContext): boolean {
		return context.event.type === "claim.proposed" && context.event.producerId !== context.participant.getId()
	}
}

export function createSkepticAuditorAgent(rt: LedgerRuntimeApi, modelName: string): Agent {
	let selfId = ""

	const submitAuditVerdictTool: Tool = {
		type: "function",
		name: "submit_audit_verdict",
		description: "Confirm or refute a proposed financial claim against immutable SourceStore records.",
		strict: false,
		parameters: {
			type: "object",
			properties: {
				claimId: { type: "string" },
				verdict: { type: "string", enum: ["CONFIRMED", "REFUTED", "NEEDS_HUMAN"] },
				note: { type: "string" },
				citations: CITATION_ARRAY_SCHEMA,
			},
			required: ["claimId", "verdict", "note", "citations"],
		},
		invoke: async (args: {
			claimId: string
			verdict: "CONFIRMED" | "REFUTED" | "NEEDS_HUMAN"
			note: string
			citations: Citation[]
		}) => {
			const state = rt.resolveRuntime().state
			const target = state.claims.find((c) => c.claimId === args.claimId)
			if (!target) return { ok: false, reason: `Claim ${args.claimId} not found` }

			if (args.verdict === "CONFIRMED") {
				const ledgerRecord = target.invoiceId ? state.getCell(target.invoiceId)?.read().value : undefined
				const check = verifyClaimConfirmation(target, args.citations, state.sourceStore, ledgerRecord)
				if (!check.ok) {
					state.metrics.uncitedNumbersBlocked += 1
					const rejection = state.recordRejection({
						level: "L1_SOURCE_OR_MATH",
						code: "AUDIT_CONFIRMATION_UNVERIFIED",
						agentName: "SkepticAuditor",
						actionName: args.claimId,
						reason: check.reason ?? `Cannot confirm ${args.claimId}: citations do not prove claim`,
						rawArgs: args,
					})
					rt.sendEvent(SemanticEvent.create("proof.blocked", selfId, rejection), selfId)
					return {
						ok: false,
						code: "AUDIT_CONFIRMATION_UNVERIFIED",
						reason: rejection.reason,
					}
				}
			}

			target.auditStatus = args.verdict
			target.auditorNote = args.note

			if (args.verdict === "REFUTED") {
				state.recordRejection({
					level: "L2_ADVERSARIAL_REFUTED",
					code: "SKEPTIC_REFUTED",
					agentName: "SkepticAuditor",
					actionName: args.claimId,
					reason: args.note,
					rawArgs: args,
				})
			}

			state.logAudit("audit.verdict", "SkepticAuditor", target.invoiceId ?? target.txId, {
				claimId: args.claimId,
				verdict: args.verdict,
				note: args.note,
			})

			rt.sendEvent(
				SemanticEvent.create("audit.verdict", selfId, {
					claimId: args.claimId,
					verdict: args.verdict,
				}),
				selfId,
			)

			return { ok: true, claimId: args.claimId, verdict: args.verdict }
		},
	}

	const processor: SituationProcessor = {
		apply(context: SituationContext): void {
			const agent = context.participant as Agent
			selfId = agent.getId()
			const state = rt.resolveRuntime().state
			const { claim } = context.event.payload as { claim: ClaimRecord }
			if (!claim) return

			// Exact deterministic matches from StrictMatcher are already verified; LLM auditor checks all LLM-produced claims concurrently!
			if (claim.producer === "StrictMatcher") {
				return
			}

			if (!state.canStartLlmLoop()) {
				state.logAudit("budget.paused", "SkepticAuditor", claim.claimId, { llmCalls: state.metrics.llmCalls })
				return
			}

			state.metrics.llmCalls += 1
			const spanId = state.beginLoop("SkepticAuditor", context.event.type, claim.claimId)
			const freshContext = ModelContext.create().addContextItem(
				DeveloperMessageItem.create(agent.getDeveloperMessage()),
			)
			const inferenceInput: InferenceInput = {
				model: modelName,
				context: freshContext,
				tools: agent.getTools(),
			}

			const sourceSnapshots = claim.citations.map((c) => state.sourceStore.get(c.sourceId))
			const prompt = [
				`[AGENT:SkepticAuditor] [EVENT:claim.proposed:${claim.claimId}] [span:${spanId}]`,
				`Adversarially verify claim ${claim.claimId} from ${claim.producer} against raw SourceStore snapshots. Call submit_audit_verdict.`,
				"```json",
				JSON.stringify({ claim, sourceSnapshots }),
				"```",
			].join("\n")

			rt.runLoop(
				agent.getId(),
				prompt,
				inferenceInput,
				new ProofGateInterceptionHandler(agent.getId(), "SkepticAuditor", inferenceInput, rt),
			)
		},
	}

	const handler: SituationHandler = {
		specification: new ClaimProposedSpec(),
		processor,
	}

	const agent = createAgent({
		name: "SkepticAuditor",
		capabilities: ["adversarial-audit", "source-verification"],
		instruction: [
			"You are SkepticAuditor, an independent adversarial verifier.",
			"Compare the proposed claim and its citations against the raw SourceStore snapshots in the JSON payload.",
			"Call submit_audit_verdict with verdict='CONFIRMED' if citations match SourceStore (or 'NEEDS_HUMAN' for high-risk fraud alerts; 'REFUTED' if numbers/sources contradict), reusing exact citations from the verified SourceStore fields.",
			"All JSON amounts are integer cents — NEVER label raw amountCents with USD/EUR (write '$288.65 (28865 cents)' or '€195.00 (19500 cents)'). In your final text reply, include [src:ID] tags for every ID or monetary amount mentioned.",
		].join("\n"),
		tools: [submitAuditVerdictTool],
		handlers: [handler],
	})
	selfId = agent.getId()
	return agent
}
