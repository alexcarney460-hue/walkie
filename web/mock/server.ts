// Mock Walkie daemon for dashboard development and product screenshots.
//   bun mock/server.ts                 serve web/dist + the local API on 127.0.0.1:7457
//   WALKIE_MOCK_PORT=7477                 other port (vite dev proxies to it via the same env)
//   WALKIE_MOCK_FIRST_RUN=1               /v1/me returns team=null (first-run screen)
//   WALKIE_MOCK_ROLE=member               view the dashboard as a non-owner
//   WALKIE_MOCK_TRANSPORT=direct          a Walkie Direct team (invite codes, no tailnet IPs)
//   WALKIE_MOCK_POOL=fleet                five machines shaped like our real fleet at four sites (split runs)
//   WALKIE_MOCK_POOL_RUN=serving          a split run already serving (with WALKIE_MOCK_POOL=fleet)
//   WALKIE_MOCK_POOL_SERVE=remote         atlas serves Qwen3 32B whole on its GPU (Connect, POOL-REAL-1)
//   WALKIE_MOCK_POOL_RUNTIME=missing      this machine lacks the llama.cpp runtime (the Install button)
//   WALKIE_MOCK_POOL=lan                  maren's office on one network (a big local group for local models;
//                                         default: a scattered team, every machine on its own)
//   WALKIE_MOCK_FLEET=busy               ~36 more working agents, one-shot churn on atlas, a flapping seat (LIVE-2)
//   WALKIE_MOCK_COMPUTE=1                 a rented machine (rent-agent-7f3a) on the team for the "Rented" chip (RENT-2;
//                                         /v1/compute/* is served either way)
//   WALKIE_MOCK_PLAN=free|trial|team|business|grace   the team's plan (default trial); license keys
//                                         "mock-team-<seats>" / "mock-business-<seats>" activate
// Implements PROTOCOL.md §5 read endpoints + post/answer/admit/invite/channels/stream, and the
// integrations routes with fictional connector data (mock/integrations.ts), Projects (mock/projects.ts) and the Linear
// import (mock/linear-import.ts: a fictional workspace, a job that progresses with time).
// Auth, Host and Origin checks are intentionally not enforced here. /v1/stream?agents=delta sends roster deltas.
import { join } from "node:path";
import { AnswerReq, ChannelReq, EventsQuery, InviteReq, PostReq, type StreamMessage } from "../../src/protocol/schemas.ts";
import { MockIntegrations, seedIntegrationPosts } from "./integrations.ts";
import { MockProjects } from "./projects.ts";
import { MockLinearImport } from "./linear-import.ts";
import { mockActivate, parseMode, planLimitBody, seedPlan } from "./plan.ts";
import { mockPrepareReset, mockRefresh, mockUseReset, resetUses } from "./accounts.ts";
import { seedWorld } from "./seed.ts";
import { qrRows } from "../../src/daemon/mobile/qr.ts";
import { Simulation } from "./sim.ts";
import { BusySim, seedBusy } from "./busy.ts";
import { MockPool } from "./pool.ts";
import { MockRecommendations } from "./recommendations.ts";
import { MockSeats } from "./seats.ts";
import { MOCK_QUOTES, MockCompute } from "./compute.ts";
import { CreditCheckoutReq, LocalRentReq, SiteStopReq } from "../../src/protocol/compute.ts";
import { TURN_SEATS_OFF } from "../../src/protocol/seats.ts";
import { sha256Hex } from "./world.ts";
import { addMachineCommand, addMachineLink, releaseTag } from "../../src/protocol/add-machine.ts";
import { VERSION } from "../../src/daemon/version.ts";

