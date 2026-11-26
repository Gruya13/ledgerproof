import {
	FunctionCallItem,
	FunctionCallOutputItem,
	ModelMessageItem,
	SemanticEvent,
	UserMessageItem,
	type InferenceInput,
	type InferenceOutput,
	type InferenceRunner,
} from "@mozaik-ai/core"

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function getAllUserTexts(input: InferenceInput): string[] {
	return input.context
		.getItems()
		.filter((item): item is UserMessageItem => item instanceof UserMessageItem)
		.map((item) => item.content.text)
}

function getToolOutputs(input: InferenceInput): Array<{ callId: string; output: string }> {
	return input.context
		.getItems()
		.filter((item): item is FunctionCallOutputItem => item instanceof FunctionCallOutputItem)
		.map((item) => ({ callId: item.callId, output: item.output.text }))
}

function getToolCalls(input: InferenceInput): FunctionCallItem[] {
	return input.context
		.getItems()
		.filter((item): item is FunctionCallItem => item instanceof FunctionCallItem)
}

function extractMeta(prompt: string, key: string): string | undefined {
	const match = prompt.match(new RegExp(`\\[${key}:([^\\]]+)\\]`))
	return match?.[1]
}

function extractJsonBlock(prompt: string): Record<string, any> | undefined {
	const match = prompt.match(/```json\s*([\s\S]*?)```/)
	if (!match) return undefined
	try {
		return JSON.parse(match[1]) as Record<string, any>
	} catch {
		return undefined
	}
}

/**
 * Zero-API-key deterministic InferenceRunner implementing Mozaik's InferenceRunner contract.
 * Introduces realistic async latency so multiple AgentLoops overlap concurrently,
 * and plants the controlled hallucination trap on REQ-3003 / INV-1011 so ProofGate L1+L2
 * interception is exercised end-to-end.
 */
export class MockInferenceRunner implements InferenceRunner {
	async run(input: InferenceInput): Promise<InferenceOutput> {
		const userTexts = getAllUserTexts(input)
		const firstPrompt = userTexts[0] ?? ""
		const role = extractMeta(firstPrompt, "AGENT") ?? "Unknown"
		const eventTag = extractMeta(firstPrompt, "EVENT") ?? ""
		const payload = extractJsonBlock(firstPrompt) ?? {}
		const previousCalls = getToolCalls(input)
		const previousOutputs = getToolOutputs(input)

		// Varied async delays ensure concurrent AgentLoops genuinely overlap in flight.
		const delayByRole: Record<string, number> = {
			Reconciler: 110,
			PayoutAndRefund: 130,
			RiskSentinel: 80,
			SkepticAuditor: 70,
		}
		await sleep(delayByRole[role] ?? 60)

		let items: InferenceOutput["items"] = []

		if (role === "Reconciler") {
			items = this.handleReconciler(eventTag, payload, previousCalls, previousOutputs)
		} else if (role === "PayoutAndRefund") {
			items = this.handlePayoutAndRefund(eventTag, payload, previousCalls, previousOutputs)
		} else if (role === "RiskSentinel") {
			items = this.handleRiskSentinel(eventTag, payload, previousCalls, previousOutputs)
		} else if (role === "SkepticAuditor") {
			items = this.handleSkepticAuditor(eventTag, payload, previousCalls, previousOutputs)
		} else {
			items = [ModelMessageItem.rehydrate({ text: `Mock agent ${role} completed.` })]
		}

		return {
			items,
			tokenUsage: undefined,
			rowResponse: { mock: true, model: input.model, role },
		}
	}

