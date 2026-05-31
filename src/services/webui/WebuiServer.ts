import { promises as fs } from "node:fs"
import http, { type Server } from "node:http"
import { createServer as createNetServer } from "node:net"
import path from "node:path"
import { LANDING_HTML } from "./landing-html"

function getAkiVersion(): string {
	const moduleDir = resolveModuleDir()
	const candidates = [
		path.resolve(moduleDir, "..", "..", "..", "package.json"),
		path.resolve(moduleDir, "..", "..", "package.json"),
		path.resolve(process.cwd(), "package.json"),
	]
	for (const p of candidates) {
		try {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic require for version lookup
			const pkg = require(p) as { name?: string; version?: string }
			if ((pkg.name === "isaac" || pkg.name === "isaac-cli") && pkg.version) return pkg.version
		} catch {}
	}
	return "?"
}

/**
 * Resolve the directory of this module, compatible with both CJS (mocha tests)
 * and ESM (CLI runtime). We avoid import.meta.url at module level since the
 * unit-test tsconfig compiles to CommonJS where import.meta is unavailable.
 */
function resolveModuleDir(): string {
	if (typeof __dirname === "string") {
		return __dirname
	}
	try {
		// biome-ignore lint: intentional runtime ESM detection
		const meta = new Function("return import.meta")() as { url: string }
		const { fileURLToPath } = require("node:url") as typeof import("node:url")
		return path.dirname(fileURLToPath(meta.url))
	} catch {
		return path.resolve(process.cwd(), "src", "services", "webui")
	}
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript",
	".mjs": "application/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".json": "application/json",
	".map": "application/json",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
}

export interface WebuiServerStatus {
	running: boolean
	url?: string
	port?: number
	external: boolean // true if ISAAC_WEBUI_URL set, no in-process server
}

export class WebuiServer {
	private server: Server | null = null
	private port: number | null = null
	private externalUrl: string | null = null

	/**
	 * Resolve the webui URL.
	 * - If ISAAC_WEBUI_URL env var is set → use it (no spawn)
	 * - Else → start an in-process static HTTP server on a free port (>=25463)
	 *   serving webview-ui/build/. SPA fallback: any non-existent path → index.html.
	 *   Server runs in this same Node process (no child spawn) for reliability.
	 *   stop() closes it cleanly at exit.
	 */
	async start(): Promise<WebuiServerStatus> {
		const fromEnv = process.env.ISAAC_WEBUI_URL?.trim()
		if (fromEnv) {
			this.externalUrl = fromEnv
			return { running: true, url: fromEnv, external: true }
		}
		return this.startLocal()
	}

