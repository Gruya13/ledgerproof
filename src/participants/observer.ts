import {
	createHuman,
	SituationSpecification,
	type SituationContext,
	type SituationHandler,
	type SituationProcessor,
} from "@mozaik-ai/core"
import type { LedgerRuntimeApi } from "../runtime"

class ObserverSpec extends SituationSpecification {
	isSatisfiedBy(context: SituationContext): boolean {
		const t = context.event.type
		return (
			t === "message_received.started" ||
			t === "model.answer" ||
			t === "proof.blocked" ||
			t === "conflict.prevented" ||
			t === "human.required" ||
			t === "claim.staled"
		)
	}
}

export type StreamLogger = (line: string) => void

export function createObserverParticipant(rt: LedgerRuntimeApi, log?: StreamLogger) {
	const processor: SituationProcessor = {
		apply(context: SituationContext): void {
			const state = rt.resolveRuntime().state
			const payload = (context.event.payload ?? {}) as Record<string, unknown>

			if (context.event.type === "message_received.started") {
				const content = typeof payload.content === "string" ? payload.content : ""
				const loopId = typeof payload.loopId === "string" ? payload.loopId : undefined
				const spanMatch = content.match(/\[span:([^\]]+)\]/)
				if (spanMatch && loopId) {
					state.attachLoopId(spanMatch[1], loopId)
				}
				return
			}

			if (context.event.type === "model.answer") {
				const loopId = typeof payload.loopId === "string" ? payload.loopId : undefined
				state.endLoopByLoopIdOrSpan(loopId, "COMPLETED")
				const answerObj = payload.answer as { content?: { text?: string } } | undefined
				const text = answerObj?.content?.text
				if (text && log) {
					const participant = rt.resolveRuntime().getParticipant(context.event.producerId)
					const name = participant?.getManifest().name ?? context.event.producerId
					log(`[${name}] ${text}`)
				}
				return
			}

			if (context.event.type === "proof.blocked" && log) {
				log(`[ProofGate BLOCKED] ${String(payload.code ?? "")}: ${String(payload.reason ?? "")}`)
			} else if (context.event.type === "conflict.prevented" && log) {
				log(`[ProofGate CAS] Prevented write-skew on ${String(payload.invoiceId ?? "")}`)
			} else if (context.event.type === "human.required" && log) {
				log(
					`[ProofGate HITL] Paused ${String(payload.actionName ?? "")} on ${String(payload.invoiceId ?? "")}: ${String(payload.reason ?? "")}`,
				)
			} else if (context.event.type === "claim.staled" && log) {
				log(
					`[Palimpsest STALE] Invalidated ${String(payload.staledCount ?? 0)} chase draft(s) on ${String(payload.invoiceId ?? "")}`,
				)
			}
		},
	}

	const handler: SituationHandler = {
		specification: new ObserverSpec(),
		processor,
	}

	return createHuman({
		name: "TelemetryObserver",
		capabilities: ["observability", "audit-trace"],
		handlers: [handler],
	})
}
