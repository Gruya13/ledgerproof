import { createHash } from "node:crypto"
import type { Invoice, PaymentRequest, Vendor } from "../types"

export interface SepaPain001Input {
	invoice: Invoice
	vendor: Vendor
	request: PaymentRequest
	approvedBy: "AUTO_POLICY" | "HUMAN"
	cellVersion: number
	createdAt?: string
	debtorName?: string
	debtorIban?: string
}

export interface SepaDraftArtifact {
	invoiceId: string
	requestId: string
	messageId: string
	sha256: string
	xml: string
	createdAt: string
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;")
}

function normalizeIban(iban: string): string {
	return iban.replace(/\s+/g, "").toUpperCase()
}

export function generateSepaPain001Draft(input: SepaPain001Input): SepaDraftArtifact {
	if (input.invoice.currency !== "EUR" || input.request.currency !== "EUR") {
		throw new Error(
			`ISO 20022 SEPA pain.001 requires EUR currency (invoice=${input.invoice.currency}, request=${input.request.currency})`,
		)
	}

	const rawTargetIban = input.request.targetIban?.trim()
	if (!rawTargetIban) {
		throw new Error(`SEPA pain.001 requires a non-empty targetIban on ${input.request.sourceId}`)
	}

	const creditorIban = normalizeIban(rawTargetIban)
	const debtorName = input.debtorName ?? "LedgerProof Synthetic Demo Entity"
	const debtorIban = normalizeIban(input.debtorIban ?? "DE00100000000000000000")
	const createdAt = input.createdAt ?? new Date().toISOString()
	const execDate = createdAt.slice(0, 10)
	const messageId = `LP-${input.request.sourceId}-${input.invoice.sourceId}`
	const pmtInfId = `PMT-${input.request.sourceId}-V${input.cellVersion}`
	const endToEndId = `${input.invoice.sourceId}-${input.invoice.poNumber}`
	const amountFormatted = (input.request.amountCents / 100).toFixed(2)
	const remittance = `SYNTHETIC ${input.invoice.sourceId} ${input.invoice.poNumber} v${input.cellVersion} ${input.approvedBy}`

	const xml = [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<!-- SYNTHETIC TEST DATA ONLY - NOT FOR BANKING SUBMISSION - NOT FINANCIAL ADVICE -->`,
		`<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">`,
		`  <CstmrCdtTrfInitn>`,
		`    <GrpHdr>`,
		`      <MsgId>${escapeXml(messageId)}</MsgId>`,
		`      <CreDtTm>${escapeXml(createdAt)}</CreDtTm>`,
		`      <NbOfTxs>1</NbOfTxs>`,
		`      <CtrlSum>${amountFormatted}</CtrlSum>`,
		`      <InitgPty>`,
		`        <Nm>${escapeXml(debtorName)}</Nm>`,
		`      </InitgPty>`,
		`    </GrpHdr>`,
		`    <PmtInf>`,
		`      <PmtInfId>${escapeXml(pmtInfId)}</PmtInfId>`,
		`      <PmtMtd>TRF</PmtMtd>`,
		`      <NbOfTxs>1</NbOfTxs>`,
		`      <CtrlSum>${amountFormatted}</CtrlSum>`,
		`      <PmtTpInf>`,
		`        <SvcLvl>`,
		`          <Cd>SEPA</Cd>`,
		`        </SvcLvl>`,
		`      </PmtTpInf>`,
		`      <ReqdExctnDt>`,
		`        <Dt>${escapeXml(execDate)}</Dt>`,
		`      </ReqdExctnDt>`,
		`      <Dbtr>`,
		`        <Nm>${escapeXml(debtorName)}</Nm>`,
		`      </Dbtr>`,
		`      <DbtrAcct>`,
		`        <Id>`,
		`          <IBAN>${escapeXml(debtorIban)}</IBAN>`,
		`        </Id>`,
		`        <Ccy>EUR</Ccy>`,
		`      </DbtrAcct>`,
		`      <ChrgBr>SLEV</ChrgBr>`,
		`      <CdtTrfTxInf>`,
		`        <PmtId>`,
		`          <EndToEndId>${escapeXml(endToEndId)}</EndToEndId>`,
		`        </PmtId>`,
		`        <Amt>`,
		`          <InstdAmt Ccy="EUR">${amountFormatted}</InstdAmt>`,
		`        </Amt>`,
		`        <Cdtr>`,
		`          <Nm>${escapeXml(input.vendor.name)}</Nm>`,
		`          <PstlAdr>`,
		`            <Ctry>${escapeXml(input.vendor.country)}</Ctry>`,
		`          </PstlAdr>`,
		`        </Cdtr>`,
		`        <CdtrAcct>`,
		`          <Id>`,
		`            <IBAN>${escapeXml(creditorIban)}</IBAN>`,
		`          </Id>`,
		`        </CdtrAcct>`,
		`        <RmtInf>`,
		`          <Ustrd>${escapeXml(remittance)}</Ustrd>`,
		`        </RmtInf>`,
		`      </CdtTrfTxInf>`,
		`    </PmtInf>`,
		`  </CstmrCdtTrfInitn>`,
		`</Document>`,
		"",
	].join("\n")

	const sha256 = createHash("sha256").update(xml).digest("hex").slice(0, 16)

	return {
		invoiceId: input.invoice.sourceId,
		requestId: input.request.sourceId,
		messageId,
		sha256,
		xml,
		createdAt,
	}
}