const PORT = Number(process.env.WALKIE_MOCK_PORT ?? 7457);
const DIST = join(import.meta.dir, "..", "dist");
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:";
const SECURITY_HEADERS = { "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

const world = seedWorld({ hasTeam: process.env.WALKIE_MOCK_FIRST_RUN !== "1" });
if (process.env.WALKIE_MOCK_ROLE === "member" || process.env.WALKIE_MOCK_ROLE === "observer") {
  world.me().role = process.env.WALKIE_MOCK_ROLE;
}
if (world.hasTeam) seedIntegrationPosts(world);
const integrations = new MockIntegrations();
const projects = new MockProjects();
const linearImport = new MockLinearImport();
if (process.env.WALKIE_MOCK_TRANSPORT === "direct") world.transport = "direct";
const planMode = parseMode(process.env.WALKIE_MOCK_PLAN);
world.planState = seedPlan(planMode);
if (world.hasTeam && process.env.WALKIE_MOCK_FLEET === "busy") seedBusy(world);
const sim = new Simulation(world);
const busy = world.hasTeam && process.env.WALKIE_MOCK_FLEET === "busy" ? new BusySim(world) : null;
busy?.start();
const pool = new MockPool(() => world.nodeViews());
const seats = new MockSeats(() => world.nodeViews(), () => world.me().handle, () => pool.share.on);
const compute = new MockCompute();
const recommendations = new MockRecommendations();
const phones = [{ id: "3f9a1c2b7d4e", name: "iPhone", created_at: Date.now() - 3 * 86_400_000, last_seen: Date.now() - 12 * 60_000, expires_at: Date.now() + 87 * 86_400_000 }];
if (world.hasTeam) sim.start();

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { ...SECURITY_HEADERS, "Cache-Control": "no-store" } });
}
function fail(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}
async function body(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { return undefined; }
}
function requireTeam(): Response | null {
  return world.hasTeam ? null : fail(409, "no_team", "this node has not joined a team (run: walkie init or walkie join)");
}
function isOwner(): boolean { return world.me().role === "owner"; }

/**
 * `?agents=delta` (the dashboard, WALKIE-LIVE-1): one roster snapshot with a revision, then only the changed rows as
 * `agents.delta` frames chained by revision, as the daemon's hub (src/daemon/sse.ts) sends them. Per client here.
 */
function deltaAgents(): (msg: StreamMessage) => StreamMessage | null {
  let base: Map<string, string> | null = null;
  let archiveKey = "";
  let rev = 0;
  return (msg) => {
    if (msg.type !== "agents") return msg;
    const rows = new Map(msg.agents.map((a) => [`${a.node}/${a.agent}`, JSON.stringify(a)]));
    const key = JSON.stringify([msg.archive, msg.archive_rev ?? null]);
    if (!base) {
      base = rows;
      archiveKey = key;
      rev = 1;
      return { ...msg, rev };
    }
    const prev = base;
    const upsert = msg.agents.filter((a) => prev.get(`${a.node}/${a.agent}`) !== rows.get(`${a.node}/${a.agent}`));
    const remove = [...prev.keys()].filter((id) => !rows.has(id));
    if (!upsert.length && !remove.length && key === archiveKey) return null;
    base = rows;
    archiveKey = key;
    rev += 1;
    return { type: "agents.delta", base: rev - 1, rev, upsert, remove, archive: msg.archive, ...(msg.archive_rev !== undefined ? { archive_rev: msg.archive_rev } : {}) };
  };
}

