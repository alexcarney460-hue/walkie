// Stateless Streamable HTTP MCP for guests. Bind to loopback; a tunnel adapter authenticates every request.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Server } from "bun";
import { HttpError, readBytes } from "../daemon/http.ts";
import { VERSION } from "../daemon/version.ts";
import { TOOLS } from "./tools.ts";
import { GUEST_TOOLS, type GuestScope } from "./guest-scope.ts";
import { type Guest, type GuestRegistry } from "./guest-registry.ts";

const BODY_MAX = 32 * 1024;
const RESULT_MAX = 64 * 1024;
const BODY_DEADLINE_MS = 10_000;
const WINDOW_MS = 60_000;
const HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" };
type TunnelAuth = { verify(req: Request, body: Uint8Array): string | null };

function equalHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Adapter for a local fake tunnel or a trusted outbound tunnel proxy with a private assertion key. */
export class HmacTunnelAuth implements TunnelAuth {
  private readonly nonces = new Map<string, number>();
  constructor(private readonly key: Uint8Array, private readonly now: () => number = Date.now,
    private readonly consumeNonce?: (subject: string, nonce: string) => boolean) {
    if (key.length < 32) throw new Error("tunnel assertion key must be at least 32 bytes");
  }
  verify(req: Request, body: Uint8Array): string | null {
    const subject = req.headers.get("x-walkie-tunnel-subject") ?? "";
    const stamp = req.headers.get("x-walkie-tunnel-time") ?? "";
    const nonce = req.headers.get("x-walkie-tunnel-nonce") ?? "";
    const signature = req.headers.get("x-walkie-tunnel-signature") ?? "";
    const time = Number(stamp);
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(subject) || !/^\d{1,16}$/.test(stamp) || !/^[A-Za-z0-9_-]{1,100}$/.test(nonce)) return null;
    if (!Number.isSafeInteger(time) || Math.abs(this.now() - time) > WINDOW_MS) return null;
    const digest = createHash("sha256").update(body).digest("hex");
    const expected = createHmac("sha256", this.key).update(`${req.method}\n${new URL(req.url).pathname}\n${subject}\n${stamp}\n${nonce}\n${digest}`).digest("hex");
    if (!equalHex(signature, expected)) return null;
    for (const [seen, at] of this.nonces) if (at + WINDOW_MS < this.now()) this.nonces.delete(seen);
    const replayKey = `${subject}:${nonce}`;
    if (this.consumeNonce) return this.consumeNonce(subject, nonce) ? subject : null;
    if (this.nonces.has(replayKey) || this.nonces.size >= 2_048) return null;
    this.nonces.set(replayKey, this.now());
    return subject;
  }
}

class Bucket {
  private readonly values = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly now: () => number) {}
  take(key: string, cap: number): boolean {
    const now = this.now();
    const prev = this.values.get(key) ?? { tokens: cap, at: now };
    const tokens = Math.min(cap, prev.tokens + Math.max(0, now - prev.at) * cap / WINDOW_MS);
    this.values.set(key, { tokens: Math.max(0, tokens - 1), at: now });
    return tokens >= 1;
  }
}

function reply(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > RESULT_MAX) return new Response(JSON.stringify({ error: "result too large" }), { status: 413, headers: HEADERS });
  return new Response(body, { status, headers: { ...HEADERS, ...extra } });
}
function error(status: number, message: string): Response { return reply({ error: message }, status); }

function guestTool(tool: (typeof TOOLS)[number]) {
  if (tool.name === "walkie_tasks") {
    const { project, query, limit } = tool.inputSchema.properties as Record<string, unknown>;
    return { ...tool, description: "List assigned cards: key, title, column, labels, and due date. Assigned cards must never carry secrets.",
      inputSchema: { type: "object", properties: { project, query, limit }, required: [], additionalProperties: false } };
  }
  if (!["walkie_post", "walkie_read", "walkie_set_status", "walkie_task"].includes(tool.name)) return tool;
  const schema = tool.inputSchema;
  const required = tool.name === "walkie_post" ? ["channel", "thread", "text"]
    : tool.name === "walkie_read" ? ["thread"] : tool.name === "walkie_set_status" ? ["title", "task"] : ["key"];
  const description = tool.name === "walkie_post" ? "Post only in an assigned card's thread."
    : tool.name === "walkie_read" ? "Read only an assigned card's comment text. Assigned cards must never carry secrets."
    : tool.name === "walkie_set_status" ? "Self-report status for one assigned card."
    : "Read one assigned card's key, title, description, column, labels, and due date. Assigned cards must never carry secrets.";
  return { ...tool, description, inputSchema: { ...schema, required } };
}

