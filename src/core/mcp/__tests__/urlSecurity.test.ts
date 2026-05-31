import { expect } from "chai"
import { afterEach, describe, it } from "vitest"

import { assertMcpUrlAllowed, isMetadataHost, shouldSendBearer } from "../urlSecurity"

describe("urlSecurity", () => {
	const savedAllow = process.env.ISAAC_MCP_ALLOW_HOSTS

	afterEach(() => {
		if (savedAllow === undefined) delete process.env.ISAAC_MCP_ALLOW_HOSTS
		else process.env.ISAAC_MCP_ALLOW_HOSTS = savedAllow
	})

	describe("assertMcpUrlAllowed (SSRF guard)", () => {
		it("blocks known cloud-metadata endpoints", () => {
			for (const u of [
				"http://169.254.169.254/latest/meta-data/",
				"http://metadata.google.internal/computeMetadata/v1/",
				"http://metadata.goog/",
				"http://100.100.100.200/",
				"http://[fd00:ec2::254]/",
			]) {
				expect(assertMcpUrlAllowed(u).ok, u).to.equal(false)
			}
		})

		it("allows public https, loopback and private hosts", () => {
			for (const u of [
				"https://api.example.com/mcp",
				"http://localhost:3000/mcp",
				"http://127.0.0.1:8080/",
				"http://10.0.0.5/mcp",
				"http://192.168.1.10/mcp",
				"http://100.64.0.1/mcp", // Tailscale CGNAT
			]) {
				expect(assertMcpUrlAllowed(u).ok, u).to.equal(true)
			}
		})

		it("blocks IPv4-mapped IPv6 and trailing-dot evasions of the metadata block", () => {
			for (const u of [
				"http://[::ffff:169.254.169.254]/", // dotted IPv4-mapped (Node compresses)
				"http://[::ffff:a9fe:a9fe]/", // hextet IPv4-mapped form of 169.254.169.254
				"http://[::ffff:6464:64c8]/", // 100.100.100.200 (Alibaba) mapped
				"http://169.254.169.254./", // trailing FQDN dot
				"http://metadata.google.internal./",
			]) {
				expect(assertMcpUrlAllowed(u).ok, u).to.equal(false)
			}
		})

		it("rejects invalid urls and non-http schemes", () => {
			expect(assertMcpUrlAllowed("not a url").ok).to.equal(false)
			expect(assertMcpUrlAllowed("ftp://example.com").ok).to.equal(false)
			expect(assertMcpUrlAllowed("file:///etc/passwd").ok).to.equal(false)
		})

		it("honours ISAAC_MCP_ALLOW_HOSTS to override a metadata block", () => {
			expect(assertMcpUrlAllowed("http://169.254.169.254/").ok).to.equal(false)
			process.env.ISAAC_MCP_ALLOW_HOSTS = "169.254.169.254, other.host"
			expect(assertMcpUrlAllowed("http://169.254.169.254/").ok).to.equal(true)
		})
	})

	describe("shouldSendBearer (token-gate)", () => {
		it("allows token over https (any host)", () => {
			expect(shouldSendBearer("https://api.example.com/mcp")).to.equal(true)
		})

		it("allows token over http only for private/loopback/CGNAT hosts", () => {
			expect(shouldSendBearer("http://localhost:3000/")).to.equal(true)
			expect(shouldSendBearer("http://127.0.0.1/")).to.equal(true)
			expect(shouldSendBearer("http://10.1.2.3/")).to.equal(true)
			expect(shouldSendBearer("http://192.168.0.2/")).to.equal(true)
			expect(shouldSendBearer("http://172.16.0.1/")).to.equal(true)
			expect(shouldSendBearer("http://100.96.0.7/")).to.equal(true)
		})

		it("recognises IPv4-mapped IPv6 private addresses as token-safe", () => {
			expect(shouldSendBearer("http://[::ffff:192.168.1.1]/")).to.equal(true)
			expect(shouldSendBearer("http://[::ffff:c0a8:0101]/")).to.equal(true) // hextet form of 192.168.1.1
		})

		it("refuses token over http to public hosts", () => {
			expect(shouldSendBearer("http://api.example.com/mcp")).to.equal(false)
			expect(shouldSendBearer("http://8.8.8.8/")).to.equal(false)
			// link-local is NOT auto-trusted (ambiguous with metadata)
			expect(shouldSendBearer("http://169.254.1.1/")).to.equal(false)
		})

		it("honours ISAAC_MCP_ALLOW_HOSTS for an otherwise-unsafe host", () => {
			expect(shouldSendBearer("http://gw.public.example/")).to.equal(false)
			process.env.ISAAC_MCP_ALLOW_HOSTS = "gw.public.example"
			expect(shouldSendBearer("http://gw.public.example/")).to.equal(true)
		})
	})

	describe("isMetadataHost", () => {
		it("matches case-insensitively", () => {
			expect(isMetadataHost("METADATA.GOOGLE.INTERNAL")).to.equal(true)
			expect(isMetadataHost("example.com")).to.equal(false)
		})
	})
})
