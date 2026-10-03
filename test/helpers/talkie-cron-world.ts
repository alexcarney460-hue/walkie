// An N-node world for TALKIE-CRON (WALK-78): the authority and its leads are each a real Core, Leadership, Schedules and
// PeerApi, like production. Lead -> authority calls go through the real signed routes. The wall clock (Date) and the
// monotonic clock (performance.now) are fake and advance together. Every call can be lost before it reaches the
// authority ("req-lost") or after the authority committed it ("ack-lost"), decided by a plan. Event replication is
// explicit (syncAll), so a lead's copy of the schedules can lag the authority's.
// Ported from the independent final review's probe harness (sonnet-cron-final, world.ts), with static imports.
import { setSystemTime } from "bun:test";
import { PeerCallError } from "../../src/daemon/peer-client.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import type { Core } from "../../src/daemon/core.ts";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { LeadGrant } from "../../src/daemon/orchestrator/lease.ts";
import { ScheduleClaimResult } from "../../src/daemon/orchestrator/schedule-claims.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { Schedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { Event as EventSchema } from "../../src/protocol/schemas.ts";
import { SCHEDULE_CHANNEL, type Schedule } from "../../src/protocol/talkie-schedule.ts";
import { makeCore } from "./core.ts";
import { createTeam, now, tnode, type TNode } from "./events.ts";

export type Fault = "ok" | "req-lost" | "ack-lost";
export interface NetInfo { from: string; to: string; path: string; body: any; n: number }
export interface Wire { from: string; to: string; path: string; wire: any; result: "ok" | "err"; body?: any; fault?: Fault; t?: number; code?: string; msg?: string }
export interface WorldNode {
  name: string; tn: TNode; core: Core; lead: Leadership; s: Schedules; api: PeerApi; up: boolean;
  turns: { run: string; at: number }[]; replies: Map<string, { text: string; ok: boolean }>;
  captured: { run: string; schedule: string; at: number; failures: number; result: string; paused: boolean }[];
  /** runs whose captured completion this node gave up as superseded (its `schedule_completion_superseded` log line) */
  superseded: Set<string>;
  /** runs whose completion this node kept as an unresolved run (its `schedule_completion_unresolved` log line) */
  unresolvedLogged: Set<string>;
}
const CLAIM_PREFIX = "walkie-talkie-claim:v1:";
const SCHED_PREFIX = "walkie-talkie-schedule:v1:";
export const iso = (n: number | null) => (n === null ? "null" : new Date(n).toISOString().slice(11, 19));