export class GuestGateway {
  private readonly buckets: Bucket;
  private readonly earlySources = new Set<string>();
  private earlyWindow = -1;
  private globalActive = 0;
  private readonly guestActive = new Map<string, number>();
  private server: Server<undefined> | null = null;
  constructor(private readonly registry: GuestRegistry, private readonly scope: GuestScope,
    private readonly tunnel: TunnelAuth, private readonly now: () => number = Date.now,
    private readonly ownerGuard: (guest: Guest) => boolean = () => true,
    private readonly bodyDeadlineMs = BODY_DEADLINE_MS) {
    this.buckets = new Bucket(now);
  }
  listen(port: number): number {
    if (this.server) throw new Error("guest gateway already listening");
    this.server = Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) => this.handle(req) });
    return this.server.port ?? port;
  }
  stop(): void { this.server?.stop(true); this.server = null; this.registry.flushEarly(); }

  private earlySource(req: Request): string {
    const window = Math.floor(this.now() / WINDOW_MS);
    if (window !== this.earlyWindow) { this.earlyWindow = window; this.earlySources.clear(); }
    // Claimed tunnel subjects are unauthenticated here; hash them and cap cardinality.
    const claimed = req.headers.get("x-walkie-tunnel-subject") ?? "";
    const source = /^[A-Za-z0-9._:-]{1,200}$/.test(claimed)
      ? createHash("sha256").update(claimed).digest("hex").slice(0, 16) : "unknown";
    if (!this.earlySources.has(source) && this.earlySources.size >= 32) return "overflow";
    this.earlySources.add(source);
    return source;
  }

  private finishEarly(req: Request, response: Response, kind: string): Response {
    this.registry.recordEarly(kind, response.status, this.earlySource(req));
    return response;
  }

  private finish(response: Response, kind: string, fields: { guest?: string; tool?: string; object?: string; event?: string; digest?: string } = {}): Response {
    this.registry.record({ kind: response.status === 413 ? "rejected" : kind, ...fields });
    return response;
  }

  async handle(req: Request): Promise<Response> {
    if (!this.buckets.take("global", 300)) return this.finishEarly(req, reply({ error: "rate limited" }, 429, { "Retry-After": "60" }), "rate_limit");
    if (new URL(req.url).pathname !== "/mcp") return this.finishEarly(req, error(404, "not found"), "rejected");
    if (req.method !== "POST") return this.finishEarly(req, error(405, "method not allowed"), "rejected");
    if (req.headers.get("origin")) return this.finishEarly(req, error(403, "forbidden"), "rejected");
    if (this.globalActive >= 8) return this.finishEarly(req, reply({ error: "rate limited" }, 429, { "Retry-After": "60" }), "rate_limit");
    this.globalActive++;
    try { return await this.handleReserved(req); }
    finally { this.globalActive--; }
  }

  private async handleReserved(req: Request): Promise<Response> {
    let bytes: Uint8Array;
    try { bytes = await readBytes(req, BODY_MAX, this.bodyDeadlineMs); }
    catch (err) { return this.finishEarly(req, err instanceof HttpError && err.status === 408 ? error(408, "body read timed out") : error(413, "request too large"), "rejected"); }
    const subject = this.tunnel.verify(req, bytes);
    if (!subject) return this.finish(error(403, "tunnel authentication failed"), "auth_failure");
    const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
    const guest = this.registry.authenticate(token, subject);
    if (!guest || !this.ownerGuard(guest)) return this.finish(error(401, "guest authentication failed"), "auth_failure");
    if (!this.buckets.take(guest.id, 30) || (this.guestActive.get(guest.id) ?? 0) >= 2) {
      return this.finish(reply({ error: "rate limited" }, 429, { "Retry-After": "60" }), "rate_limit", { guest: guest.id });
    }
    this.guestActive.set(guest.id, (this.guestActive.get(guest.id) ?? 0) + 1);
    try { return this.dispatch(guest, bytes); }
    finally {
      this.guestActive.set(guest.id, (this.guestActive.get(guest.id) ?? 1) - 1);
    }
  }

  private dispatch(guest: Guest, bytes: Uint8Array): Response {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return this.finish(error(400, "invalid JSON"), "denied", { guest: guest.id }); }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return this.finish(error(400, "invalid request"), "denied", { guest: guest.id });
    }
    const req = value as Record<string, unknown>;
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string" || !(typeof req.id === "string" || typeof req.id === "number" || req.id === undefined)) {
      return this.finish(error(400, "invalid request"), "denied", { guest: guest.id });
    }
    const method = req.method;
    if (method === "notifications/initialized" && req.id === undefined) {
      return this.finish(new Response(null, { status: 202, headers: HEADERS }), "accepted", { guest: guest.id, tool: method });
    }
    if (req.id === undefined) {
      return this.finish(error(400, "invalid request"), "denied", { guest: guest.id });
    }
    if (method === "initialize") {
      return this.finish(reply({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "walkie-guest", version: VERSION } } }), "accepted", { guest: guest.id, tool: "initialize" });
    }
    if (method === "tools/list") {
      return this.finish(reply({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS.filter((tool) => GUEST_TOOLS.includes(tool.name) && guest.tools.includes(tool.name)).map(guestTool) } }), "accepted", { guest: guest.id, tool: "tools/list" });
    }
    if (method !== "tools/call") {
      return this.finish(reply({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } }), "denied", { guest: guest.id });
    }
    const params = req.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      return this.finish(error(400, "invalid params"), "denied", { guest: guest.id, tool: method });
    }
    const { name, arguments: args } = params as Record<string, unknown>;
    if (typeof name !== "string" || name.length > 80) {
      return this.finish(error(400, "invalid params"), "denied", { guest: guest.id, tool: method });
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    try {
      const output = this.scope.call(guest, name, args ?? {}, () => this.registry.active(guest) && this.ownerGuard(guest));
      const { eventId: _event, objectId: _object, ...result } = output;
      const response = reply({ jsonrpc: "2.0", id: req.id, result });
      return this.finish(response, output.isError ? "denied" : "accepted", { guest: guest.id,
        ...(GUEST_TOOLS.includes(name) ? { tool: name } : {}), digest,
        ...(output.objectId ? { object: output.objectId } : {}), ...(output.eventId ? { event: output.eventId } : {}) });
    } catch {
      return this.finish(reply({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "guest call failed" }], isError: true } }), "denied",
        { guest: guest.id, ...(GUEST_TOOLS.includes(name) ? { tool: name } : {}) });
    }
  }
}