function stream(req: Request): Response {
  const url = new URL(req.url);
  const filter = url.searchParams.get("channels")?.split(",").filter(Boolean);
  const toWire = url.searchParams.get("agents") === "delta" ? deltaAgents() : (m: StreamMessage) => m;
  const enc = new TextEncoder();
  let unsubscribe: () => void = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (raw: StreamMessage) => {
        const msg = toWire(raw);
        if (!msg) return;
        if (msg.type === "event") {
          if (!world.canSee(msg.event.channel)) return;
          if (filter?.length && msg.event.channel && !filter.includes(msg.event.channel)) return;
        }
        try { controller.enqueue(enc.encode(`event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`)); } catch { cleanup(); }
      };
      const cleanup = () => { unsubscribe(); if (heartbeat) clearInterval(heartbeat); };
      send({ type: "hello", me: world.meView() });
      if (world.hasTeam) send({ type: "agents", ...world.agentsPayload() }); // a delta stream's first snapshot
      unsubscribe = world.subscribe(send);
      heartbeat = setInterval(() => {
        try { controller.enqueue(enc.encode(": hb\n\n")); } catch { cleanup(); }
      }, 15_000);
      req.signal.addEventListener("abort", () => { cleanup(); try { controller.close(); } catch { /* already closed */ } });
    },
    cancel() { unsubscribe(); if (heartbeat) clearInterval(heartbeat); },
  });
  return new Response(body, { headers: { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
}

async function api(req: Request, url: URL): Promise<Response> {
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return fail(400, "invalid", "malformed path"); }
  const method = req.method;
  const q = Object.fromEntries(url.searchParams);

  if (path === "/v1/healthz") return json({ ok: true, version: "0.1.0-mock" });
  if (path === "/v1/me") return json(world.meView());
  const noTeam = requireTeam();
  if (noTeam) return noTeam;

  if (path === "/v1/stream") return stream(req);
  if (path === "/v1/team" && method === "GET") return json(world.teamView());
  if (path === "/v1/peers") return json({ nodes: world.nodeViews() });
  if (path === "/v1/license" && method === "GET") return json(world.planView());
  if (path === "/v1/agents") return json(world.agentsPayload(q));
  if (path === "/v1/accounts") return json({ accounts: world.accountViews(), pool: { policy: "company", at: Date.now() - 3_600_000, by: "maren" } });
  if (path.startsWith("/v1/compute/")) return computeRoute(req, path, method);
  if (path === "/v1/pool" && method === "GET") return json(pool.view());
  if (path === "/v1/pool/share" && method === "POST") {
    const b = (await body(req)) as { on?: unknown; max_gb?: unknown } | undefined;
    if (typeof b?.on !== "boolean") return fail(400, "invalid", "on: boolean");
    if (b.on && seats.allow) return fail(409, "seats_pool_conflict", TURN_SEATS_OFF);
    pool.setShare(b.on, typeof b.max_gb === "number" ? b.max_gb : b.max_gb === null ? null : undefined);
    return json(pool.view());
  }
  if (path === "/v1/pool/run" && method === "POST") {
    const run = pool.start();
    return run ? json({ run }, 202) : fail(409, "does_not_fit", "nothing fits in the memory the sharing machines have free");
  }
  if (path === "/v1/pool/stop" && method === "POST") return json({ run: pool.stop() });
  // POOL-REAL-1: serve / connect / install (people only, like the daemon's; install also for named agents).
  if (path === "/v1/pool/install" && method === "POST") {
    if (req.headers.get("x-walkie-under-agent") === "1" && !req.headers.has("x-walkie-agent")) return fail(403, "agent_unnamed", "an agent installing the runtime must name itself");
    return json({ install: pool.startInstall() }, 202);
  }
  if (path.startsWith("/v1/pool/") && method === "POST" && (req.headers.has("x-walkie-agent") || req.headers.has("x-walkie-under-agent"))) {
    return fail(403, "forbidden", "that is for a person, not an agent");
  }
  if (path === "/v1/pool/serve" && method === "POST") {
    const b = (await body(req)) as { model?: string; quant?: "q4" | "q8"; on?: string } | undefined;
    const on = b?.on ? world.nodeViews().find((n) => n.node_id === b.on || n.hostname === b.on) ?? null : null;
    const r = b?.model ? pool.startServe(b.model, b.quant ?? "q4", on) : null;
    return r ? json(r, 202) : fail(400, "unknown_model", "no such model");
  }
  if (path === "/v1/pool/serve/stop" && method === "POST") return json({ serve: pool.stopServe() });
  if ((path === "/v1/pool/connect" || path === "/v1/pool/disconnect") && method === "POST") {
    const b = (await body(req)) as { machine?: string } | undefined;
    const n = world.nodeViews().find((x) => x.node_id === b?.machine || x.hostname === b?.machine);
    if (!n) return fail(404, "unknown_machine", "no such machine");
    return json({ connection: path.endsWith("/connect") ? pool.connect(n) : pool.disconnect(n.node_id) });
  }
  // Remote seats (PROTOCOL §11): the routes the dashboard's Seats view calls, person-only like the daemon's.
  if (path.startsWith("/v1/seats") && method === "POST" && (req.headers.has("x-walkie-agent") || req.headers.has("x-walkie-under-agent"))) {
    return fail(403, "forbidden", "seats are set up and used by a person here, not an agent");
  }
  if (path === "/v1/seats" && method === "GET") return json(seats.view());
  if (path === "/v1/seats/config" && method === "POST") {
    const b = (await body(req)) as { allow?: unknown } | undefined;
    if (typeof b?.allow !== "boolean") return fail(400, "invalid", "allow: boolean");
    const refused = seats.configure(b.allow);
    return refused ? fail(409, "seats_pool_conflict", refused) : json({ local: seats.local() });
  }
  if (path === "/v1/seats/run" && method === "POST") {
    const b = (await body(req)) as { machine?: unknown; runtime?: unknown; prompt?: unknown } | undefined;
    if (typeof b?.machine !== "string" || (b.runtime !== "claude" && b.runtime !== "codex") || typeof b.prompt !== "string" || !b.prompt.trim()) return fail(400, "invalid", "machine, runtime and prompt are required");
    const r = seats.run(b as Parameters<MockSeats["run"]>[0]);
    return typeof r === "string" ? fail(404, "not_found", r) : json({ seat: r.id, event: { id: r.id } });
  }
  if (path === "/v1/seats/stop" && method === "POST") {
    const b = (await body(req)) as { seat?: unknown } | undefined;
    return typeof b?.seat === "string" && seats.stop(b.seat) ? json({ stopped: "requested" }) : fail(404, "not_found", "no such seat");
  }
  if (path === "/v1/seats/busy" && method === "POST") {
    const b = (await body(req)) as { max?: unknown; for_s?: unknown } | undefined;
    seats.setBusy(typeof b?.max === "number" ? b.max : 1, typeof b?.for_s === "number" ? b.for_s : undefined);
    return json({ local: seats.local() });
  }
  if (path === "/v1/seats/resume" && method === "POST") { seats.resume(); return json({ local: seats.local() }); }
  if ((path === "/v1/accounts/reset" || path === "/v1/accounts/reset/prepare" || path === "/v1/accounts/reset/resolve" || path === "/v1/accounts/refresh") && method === "POST") {
    if (req.headers.has("x-walkie-agent") || req.headers.has("x-walkie-under-agent")) return fail(403, "person_only", "limit resets are used by a person, not an agent");
    const b = (await body(req)) as { account?: unknown; request_id?: unknown } | undefined;
    const account = typeof b?.account === "string" ? b.account : "";
    if (path === "/v1/accounts/refresh") { const r = mockRefresh(world, account); return json(r.body, r.status); }
    if (path === "/v1/accounts/reset/resolve") return json({ attempt: null, ledger: false });
    if (path === "/v1/accounts/reset/prepare") { const r = mockPrepareReset(world, account); return json(r.body, r.status); }
    if (typeof b?.request_id !== "string" || !/^[A-Za-z0-9-]{16,64}$/.test(b.request_id)) return fail(400, "invalid", "request_id is required");
    const r = mockUseReset(world, account, b.request_id);
    return json(r.body, r.status);
  }
  if (path === "/v1/debug/reset-uses" && method === "GET") return json(Object.fromEntries(resetUses));
  // Walkie on your phone (fictional device; the pairing link points at the real app URL but its secret is random).
  if (path === "/v1/mobile" && method === "GET") return json({ linked: phones.length > 0, relay: "walkie-relay.fly.dev", pairing: 0, connected: 0, notice: null, devices: phones });
  if (path === "/v1/mobile/pair" && method === "POST") {
    const rand = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64url");
    const code = `${rand(16)}.${rand(16)}`; // fictional room id and secret
    const link = `https://getwalkie.vercel.app/m#pair=${code}`;
    return json({ url: link, code, expires_at: Date.now() + 10 * 60_000, qr: qrRows(link) });
  }
  const phone = /^\/v1\/mobile\/devices\/([0-9a-f]{12})$/.exec(path);
  if (phone && method === "DELETE") {
    const i = phones.findIndex((d) => d.id === phone[1]);
    if (i < 0) return fail(404, "not_found", "no such device");
    phones.splice(i, 1);
    return json({ revoked: true });
  }
  const recResponse = await recommendations.handle(req, world.me().role !== "observer");
  if (recResponse) return recResponse;
  const integ = await integrations.handle(req, path, url, world);
  if (integ) return integ;
  const proj = await projects.handle(req, path, json, fail);
  if (proj) return proj;
  const li = await linearImport.handle(req, path, json, fail);
  if (li) return li;

  if (path === "/v1/team/pending") {
    if (!isOwner()) return fail(403, "forbidden", "owners only");
    return json({ requests: world.pending });
  }

  if (path === "/v1/events" && method === "GET") {
    const parsed = EventsQuery.safeParse(q);
    if (!parsed.success) return fail(400, "invalid", parsed.error.issues[0]?.message ?? "invalid query");
    const { channel, thread, kinds, before_ts, since_ts, limit } = parsed.data;
    const kindSet = kinds ? new Set(kinds.split(",")) : null;
    const out = world.events
      .filter((e) => world.canSee(e.channel))
      .filter((e) => !channel || e.channel === channel)
      .filter((e) => !thread || e.id === thread || (e.body as { thread?: string }).thread === thread)
      .filter((e) => !kindSet || kindSet.has(e.kind))
      .filter((e) => before_ts === undefined || e.ts < before_ts)
      .filter((e) => since_ts === undefined || e.ts >= since_ts)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
    return json({ events: out });
  }

  const eventMatch = path.match(/^\/v1\/events\/([0-9a-f]{16}:[0-9]+)$/);
  if (eventMatch && method === "GET") {
    const event = world.events.find((e) => e.id === eventMatch[1]);
    if (!event || !world.canSee(event.channel)) return fail(404, "not_found", "no such event");
    const replies = world.events.filter((e) => (e.body as { thread?: string }).thread === event.id).sort((a, b) => a.ts - b.ts);
    return json({ event, replies });
  }

  if (path === "/v1/asks" && method === "GET") {
    let asks = world.askViews().filter((a) => world.canSee(a.ask.channel));
    if (q.state) asks = asks.filter((a) => a.state === q.state);
    if (q.to === "me") asks = asks.filter((a) => world.addressedToMe(String((a.ask.body as { to: string }).to)));
    return json({ asks });
  }
  const askMatch = path.match(/^\/v1\/asks\/([0-9a-f]{16}:[0-9]+)$/);
  if (askMatch && method === "GET") {
    const ask = world.events.find((e) => e.id === askMatch[1] && e.kind === "ask");
    return ask ? json(world.askView(ask)) : fail(404, "not_found", "no such ask");
  }

  const artMatch = path.match(/^\/v1\/artifacts\/([0-9a-f]{64})$/);
  if (artMatch && method === "GET") {
    const blob = world.blobs.get(artMatch[1]!);
    if (!blob) return fail(404, "not_found", "artifact not available");
    return new Response(blob.bytes, {
      headers: { ...SECURITY_HEADERS, "Content-Type": blob.mime, "Content-Disposition": `attachment; filename="${blob.name.replace(/"/g, "")}"`, "Cache-Control": "private, max-age=31536000, immutable" },
    });
  }

  if (method !== "POST") return fail(404, "not_found", `no route for ${method} ${path}`);
  const me = world.me();
  if (me.role === "observer") return fail(403, "forbidden", "observers are read-only");
  const payload = await body(req);

  if (path === "/v1/post") {
    const parsed = PostReq.safeParse(payload);
    if (!parsed.success) return fail(400, "invalid", parsed.error.issues[0]?.message ?? "invalid body");
    const { channel, text, thread } = parsed.data;
    if (!world.channels.some((c) => c.name === channel)) return fail(404, "not_found", `no channel #${channel}`);
    if (!world.canSee(channel)) return fail(403, "forbidden", `#${channel} is restricted`);
    const mentions = text.match(/@[a-z][a-z0-9-]*(?:\/[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9._-]*)?)?/g) ?? undefined;
    const event = world.emit({ handle: me.handle, hostname: world.meNodeHost, kind: "msg.post", channel, body: { text, ...(thread ? { thread } : {}), ...(mentions ? { mentions } : {}) } });
    sim.onHumanPost(event);
    return json({ event });
  }

  if (path === "/v1/answer") {
    const parsed = AnswerReq.safeParse(payload);
    if (!parsed.success) return fail(400, "invalid", parsed.error.issues[0]?.message ?? "invalid body");
    const ask = world.events.find((e) => e.id === parsed.data.ask && e.kind === "ask");
    if (!ask) return fail(404, "not_found", "no such ask");
    if (world.askView(ask).state !== "open") return fail(409, "conflict", "this ask is no longer open");
    const event = world.emit({ handle: me.handle, hostname: world.meNodeHost, kind: "answer", channel: ask.channel, body: { ask: ask.id, text: parsed.data.text, ...(parsed.data.declined ? { declined: true } : {}) } });
    return json({ event });
  }

  if (!isOwner() && (path.startsWith("/v1/team/") || path === "/v1/license")) return fail(403, "forbidden", "owners only");

  if (path === "/v1/license") {
    const key = (payload as { key?: unknown } | undefined)?.key;
    const lic = typeof key === "string" ? mockActivate(key) : null;
    if (!lic) return fail(400, "bad_license", "that license key is not valid (mock keys look like mock-team-10)");
    world.planState = { ...world.planState, license: lic };
    const event = world.emit({ handle: me.handle, hostname: world.meNodeHost, kind: "team.license", body: { key: String(key) } });
    return json({ event, plan: world.planView() });
  }

  if (path === "/v1/team/admit") {
    const b = payload as { node_id?: string; approve?: boolean } | undefined;
    const idx = world.pending.findIndex((p) => p.node_id === b?.node_id);
    if (idx < 0 || typeof b?.approve !== "boolean") return fail(400, "invalid", "unknown pending node or missing approve");
    const plan = world.planView();
    if (b.approve && plan.machines.limit !== null && plan.machines.used >= plan.machines.limit) {
      return json(planLimitBody(plan, "machines", plan.machines.limit, plan.machines.used, `plan limit: ${plan.machines.limit} machines`), 402);
    }
    const [p] = world.pending.splice(idx, 1);
    if (!b.approve || !p) return json({ ok: true });
    world.nodes.push({ node_id: p.node_id, handle: p.handle, hostname: p.hostname, ip: p.ip, port: 7458, online: false, rtt_ms: 0, last_seen: 0, behind: 0, last_sync: 0 });
    const event = world.emit({ handle: me.handle, hostname: world.meNodeHost, kind: "team.node", body: { node_id: p.node_id, login: p.login, hostname: p.hostname, pubkey: "bW9jay1wdWJrZXk=", ip: p.ip } });
    world.broadcast({ type: "nodes", nodes: world.nodeViews() });
    return json({ event });
  }

  if (path === "/v1/team/invite-code") {
    const b = payload as { handle?: string; role?: string } | undefined;
    if (world.transport !== "direct") return fail(409, "direct_unavailable", "this machine doesn't run Walkie Direct; invite Tailscale teammates by login");
    if (!b?.handle || !/^[a-z][a-z0-9-]{0,23}$/.test(b.handle)) return fail(400, "invalid", "handle: invalid");
    const existing = world.member(b.handle);
    const role = existing?.role ?? (b.role === "owner" || b.role === "observer" ? b.role : "member");
    // A fictional code of the real shape (it admits nothing: there is no peer network in the mock).
    const code = "wk1" + Buffer.from(sha256Hex(`invite:${b.handle}:${Date.now()}`).repeat(3), "hex").toString("base64url").slice(0, 187);
    return json({ code, handle: b.handle, role, expires_at: Date.now() + 7 * 24 * 3600_000, existing_member: !!existing });
  }

  if (path === "/v1/team/add-machine") {
    const b = payload as { handle?: string } | undefined;
    if (world.transport !== "direct") return fail(409, "direct_unavailable", "the team's roster authority doesn't run Walkie Direct yet");
    const existing = b?.handle ? world.member(b.handle) : undefined;
    if (!existing) return fail(404, "not_found", `@${b?.handle ?? ""} isn't on the team`);
    // A fictional code of the real shape (it admits nothing: there is no peer network in the mock).
    const code = "wk1" + Buffer.from(sha256Hex(`machine:${existing.handle}:${Date.now()}`).repeat(3), "hex").toString("base64url").slice(0, 187);
    const tag = releaseTag(VERSION);
    return json({
      code, handle: existing.handle, role: existing.role, expires_at: Date.now() + 7 * 24 * 3600_000, existing_member: true,
      version: VERSION, team_agents: process.env.WALKIE_MOCK_SEATS === "1", link: addMachineLink(code, tag, process.env.WALKIE_MOCK_SEATS === "1"),
      command: addMachineCommand(code, tag),
    });
  }

  if (path === "/v1/team/invite") {
    const parsed = InviteReq.safeParse(payload);
    if (!parsed.success) return fail(400, "invalid", parsed.error.issues[0]?.message ?? "invalid body");
    if (world.member(parsed.data.handle)) return fail(409, "conflict", `@${parsed.data.handle} is already on the team`);
    const plan = world.planView();
    if (plan.seats.limit !== null && plan.seats.used >= plan.seats.limit) {
      return json(planLimitBody(plan, "people", plan.seats.limit, plan.seats.used, `plan limit: ${plan.seats.limit} people`), 402);
    }
    world.members.push({ ...parsed.data, display_name: parsed.data.display_name ?? parsed.data.handle });
    const event = world.emit({ handle: me.handle, hostname: world.meNodeHost, kind: "team.member", body: { ...parsed.data } });
    return json({ event });
  }

  if (path === "/v1/channels") {
    const parsed = ChannelReq.safeParse(payload);
    if (!parsed.success) return fail(400, "invalid", parsed.error.issues[0]?.message ?? "invalid body");
    const existing = world.channels.findIndex((c) => c.name === parsed.data.name);
    const plan = world.planView();
    const restricting = parsed.data.members !== undefined && (existing < 0 || !world.channels[existing]?.members);
    if (restricting && !plan.entitlements.restricted_channels) {
      return json(planLimitBody(plan, "restricted_channels", 0, 0, "restricted channels need the Team plan"), 402);
    }
    const next = { ...parsed.data };
    if (existing >= 0) world.channels.splice(existing, 1, next); else world.channels.push(next);
    const event = world.emit({ handle: me.handle, hostname: world.meNodeHost, kind: "channel.upsert", body: { ...parsed.data } });
    return json({ event });
  }

  return fail(404, "not_found", `no route for ${method} ${path}`);
}