	private async startLocal(): Promise<WebuiServerStatus> {
		const buildDir = await this.findBuildDir()
		// buildDir may be null if webview-ui/build is missing; landing still works
		const port = await this.findFreePort(25463)
		const server = http.createServer((req, res) => {
			void this.handleRequest(req, res, buildDir)
		})
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(port, "127.0.0.1", () => resolve())
		})
		// Don't keep the event loop alive just for this server (Node will still
		// serve while the CLI is running, but won't block exit).
		server.unref()
		this.server = server
		this.port = port
		return { running: true, url: `http://127.0.0.1:${port}`, port, external: false }
	}

	private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse, buildDir: string | null): Promise<void> {
		try {
			const reqPath = decodeURIComponent((req.url || "/").split("?")[0])

			// CORS headers for standalone SPA mode
			res.setHeader("Access-Control-Allow-Origin", "*")
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			res.setHeader("Access-Control-Allow-Headers", "Content-Type")
			if (req.method === "OPTIONS") {
				res.writeHead(204)
				res.end()
				return
			}

			// gRPC HTTP routes: /grpc/<service>/<method>
			if (reqPath.startsWith("/grpc/")) {
				return this.handleGrpc(req, res, reqPath.slice(6))
			}

			// Custom landing on root
			if (reqPath === "/" || reqPath === "/index.html") {
				return this.serveLanding(res)
			}

			// Version endpoint for landing
			if (reqPath === "/api/version") {
				res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
				res.end(getAkiVersion())
				return
			}

			// Server-side worker health probes (avoid CORS from browser)
			if (reqPath === "/api/probe-workers") {
				return this.serveProbeWorkers(res)
			}

			// /spa → webview-ui SPA (standalone build)
			if (reqPath === "/spa" || reqPath === "/spa/") {
				if (!buildDir) {
					res.writeHead(503)
					res.end("webview-ui build not found")
					return
				}
				const spaPath = path.join(buildDir, "index.html")
				return this.serveStaticFile(spaPath, res)
			}

			// Static assets from webview-ui/build
			if (!buildDir) {
				res.writeHead(503)
				res.end("webview-ui build not found")
				return
			}
			const safe = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, "")
			let filePath = path.join(buildDir, safe)
			let stat: import("node:fs").Stats | null = null
			try {
				stat = await fs.stat(filePath)
			} catch {
				stat = null
			}
			if (!stat || !stat.isFile()) {
				// SPA fallback
				filePath = path.join(buildDir, "index.html")
			}
			return this.serveStaticFile(filePath, res)
		} catch {
			res.writeHead(500)
			res.end("internal error")
		}
	}

	private async handleGrpc(req: http.IncomingMessage, res: http.ServerResponse, methodPath: string): Promise<void> {
		let body: unknown = {}
		if (req.method === "POST") {
			const chunks: Buffer[] = []
			await new Promise<void>((resolve, reject) => {
				req.on("data", (c: Buffer) => chunks.push(c))
				req.on("end", () => resolve())
				req.on("error", reject)
			})
			const raw = Buffer.concat(chunks).toString("utf8")
			if (raw) {
				try {
					body = JSON.parse(raw)
				} catch {
					body = {}
				}
			}
		}
		const { grpcRouter } = await import("./GrpcRouter")
		const { status, data } = await grpcRouter.handle(methodPath, body)
		res.writeHead(status, { "Content-Type": "application/json" })
		res.end(JSON.stringify(data))
	}

	private async serveProbeWorkers(res: http.ServerResponse): Promise<void> {
		const targets = [
			{ id: "proxy", url: "http://127.0.0.1:4000/health/readiness" },
			{ id: "router", url: "http://127.0.0.1:5050/health" },
			{ id: "gw", url: "http://100.78.191.52:9300/health" },
			{ id: "apertus", url: "http://100.116.92.12:9301/health" },
			{ id: "eurollm", url: "http://100.116.92.12:9303/health" },
			{ id: "devstral", url: "http://100.112.121.126:9302/health" },
			{ id: "gemma", url: "http://100.78.6.122:9304/v1/models" },
		]
		const results = await Promise.all(
			targets.map(async (t) => {
				const ctrl = new AbortController()
				const timeout = setTimeout(() => ctrl.abort(), 3000)
				try {
					const r = await fetch(t.url, { signal: ctrl.signal })
					clearTimeout(timeout)
					return { id: t.id, up: r.ok, status: r.status }
				} catch {
					clearTimeout(timeout)
					return { id: t.id, up: false, status: 0 }
				}
			}),
		)
		res.writeHead(200, { "Content-Type": "application/json" })
		res.end(JSON.stringify(results))
	}

	private async serveLanding(res: http.ServerResponse): Promise<void> {
		// Embedded inline (LANDING_HTML is auto-generated from landing.html
		// at dev time and bundled into cli/dist/cli.mjs). No filesystem I/O.
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" })
		res.end(LANDING_HTML)
	}

	private async serveStaticFile(filePath: string, res: http.ServerResponse): Promise<void> {
		const data = await fs.readFile(filePath)
		const ext = path.extname(filePath).toLowerCase()
		res.writeHead(200, {
			"Content-Type": MIME[ext] || "application/octet-stream",
			"Cache-Control": "no-cache",
		})
		res.end(data)
	}

	private async findBuildDir(): Promise<string | null> {
		const moduleDir = resolveModuleDir()
		// Try several locations relative to this module at runtime.
		// In a bundled CLI, __dirname is cli/dist, so we walk up a couple of
		// levels to reach the repo root then into webview-ui/build.
		const candidates = [
			path.resolve(moduleDir, "..", "..", "..", "webview-ui", "build"),
			path.resolve(moduleDir, "..", "..", "webview-ui", "build"),
			path.resolve(moduleDir, "..", "..", "..", "..", "webview-ui", "build"),
			path.resolve(moduleDir, "..", "webview-ui", "build"),
			// Last resort: cwd-based
			path.resolve(process.cwd(), "webview-ui", "build"),
		]
		for (const c of candidates) {
			try {
				await fs.access(path.join(c, "index.html"))
				return c
			} catch {}
		}
		return null
	}

	private findFreePort(start: number): Promise<number> {
		return new Promise((resolve, reject) => {
			const tryPort = (p: number) => {
				const srv = createNetServer()
				srv.once("error", () => {
					srv.close()
					if (p > start + 100) reject(new Error("no free port"))
					else tryPort(p + 1)
				})
				srv.once("listening", () => {
					const port = (srv.address() as { port: number }).port
					srv.close(() => resolve(port))
				})
				srv.listen(p, "127.0.0.1")
			}
			tryPort(start)
		})
	}

	async stop(): Promise<void> {
		if (this.server) {
			await new Promise<void>((resolve) => {
				this.server?.close(() => resolve())
			})
			this.server = null
			this.port = null
		}
	}

	status(): WebuiServerStatus {
		if (this.externalUrl) return { running: true, url: this.externalUrl, external: true }
		if (this.server && this.port)
			return { running: true, url: `http://127.0.0.1:${this.port}`, port: this.port, external: false }
		return { running: false, external: false }
	}
}

export const webuiServer = new WebuiServer()