	async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		yield SemanticEvent.create("inference.output", input.model, await this.run(input))
	}

	private handleReconciler(
		eventTag: string,
		payload: Record<string, any>,
		previousCalls: FunctionCallItem[],
		previousOutputs: Array<{ callId: string; output: string }>,
	): InferenceOutput["items"] {
		if (previousCalls.length === 0) {
			const tx = payload.transaction as Record<string, any> | undefined
			const arrivedTransactions = (payload.arrivedTransactions as Array<Record<string, any>> | undefined) ?? []
			const arrivedInvoices = (payload.arrivedInvoices as Array<Record<string, any>> | undefined) ?? []

			// Split payment case: INV-1006 ($1,200.00) paid by TX-2006 ($700) + TX-2007 ($500) with "INV10O6" typo
			if (tx?.sourceId === "TX-2006" || tx?.sourceId === "TX-2007") {
				const splitPair = arrivedTransactions.filter(
					(t) => t.sourceId === "TX-2006" || t.sourceId === "TX-2007",
				)
				const inv1006 = arrivedInvoices.find((i) => i.sourceId === "INV-1006")
				if (splitPair.length === 2 && inv1006) {
					return [
						FunctionCallItem.rehydrate({
							callId: `call-rec-1006-${Date.now()}`,
							name: "record_reconciliation",
							args: JSON.stringify({
								invoiceId: "INV-1006",
								txIds: ["TX-2006", "TX-2007"],
								amountCents: 120000,
								matchKind: "SPLIT_MATCH",
								explanation:
									"Matched split payments TX-2006 ($700.00) + TX-2007 ($500.00) despite memo typo INV10O6.",
								citations: [
									{ sourceId: "INV-1006", field: "amountCents", expectedValue: 120000 },
									{ sourceId: "TX-2006", field: "amountCents", expectedValue: 70000 },
									{ sourceId: "TX-2007", field: "amountCents", expectedValue: 50000 },
								],
							}),
						}),
					]
				}
				return [
					ModelMessageItem.rehydrate({
						text: `Holding ${tx.sourceId} ($${(tx.amountCents / 100).toFixed(2)}) [src:${tx.sourceId}] pending matching split counterpart.`,
					}),
				]
			}

			// Partial payment case: TX-2008 ($500) toward INV-1007 ($800)
			if (tx?.sourceId === "TX-2008") {
				return [
					FunctionCallItem.rehydrate({
						callId: `call-rec-1007-${Date.now()}`,
						name: "record_reconciliation",
						args: JSON.stringify({
							invoiceId: "INV-1007",
							txIds: ["TX-2008"],
							amountCents: 50000,
							matchKind: "PARTIAL_MATCH",
							explanation: "Partial tranche TX-2008 ($500.00) applied to INV-1007 ($800.00); $300.00 remains open.",
							citations: [
								{ sourceId: "INV-1007", field: "amountCents", expectedValue: 80000 },
								{ sourceId: "TX-2008", field: "amountCents", expectedValue: 50000 },
							],
						}),
					}),
				]
			}

			// Orphan wire case: TX-2014 ($189.40)
			if (tx?.sourceId === "TX-2014") {
				return [
					FunctionCallItem.rehydrate({
						callId: `call-rec-2014-${Date.now()}`,
						name: "record_reconciliation",
						args: JSON.stringify({
							txId: "TX-2014",
							amountCents: 18940,
							matchKind: "ORPHAN_TX",
							explanation: "Unreferenced wire TX-2014 ($189.40) has no matching invoice or vendor.",
							citations: [{ sourceId: "TX-2014", field: "amountCents", expectedValue: 18940 }],
						}),
					}),
				]
			}

			return [
				ModelMessageItem.rehydrate({
					text: `Reconciler reviewed ${eventTag}; no additional action required.`,
				}),
			]
		}

		// After tool output
		const lastOut = previousOutputs[previousOutputs.length - 1]?.output ?? ""
		if (eventTag.includes("TX-2007") || lastOut.includes("INV-1006")) {
			return [
				ModelMessageItem.rehydrate({
					text: "Confirmed split reconciliation for [src:INV-1006] ($1,200.00) across [src:TX-2006] ($700.00) and [src:TX-2007] ($500.00).",
				}),
			]
		}
		if (lastOut.includes("INV-1007")) {
			return [
				ModelMessageItem.rehydrate({
					text: "Recorded partial match for [src:INV-1007] ($800.00) with [src:TX-2008] ($500.00); $300.00 open.",
				}),
			]
		}
		if (lastOut.includes("TX-2014")) {
			return [
				ModelMessageItem.rehydrate({
					text: "Flagged orphan wire [src:TX-2014] ($189.40) as unmatched.",
				}),
			]
		}
		return [ModelMessageItem.rehydrate({ text: "Reconciler step completed." })]
	}

	private handlePayoutAndRefund(
		eventTag: string,
		payload: Record<string, any>,
		previousCalls: FunctionCallItem[],
		previousOutputs: Array<{ callId: string; output: string }>,
	): InferenceOutput["items"] {
		const req = payload.request as Record<string, any> | undefined
		const expectedVersion = (payload.expectedVersion as number | undefined) ?? 1

		// Case 3: Partial invoice triggers overdue chase draft; later claim.staled acknowledges cancellation
		if (eventTag === "invoice.partial") {
			if (previousCalls.length === 0) {
				return [
					FunctionCallItem.rehydrate({
						callId: `call-chase-${payload.invoiceId}-${Date.now()}`,
						name: "draft_overdue_chase",
						args: JSON.stringify({
							invoiceId: payload.invoiceId,
							amountCents: payload.remainingCents,
							basedOnVersion: expectedVersion,
							reason: `Remaining unpaid balance on ${payload.invoiceId}`,
							citations: [
								{ sourceId: payload.invoiceId, field: "amountCents", expectedValue: 80000 },
								{ sourceId: "TX-2008", field: "amountCents", expectedValue: 50000 },
							],
						}),
					}),
				]
			}
			return [
				ModelMessageItem.rehydrate({
					text: `Created overdue chase draft for $300.00 on [src:INV-1007] minus [src:TX-2008] ($500.00).`,
				}),
			]
		}

		if (eventTag === "claim.staled") {
			return [
				ModelMessageItem.rehydrate({
					text: `Acknowledged STALE chase draft on [src:INV-1007] after late settlement [src:TX-2017] ($300.00); chase aborted cleanly.`,
				}),
			]
		}

		// Case 7: Planted hallucination trap + concurrent CAS write-skew on REQ-3003 / INV-1011
		if (req?.sourceId === "REQ-3003") {
			if (previousCalls.length === 0) {
				// Deliberately attempt invented fee ($319.99 = 31999) + bogus TX-9999 so ProofGate L1 blocks it!
				return [
					FunctionCallItem.rehydrate({
						callId: `call-req3003-attempt1-${Date.now()}`,
						name: "propose_refund",
						args: JSON.stringify({
							requestId: "REQ-3003",
							invoiceId: "INV-1011",
							amountCents: 31999,
							expectedVersion,
							reason: "Refund with estimated rush fee",
							citations: [
								{ sourceId: "REQ-3003", field: "amountCents", expectedValue: 31000 },
								{ sourceId: "TX-9999", field: "amountCents", expectedValue: 31999 },
							],
						}),
					}),
				]
			}
			if (previousCalls.length === 1) {
				// Retry with exact source numbers & original expectedVersion -> hits ProofGate L2 CAS conflict!
				return [
					FunctionCallItem.rehydrate({
						callId: `call-req3003-attempt2-${Date.now()}`,
						name: "propose_refund",
						args: JSON.stringify({
							requestId: "REQ-3003",
							invoiceId: "INV-1011",
							amountCents: 31000,
							expectedVersion,
							reason: "Retry refund with exact cited amount from REQ-3003",
							citations: [
								{ sourceId: "REQ-3003", field: "amountCents", expectedValue: 31000 },
								{ sourceId: "INV-1011", field: "amountCents", expectedValue: 31000 },
							],
						}),
					}),
				]
			}
			const lastOut = previousOutputs[previousOutputs.length - 1]?.output ?? ""
			return [
				ModelMessageItem.rehydrate({
					text: `Refund for [src:REQ-3003] on [src:INV-1011] ($310.00) halted by ProofGate (${lastOut.includes("WRITE_SKEW") ? "CAS write-skew conflict" : "verification gate"}); escalated for human review.`,
				}),
			]
		}

		// SEPA Payout drafts (REQ-3001, REQ-3002 BEC IBAN, REQ-3004 controlled auto-approve)
		if (req?.kind === "sepa_payout") {
			if (previousCalls.length === 0) {
				return [
					FunctionCallItem.rehydrate({
						callId: `call-sepa-${req.sourceId}-${Date.now()}`,
						name: "propose_sepa_payout",
						args: JSON.stringify({
							requestId: req.sourceId,
							invoiceId: req.invoiceId,
							vendorId: req.vendorId,
							amountCents: req.amountCents,
							targetIban: req.targetIban,
							expectedVersion,
							citations: [
								{ sourceId: req.sourceId, field: "amountCents", expectedValue: req.amountCents },
								{ sourceId: req.invoiceId, field: "amountCents", expectedValue: req.amountCents },
							],
						}),
					}),
				]
			}
			const lastOut = previousOutputs[previousOutputs.length - 1]?.output ?? ""
			const blocked = lastOut.includes('"ok":false')
			return [
				ModelMessageItem.rehydrate({
					text: blocked
						? `SEPA payout [src:${req.sourceId}] for [src:${req.invoiceId}] ($${(req.amountCents / 100).toFixed(2)}) blocked/held by ProofGate.`
						: `SEPA payout draft [src:${req.sourceId}] for [src:${req.invoiceId}] ($${(req.amountCents / 100).toFixed(2)}) prepared.`,
				}),
			]
		}

		return [ModelMessageItem.rehydrate({ text: `PayoutAndRefund finished ${eventTag}.` })]
	}

	private handleRiskSentinel(
		eventTag: string,
		payload: Record<string, any>,
		previousCalls: FunctionCallItem[],
		_previousOutputs: Array<{ callId: string; output: string }>,
	): InferenceOutput["items"] {
		if (previousCalls.length === 0) {
			const inv = payload.invoice as Record<string, any> | undefined
			const tx = payload.transaction as Record<string, any> | undefined
			const req = payload.request as Record<string, any> | undefined
			const duplicateOf = payload.duplicateOf as Record<string, any> | undefined

			// Case 4: Duplicate invoice INV-1009 vs INV-1008
			if (inv?.sourceId === "INV-1009" && duplicateOf) {
				return [
					FunctionCallItem.rehydrate({
						callId: `call-risk-dup-${Date.now()}`,
						name: "flag_risk",
						args: JSON.stringify({
							invoiceId: "INV-1009",
							riskFlag: "DUPLICATE_INVOICE",
							severity: "HIGH",
							reason: `INV-1009 duplicates INV-1008 (same vendor ${inv.vendorId}, PO ${inv.poNumber}, $450.00).`,
							citations: [
								{ sourceId: "INV-1009", field: "poNumber", expectedValue: inv.poNumber },
								{ sourceId: "INV-1008", field: "poNumber", expectedValue: duplicateOf.poNumber },
								{ sourceId: "INV-1009", field: "amountCents", expectedValue: 45000 },
							],
						}),
					}),
				]
			}

			// Case 6: BEC vendor IBAN change on REQ-3002 / INV-1010
			if (req?.sourceId === "REQ-3002") {
				const vendor = payload.vendor as Record<string, any>
				return [
					FunctionCallItem.rehydrate({
						callId: `call-risk-bec-${Date.now()}`,
						name: "flag_risk",
						args: JSON.stringify({
							invoiceId: "INV-1010",
							riskFlag: "BEC_IBAN_CHANGE",
							severity: "CRITICAL",
							reason: `REQ-3002 changes IBAN to ${req.targetIban}, mismatching vendor ${vendor.sourceId} master IBAN ${vendor.masterIban}.`,
							citations: [
								{ sourceId: "REQ-3002", field: "targetIban", expectedValue: req.targetIban },
								{ sourceId: "VND-04", field: "masterIban", expectedValue: vendor.masterIban },
							],
						}),
					}),
				]
			}

			// Case 7: Velocity fraud alert TX-2016 on INV-1011
			if (tx?.sourceId === "TX-2016") {
				return [
					FunctionCallItem.rehydrate({
						callId: `call-risk-fraud-${Date.now()}`,
						name: "flag_risk",
						args: JSON.stringify({
							invoiceId: "INV-1011",
							riskFlag: "FRAUD_VELOCITY",
							severity: "CRITICAL",
							reason: `Velocity fraud alert TX-2016 ($310.00) detected on INV-1011; placing immediate HOLD_RISK.`,
							citations: [
								{ sourceId: "TX-2016", field: "amountCents", expectedValue: 31000 },
								{ sourceId: "INV-1011", field: "amountCents", expectedValue: 31000 },
							],
						}),
					}),
				]
			}
		}

		if (eventTag.includes("INV-1009")) {
			return [
				ModelMessageItem.rehydrate({
					text: "Locked duplicate invoice [src:INV-1009] ($450.00), matching [src:INV-1008] ($450.00).",
				}),
			]
		}
		if (eventTag.includes("REQ-3002")) {
			return [
				ModelMessageItem.rehydrate({
					text: "Flagged BEC IBAN mismatch on [src:REQ-3002] vs master [src:VND-04] for [src:INV-1010] ($640.00).",
				}),
			]
		}
		if (eventTag.includes("TX-2016")) {
			return [
				ModelMessageItem.rehydrate({
					text: "Placed HOLD_RISK on [src:INV-1011] ($310.00) after fraud alert [src:TX-2016].",
				}),
			]
		}
		return [ModelMessageItem.rehydrate({ text: "RiskSentinel check completed." })]
	}

	private handleSkepticAuditor(
		_eventTag: string,
		payload: Record<string, any>,
		previousCalls: FunctionCallItem[],
		_previousOutputs: Array<{ callId: string; output: string }>,
	): InferenceOutput["items"] {
		const claim = payload.claim as Record<string, any> | undefined
		if (!claim) {
			return [ModelMessageItem.rehydrate({ text: "SkepticAuditor had no claim payload." })]
		}

		if (previousCalls.length === 0) {
			const verdict = claim.kind === "RISK_FLAG" && claim.invoiceId === "INV-1011" ? "NEEDS_HUMAN" : "CONFIRMED"
			return [
				FunctionCallItem.rehydrate({
					callId: `call-audit-${claim.claimId}-${Date.now()}`,
					name: "submit_audit_verdict",
					args: JSON.stringify({
						claimId: claim.claimId,
						verdict,
						note: `Independent check confirmed citations for ${claim.claimId} against immutable SourceStore.`,
						citations: claim.citations,
					}),
				}),
			]
		}

		const srcId = claim.invoiceId ?? claim.txId ?? "INV-1001"
		return [
			ModelMessageItem.rehydrate({
				text: `Audit verdict recorded for ${claim.claimId} referencing [src:${srcId}].`,
			}),
		]
	}
}