/** Rental compute (RENT-2), owners only like the daemon's routes. Prices only. */
async function computeRoute(req: Request, path: string, method: string): Promise<Response> {
  if (!isOwner()) return fail(403, "forbidden", "only owners rent machines");
  if (path === "/v1/compute/quotes" && method === "GET") return json(MOCK_QUOTES);
  if (path === "/v1/compute/state" && method === "GET") return json(compute.state());
  if (method !== "POST") return fail(404, "not_found", `no route for ${method} ${path}`);
  const b = await body(req);
  if (path === "/v1/compute/rent") {
    const p = LocalRentReq.safeParse(b);
    if (!p.success) return fail(400, "invalid", p.error.issues[0]?.message ?? "invalid body");
    const r = compute.rent(p.data.machines);
    if ("error" in r) return json({ error: { code: r.error, message: "not enough credit for the first hour", needed_micros: r.needed_micros, balance_micros: compute.balance } }, 402);
    return json(r);
  }
  if (path === "/v1/compute/stop") {
    const p = SiteStopReq.safeParse(b);
    if (!p.success) return fail(400, "invalid", "rental_id or all: true");
    const r = compute.stop(p.data);
    return r ? json(r) : fail(404, "not_found", "no such rental");
  }
  if (path === "/v1/compute/credit") {
    const p = CreditCheckoutReq.safeParse(b);
    if (!p.success) return fail(400, "invalid", "block: 50, 200 or 1000");
    return json({ url: compute.creditUrl(p.data.block) });
  }
  return fail(404, "not_found", `no route for ${method} ${path}`);
}

