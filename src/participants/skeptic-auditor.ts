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
import { ProofGateInterceptionHandler } from "../interception/proof-gate"
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
				citations: { type: "array", items: { type: "object" } },
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
		instruction:
			"You are SkepticAuditor, an independent adversarial verifier. Attempt to refute claims using raw SourceStore data; confirm only if every cited number and ID holds, and include [src:ID] in your final message.",
		tools: [submitAuditVerdictTool],
		handlers: [handler],
	})
	selfId = agent.getId()
	return agent
}
