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

export function createLedgerServer(
	controller = new SessionController(),
	distUiDir = resolve(process.cwd(), "dist-ui"),
): { server: Server; controller: SessionController } {
	const sseClients = new Set<ServerResponse>()
	let broadcastScheduled = false

	const broadcastSnapshot = () => {
		if (broadcastScheduled || sseClients.size === 0) return
		broadcastScheduled = true
		setTimeout(() => {
			broadcastScheduled = false
			const data = `event: snapshot\ndata: ${JSON.stringify(controller.getSnapshot())}\n\n`
			for (const client of sseClients) {
				if (!client.writableEnded) {
					client.write(data)
				}
			}
		}, 25)
	}

	const unsubscribeController = controller.subscribe(broadcastSnapshot)

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		const path = url.pathname
		const method = (req.method ?? "GET").toUpperCase()

		try {
			if (method === "GET" && path === "/api/health") {
				const live = resolveLiveProviderFromEnv()
				sendJson(res, 200, { ok: true, liveProvider: live?.label ?? null })
				return
			}

			if (method === "GET" && path === "/api/state") {
				sendJson(res, 200, controller.getSnapshot())
				return
			}

			if (method === "GET" && path === "/api/events") {
				res.writeHead(200, {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache, no-transform",
					Connection: "keep-alive",
				})
				sseClients.add(res)
				res.write(`event: snapshot\ndata: ${JSON.stringify(controller.getSnapshot())}\n\n`)
				req.on("close", () => {
					sseClients.delete(res)
				})
				return
			}

			if (method === "POST" && path === "/api/run") {
				const body = await readJsonBody(req)
				const result = controller.startRun({
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
				const result = controller.resolveApproval(
					approvalId,
					body.approved,
					typeof body.reason === "string" ? body.reason : undefined,
				)
				sendJson(res, result.ok ? 200 : 404, result)
				return
			}

			if (method === "POST" && path === "/api/inject-late") {
				const result = controller.injectLateSettlement()
				sendJson(res, result.ok ? 200 : 400, result)
				return
			}

			if (method === "POST" && path === "/api/stream/start") {
				const body = await readJsonBody(req)
				const result = controller.startContinuousStream({
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
				const result = controller.pauseContinuousStream()
				sendJson(res, result.ok ? 200 : 400, result)
				return
			}

			if (method === "POST" && path === "/api/stream/resume") {
				const result = controller.resumeContinuousStream()
				sendJson(res, result.ok ? 200 : 400, result)
				return
			}

			if (method === "POST" && path === "/api/stream/stop") {
				const result = controller.stopContinuousStream()
				sendJson(res, 200, result)
				return
			}

			if (method === "POST" && path === "/api/stream/inject-trap") {
				const body = await readJsonBody(req)
				const kind = typeof body.kind === "string" ? (body.kind as TrapKind) : undefined
				const result = controller.injectStreamTrap(kind)
				sendJson(res, result.ok ? 200 : 400, result)
				return
			}

			if (method === "GET" && path.startsWith("/api/source/")) {
				const sourceId = decodeURIComponent(path.slice("/api/source/".length))
				const entity = controller.getSource(sourceId)
				if (!entity) {
					sendJson(res, 404, { ok: false, error: `Source "${sourceId}" not found` })
					return
				}
				sendJson(res, 200, { ok: true, sourceId, entity })
				return
			}

			if (method === "GET" && path === "/api/audit.jsonl") {
				const jsonl = controller.getAuditJsonl()
				res.writeHead(200, {
					"Content-Type": "application/x-ndjson; charset=utf-8",
					"Content-Disposition": 'attachment; filename="ledgerproof-audit-trace.jsonl"',
				})
				res.end(jsonl)
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
		controller.stopContinuousStream()
		unsubscribeController()
		for (const client of sseClients) {
			if (!client.writableEnded) {
				client.end()
			}
		}
		sseClients.clear()
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
