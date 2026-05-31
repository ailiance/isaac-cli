import http from "node:http"
import { expect } from "chai"
import * as sinon from "sinon"
import * as stackMonitorModule from "../../local-stack/StackMonitor"
import { WebuiServer } from "../WebuiServer"

describe("WebuiServer", () => {
	afterEach(() => {
		delete process.env.ISAAC_WEBUI_URL
	})

	it("returns external mode when ISAAC_WEBUI_URL is set", async () => {
		process.env.ISAAC_WEBUI_URL = "http://localhost:3000"
		const server = new WebuiServer()
		const status = await server.start()
		expect(status.running).to.equal(true)
		expect(status.external).to.equal(true)
		expect(status.url).to.equal("http://localhost:3000")
	})

	it("starts local server even when no webview-ui build dir", async () => {
		// No ISAAC_WEBUI_URL, no webview-ui/build — landing should still be served
		const server = new WebuiServer()
		const status = await server.start()
		expect(status.running).to.equal(true)
		expect(status.external).to.equal(false)
		expect(status.url).to.match(/^http:\/\/127\.0\.0\.1:\d+$/)
		await server.stop()
	})

	it("findFreePort returns a valid port number", async () => {
		const server = new WebuiServer()
		const port = await (server as any).findFreePort(25463)
		expect(port).to.be.a("number")
		expect(port).to.be.greaterThanOrEqual(25463)
		expect(port).to.be.lessThanOrEqual(25563)
	})

	it("status() returns running:false before start()", () => {
		const server = new WebuiServer()
		const s = server.status()
		expect(s.running).to.equal(false)
		expect(s.external).to.equal(false)
	})

	it("status() returns external url after start() with ISAAC_WEBUI_URL", async () => {
		process.env.ISAAC_WEBUI_URL = "http://example.com:4000"
		const server = new WebuiServer()
		await server.start()
		const s = server.status()
		expect(s.running).to.equal(true)
		expect(s.url).to.equal("http://example.com:4000")
		expect(s.external).to.equal(true)
	})

	describe("HTTP endpoints", () => {
		let server: WebuiServer
		let port: number
		let sandbox: sinon.SinonSandbox

		beforeEach(async () => {
			sandbox = sinon.createSandbox()
			server = new WebuiServer()
			const status = await server.start()
			port = status.port!
		})

		afterEach(async () => {
			sandbox.restore()
			await server.stop()
		})

		function get(
			path: string,
		): Promise<{ status: number; body: string; contentType: string; headers: http.IncomingHttpHeaders }> {
			return new Promise((resolve, reject) => {
				http.get(`http://127.0.0.1:${port}${path}`, (res) => {
					let body = ""
					res.on("data", (chunk: Buffer) => {
						body += chunk.toString()
					})
					res.on("end", () => {
						resolve({
							status: res.statusCode ?? 0,
							body,
							contentType: (res.headers["content-type"] as string) ?? "",
							headers: res.headers,
						})
					})
				}).on("error", reject)
			})
		}

		function post(
			path: string,
			data: unknown,
		): Promise<{ status: number; body: string; contentType: string; headers: http.IncomingHttpHeaders }> {
			return new Promise((resolve, reject) => {
				const payload = JSON.stringify(data)
				const options: http.RequestOptions = {
					hostname: "127.0.0.1",
					port,
					path,
					method: "POST",
					headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
				}
				const req = http.request(options, (res) => {
					let body = ""
					res.on("data", (chunk: Buffer) => {
						body += chunk.toString()
					})
					res.on("end", () => {
						resolve({
							status: res.statusCode ?? 0,
							body,
							contentType: (res.headers["content-type"] as string) ?? "",
							headers: res.headers,
						})
					})
				})
				req.on("error", reject)
				req.write(payload)
				req.end()
			})
		}

		function options(path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
			return new Promise((resolve, reject) => {
				const opts: http.RequestOptions = {
					hostname: "127.0.0.1",
					port,
					path,
					method: "OPTIONS",
				}
				const req = http.request(opts, (res) => {
					resolve({ status: res.statusCode ?? 0, headers: res.headers })
				})
				req.on("error", reject)
				req.end()
			})
		}

		it("GET / returns landing page containing ISAAC heading", async () => {
			const { status, body, contentType } = await get("/")
			expect(status).to.equal(200)
			expect(contentType).to.include("text/html")
			expect(body).to.include("<h1>ISAAC</h1>")
		})

		it("GET /api/version returns current version string", async () => {
			const { status, body, contentType } = await get("/api/version")
			expect(status).to.equal(200)
			expect(contentType).to.include("text/plain")
			// version is either a semver string (optionally with a prerelease
			// suffix like 0.9.1-beta) or "?"
			expect(body.trim()).to.match(/^\d+\.\d+\.\d+(-[\w.]+)?$|^\?$/)
		})

		it("GET /spa returns HTML (SPA build present) or 503 (build absent)", async () => {
			const { status, contentType } = await get("/spa")
			// Build exists in dev tree → 200 with HTML; absent in CI → 503
			expect([200, 503]).to.include(status)
			if (status === 200) {
				expect(contentType).to.include("text/html")
			}
		})

		describe("gRPC HTTP endpoints", () => {
			it("POST /grpc/StackService/getSnapshot returns 200 JSON", async () => {
				const fakeSnapshot = { proxy: { running: false }, router: { running: false }, models: [] }
				sandbox.stub(stackMonitorModule.stackMonitor, "snapshot").resolves(fakeSnapshot as any)

				const { status, body, contentType } = await post("/grpc/StackService/getSnapshot", {})
				expect(status).to.equal(200)
				expect(contentType).to.include("application/json")
				const parsed = JSON.parse(body)
				expect(parsed).to.deep.equal(fakeSnapshot)
			})

			it("OPTIONS /grpc/StackService/getSnapshot returns 204 with CORS headers", async () => {
				const { status, headers } = await options("/grpc/StackService/getSnapshot")
				expect(status).to.equal(204)
				expect(headers["access-control-allow-origin"]).to.equal("*")
				expect(headers["access-control-allow-methods"]).to.include("POST")
			})

			it("POST /grpc/InvalidService/foo returns 404", async () => {
				const { status, body } = await post("/grpc/InvalidService/foo", {})
				expect(status).to.equal(404)
				const parsed = JSON.parse(body)
				expect(parsed.error).to.include("unknown method")
			})
		})
	})
})
