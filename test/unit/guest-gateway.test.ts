import { createHmac, createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { GuestGateway, HmacTunnelAuth } from "../../src/mcp/guest-gateway.ts";
import { GuestRegistry } from "../../src/mcp/guest-registry.ts";
import { GuestScope, type GuestData } from "../../src/mcp/guest-scope.ts";

const secret = Buffer.alloc(32, 7);
const cardId = "aaaaaaaaaaaaaaaa:1";
function fixture(now = () => Date.now(), bodyDeadlineMs = 10_000, scopeOverride?: GuestScope) {
  const values = new Map<string, string>();
  let writes = 0;
  const registry = new GuestRegistry({ getMeta: (k) => values.get(k) ?? null, setMeta: (k, v) => { writes++; values.set(k, v); } }, now);
  const { token, guest } = registry.issue({ owner: "alex", node: "1234567890abcdef", family: "dots", name: "ops", subject: "fake-tunnel", cardIds: [cardId], tools: ["walkie_tasks", "walkie_task", "walkie_set_status"] }, 60_000);
  const data: GuestData = {
    card: () => ({ id: cardId, channel: "p-11111111", key: "WEB-1", ref: "WEB-1-aaaaaaaa", title: "Assigned", body: "Work", assignee: guest.address, labels: [], state: "open", column: "todo", updated_at: 1 }),
    project: () => ({ channel: "p-11111111", name: "Allowed", prefix: "WEB", private: false, state: "active" }),
    comments: () => [], comment: () => "event-comment", move: () => "event-move", status: () => "event-status",
  };
  const gateway = new GuestGateway(registry, scopeOverride ?? new GuestScope(data), new HmacTunnelAuth(secret, now), now, () => true, bodyDeadlineMs);
  let serial = 0;
  const call = async (method: string, params: unknown, options: { token?: string; subject?: string; nonce?: string; headerAgent?: string } = {}) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++serial, method, params });
    const ts = now();
    const nonce = options.nonce ?? `n-${serial}`;
    const subject = options.subject ?? "fake-tunnel";
    const digest = createHash("sha256").update(body).digest("hex");
    const signature = createHmac("sha256", secret).update(`POST\n/mcp\n${subject}\n${ts}\n${nonce}\n${digest}`).digest("hex");
    const req = new Request("http://127.0.0.1:0/mcp", { method: "POST", body, headers: {
      authorization: `Bearer ${options.token ?? token}`, "content-type": "application/json", "x-walkie-tunnel-subject": subject,
      "x-walkie-tunnel-time": String(ts), "x-walkie-tunnel-nonce": nonce, "x-walkie-tunnel-signature": signature,
      ...(options.headerAgent ? { "x-walkie-agent": options.headerAgent } : {}),
    } });
    return gateway.handle(req);
  };
  return { gateway, registry, guest, token, call, data, writes: () => writes };
}

test("fake tunnel reaches only guest MCP tools with bound identity", async () => {
  const f = fixture();
  const init = await f.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fake", version: "1" } });
  expect(init.status).toBe(200);
  expect((await init.json() as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("walkie-guest");
  const list = await f.call("tools/list", {});
  const tools = (await list.json() as { result: { tools: { name: string; description: string; inputSchema: { required: string[] } }[] } }).result.tools;
  const listed = tools.map((tool) => tool.name);
  expect(listed).toContain("walkie_task");
  expect(listed).not.toContain("walkie_cli");
  expect(tools.find((tool) => tool.name === "walkie_set_status")?.inputSchema.required).toContain("task");
  expect(tools.find((tool) => tool.name === "walkie_task")?.description).toContain("Assigned cards must never carry secrets");
  const task = await f.call("tools/call", { name: "walkie_task", arguments: { key: "WEB-1" } }, { headerAgent: "orchestrator" });
  expect(task.status).toBe(200);
  expect(JSON.stringify(await task.json())).toContain("Assigned");
  expect(f.registry.audit().some((entry) => entry.kind === "accepted" && entry.tool === "walkie_task")).toBe(true);
});

test("bad subject, replay, expiry, kill and rate cap deny before tool execution", async () => {
  let now = 1_000;
  const f = fixture(() => now);
  expect((await f.call("tools/list", {}, { subject: "other" })).status).toBe(401);
  expect((await f.call("tools/list", {}, { nonce: "once" })).status).toBe(200);
  expect((await f.call("tools/list", {}, { nonce: "once" })).status).toBe(403);
  for (let i = 0; i < 29; i++) expect((await f.call("tools/list", {})).status).toBe(200);
  expect((await f.call("tools/list", {})).status).toBe(429);
  now += 61_000;
  expect((await f.call("tools/list", {})).status).toBe(401);
  f.registry.killAll(true);
  expect((await f.call("tools/list", {})).status).toBe(401);
});

test("local fake tunnel reaches the loopback HTTP MCP listener", async () => {
  const f = fixture();
  const port = f.gateway.listen(0);
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "walkie_task", arguments: { key: "WEB-1" } } });
    const ts = Date.now();
    const nonce = "http-integration";
    const digest = createHash("sha256").update(body).digest("hex");
    const signature = createHmac("sha256", secret).update(`POST\n/mcp\nfake-tunnel\n${ts}\n${nonce}\n${digest}`).digest("hex");
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body, headers: {
      authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-walkie-tunnel-subject": "fake-tunnel",
      "x-walkie-tunnel-time": String(ts), "x-walkie-tunnel-nonce": nonce, "x-walkie-tunnel-signature": signature,
    } });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("WEB-1");
  } finally { f.gateway.stop(); }
});