async function staticFile(url: URL): Promise<Response> {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (rel.includes("..")) return new Response("bad path", { status: 400 });
  const file = Bun.file(join(DIST, rel || "index.html"));
  if (rel && (await file.exists())) {
    const immutable = rel.startsWith("assets/");
    return new Response(file, { headers: { ...SECURITY_HEADERS, "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } });
  }
  const index = Bun.file(join(DIST, "index.html"));
  if (!(await index.exists())) return new Response("web/dist not built. Run: bun run web:build (or use vite dev on :5173)", { status: 503 });
  return new Response(index, { headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0, // SSE connections stay open; heartbeats every 15 s
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/auth") {
        // like the daemon (SEC-COOKIE-2): the session goes to the page in the fragment, never in a cookie
        return new Response(null, { status: 302, headers: { Location: `/#s=${"0".repeat(64)}`, "Cache-Control": "no-store" } });
      }
      if (url.pathname === "/auth/logout" && req.method === "POST") {
        return new Response(null, { status: 204 });
      }
      if (url.pathname.startsWith("/v1/")) return await api(req, url);
      return await staticFile(url);
    } catch (err) {
      process.stderr.write(`mock error on ${req.method} ${url.pathname}: ${String(err)}\n`);
      return fail(500, "internal", "internal error");
    }
  },
});

process.stdout.write(`walkie mock on http://${server.hostname}:${server.port}  (team: ${world.hasTeam ? world.teamName : "none"}, role: ${world.me().role}, plan: ${planMode})\n`);
