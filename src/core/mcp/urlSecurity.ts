// ---------------------------------------------------------------------------
// MCP HTTP URL security
//
// Two independent guards for http(s) MCP servers whose URL + bearer token come
// from a plugin-supplied .mcp.json (an untrusted source):
//
//   1. SSRF guard (assertMcpUrlAllowed): refuse to connect to known cloud
//      metadata endpoints (169.254.169.254 & friends). Loopback and private
//      ranges stay allowed — local/LAN MCP servers are a legitimate, common
//      setup. Hosts listed in ISAAC_MCP_ALLOW_HOSTS bypass the block.
//
//   2. Bearer token-gate (shouldSendBearer): only attach `Authorization: Bearer`
//      when the channel is safe — https, OR a loopback / RFC1918 / CGNAT
//      (Tailscale 100.64/10) host, OR an explicitly allowlisted host. A token
//      must never leave the machine in cleartext to a public http:// endpoint.
//
// Limitation: checks operate on the URL's literal host. DNS rebinding (a public
// name resolving to a private IP at connect time) is out of scope for this
// .mcp.json threat model and documented as such.
// ---------------------------------------------------------------------------

/** Cloud instance-metadata endpoints — connecting here is almost always SSRF. */
const METADATA_HOSTS = new Set([
	"169.254.169.254", // AWS / Azure / GCP / OpenStack / DigitalOcean
	"metadata.google.internal", // GCP
	"metadata.goog", // GCP
	"100.100.100.200", // Alibaba Cloud (note: inside CGNAT 100.64/10)
	"fd00:ec2::254", // AWS IPv6 IMDS
])

/**
 * url.hostname keeps the [..] brackets for IPv6 literals; strip them + lowercase.
 * Also canonicalise two evasion forms so downstream checks see the real address:
 *  - trailing FQDN dot ("169.254.169.254." / "metadata.google.internal.")
 *  - IPv4-mapped IPv6 ("::ffff:a9fe:a9fe" or "::ffff:169.254.169.254") -> dotted
 *    IPv4, so both the metadata set and the private-range check apply.
 */
function normalizeHost(hostname: string): string {
	let h = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase()
	if (h.length > 1 && h.endsWith(".")) h = h.slice(0, -1)
	const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
	if (mappedHex) {
		const hi = Number.parseInt(mappedHex[1], 16)
		const lo = Number.parseInt(mappedHex[2], 16)
		return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
	}
	const mappedDotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
	if (mappedDotted) return mappedDotted[1]
	return h
}

function envAllowlist(): Set<string> {
	const raw = process.env.ISAAC_MCP_ALLOW_HOSTS
	if (!raw) return new Set()
	return new Set(
		raw
			.split(",")
			.map((h) => h.trim().toLowerCase())
			.filter(Boolean),
	)
}

function parseIpv4(host: string): number[] | null {
	const parts = host.split(".")
	if (parts.length !== 4) return null
	const octets: number[] = []
	for (const p of parts) {
		if (!/^\d{1,3}$/.test(p)) return null
		const n = Number(p)
		if (n > 255) return null
		octets.push(n)
	}
	return octets
}

/** Loopback / RFC1918 / link-local-ULA / CGNAT — "private enough" to send a token over http. */
function isPrivateHost(hostname: string): boolean {
	const host = hostname.toLowerCase()
	if (host === "localhost" || host.endsWith(".localhost")) return true
	if (host === "::1") return true
	// IPv6 unique-local (fc00::/7 → fc.. / fd..). url.hostname strips [] brackets.
	if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true

	const v4 = parseIpv4(host)
	if (!v4) return false
	const [a, b] = v4
	if (a === 127) return true // 127.0.0.0/8 loopback
	if (a === 10) return true // 10.0.0.0/8
	if (a === 192 && b === 168) return true // 192.168.0.0/16
	if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
	// 100.64.0.0/10 CGNAT (Tailscale). NB: 100.100.100.200 (Alibaba metadata)
	// falls in this range, but the SSRF guard checks isMetadataHost FIRST and
	// blocks the connection outright, so it never reaches the token-gate here.
	if (a === 100 && b >= 64 && b <= 127) return true
	return false
}

export function isMetadataHost(hostname: string): boolean {
	return METADATA_HOSTS.has(normalizeHost(hostname))
}

/** Whether a bearer token may be attached for this URL (token-gate policy). */
export function shouldSendBearer(rawUrl: string): boolean {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		return false
	}
	const host = normalizeHost(url.hostname)
	if (envAllowlist().has(host)) return true
	if (url.protocol === "https:") return true
	if (url.protocol === "http:" && isPrivateHost(host)) return true
	return false
}

export type McpUrlVerdict = { ok: true } | { ok: false; reason: string }

/** SSRF guard: block cloud-metadata endpoints unless explicitly allowlisted. */
export function assertMcpUrlAllowed(rawUrl: string): McpUrlVerdict {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		return { ok: false, reason: `invalid url "${rawUrl}"` }
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { ok: false, reason: `unsupported scheme "${url.protocol}" (only http/https)` }
	}
	const host = normalizeHost(url.hostname)
	if (envAllowlist().has(host)) return { ok: true }
	if (isMetadataHost(host)) {
		return {
			ok: false,
			reason: `blocked cloud-metadata endpoint "${host}" (set ISAAC_MCP_ALLOW_HOSTS to override)`,
		}
	}
	return { ok: true }
}