test("slow request bodies occupy the eight inbound slots and release them at the deadline", async () => {
  const f = fixture();
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const pending = Array.from({ length: 8 }, () => {
    const body = new ReadableStream<Uint8Array>({ start: (controller) => { controllers.push(controller); } });
    return f.gateway.handle(new Request("http://127.0.0.1/mcp", { method: "POST", body }));
  });
  const extra = await f.gateway.handle(new Request("http://127.0.0.1/mcp", { method: "POST", body: "{}" }));
  expect(extra.status).toBe(429);
  for (const controller of controllers) controller.close();
  expect((await Promise.all(pending)).map((response) => response.status)).toEqual(Array(8).fill(403));
  const timed = fixture(() => Date.now(), 10);
  const stalled = new ReadableStream<Uint8Array>({ start: () => undefined });
  expect((await timed.gateway.handle(new Request("http://127.0.0.1/mcp", { method: "POST", body: stalled }))).status).toBe(408);
  expect((await timed.gateway.handle(new Request("http://127.0.0.1/mcp", { method: "POST", body: "{}" }))).status).toBe(403);
});

test("audit records early rejections and canonical objects without raw arguments", async () => {
  const f = fixture();
  expect((await f.gateway.handle(new Request("http://127.0.0.1/mcp", { method: "GET" }))).status).toBe(405);
  expect((await f.gateway.handle(new Request("http://127.0.0.1/mcp", { method: "POST", body: "{}", headers: { origin: "https://example.com" } }))).status).toBe(403);
  expect((await f.gateway.handle(new Request("http://127.0.0.1/mcp", { method: "POST", body: "x".repeat(32_769) }))).status).toBe(413);
  const marker = "unverified-private-token";
  await f.call("tools/call", { name: "walkie_task", arguments: { key: marker } });
  await f.call("tools/call", { name: "walkie_task", arguments: { key: "WEB-1" } });
  const audit = f.registry.audit();
  expect(audit.filter((entry) => entry.kind === "rejected").length).toBeGreaterThanOrEqual(3);
  expect(JSON.stringify(audit)).not.toContain(marker);
  expect(audit.find((entry) => entry.kind === "accepted" && entry.tool === "walkie_task")?.object).toBe(cardId);
});

test("early rejections share the global limit and coalesce repeated audits per source and minute", async () => {
  const f = fixture(() => 1_000);
  const source = { "x-walkie-tunnel-subject": "fake-tunnel" };
  const request = (path: string, method: string, body?: string, origin?: string) =>
    f.gateway.handle(new Request(`http://127.0.0.1${path}`, { method, body, headers: { ...source, ...(origin ? { origin } : {}) } }));
  const before = f.writes();
  expect((await request("/bad", "GET")).status).toBe(404);
  expect((await request("/mcp", "GET")).status).toBe(405);
  expect((await request("/mcp", "POST", "{}", "https://example.com")).status).toBe(403);
  expect((await request("/mcp", "POST", "x".repeat(32_769))).status).toBe(413);
  for (let i = 0; i < 296; i++) expect((await request("/bad", "GET")).status).toBe(404);
  for (let i = 0; i < 5; i++) expect((await request("/bad", "GET")).status).toBe(429);
  const audit = f.registry.audit();
  expect(audit.find((entry) => entry.status === 404)?.count).toBe(297);
  expect(audit.find((entry) => entry.status === 405)?.count).toBe(1);
  expect(audit.find((entry) => entry.status === 403)?.count).toBe(1);
  expect(audit.find((entry) => entry.status === 413)?.count).toBe(1);
  expect(audit.find((entry) => entry.status === 429)?.count).toBe(5);
  expect(f.writes() - before).toBeLessThanOrEqual(30);
});

test("forged early source claims cannot create unbounded audit groups", async () => {
  const f = fixture(() => 1_000);
  for (let i = 0; i < 40; i++) {
    const req = new Request("http://127.0.0.1/bad", { method: "GET", headers: { "x-walkie-tunnel-subject": `claim-${i}` } });
    expect((await f.gateway.handle(req)).status).toBe(404);
  }
  const rejected = f.registry.audit().filter((entry) => entry.status === 404);
  expect(rejected.length).toBe(33);
  expect(rejected.find((entry) => entry.source === "overflow")?.count).toBe(8);
  expect(JSON.stringify(rejected)).not.toContain("claim-");
});

test("a result over the response cap is audited as rejected", async () => {
  const oversized = { call: () => ({ content: [{ type: "text" as const, text: "x".repeat(65_536) }], objectId: cardId }) } as unknown as GuestScope;
  const f = fixture(() => Date.now(), 10_000, oversized);
  const response = await f.call("tools/call", { name: "walkie_task", arguments: { key: "WEB-1" } });
  expect(response.status).toBe(413);
  expect(f.registry.audit().at(-1)).toMatchObject({ kind: "rejected", tool: "walkie_task", object: cardId });
});

test("revocation accepted during dispatch prevents a later write", async () => {
  const f = fixture();
  let writes = 0;
  const card = f.data.card;
  f.data.card = (id) => { f.registry.revoke(f.guest.id); return card(id); };
  f.data.status = () => { writes++; return "event-status"; };
  const response = await f.call("tools/call", { name: "walkie_set_status", arguments: { title: "Working", task: "WEB-1" } });
  expect(response.status).toBe(200);
  expect((await response.json() as { result: { isError?: boolean } }).result.isError).toBe(true);
  expect(writes).toBe(0);
});
