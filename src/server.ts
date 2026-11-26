import "dotenv/config"
import { existsSync, readFileSync, statSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { extname, resolve, sep } from "node:path"
import { resolveLiveProviderFromEnv } from "./engine/provider-factory"
import type { TrapKind } from "./engine/stream-generator"
import { SessionController } from "./session-controller"

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
	const json = JSON.stringify(body)
	res.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(json),
	})
	res.end(json)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		size += buf.length
		if (size > 1_000_000) {
			throw new Error("Request body too large")
		}
		chunks.push(buf)
	}
	if (chunks.length === 0) return {}
	const raw = Buffer.concat(chunks).toString("utf8").trim()
	if (!raw) return {}
	return JSON.parse(raw) as Record<string, unknown>
}

const MAX_SESSIONS = 25
const SESSION_TTL_MS = 15 * 60 * 1000
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

interface SessionEntry {
	id: string
	controller: SessionController
	sseClients: Set<ServerResponse>
	broadcastScheduled: boolean
	unsubscribe: () => void
	lastActiveAt: number
}

function resolveSessionId(req: IncomingMessage, url: URL): string {
	const queryVal = url.searchParams.get("session")?.trim()
	if (queryVal && SESSION_ID_RE.test(queryVal)) return queryVal
	const headerRaw = req.headers["x-session-id"]
	const headerVal = Array.isArray(headerRaw) ? headerRaw[0]?.trim() : headerRaw?.trim()
	if (headerVal && SESSION_ID_RE.test(headerVal)) return headerVal
	return "default"
}

