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

function extractFuzzyInvoiceId(text: string): string | undefined {
	const match = text.match(/\bINV-?([0-9O]{3,6})\b/i)
	if (!match) return undefined
	return `INV-${match[1].toUpperCase().replace(/O/g, "0")}`
}

/**
 * Zero-API-key deterministic InferenceRunner implementing Mozaik's InferenceRunner contract.
 * Generic across both the fixed Black Friday pack and dynamic continuous stream IDs.
 * Introduces realistic async latency so multiple AgentLoops overlap concurrently,
 * and simulates the controlled L1 hallucination + L2 CAS write-skew trap when
 * concurrentWithAlert refunds arrive.
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
			items = this.handleRiskSentinel(eventTag, payload, previousCalls)
		} else if (role === "SkepticAuditor") {
			items = this.handleSkepticAuditor(payload, previousCalls)
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
		const tx = payload.transaction as Record<string, any> | undefined
		const arrivedTransactions = (payload.arrivedTransactions as Array<Record<string, any>> | undefined) ?? []
		const arrivedInvoices = (payload.arrivedInvoices as Array<Record<string, any>> | undefined) ?? []

		if (previousCalls.length === 0 && tx) {
			// Split payment case: SPLIT-* transactions sharing a normalized memo invoice ID or vendor sum
			if (typeof tx.reference === "string" && tx.reference.startsWith("SPLIT-")) {
				const targetInvId = extractFuzzyInvoiceId(String(tx.memo ?? ""))
				const inv = arrivedInvoices.find((i) => i.sourceId === targetInvId)
				if (inv) {
					const splitPeers = arrivedTransactions.filter(
						(t) =>
							typeof t.reference === "string" &&
							t.reference.startsWith("SPLIT-") &&
							t.vendorId === tx.vendorId &&
							extractFuzzyInvoiceId(String(t.memo ?? "")) === targetInvId,
					)
					const sumCents = splitPeers.reduce((acc, t) => acc + Number(t.amountCents ?? 0), 0)
					if (splitPeers.length >= 2 && sumCents === Number(inv.amountCents)) {
						const txIds = splitPeers.map((t) => String(t.sourceId))
						return [
							FunctionCallItem.rehydrate({
								callId: `call-rec-${inv.sourceId}-${Date.now()}`,
								name: "record_reconciliation",
								args: JSON.stringify({
									invoiceId: inv.sourceId,
									txIds,
									amountCents: sumCents,
									matchKind: "SPLIT_MATCH",
									explanation: `Matched split payments ${txIds.join(" + ")} to ${inv.sourceId} despite memo typo.`,
									citations: [
										{ sourceId: inv.sourceId, field: "amountCents", expectedValue: inv.amountCents },
										...splitPeers.map((t) => ({
											sourceId: t.sourceId,
											field: "amountCents",
											expectedValue: t.amountCents,
										})),
									],
								}),
							}),
						]
					}
				}
				return [
					ModelMessageItem.rehydrate({
						text: `Holding ${tx.sourceId} ($${(Number(tx.amountCents) / 100).toFixed(2)}) [src:${tx.sourceId}] pending matching split counterpart.`,
					}),
				]
			}

			// Partial payment case: PARTIAL-* tranche referencing an open invoice
			if (typeof tx.reference === "string" && tx.reference.startsWith("PARTIAL-")) {
				const refDigits = tx.reference.match(/PARTIAL-(\d+)/i)?.[1]
				const targetInvId = extractFuzzyInvoiceId(String(tx.memo ?? "")) ?? (refDigits ? `INV-${refDigits}` : undefined)
				const inv = arrivedInvoices.find((i) => i.sourceId === targetInvId)
				if (inv) {
					return [
						FunctionCallItem.rehydrate({
							callId: `call-rec-partial-${inv.sourceId}-${Date.now()}`,
							name: "record_reconciliation",
							args: JSON.stringify({
								invoiceId: inv.sourceId,
								txIds: [tx.sourceId],
								amountCents: tx.amountCents,
								matchKind: "PARTIAL_MATCH",
								explanation: `Partial tranche ${tx.sourceId} ($${(Number(tx.amountCents) / 100).toFixed(2)}) applied to ${inv.sourceId} ($${(Number(inv.amountCents) / 100).toFixed(2)}).`,
								citations: [
									{ sourceId: inv.sourceId, field: "amountCents", expectedValue: inv.amountCents },
									{ sourceId: tx.sourceId, field: "amountCents", expectedValue: tx.amountCents },
								],
							}),
						}),
					]
				}
			}

			// Orphan wire case: unreferenced wire without vendor
			if (tx.kind === "wire" && !tx.vendorId) {
				return [
					FunctionCallItem.rehydrate({
						callId: `call-rec-orphan-${tx.sourceId}-${Date.now()}`,
						name: "record_reconciliation",
						args: JSON.stringify({
							txId: tx.sourceId,
							amountCents: tx.amountCents,
							matchKind: "ORPHAN_TX",
							explanation: `Unreferenced wire ${tx.sourceId} ($${(Number(tx.amountCents) / 100).toFixed(2)}) has no matching invoice or vendor.`,
							citations: [{ sourceId: tx.sourceId, field: "amountCents", expectedValue: tx.amountCents }],
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

		// Final prose summary after tool output
		const lastCallArgs = (() => {
			try {
				return JSON.parse(previousCalls[0]?.args ?? "{}") as Record<string, any>
			} catch {
				return {}
			}
		})()

		if (lastCallArgs.matchKind === "SPLIT_MATCH" && lastCallArgs.invoiceId) {
			const txTags = ((lastCallArgs.txIds as string[]) ?? []).map((id) => `[src:${id}]`).join(" + ")
			return [
				ModelMessageItem.rehydrate({
					text: `Confirmed split reconciliation for [src:${lastCallArgs.invoiceId}] ($${(Number(lastCallArgs.amountCents) / 100).toFixed(2)}) across ${txTags}.`,
				}),
			]
		}

		if (lastCallArgs.matchKind === "PARTIAL_MATCH" && lastCallArgs.invoiceId) {
			const txId = (lastCallArgs.txIds as string[])?.[0] ?? tx?.sourceId ?? ""
			return [
				ModelMessageItem.rehydrate({
					text: `Recorded partial match for [src:${lastCallArgs.invoiceId}] with [src:${txId}] ($${(Number(lastCallArgs.amountCents) / 100).toFixed(2)}).`,
				}),
			]
		}

		if (lastCallArgs.matchKind === "ORPHAN_TX" && lastCallArgs.txId) {
			return [
				ModelMessageItem.rehydrate({
					text: `Flagged orphan wire [src:${lastCallArgs.txId}] ($${(Number(lastCallArgs.amountCents) / 100).toFixed(2)}) as unmatched.`,
				}),
			]
		}

		const lastOut = previousOutputs[previousOutputs.length - 1]?.output ?? ""
		return [ModelMessageItem.rehydrate({ text: `Reconciler step completed (${lastOut ? "ok" : "done"}).` })]
	}

	private handlePayoutAndRefund(
		eventTag: string,
		payload: Record<string, any>,
		previousCalls: FunctionCallItem[],
		previousOutputs: Array<{ callId: string; output: string }>,
	): InferenceOutput["items"] {
		const req = payload.request as Record<string, any> | undefined
		const expectedVersion = (payload.expectedVersion as number | undefined) ?? 1

		// Partial invoice triggers overdue chase draft; later claim.staled acknowledges cancellation
		if (eventTag === "invoice.partial") {
			const invoice = payload.invoice as Record<string, any> | undefined
			const partialTx = payload.partialTransaction as Record<string, any> | undefined
			const invoiceId = String(payload.invoiceId ?? invoice?.sourceId ?? "")
			const remainingCents = Number(payload.remainingCents ?? 0)
			const citations: Array<Record<string, unknown>> = [
				{ sourceId: invoiceId, field: "amountCents", expectedValue: Number(invoice?.amountCents ?? 0) },
			]
			if (partialTx?.sourceId) {
				citations.push({
					sourceId: partialTx.sourceId,
					field: "amountCents",
					expectedValue: Number(partialTx.amountCents ?? 0),
				})
			}

			if (previousCalls.length === 0) {
				return [
					FunctionCallItem.rehydrate({
						callId: `call-chase-${invoiceId}-${Date.now()}`,
						name: "draft_overdue_chase",
						args: JSON.stringify({
							invoiceId,
							amountCents: remainingCents,
							basedOnVersion: expectedVersion,
							reason: `Remaining unpaid balance on ${invoiceId}`,
							citations,
						}),
					}),
				]
			}
			const partialSuffix = partialTx?.sourceId
				? ` minus [src:${partialTx.sourceId}] ($${(Number(partialTx.amountCents) / 100).toFixed(2)})`
				: ""
			return [
				ModelMessageItem.rehydrate({
					text: `Created overdue chase draft for $${(remainingCents / 100).toFixed(2)} on [src:${invoiceId}]${partialSuffix}.`,
				}),
			]
		}

		if (eventTag === "claim.staled") {
			const invoiceId = String(payload.invoiceId ?? "")
			const txId = String(payload.txId ?? "")
			return [
				ModelMessageItem.rehydrate({
					text: `Acknowledged STALE chase draft on [src:${invoiceId}] after late settlement [src:${txId}]; chase aborted cleanly.`,
				}),
			]
		}

		// Legitimate non-alert refund (routes to L3 HITL if > $250, becomes REFUNDED when approved)
		if (req?.kind === "refund" && !req.concurrentWithAlert && previousCalls.length >= 1) {
			const lastOut = previousOutputs[previousOutputs.length - 1]?.output ?? ""
			const blocked = lastOut.includes('"ok":false')
			return [
				ModelMessageItem.rehydrate({
					text: blocked
						? `Refund [src:${req.sourceId}] on [src:${req.invoiceId}] ($${(Number(req.amountCents) / 100).toFixed(2)}) rejected by human approver.`
						: `Refund [src:${req.sourceId}] on [src:${req.invoiceId}] ($${(Number(req.amountCents) / 100).toFixed(2)}) approved and executed.`,
				}),
			]
		}

		// Planted hallucination trap + concurrent CAS write-skew on concurrent refund requests
		if (req?.kind === "refund") {
			const invoiceId = String(req.invoiceId)
			const exactCents = Number(req.amountCents)
			if (previousCalls.length === 0 && req.concurrentWithAlert) {
				const bogusCents = exactCents + 999
				// Deliberately attempt invented fee + bogus TX-9999 so ProofGate L1 blocks it!
				return [
					FunctionCallItem.rehydrate({
						callId: `call-refund-attempt1-${req.sourceId}-${Date.now()}`,
						name: "propose_refund",
						args: JSON.stringify({
							requestId: req.sourceId,
							invoiceId,
							amountCents: bogusCents,
							expectedVersion,
							reason: "Refund with estimated rush fee",
							citations: [
								{ sourceId: req.sourceId, field: "amountCents", expectedValue: exactCents },
								{ sourceId: "TX-9999", field: "amountCents", expectedValue: bogusCents },
							],
						}),
					}),
				]
			}
			if ((req.concurrentWithAlert && previousCalls.length === 1) || (!req.concurrentWithAlert && previousCalls.length === 0)) {
				// Retry with exact source numbers & original expectedVersion -> hits ProofGate L2 CAS conflict!
				return [
					FunctionCallItem.rehydrate({
						callId: `call-refund-attempt2-${req.sourceId}-${Date.now()}`,
						name: "propose_refund",
						args: JSON.stringify({
							requestId: req.sourceId,
							invoiceId,
							amountCents: exactCents,
							expectedVersion,
							reason: `Retry refund with exact cited amount from ${req.sourceId}`,
							citations: [
								{ sourceId: req.sourceId, field: "amountCents", expectedValue: exactCents },
								{ sourceId: invoiceId, field: "amountCents", expectedValue: exactCents },
							],
						}),
					}),
				]
			}
			const lastOut = previousOutputs[previousOutputs.length - 1]?.output ?? ""
			return [
				ModelMessageItem.rehydrate({
					text: `Refund for [src:${req.sourceId}] on [src:${invoiceId}] ($${(exactCents / 100).toFixed(2)}) halted by ProofGate (${lastOut.includes("WRITE_SKEW") ? "CAS write-skew conflict" : "verification gate"}); escalated for human review.`,
				}),
			]
		}

		// SEPA Payout drafts (auto-approve within limit or BEC IBAN human review)
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
						? `SEPA payout [src:${req.sourceId}] for [src:${req.invoiceId}] ($${(Number(req.amountCents) / 100).toFixed(2)}) blocked/held by ProofGate.`
						: `SEPA payout draft [src:${req.sourceId}] for [src:${req.invoiceId}] ($${(Number(req.amountCents) / 100).toFixed(2)}) prepared.`,
				}),
			]
		}

		return [ModelMessageItem.rehydrate({ text: `PayoutAndRefund finished ${eventTag}.` })]
	}

	private handleRiskSentinel(
		eventTag: string,
		payload: Record<string, any>,
		previousCalls: FunctionCallItem[],
	): InferenceOutput["items"] {
		const inv = payload.invoice as Record<string, any> | undefined
		const tx = payload.transaction as Record<string, any> | undefined
		const req = payload.request as Record<string, any> | undefined
		const vendor = payload.vendor as Record<string, any> | undefined
		const duplicateOf = payload.duplicateOf as Record<string, any> | undefined
		const currencyMismatch = payload.currencyMismatch as { invoice: Record<string, any>; transaction: Record<string, any> } | undefined
		const overpayment = payload.overpayment as
			| { invoice: Record<string, any>; transaction: Record<string, any>; excessCents: number }
			| undefined

		if (previousCalls.length === 0) {
			if (currencyMismatch) {
				const mInv = currencyMismatch.invoice
				const mTx = currencyMismatch.transaction
				return [
					FunctionCallItem.rehydrate({
						callId: `call-risk-curr-${mTx.sourceId}-${Date.now()}`,
						name: "flag_risk",
						args: JSON.stringify({
							invoiceId: mInv.sourceId,
							riskFlag: "CURRENCY_MISMATCH",
							severity: "HIGH",
							reason: `${mTx.sourceId} settled in ${mTx.currency} while ${mInv.sourceId} is billed in ${mInv.currency} ($${(Number(mInv.amountCents) / 100).toFixed(2)}).`,
							citations: [
								{ sourceId: mInv.sourceId, field: "currency", expectedValue: mInv.currency },
								{ sourceId: mTx.sourceId, field: "currency", expectedValue: mTx.currency },
								{ sourceId: mInv.sourceId, field: "amountCents", expectedValue: mInv.amountCents },
							],
						}),
					}),
				]
			}

			if (overpayment) {
				const oInv = overpayment.invoice
				const oTx = overpayment.transaction
				return [
					FunctionCallItem.rehydrate({
						callId: `call-risk-over-${oTx.sourceId}-${Date.now()}`,
						name: "flag_risk",
						args: JSON.stringify({
							invoiceId: oInv.sourceId,
							riskFlag: "OVERPAYMENT_ANOMALY",
							severity: "HIGH",
							reason: `${oTx.sourceId} ($${(Number(oTx.amountCents) / 100).toFixed(2)}) overpays ${oInv.sourceId} ($${(Number(oInv.amountCents) / 100).toFixed(2)}) by $${(overpayment.excessCents / 100).toFixed(2)}.`,
							citations: [
								{ sourceId: oInv.sourceId, field: "amountCents", expectedValue: oInv.amountCents },
								{ sourceId: oTx.sourceId, field: "amountCents", expectedValue: oTx.amountCents },
							],
						}),
					}),
				]
			}

			if (inv && duplicateOf) {
				return [
					FunctionCallItem.rehydrate({
						callId: `call-risk-dup-${inv.sourceId}-${Date.now()}`,
						name: "flag_risk",
						args: JSON.stringify({
							invoiceId: inv.sourceId,
							riskFlag: "DUPLICATE_INVOICE",
							severity: "HIGH",
							reason: `${inv.sourceId} duplicates ${duplicateOf.sourceId} (same vendor ${inv.vendorId}, PO ${inv.poNumber}, $${(Number(inv.amountCents) / 100).toFixed(2)}).`,
							citations: [
								{ sourceId: inv.sourceId, field: "poNumber", expectedValue: inv.poNumber },
								{ sourceId: duplicateOf.sourceId, field: "poNumber", expectedValue: duplicateOf.poNumber },
								{ sourceId: inv.sourceId, field: "amountCents", expectedValue: inv.amountCents },
							],
						}),
					}),
				]
			}

			if (req && vendor && req.targetIban !== vendor.masterIban) {
				return [
					FunctionCallItem.rehydrate({
						callId: `call-risk-bec-${req.sourceId}-${Date.now()}`,
						name: "flag_risk",
						args: JSON.stringify({
							invoiceId: req.invoiceId,
							riskFlag: "BEC_IBAN_CHANGE",
							severity: "CRITICAL",
							reason: `${req.sourceId} changes IBAN to ${req.targetIban}, mismatching vendor ${vendor.sourceId} master IBAN ${vendor.masterIban}.`,
							citations: [
								{ sourceId: req.sourceId, field: "targetIban", expectedValue: req.targetIban },
								{ sourceId: vendor.sourceId, field: "masterIban", expectedValue: vendor.masterIban },
							],
						}),
					}),
				]
			}

			if (tx?.kind === "fraud_alert") {
				const invoiceId = String(inv?.sourceId ?? tx.reference)
				return [
					FunctionCallItem.rehydrate({
						callId: `call-risk-fraud-${tx.sourceId}-${Date.now()}`,
						name: "flag_risk",
						args: JSON.stringify({
							invoiceId,
							riskFlag: "FRAUD_VELOCITY",
							severity: "CRITICAL",
							reason: `Velocity fraud alert ${tx.sourceId} ($${(Number(tx.amountCents) / 100).toFixed(2)}) detected on ${invoiceId}; placing immediate HOLD_RISK.`,
							citations: [
								{ sourceId: tx.sourceId, field: "amountCents", expectedValue: tx.amountCents },
								{ sourceId: invoiceId, field: "amountCents", expectedValue: Number(inv?.amountCents ?? tx.amountCents) },
							],
						}),
					}),
				]
			}
		}

		if (currencyMismatch) {
			const mInv = currencyMismatch.invoice
			const mTx = currencyMismatch.transaction
			return [
				ModelMessageItem.rehydrate({
					text: `Flagged currency mismatch between [src:${mInv.sourceId}] (${mInv.currency}) and [src:${mTx.sourceId}] (${mTx.currency}) ($${(Number(mInv.amountCents) / 100).toFixed(2)}).`,
				}),
			]
		}
		if (overpayment) {
			const oInv = overpayment.invoice
			const oTx = overpayment.transaction
			return [
				ModelMessageItem.rehydrate({
					text: `Flagged overpayment anomaly: [src:${oTx.sourceId}] ($${(Number(oTx.amountCents) / 100).toFixed(2)}) exceeds [src:${oInv.sourceId}] ($${(Number(oInv.amountCents) / 100).toFixed(2)}).`,
				}),
			]
		}
		if (inv && duplicateOf) {
			return [
				ModelMessageItem.rehydrate({
					text: `Locked duplicate invoice [src:${inv.sourceId}] ($${(Number(inv.amountCents) / 100).toFixed(2)}), matching [src:${duplicateOf.sourceId}].`,
				}),
			]
		}
		if (req && vendor) {
			return [
				ModelMessageItem.rehydrate({
					text: `Flagged BEC IBAN mismatch on [src:${req.sourceId}] vs master [src:${vendor.sourceId}] for [src:${req.invoiceId}] ($${(Number(req.amountCents) / 100).toFixed(2)}).`,
				}),
			]
		}
		if (tx) {
			const invoiceId = String(inv?.sourceId ?? tx.reference)
			return [
				ModelMessageItem.rehydrate({
					text: `Placed HOLD_RISK on [src:${invoiceId}] ($${(Number(tx.amountCents) / 100).toFixed(2)}) after fraud alert [src:${tx.sourceId}].`,
				}),
			]
		}
		return [ModelMessageItem.rehydrate({ text: `RiskSentinel check completed (${eventTag}).` })]
	}

	private handleSkepticAuditor(
		payload: Record<string, any>,
		previousCalls: FunctionCallItem[],
	): InferenceOutput["items"] {
		const claim = payload.claim as Record<string, any> | undefined
		if (!claim) {
			return [ModelMessageItem.rehydrate({ text: "SkepticAuditor had no claim payload." })]
		}

		if (previousCalls.length === 0) {
			const summary = String(claim.summary ?? "")
			const verdict =
				claim.kind === "RISK_FLAG" && summary.toLowerCase().includes("fraud")
					? "NEEDS_HUMAN"
					: "CONFIRMED"
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

		const srcId = claim.invoiceId ?? claim.txId ?? claim.citations?.[0]?.sourceId ?? "INV-1001"
		return [
			ModelMessageItem.rehydrate({
				text: `Audit verdict recorded for ${claim.claimId} referencing [src:${srcId}].`,
			}),
		]
	}
}