export async function makeWorld(cleanups: (() => void)[], o: { names?: string[]; wireLost?: boolean } = {}) {
  const names = o.names ?? ["alex", "mira", "bea", "cy"];
  const tn: Record<string, TNode> = Object.fromEntries(names.map((n) => [n, tnode(n)]));
  const root = tn[names[0]!]!;
  const { team, create } = createTeam(root);
  const base = Math.floor(now() / 3_600_000) * 3_600_000 + 3_600_000;
  const wall = { value: base - 2 * 60_000 };
  const mono = { v: 1_000_000 };
  setSystemTime(new Date(wall.value));
  const origPerf = performance.now.bind(performance);
  (performance as { now: () => number }).now = () => mono.v;
  cleanups.push(() => { (performance as { now: () => number }).now = origPerf; });
  const at = (ms: number) => { const d = ms - wall.value; wall.value = ms; setSystemTime(new Date(ms)); if (d > 0) mono.v += d; };

  const pref = { v: root.keys.nodeId as string };
  /** How far each lead's own clock runs ahead of the wall clock the authority reads (its tick time). */
  const skews: Record<string, number> = {};
  const nodes: Record<string, WorldNode> = {};
  const net = {
    plan: ((_i: NetInfo) => "ok") as (i: NetInfo) => Fault,
    log: [] as { from: string; to: string; path: string; fault: Fault; result: string }[],
    wires: [] as Wire[],
    n: 0,
    badResponses: [] as { path: string; issues: string }[],
  };
  const byId = (id: string | null | undefined) => Object.values(nodes).find((n) => n.core.nodeId === id);
  const responseSchemas: Record<string, { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: unknown } } }> =
    { lease: LeadGrant, "schedule-claim": ScheduleClaimResult, "schedule-progress": EventSchema };

  const call = async (from: WorldNode, path: string, wire: any): Promise<any> => {
    const to = byId(from.core.authority);
    const body = wire?.body;
    const info: NetInfo = { from: from.name, to: to?.name ?? "?", path, body, n: ++net.n };
    const fault = to ? net.plan(info) : "req-lost";
    if (!to || fault === "req-lost") {
      net.log.push({ from: from.name, to: info.to, path, fault, result: "req-lost" });
      net.wires.push({ from: from.name, to: info.to, path, wire, result: "err", fault: "req-lost", t: wall.value, code: "req-lost" });
      throw new PeerCallError(0, "unreachable", "request lost");
    }
    const url = new URL(`http://peer/peer/v1/orchestrator/${path}`);
    let result: any;
    try {
      const api = to.api as unknown as { serveAdmitted: (req: Request, url: URL, node: string, member: { handle: string; role: string }) => Promise<Response> };
      const r = await api.serveAdmitted(new Request(url, { method: "POST", body: JSON.stringify(wire) }), url,
        from.core.nodeId, { handle: from.name, role: "owner" });
      result = await r.json();
      net.wires.push({ from: from.name, to: to.name, path, wire, result: "ok", body: result, fault, t: wall.value });
      net.log.push({ from: from.name, to: to.name, path, fault, result: `${r.status}` });
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      net.wires.push({ from: from.name, to: to.name, path, wire, result: "err", fault, t: wall.value, code: `${e.status}:${e.code}`, msg: e.message });
      net.log.push({ from: from.name, to: to.name, path, fault, result: `${e.status}:${e.code}` });
      throw new PeerCallError(e.status ?? 0, e.code ?? "x", e.message ?? "");
    }
    if (fault === "ack-lost") throw new PeerCallError(0, "timeout", "ack lost");
    // PeerClient.call validates the response with the route's schema; mirror it so a shape mismatch fails like production
    const schema = responseSchemas[path];
    if (schema) {
      const parsed = schema.safeParse(result);
      if (!parsed.success) {
        net.badResponses.push({ path, issues: JSON.stringify(parsed.error?.issues).slice(0, 300) });
        throw new PeerCallError(200, "bad_response", "peer response has the wrong shape");
      }
      return parsed.data;
    }
    return result;
  };

  for (const name of names) {
    const core = makeCore(tn[name]!, team, cleanups, { clock: () => wall.value });
    const node = { name, tn: tn[name]!, core, up: true, turns: [], replies: new Map(), captured: [], superseded: new Set<string>(), unresolvedLogged: new Set<string>() } as unknown as WorldNode;
    const warn = core.log.warn.bind(core.log);
    core.log.warn = (msg: string, fields?: Record<string, unknown>) => {
      if (msg === "schedule_completion_superseded") node.superseded.add(String(fields?.run));
      if (msg === "schedule_completion_unresolved") node.unresolvedLogged.add(String(fields?.run));
      warn(msg, fields);
    };
    nodes[name] = node;
  }
  const A0 = nodes[names[0]!]!;
  A0.core.ingest(create, "local");
  for (const n of names.slice(1)) {
    A0.core.emit("team.member", { login: tn[n]!.login, handle: tn[n]!.handle, role: "owner" });
    A0.core.emit("team.node", { node_id: tn[n]!.keys.nodeId, login: tn[n]!.login, hostname: tn[n]!.hostname, pubkey: tn[n]!.keys.pubkey, ip: "127.0.0.1" });
  }
  A0.core.emit("channel.upsert", { name: "general" });
  A0.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: [...names].sort() });

  const eventsOf = (n: WorldNode) => n.core.store.queryEvents({ limit: 1_000_000 }).map((r: { json: string }) => JSON.parse(r.json))
    .sort((x: { seq: number }, y: { seq: number }) => x.seq - y.seq);
  const syncFrom = (src: WorldNode, ...dst: WorldNode[]) => { const evs = eventsOf(src); for (const d of dst) for (const e of evs) d.core.ingest(e, "remote"); };
  const syncAll = () => { for (let round = 0; round < 2; round++) for (const a of Object.values(nodes)) for (const b of Object.values(nodes)) if (a !== b) syncFrom(a, b); };

  for (const name of names) {
    const node = nodes[name]!;
    const client = {
      addrOf: () => ({ ip: "127.0.0.1", port: 9 }),
      leadLease: (_a: unknown, w: unknown) => call(node, "lease", w),
      scheduleClaim: (_a: unknown, w: unknown) => call(node, "schedule-claim", w),
      scheduleProgress: (_a: unknown, w: unknown) => call(node, "schedule-progress", w),
      scheduleDefaults: (_a: unknown, w: unknown) => call(node, "schedule-defaults", w),
    };
    node.lead = new Leadership({ core: node.core, client: client as never, preferred: () => pref.v,
      lost: () => { if (o.wireLost) node.s.abandon(); } });
    const runner = {
      valid: () => node.lead.valid, epoch: () => node.lead.epoch, leaseFailure: () => node.lead.leaseFailure,
      claim: (id: string, slot: number, run: string, rn?: boolean, tg?: readonly string[]) => node.lead.claimSchedule(id, slot, run, rn, tg),
      turn: (_prompt: string, run: string) => { node.turns.push({ run, at: wall.value }); return `turn-${run}`; },
      reply: (turn: string) => node.replies.get(turn) ?? null,
      interrupt: () => {}, capacityTargets: () => [] as string[],
    };
    node.s = new Schedules(node.core, runner, client as never);
    // Record every completion the lead captures (its first, possibly failed, attempt), for the lost-result accounting.
    const internals = node.s as unknown as { complete: (schedule: Schedule, active: { run: string; completion?: { failures: number; result: string; paused: boolean } }, reply: unknown, at: number) => Promise<void> };
    const origComplete = internals.complete.bind(node.s);
    internals.complete = async (schedule, active, reply, at) => {
      const before = !!active.completion;
      const r = await origComplete(schedule, active, reply, at);
      if (!before && active.completion) node.captured.push({ run: active.run, schedule: schedule.id, at: wall.value, failures: active.completion.failures, result: active.completion.result, paused: active.completion.paused });
      return r;
    };
    registerHost(node.core, { schedules: node.s, grantLeadership: (n: string) => node.lead.grant(n),
      holdsScheduleLease: (n: string, e: number) => node.lead.holds(n, e), claimSchedule: (n: string, cl: never) => node.lead.claimFromPeer(n, cl) } as unknown as OrchestratorHost);
    node.api = new PeerApi(node.core);
    cleanups.push(() => { try { node.lead.stop(); } catch { /* already stopped */ } });
  }
  syncFrom(A0, ...names.slice(1).map((n) => nodes[n]!));

  const authority = () => Object.values(nodes).find((n) => n.core.isAuthority())!;
  const view = (n: WorldNode, id: string) => readSchedules(n.core).find((s) => s.id === id);
  const show = (n: WorldNode, id: string) => { const s = view(n, id); return s ? `run=${s.run_id?.slice(0, 4) ?? null} last=${iso(s.last_run)} next=${iso(s.next_run)} en=${s.enabled} fail=${s.failures} rev=${s.progress_rev} res=${JSON.stringify(s.last_result)}` : "gone"; };

  /** every claim post in the authority-signed stream, in origin order */
  const claimPosts = (n: WorldNode = authority()) => eventsOf(n).filter((e: any) => typeof e.body?.text === "string" && e.body.text.startsWith(CLAIM_PREFIX))
    .map((e: any) => ({ ...JSON.parse(e.body.text.slice(CLAIM_PREFIX.length)), origin: e.origin, seq: e.seq }));
  /** every schedule change post (puts/notes/removes) */
  const changePosts = (n: WorldNode = authority()) => eventsOf(n).filter((e: any) => typeof e.body?.text === "string" && e.body.text.startsWith(SCHED_PREFIX))
    .map((e: any) => ({ ...JSON.parse(e.body.text.slice(SCHED_PREFIX.length)), origin: e.origin, seq: e.seq, evId: e.id }));
  const completions = (n: WorldNode = authority()) => changePosts(n).filter((c: any) => c.op === "put" && c.completion_run);
  /** every #general post's text, as one node holds them */
  const generalPosts = (n: WorldNode): string[] => n.core.store.queryEvents({ channel: "general", kinds: ["msg.post"], limit: 100_000 })
    .map((r: { json: string }) => (JSON.parse(r.json) as { body: { text: string } }).body.text);

  /** Plain posts in the owner-only schedule channel (the machine records are the schedule and claim posts). */
  const scheduleNotes = (n: WorldNode): string[] => n.core.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 100_000 })
    .map((r: { json: string }) => (JSON.parse(r.json) as { body: { text: string } }).body.text)
    .filter((t: string) => !t.startsWith(SCHED_PREFIX) && !t.startsWith(CLAIM_PREFIX));
  /** The completions a node still holds in memory, by schedule id. */
  const held = (n: WorldNode): Map<string, { run: string; completion?: unknown }> => {
    const active = (n.s as unknown as { active: Map<string, { run: string; completion?: unknown }> }).active;
    return new Map([...active].filter(([, entry]) => !!entry.completion));
  };
  /** Let a node's turns end well without naming each one. */
  const autoReply = (n: WorldNode) => { n.replies.get = () => ({ text: "ok", ok: true }); };
  /**
   * Append a schedule put the authority's own code would not write, after the schedule's latest accepted change: the state
   * an older build (or a rare race) can leave. `patch` overrides schedule fields.
   */
  const forgePut = (id: string, patch: Partial<Schedule>) => {
    const top = changePosts().filter((c: any) => (c.op === "put" ? c.schedule.id : c.id) === id).at(-1);
    if (!top) throw new Error("no change to build on");
    const { origin: _o, seq: _s, evId: _e, completion_run: _r, completion_claim: _c, request_key: _k, ...change } = top;
    authority().core.emit("msg.post", { text: SCHED_PREFIX + JSON.stringify({ ...change, rev: (top.rev ?? 0) + 1,
      schedule: { ...top.schedule, ...patch } }) }, { channel: SCHEDULE_CHANNEL });
  };

  /** Renew a node's lease, then tick it. */
  const stepNode = async (n: WorldNode) => {
    if (!n.up) return;
    await n.lead.acquire();
    await n.s.tick(wall.value + (skews[n.name] ?? 0));
  };
  /** Advance the clock in `step` slices; every running node renews and ticks in each slice (order = names order). */
  const advance = async (ms: number, opts: { step?: number; order?: string[]; syncEach?: boolean } = {}) => {
    const step = opts.step ?? 10_000;
    const end = wall.value + ms;
    while (wall.value < end) {
      at(Math.min(end, wall.value + step));
      for (const name of opts.order ?? names) await stepNode(nodes[name]!);
      if (opts.syncEach) syncAll();
    }
  };

  /** Transfer schedule/roster authority from the current authority to `to`, delivering all events to everyone. */
  const transfer = (to: string, opts: { deliver?: boolean } = {}) => {
    authority().core.emit("team.authority", { node_id: nodes[to]!.core.nodeId });
    if (opts.deliver !== false) syncAll();
  };

  /** AT-MOST-ONCE audit: every executed run (turn) maps to an accepted claim and no slot runs twice or is accepted twice. */
  const audit = () => {
    const claims = claimPosts();
    const byRun = new Map<string, any[]>(); for (const c of claims) { const arr = byRun.get(c.run) ?? []; arr.push(c); byRun.set(c.run, arr); }
    const slotRuns = new Map<string, string[]>();
    const problems: string[] = [];
    for (const n of Object.values(nodes)) for (const t of n.turns) {
      const cs = byRun.get(t.run) ?? [];
      if (cs.length === 0) { problems.push(`run ${t.run.slice(0, 4)} executed on ${n.name} with NO accepted claim`); continue; }
      for (const c of cs) { const key = `${c.schedule}:${c.slot}`; const arr = slotRuns.get(key) ?? []; arr.push(`${n.name}:${t.run.slice(0, 4)}`); slotRuns.set(key, arr); }
    }
    for (const [key, runs] of slotRuns) if (runs.length > 1) problems.push(`slot ${key.slice(0, 4)}:${iso(Number(key.split(":")[1]))} executed ${runs.length}x: ${runs.join(",")}`);
    // accepted claim slots per schedule are unique except across a reset barrier (the fold resets them)
    const seenSlots = new Map<string, number>();
    for (const c of claims) {
      if (c.reset) { for (const k of [...seenSlots.keys()]) if (k.startsWith(c.schedule)) seenSlots.delete(k); continue; }
      const key = `${c.schedule}:${c.slot}`; seenSlots.set(key, (seenSlots.get(key) ?? 0) + 1);
    }
    for (const [key, n] of seenSlots) if (n > 1) problems.push(`slot ${key.slice(0, 4)}:${iso(Number(key.split(":")[1]))} accepted ${n}x`);
    return problems;
  };

  return { skews, names, nodes, net, pref, wall, mono, at, syncFrom, syncAll, eventsOf, authority, view, show,
    claimPosts, changePosts, completions, generalPosts, scheduleNotes, held, autoReply, forgePut, advance, stepNode, transfer, audit, byId, call, team, tn };
}
export type World = Awaited<ReturnType<typeof makeWorld>>;
