// FINAL-review two-core (N-core) harness for TALKIE-CRON (rounds 19-23 review).
//   * every node = real Core + real Leadership + real Schedules + real PeerApi (registered host), like production
//   * the lead -> authority peer routes are the real signed routes (signSchedulePeer -> PeerApi.serveAdmitted -> verify)
//   * fake wall clock (Date via setSystemTime) and fake monotonic clock (performance.now overridden), advanced together
//   * lossy acknowledgements: every RPC can be "req-lost" (never reaches the authority) or "ack-lost" (the authority
//     commits, the caller sees an error), decided by a caller-supplied plan
//   * event replication is explicit (sync) so a lead's local view can lag the authority
import { setSystemTime } from "bun:test";
import { load, SRC } from "./load.ts";

export type Fault = "ok" | "req-lost" | "ack-lost";
export interface NetInfo { from: string; to: string; path: string; body: any; n: number }
const CLAIM_PREFIX = "walkie-talkie-claim:v1:";
const SCHED_PREFIX = "walkie-talkie-schedule:v1:";
export const iso = (n: number | null) => (n === null ? "null" : new Date(n).toISOString().slice(11, 19));

export async function makeWorld(cleanups: (() => void)[], o: { names?: string[]; wireLost?: boolean } = {}) {
  const L = await load();
  const { PeerCallError } = await import(`${SRC}/src/daemon/peer-client.ts`);
  const { stubOf } = await import(`${SRC}/src/protocol/header.ts`);
  const { Event: EventSchema } = await import(`${SRC}/src/protocol/schemas.ts`);
  const { LeadGrant } = await import(`${SRC}/src/daemon/orchestrator/lease.ts`);
  const { ScheduleClaimResult } = await import(`${SRC}/src/daemon/orchestrator/schedule-claims.ts`);
  const responseSchemas: Record<string, any> = { lease: LeadGrant, "schedule-claim": ScheduleClaimResult, "schedule-progress": EventSchema };
  const names = o.names ?? ["alex", "mira", "bea", "cy"];
  const tn: Record<string, any> = Object.fromEntries(names.map((n) => [n, L.tnode(n)]));
  const root = tn[names[0]!];
  const { team, create } = L.createTeam(root);
  const base = Math.floor(L.now() / 3_600_000) * 3_600_000 + 3_600_000;
  const wall = { value: base - 2 * 60_000 };
  const mono = { v: 1_000_000 };
  setSystemTime(new Date(wall.value));
  const origPerf = performance.now.bind(performance);
  (performance as any).now = () => mono.v;
  cleanups.push(() => { (performance as any).now = origPerf; });
  const at = (ms: number) => { const d = ms - wall.value; wall.value = ms; setSystemTime(new Date(ms)); if (d > 0) mono.v += d; };

  const pref = { v: root.keys.nodeId as string };
  type Node = {
    name: string; tn: any; core: any; lead: any; s: any; api: any; client: any; up: boolean;
    turns: { run: string; at: number }[]; replies: Map<string, { text: string; ok: boolean }>; captured: { run: string; schedule: string; at: number; failures: number; result: string }[]; deletions: { run: string; hadCompletion: boolean; caller: string; at: number }[];
  };
  const nodes: Record<string, Node> = {};
  const net = {
    plan: ((_i: NetInfo) => "ok") as (i: NetInfo) => Fault,
    log: [] as { from: string; to: string; path: string; fault: Fault; result: string }[],
    wires: [] as { from: string; to: string; path: string; wire: any; result: "ok" | "err"; body?: any; fault?: Fault; t?: number; code?: string; msg?: string }[],
    n: 0,
    badResponses: [] as { path: string; issues: string }[],
  };
  const byId = (id: string | null) => Object.values(nodes).find((n) => n.core.nodeId === id);

  const call = async (from: Node, path: string, wire: any) => {
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
      const r = await to.api.serveAdmitted(new Request(url, { method: "POST", body: JSON.stringify(wire) }), url,
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
    if (schema) { const parsed = schema.safeParse(result); if (!parsed.success) { net.badResponses.push({ path, issues: JSON.stringify(parsed.error.issues).slice(0, 300) }); throw new PeerCallError(200, "bad_response", "peer response has the wrong shape"); } return parsed.data; }
    return result;
  };

  for (const name of names) {
    const core = L.makeCore(tn[name], team, cleanups, { clock: () => wall.value });
    const node = { name, tn: tn[name], core, up: true, turns: [], replies: new Map(), captured: [], deletions: [] } as unknown as Node;
    nodes[name] = node;
  }
  const A0 = nodes[names[0]!]!;
  A0.core.ingest(create, "local");
  for (const n of names.slice(1)) {
    A0.core.emit("team.member", { login: tn[n].login, handle: tn[n].handle, role: "owner" });
    A0.core.emit("team.node", { node_id: tn[n].keys.nodeId, login: tn[n].login, hostname: tn[n].hostname, pubkey: tn[n].keys.pubkey, ip: "127.0.0.1" });
  }
  A0.core.emit("channel.upsert", { name: "general" });
  A0.core.emit("channel.upsert", { name: L.SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: [...names].sort() });

  const eventsOf = (n: Node) => n.core.store.queryEvents({ limit: 1_000_000 }).map((r: { json: string }) => JSON.parse(r.json))
    .sort((x: { seq: number }, y: { seq: number }) => x.seq - y.seq);
  const syncFrom = (src: Node, ...dst: Node[]) => { const evs = eventsOf(src); for (const d of dst) for (const e of evs) d.core.ingest(e, "remote"); };
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
    node.client = client;
    node.lead = new L.Leadership({ core: node.core, client, preferred: () => pref.v,
      lost: () => { if (o.wireLost) node.s?.abandon(); } });
    const runner = {
      valid: () => node.lead.valid, epoch: () => node.lead.epoch, leaseFailure: () => node.lead.leaseFailure,
      claim: (id: string, slot: number, run: string, rn?: boolean, tg?: readonly string[]) => node.lead.claimSchedule(id, slot, run, rn, tg),
      turn: (_prompt: string, run: string) => { node.turns.push({ run, at: wall.value }); return `turn-${run}`; },
      reply: (turn: string) => node.replies.get(turn) ?? null,
      interrupt: () => {}, capacityTargets: () => [],
    };
    node.s = new L.Schedules(node.core, runner, client);
    { const activeMap: Map<string, any> = node.s.active; const origDelete = activeMap.delete.bind(activeMap);
      activeMap.delete = (key: string) => { const v = activeMap.get(key); if (v) { const frames = (new Error().stack ?? "").split("\n").slice(2, 6).map((l) => (/at (?:async )?(?:Schedules\.)?([A-Za-z_.]+)/.exec(l)?.[1] ?? "?")); node.deletions.push({ run: v.run, hadCompletion: !!v.completion, caller: frames.join("<"), at: wall.value }); } return origDelete(key); };
      const origClear = activeMap.clear.bind(activeMap);
      activeMap.clear = () => { for (const [, v] of activeMap) node.deletions.push({ run: v.run, hadCompletion: !!v.completion, caller: "clear(stop)", at: wall.value }); origClear(); }; }
    { const origComplete = node.s.complete.bind(node.s);
      node.s.complete = async (schedule: any, active: any, reply: any, now: number) => {
        const before = !!active.completion; const r = await origComplete(schedule, active, reply, now);
        if (!before && active.completion) node.captured.push({ run: active.run, schedule: schedule.id, at: wall.value, failures: active.completion.failures, result: active.completion.result });
        return r; }; }
    L.registerHost(node.core, { schedules: node.s, grantLeadership: (n: string) => node.lead.grant(n),
      holdsScheduleLease: (n: string, e: number) => node.lead.holds(n, e), claimSchedule: (n: string, cl: never) => node.lead.claimFromPeer(n, cl) });
    node.api = new L.PeerApi(node.core);
    cleanups.push(() => { try { node.lead.stop(); } catch {} });
  }
  syncFrom(A0, ...names.slice(1).map((n) => nodes[n]!));

  const authority = () => Object.values(nodes).find((n) => n.core.isAuthority())!;
  const view = (n: Node, id: string) => L.readSchedules(n.core).find((s: { id: string }) => s.id === id);
  const show = (n: Node, id: string) => { const s = view(n, id); return s ? `run=${s.run_id?.slice(0, 4) ?? null} last=${iso(s.last_run)} next=${iso(s.next_run)} en=${s.enabled} fail=${s.failures} rev=${s.progress_rev} res=${JSON.stringify(s.last_result)}` : "gone"; };

  /** every claim post in the authority-signed stream, in origin order */
  const claimPosts = (n: Node = authority()) => eventsOf(n).filter((e: any) => typeof e.body?.text === "string" && e.body.text.startsWith(CLAIM_PREFIX))
    .map((e: any) => ({ ...JSON.parse(e.body.text.slice(CLAIM_PREFIX.length)), origin: e.origin, seq: e.seq }));
  /** every schedule change post (puts/notes/removes) */
  const changePosts = (n: Node = authority()) => eventsOf(n).filter((e: any) => typeof e.body?.text === "string" && e.body.text.startsWith(SCHED_PREFIX))
    .map((e: any) => ({ ...JSON.parse(e.body.text.slice(SCHED_PREFIX.length)), origin: e.origin, seq: e.seq, evId: e.id }));
  const completions = (n: Node = authority()) => changePosts(n).filter((c: any) => c.op === "put" && c.completion_run);

  /** Renew every running node's lease, then tick it. */
  const stepNode = async (n: Node) => {
    if (!n.up) return;
    await n.lead.acquire();
    await n.s.tick(wall.value);
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
    const from = authority();
    from.core.emit("team.authority", { node_id: nodes[to]!.core.nodeId });
    if (opts.deliver !== false) syncAll();
  };
  const lastCompletionEvent = (id: string) => completions().filter((c: any) => c.schedule.id === id).at(-1);

  /** AT-MOST-ONCE audit: every executed run (turn) maps to exactly one accepted claim slot and no slot runs twice. */
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
    // accepted claim slots per schedule are unique except across a reset barrier (fold resets)
    const seenSlots = new Map<string, number>();
    for (const c of claims) { if (c.reset) { for (const k of [...seenSlots.keys()]) if (k.startsWith(c.schedule)) seenSlots.delete(k); continue; }
      const key = `${c.schedule}:${c.slot}`; seenSlots.set(key, (seenSlots.get(key) ?? 0) + 1); }
    for (const [key, n] of seenSlots) if (n > 1) problems.push(`slot ${key.slice(0, 4)}:${iso(Number(key.split(":")[1]))} accepted ${n}x`);
    return problems;
  };

  return { L, PeerCallError, stubOf, names, nodes, net, pref, wall, mono, at, syncFrom, syncAll, eventsOf, authority, view, show,
    claimPosts, changePosts, completions, lastCompletionEvent, advance, stepNode, transfer, audit, byId, call, team, tn };
}
export type World = Awaited<ReturnType<typeof makeWorld>>;