export function createLedgerServer(
	controller = new SessionController(),
	distUiDir = resolve(process.cwd(), "dist-ui"),
): { server: Server; controller: SessionController } {
	const sessions = new Map<string, SessionEntry>()

	const disposeSession = (id: string) => {
		const entry = sessions.get(id)
		if (!entry) return
		entry.controller.stopContinuousStream()
		entry.unsubscribe()
		for (const client of entry.sseClients) {
			if (!client.writableEnded) {
				client.end()
			}
		}
		entry.sseClients.clear()
		sessions.delete(id)
	}

	const getOrCreateSession = (sessionId: string): SessionEntry => {
		const now = Date.now()
		const existing = sessions.get(sessionId)
		if (existing) {
			existing.lastActiveAt = now
			return existing
		}

		// Evict expired idle non-default sessions before allocating a new one
		for (const [id, entry] of sessions.entries()) {
			if (id !== "default" && entry.sseClients.size === 0 && now - entry.lastActiveAt > SESSION_TTL_MS) {
				disposeSession(id)
			}
		}

		if (sessions.size >= MAX_SESSIONS) {
			let oldestId: string | null = null
			let oldestTs = Infinity
			for (const [id, entry] of sessions.entries()) {
				if (id !== "default" && entry.lastActiveAt < oldestTs) {
					oldestTs = entry.lastActiveAt
					oldestId = id
				}
			}
			if (oldestId) {
				disposeSession(oldestId)
			}
		}

		const ctrl = sessionId === "default" ? controller : new SessionController()
		const sseClients = new Set<ServerResponse>()
		const entry: SessionEntry = {
			id: sessionId,
			controller: ctrl,
			sseClients,
			broadcastScheduled: false,
			unsubscribe: () => {},
			lastActiveAt: now,
		}

		entry.unsubscribe = ctrl.subscribe(() => {
			if (entry.broadcastScheduled || entry.sseClients.size === 0) return
			entry.broadcastScheduled = true
			setTimeout(() => {
				entry.broadcastScheduled = false
				const data = `event: snapshot\ndata: ${JSON.stringify(entry.controller.getSnapshot())}\n\n`
				for (const client of entry.sseClients) {
					if (!client.writableEnded) {
						client.write(data)
					}
				}
			}, 25)
		})

		sessions.set(sessionId, entry)
		return entry
	}

	// Ensure default session is registered immediately
	getOrCreateSession("default")

	const heartbeatTimer = setInterval(() => {
		for (const entry of sessions.values()) {
			for (const client of entry.sseClients) {
				if (!client.writableEnded) {
					client.write(": ping\n\n")
				}
			}
		}
	}, 25_000)
	heartbeatTimer.unref()

	const cleanupTimer = setInterval(() => {
		const now = Date.now()
		for (const [id, entry] of sessions.entries()) {
			if (id !== "default" && entry.sseClients.size === 0 && now - entry.lastActiveAt > SESSION_TTL_MS) {
				disposeSession(id)
			}
		}
	}, 60_000)
	cleanupTimer.unref()

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		const path = url.pathname
		const method = (req.method ?? "GET").toUpperCase()

		try {
			if (method === "GET" && path === "/api/health") {
				const live = resolveLiveProviderFromEnv()
				sendJson(res, 200, {
					ok: true,
					liveProvider: live?.label ?? null,
					activeSessions: sessions.size,
				})
				return
			}

			const session = getOrCreateSession(resolveSessionId(req, url))
			const activeController = session.controller

			if (method === "GET" && path === "/api/state") {
				sendJson(res, 200, activeController.getSnapshot())
				return
			}

			if (method === "GET" && path === "/api/events") {
				res.writeHead(200, {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache, no-transform",
					Connection: "keep-alive",
					"X-Accel-Buffering": "no",
				})
				session.sseClients.add(res)
				res.write(`event: snapshot\ndata: ${JSON.stringify(activeController.getSnapshot())}\n\n`)
				req.on("close", () => {
					session.sseClients.delete(res)
					session.lastActiveAt = Date.now()
				})
				return
			}

			if (method === "POST" && path === "/api/run") {
				const body = await readJsonBody(req)
				const result = activeController.startRun({
					mode: body.mode === "live" ? "live" : "mock",
					manualLateSettlement:
						typeof body.manualLateSettlement === "boolean" ? body.manualLateSettlement : true,
					autoApprovePolicy:
						typeof body.autoApprovePolicy === "boolean" ? body.autoApprovePolicy : false,
					staggerMs: typeof body.staggerMs === "number" ? body.staggerMs : undefined,
				})
				if (!result.ok) {
					sendJson(res, 400, result)
					return
				}
				sendJson(res, 200, result)
				return
			}

			if (method === "POST" && path.startsWith("/api/approvals/")) {
				const approvalId = decodeURIComponent(path.slice("/api/approvals/".length))
				const body = await readJsonBody(req)
				if (typeof body.approved !== "boolean") {
					sendJson(res, 400, { ok: false, error: "approved (boolean) is required" })
					return
				}
				const result = activeController.resolveApproval(
					approvalId,
					body.approved,
					typeof body.reason === "string" ? body.reason : undefined,
				)
				sendJson(res, result.ok ? 200 : 404, result)
				return
			}

			if (method === "POST" && path === "/api/inject-late") {
				const result = activeController.injectLateSettlement()
				sendJson(res, result.ok ? 200 : 400, result)
				return
			}

			if (method === "POST" && path === "/api/stream/start") {
				const body = await readJsonBody(req)
				const result = activeController.startContinuousStream({
					mode: body.mode === "live" ? "live" : "mock",
					intervalMs: typeof body.intervalMs === "number" ? body.intervalMs : undefined,
					trapCadence: typeof body.trapCadence === "number" ? body.trapCadence : undefined,
					autoApprovePolicy:
						typeof body.autoApprovePolicy === "boolean" ? body.autoApprovePolicy : false,
					maxLlmCalls: typeof body.maxLlmCalls === "number" ? body.maxLlmCalls : undefined,
					lateDelayMs: typeof body.lateDelayMs === "number" ? body.lateDelayMs : undefined,
					seed: typeof body.seed === "number" ? body.seed : undefined,
				})
				sendJson(res, result.ok ? 200 : 400, result)
				return
			}

			if (method === "POST" && path === "/api/stream/pause") {
				const result = activeController.pauseContinuousStream()
				sendJson(res, result.ok ? 200 : 400, result)
				return
			}

			if (method === "POST" && path === "/api/stream/resume") {
				const result = activeController.resumeContinuousStream()
				sendJson(res, result.ok ? 200 : 400, result)
				return
			}

			if (method === "POST" && path === "/api/stream/stop") {
				const result = activeController.stopContinuousStream()
				sendJson(res, 200, result)
				return
			}

			if (method === "POST" && path === "/api/stream/inject-trap") {
				const body = await readJsonBody(req)
				const kind = typeof body.kind === "string" ? (body.kind as TrapKind) : undefined
				const result = activeController.injectStreamTrap(kind)
				sendJson(res, result.ok ? 200 : 400, result)
				return
			}

			if (method === "GET" && path.startsWith("/api/source/")) {
				const sourceId = decodeURIComponent(path.slice("/api/source/".length))
				const entity = activeController.getSource(sourceId)
				if (!entity) {
					sendJson(res, 404, { ok: false, error: `Source "${sourceId}" not found` })
					return
				}
				sendJson(res, 200, { ok: true, sourceId, entity })
				return
			}

			if (method === "GET" && path === "/api/audit.jsonl") {
				const jsonl = activeController.getAuditJsonl()
				res.writeHead(200, {
					"Content-Type": "application/x-ndjson; charset=utf-8",
					"Content-Disposition": 'attachment; filename="ledgerproof-audit-trace.jsonl"',
				})
				res.end(jsonl)
				return
			}

			if (method === "GET" && path.startsWith("/api/sepa/") && path.endsWith(".xml")) {
				const invoiceId = decodeURIComponent(path.slice("/api/sepa/".length, -".xml".length))
				const artifact = activeController.getSepaDraftXml(invoiceId)
				if (!artifact) {
					sendJson(res, 404, { ok: false, error: `No SEPA pain.001 XML draft found for "${invoiceId}"` })
					return
				}
				const inline = url.searchParams.get("inline") === "1"
				const headers: Record<string, string> = {
					"Content-Type": "application/xml; charset=utf-8",
					"X-LedgerProof-Sha256": artifact.sha256,
					"X-LedgerProof-Message-Id": artifact.messageId,
				}
				if (!inline) {
					headers["Content-Disposition"] = `attachment; filename="pain.001-${invoiceId}.xml"`
				}
				res.writeHead(200, headers)
				res.end(artifact.xml)
				return
			}

			if (path.startsWith("/api/")) {
				sendJson(res, 404, { ok: false, error: "Not found" })
				return
			}

			// Serve built React SPA from dist-ui/
			if (!existsSync(distUiDir)) {
				res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
				res.end("UI bundle not built. Run `npm run ui:build` or `npm run ui`.")
				return
			}

			const relPath = path === "/" ? "index.html" : path.replace(/^\/+/, "")
			const candidate = resolve(distUiDir, relPath)
			const safeBase = distUiDir.endsWith(sep) ? distUiDir : `${distUiDir}${sep}`
			let targetFile = resolve(distUiDir, "index.html")
			if (candidate.startsWith(safeBase) && existsSync(candidate) && statSync(candidate).isFile()) {
				targetFile = candidate
			}

			const ext = extname(targetFile)
			res.writeHead(200, {
				"Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
			})
			res.end(readFileSync(targetFile))
		} catch (err) {
			sendJson(res, 500, {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	})

	server.on("close", () => {
		clearInterval(heartbeatTimer)
		clearInterval(cleanupTimer)
		for (const id of [...sessions.keys()]) {
			disposeSession(id)
		}
	})

	return { server, controller }
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const port = Number(process.env.PORT) || 4317
	const host = process.env.HOST || "127.0.0.1"
	const { server } = createLedgerServer()
	server.listen(port, host, () => {
		console.log(`LedgerProof Web UI ready at http://${host}:${port}`)
		console.log("Disclaimer: 100% synthetic data only. Not financial advice.")
	})
}
