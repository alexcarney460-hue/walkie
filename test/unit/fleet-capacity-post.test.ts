// WALK-66: the orchestration poll posts a fleet capacity summary when the picture changes, including when nobody is
// eligible for a capacity ask. It recommends nothing: no ask, no seat, and no second post inside the hour. The
// summary goes to the owner-only schedule channel. A one-seat flap is not a new picture.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { eligibleCapacityTargets } from "../../src/daemon/orchestrator/capacity-asks.ts";
import type { Core } from "../../src/daemon/core.ts";
import { lastPostedSummary, SUMMARY_COOLDOWN_MS, SUMMARY_MARKER_ROWS } from "../../src/daemon/orchestrator/capacity-summary.ts";
import { prepareOrchestrationPoll, type PollDeps } from "../../src/daemon/orchestrator/poll.ts";
import { canSeeChannel, isRestricted } from "../../src/daemon/roster.ts";
import type { AccountView } from "../../src/protocol/accounts.ts";
import { stubOf } from "../../src/protocol/header.ts";
import type { Event, NodeView } from "../../src/protocol/schemas.ts";
import type { SeatHostView, SeatView } from "../../src/protocol/seats.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { recsWorld } from "../helpers/talkie-recs.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const H = 3_600_000;
const GIB = 1024 ** 3;
const NODE = "aaaaaaaaaaaaaaaa";
const PREFIX = "walkie-talkie-capacity-summary:v1:";

const node = (over: Record<string, unknown> = {}): NodeView => ({
  node_id: NODE, handle: "maren", hostname: "mac-a", ip: "127.0.0.1", transports: ["tailscale"], online: true,
  last_seen: Date.now(), rtt_ms: 1, self: false, sync: { behind: 0, last_sync: null },
  stats: { at: Date.now(), mem: { total: 16 * GIB, used: 4 * GIB, free: 8 * GIB, swap_used: 0, pressure: "normal" }, temp_c: null,
    sys: { os: "linux", arch: "x64", cpus: 8, load1: 0.5, cpu_busy_pct: 10 } }, ...over,
}) as unknown as NodeView;
const host = (over: Record<string, unknown> = {}): SeatHostView => ({
  node: NODE, hostname: "mac-a", handle: "maren", self: false, allows: true, member: true, channel: `seats-${NODE}`, online: true,
  availability: { state: "available", max: 3, running: 0 }, ...over,
}) as SeatHostView;
const account = (used = 10): AccountView => {
  const usage = { at: Date.now() - 60_000, state: "ok" as const, reason: null, source: "api" as const, until: null,
    windows: [{ kind: "session" as const, used_pct: used, resets_at: Date.now() + 3 * H, window_s: null, scope: null }] };
  return { key: "maren:claude:aaaaaaaaaaaaaaaaaaaaaaaa", id: "claude", provider: "claude", label: "Claude account", plan: null,
    owners: ["maren"], claimed_by: [], machines: [{ node_id: NODE, hostname: "mac-a", handle: "maren", online: true, self: false, agents: [], usage }],
    usage, usage_host: "mac-a", last_seen: Date.now() };
};

function setup() {
  const t = recsWorld(cleanups);
  const fleet: { nodes: NodeView[]; hosts: SeatHostView[]; seats: SeatView[]; accounts: AccountView[] } = {
    nodes: [node()], hosts: [host()], seats: [], accounts: [account()],
  };
  const deps: PollDeps = {
    ...t.deps, nodes: () => fleet.nodes, seatHosts: () => fleet.hosts, seats: () => fleet.seats,
    accounts: () => fleet.accounts.map((a) => account(a.usage?.windows[0]?.used_pct ?? 10)), agents: () => [],
  };
  const run = (canAct: () => boolean = () => true) => prepareOrchestrationPoll(deps, canAct);
  const events = () => t.core.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;
  const posts = (channel: string) => t.core.store.queryEvents({ channel, kinds: ["msg.post"], limit: 100 }).flatMap((row) => {
    const event = JSON.parse(row.json) as { body?: { text?: string; seat?: unknown }; author?: { agent?: string } };
    return typeof event.body?.text === "string" ? [{ text: event.body.text, agent: event.author?.agent, seat: event.body.seat }] : [];
  });
  const summaries = () => posts(SCHEDULE_CHANNEL).filter((p) => p.text.startsWith("WalkieTalkie fleet capacity"));
  return { t, fleet, deps, run, events, posts, summaries };
}

const POSTED = `Fleet capacity summary posted to #${SCHEDULE_CHANNEL}.`;

test("the poll posts the summary when no orchestrator is eligible, and the post recommends nothing", async () => {
  const { t, run, events, posts, summaries } = setup();
  // Checked a moment ago: the two-hour ask cooldown would skip this address. The summary does not consult that list.
  expect(eligibleCapacityTargets(t.core, ["@maren/mac-a"], Date.now(), { "@maren/mac-a": Date.now() })).toEqual([]);
  const before = events();
  const asksBefore = t.core.store.queryEvents({ kinds: ["ask"], limit: 20 }).length;
  const r = await run();
  expect((r as { skip: string }).skip).toContain(POSTED);
  expect((r as { skip: string }).skip).toContain("1 machine (3 free seats)");
  expect(events()).toBe(before + 2);
  expect(posts("general").filter((p) => p.text.includes("WalkieTalkie fleet capacity"))).toEqual([]);
  const summary = summaries();
  expect(summary).toHaveLength(1);
  expect(summary[0]?.agent).toBeUndefined();
  expect(summary[0]?.text).toContain("WalkieTalkie fleet capacity:");
  expect(summary[0]?.text).toContain("mac-a:");
  expect(summary[0]?.text).not.toContain("127.0.0.1");
  expect(summary[0]?.text).not.toContain("maren:claude");
  expect(summary[0]?.seat).toBeUndefined();
  const marker = posts(SCHEDULE_CHANNEL).filter((p) => p.text.startsWith(PREFIX));
  expect(marker).toHaveLength(1);
  expect(marker[0]?.text).not.toContain("mac-a");
  expect(marker[0]?.text).not.toContain("127.0.0.1");
  expect(marker[0]?.agent).toBeUndefined();
  const saved = lastPostedSummary(t.core) as { fingerprint: string; at: number; machines?: { node: string; factor: string; free_slots: number; score: number }[] } | null;
  expect(saved?.machines).toEqual([{ node: NODE, factor: "seats", free_slots: 3, score: 100 }]);
  expect(t.core.store.queryEvents({ kinds: ["ask"], limit: 20 })).toHaveLength(asksBefore);
});

test("a seat change inside the hour is not posted again, and the same picture is not posted after the hour", async () => {
  const { t, fleet, run, events, posts, summaries } = setup();
  const firstRun = await run();
  expect((firstRun as { skip: string }).skip).toContain(POSTED);
  expect(summaries()).toHaveLength(1);
  expect(posts("general").filter((p) => p.text.includes("WalkieTalkie fleet capacity"))).toEqual([]);
  const before = events();
  const first = postsOf(t);
  fleet.hosts = [host({ availability: { state: "available", max: 1, running: 0 } })];
  t.tick(5 * 60_000);
  await run();
  expect(events()).toBe(before);
  expect(postsOf(t)).toBe(first);
  // Back to the picture that was posted. An hour later the same picture is still not worth a post.
  fleet.hosts = [host()];
  t.tick(SUMMARY_COOLDOWN_MS);
  const r = await run();
  expect(events()).toBe(before);
  expect((r as { skip: string }).skip).not.toContain("Fleet capacity summary posted");
});

test("a real change posts once the hour has passed, still with nobody eligible for an ask", async () => {
  const { t, fleet, run, events, posts, summaries } = setup();
  await run();
  const before = events();
  // One more free seat (3 → 4) is inside the dead-band, even after the hour, and even though the old band key would split it.
  fleet.hosts = [host({ availability: { state: "available", max: 4, running: 0 } })];
  t.tick(SUMMARY_COOLDOWN_MS);
  expect(SUMMARY_COOLDOWN_MS).toBeLessThan(2 * H);
  expect(eligibleCapacityTargets(t.core, ["@maren"], Date.now(), { "@maren": Date.now() })).toEqual([]);
  const quiet = await run();
  expect(events()).toBe(before);
  expect((quiet as { skip: string }).skip).not.toContain(POSTED);
  // Two more than the posted count (3 → 5) is a new picture.
  fleet.hosts = [host({ availability: { state: "available", max: 5, running: 0 } })];
  t.tick(SUMMARY_COOLDOWN_MS);
  const r = await run();
  expect(events()).toBe(before + 2);
  expect((r as { skip: string }).skip).toContain(POSTED);
  const text = summaries().map((p) => p.text).join("\n");
  expect(text).toContain("5 free");
  expect(posts("general").filter((p) => p.text.includes("WalkieTalkie fleet capacity"))).toEqual([]);
});

test("CPU chatter around the busy line does not post again; dropping clearly below it does", async () => {
  const { t, fleet, run, events, summaries } = setup();
  fleet.nodes = [node({ stats: busy(90) })];
  await run();
  expect(summaries()[0]?.text).toContain("limited by CPU");
  const held = events();
  fleet.nodes = [node({ stats: busy(80) })];
  t.tick(SUMMARY_COOLDOWN_MS + 1_000);
  await run();
  expect(events()).toBe(held);
  fleet.nodes = [node({ stats: busy(70) })];
  t.tick(SUMMARY_COOLDOWN_MS + 1_000);
  const r = await run();
  expect(events()).toBe(held + 2);
  expect((r as { skip: string }).skip).toContain(POSTED);
  expect(summaries().map((p) => p.text).join("\n")).toContain("limited by seats");
});

test("an empty team still says exactly what it said, and writes nothing", async () => {
  const { t, fleet, run, events } = setup();
  fleet.nodes = [];
  fleet.hosts = [];
  const before = events();
  const r = await run();
  expect(r).toEqual({ skip: "Orchestration poll: 0 machines (0 free seats), 0 cards waiting, 0 without a seat; recommendations 0 new, 0 already open." });
  expect(events()).toBe(before);
  void t;
});

test("a lost lease posts nothing", async () => {
  const { t, run, events, posts, summaries } = setup();
  const p = await t.project("Website", "WEB", { off: true });
  t.card(p, "Fix the login page");
  t.tick(5 * H);
  const before = events();
  await expect(run(() => false)).rejects.toThrow("lease expired");
  expect(events()).toBe(before);
  expect(posts("general")).toEqual([]);
  expect(summaries()).toEqual([]);
});

test("a hostname that looks like a key is redacted before it is signed, and the marker keeps the node id", async () => {
  const { fleet, run, posts, summaries } = setup();
  const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz";
  fleet.nodes = [node({ hostname: `box-${secret}` })];
  fleet.hosts = [host({ hostname: `box-${secret}` })];
  await run();
  const text = summaries()[0]?.text ?? "";
  expect(text).not.toContain(secret);
  expect(text).toContain("REDACTED");
  expect(text).not.toContain("127.0.0.1");
  const marker = posts(SCHEDULE_CHANNEL).find((p) => p.text.startsWith(PREFIX))?.text ?? "";
  expect(marker).not.toContain(secret);
  expect(marker).not.toContain("box-");
  expect(marker).toContain(NODE);
});

test("a member outside the schedule channel and the host's seats channel receives nothing", async () => {
  const { t, run, summaries } = setup();
  t.core.emit("channel.upsert", { name: `seats-${NODE}`, members: ["alex"] });
  const ines = t.person("ines");
  expect(ines.core.roster.channels.get(SCHEDULE_CHANNEL)?.members?.includes("ines")).toBe(false);
  expect(ines.core.roster.channels.get(`seats-${NODE}`)?.members?.includes("ines")).toBe(false);
  await run();
  expect(summaries().map((p) => p.text).join("\n")).toContain("3 free");
  // A peer serves a non-member a stub (peer-api asServed). The helper's mirror() copies full rows, which is not that path.
  const rows = t.core.store.db.query<{ json: string }, []>(
    "SELECT json FROM events WHERE redacted = 0 AND status = 'ok' ORDER BY origin, seq").all();
  for (const row of rows) {
    const ev = JSON.parse(row.json) as Event;
    if (ines.core.store.getRow(ev.id)) continue;
    const hidden = isRestricted(t.core.roster, ev.channel) && !canSeeChannel(t.core.roster, ev.channel, "ines");
    ines.core.ingest(hidden ? stubOf(ev) : ev, "remote");
  }
  const stored = ines.core.store.db.query<{ json: string }, []>("SELECT json FROM events").all().map((row) => row.json).join("\n");
  expect(stored).not.toContain("WalkieTalkie fleet capacity");
  expect(stored).not.toContain("free_slots");
  expect(stored).not.toContain("limited by");
  const stubs = ines.core.store.db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM events WHERE channel = ? AND redacted = 1").get(SCHEDULE_CHANNEL)?.n ?? 0;
  expect(stubs).toBeGreaterThanOrEqual(2);
  expect(ines.core.visible({ channel: SCHEDULE_CHANNEL })).toBe(false);
  expect(ines.core.store.queryEvents({ channel: "general", kinds: ["msg.post"], limit: 50 })
    .map((row) => JSON.parse(row.json).body?.text as string)
    .filter((text) => typeof text === "string" && text.includes("fleet capacity"))).toEqual([]);
  expect(ines.core.roster.channels.get(SCHEDULE_CHANNEL)?.members?.includes("ines")).toBe(false);
});

test("one seat flapping for 24 hours posts at most a few summaries", async () => {
  const { t, fleet, run, posts, summaries } = setup();
  const seat = { id: "s1", host: { node: NODE, hostname: "mac-a", handle: "maren" }, state: "running" } as unknown as SeatView;
  // The reviewer's probe: max 3, one seat on then off, across a day. Each hour also flips inside the hour.
  for (let hour = 0; hour < 24; hour++) {
    fleet.seats = [];
    await run();
    t.tick(5 * 60_000);
    fleet.seats = [seat];
    await run();
    t.tick(SUMMARY_COOLDOWN_MS - 5 * 60_000);
  }
  const texts = [...summaries(), ...posts("general")].map((p) => p.text).filter((text) => text.startsWith("WalkieTalkie fleet capacity"));
  // 3 free (score 100) and 2 free (score 67) are one picture, so the day is a single post.
  expect(texts.length).toBe(1);
  expect(texts.join("\n")).toMatch(/\d free/);
  expect(posts("general").filter((p) => p.text.includes("WalkieTalkie fleet capacity"))).toEqual([]);
});

test("the posted picture is the newer of the local copy and one prefix-filtered marker query", () => {
  const { t } = setup();
  const orig = t.core.store.queryEvents.bind(t.core.store);
  const limits: number[] = [];
  t.core.store.queryEvents = (filter) => {
    if (filter.channel === SCHEDULE_CHANNEL) limits.push(filter.limit);
    return orig(filter);
  };
  const queries: string[] = [];
  const q = t.core.store.db.query.bind(t.core.store.db);
  t.core.store.db.query = ((sql: string) => {
    if (sql.includes("json_extract(body")) queries.push(sql);
    return q(sql);
  }) as typeof t.core.store.db.query;
  // Posted by another owner's machine: this lead's own marker later than its copy is one from before a clock correction.
  const bea = t.person("bea", "owner");
  t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "bea"] });
  bea.mirror();
  const marker = (fingerprint: string, at: number) => {
    t.tick(1);
    bea.core.emit("msg.post", { text: PREFIX + JSON.stringify({ fingerprint, at }) }, { channel: SCHEDULE_CHANNEL });
    bea.push();
  };
  const buried = "ab".repeat(32);
  marker(buried, 1_000);
  for (let i = 0; i < 240; i++) {
    t.tick(1);
    t.core.emit("msg.post", { text: `schedule note ${i}` }, { channel: SCHEDULE_CHANNEL });
  }
  limits.length = 0;
  queries.length = 0;
  expect(lastPostedSummary(t.core)?.fingerprint).toBe(buried);
  expect(limits).toEqual([]);
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain("LIKE");
  expect(queries[0]).toContain("LIMIT ?");
  expect(SUMMARY_MARKER_ROWS).toBe(8);
  // An older local copy loses. The same time, or a later one, keeps the local copy.
  t.core.store.setMeta("talkie_capacity_summary_v1", JSON.stringify({ fingerprint: "11".repeat(32), at: 500 }));
  expect(lastPostedSummary(t.core)?.fingerprint).toBe(buried);
  const local = "22".repeat(32);
  t.core.store.setMeta("talkie_capacity_summary_v1", JSON.stringify({ fingerprint: local, at: 1_000 }));
  expect(lastPostedSummary(t.core)?.fingerprint).toBe(local);
  t.core.store.setMeta("talkie_capacity_summary_v1", JSON.stringify({ fingerprint: local, at: 2_000 }));
  expect(lastPostedSummary(t.core)?.fingerprint).toBe(local);
  expect(limits).toEqual([]);
});

test("a returning lead does not post the picture a later lead already posted", async () => {
  const { t, fleet, run, summaries } = setup();
  const bea = t.person("bea", "owner");
  t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "bea"] });
  bea.mirror();
  const beaDeps: PollDeps = {
    ...bea.deps, nodes: () => fleet.nodes, seatHosts: () => fleet.hosts, seats: () => fleet.seats,
    accounts: () => fleet.accounts.map((a) => account(a.usage?.windows[0]?.used_pct ?? 10)), agents: () => [],
  };
  const beaRun = () => prepareOrchestrationPoll(beaDeps, () => true);
  await beaRun();
  bea.push();
  expect(summariesOn(bea.core)).toBe(1);
  // The picture changes and the hour has passed. Alex, now leading, posts the new one.
  t.tick(2 * H);
  fleet.seats = [0, 1, 2].map((i) => ({ id: `s${i}`, host: { node: NODE, hostname: "mac-a", handle: "maren" }, state: "running" }) as unknown as SeatView);
  await run();
  bea.mirror();
  const before = summariesOn(bea.core);
  expect(before).toBe(2);
  // Lead returns to bea. The picture is still the one alex posted. Her older local copy must not win.
  t.tick(10 * 60_000);
  await beaRun();
  expect(summariesOn(bea.core)).toBe(before);
});

test("a new lead with no local copy still sees a marker buried under ordinary schedule posts", async () => {
  const { t, fleet, summaries } = setup();
  const bea = t.person("bea", "owner");
  t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "bea"] });
  const deps: PollDeps = {
    ...t.deps, nodes: () => fleet.nodes, seatHosts: () => fleet.hosts, seats: () => fleet.seats,
    accounts: () => fleet.accounts.map((a) => account(a.usage?.windows[0]?.used_pct ?? 10)), agents: () => [],
  };
  await prepareOrchestrationPoll(deps, () => true);
  for (let i = 0; i < 260; i++) {
    t.tick(60_000);
    t.core.emit("msg.post", { text: `schedule note ${i}` }, { channel: SCHEDULE_CHANNEL });
  }
  bea.mirror();
  expect(bea.core.store.getMeta("talkie_capacity_summary_v1")).toBeNull();
  const before = summariesOn(bea.core);
  expect(before).toBe(1);
  const queries: { sql: string; args: unknown[] }[] = [];
  const orig = t.core.store.queryEvents.bind(t.core.store);
  let scanned = 0;
  bea.core.store.queryEvents = (filter) => {
    if (filter.channel === SCHEDULE_CHANNEL) scanned++;
    return orig(filter);
  };
  const q = bea.core.store.db.query.bind(bea.core.store.db);
  bea.core.store.db.query = ((sql: string) => {
    const statement = q(sql);
    // The marker query is the prefix filter. Other statements also use LIMIT; leave those alone.
    if (!sql.includes("author_agent IS NULL") || !sql.includes("json_extract(body, '$.text') LIKE")) return statement;
    const all = statement.all.bind(statement);
    statement.all = ((...args: unknown[]) => {
      if (args.some((arg) => arg === `${PREFIX}%`)) queries.push({ sql, args });
      return all(...(args as Parameters<typeof all>));
    }) as typeof statement.all;
    return statement;
  }) as typeof bea.core.store.db.query;
  await prepareOrchestrationPoll({ ...bea.deps, nodes: () => fleet.nodes, seatHosts: () => fleet.hosts, seats: () => fleet.seats,
    accounts: () => fleet.accounts.map((a) => account(a.usage?.windows[0]?.used_pct ?? 10)), agents: () => [] }, () => true);
  expect(summariesOn(bea.core)).toBe(before);
  expect(scanned).toBe(0);
  // Other poll reads use json_extract too. A valid newest marker is one prefix query, and it stops at that row.
  expect(queries).toHaveLength(1);
  expect(queries[0]?.sql).toContain("LIKE");
  expect(queries[0]?.sql).toContain("LIMIT ?");
  expect(queries[0]?.args[3]).toBe(1);
  expect(queries[0]?.args.some((arg) => arg === `${PREFIX}%`)).toBe(true);
});

test("a one-seat flap posts at most a few summaries in a day, for the probe and the neighbouring caps", async () => {
  const cases = [
    { name: "probe max 3, 3<->2", max: 3, steady: 0 },
    { name: "default cap 3, 2<->1", max: 3, steady: 1 },
    { name: "cap 4, 4<->3", max: 4, steady: 0 },
    { name: "cap 5, 4<->3", max: 5, steady: 1 },
    { name: "cap 6, 4<->3", max: 6, steady: 2 },
    { name: "cap 8, 4<->3", max: 8, steady: 4 },
  ];
  for (const cfg of cases) {
    for (const pattern of ["hourly", "every-poll"] as const) {
      const { t, fleet, run, posts, summaries } = setup();
      const steady = Array.from({ length: cfg.steady }, (_, i) => ({ id: `steady-${i}`, host: { node: NODE, hostname: "mac-a", handle: "maren" }, state: "running" }) as unknown as SeatView);
      const flap = { id: "flap", host: { node: NODE, hostname: "mac-a", handle: "maren" }, state: "running" } as unknown as SeatView;
      fleet.hosts = [host({ availability: { state: "available", max: cfg.max, running: 0 } })];
      if (pattern === "hourly") {
        for (let hour = 0; hour < 24; hour++) {
          fleet.seats = [...steady];
          await run();
          t.tick(5 * 60_000);
          fleet.seats = [...steady, flap];
          await run();
          t.tick(SUMMARY_COOLDOWN_MS - 5 * 60_000);
        }
      } else {
        for (let i = 0; i < 288; i++) {
          fleet.seats = i % 2 ? [...steady, flap] : [...steady];
          await run();
          t.tick(5 * 60_000);
        }
      }
      const n = [...summaries(), ...posts("general")].filter((p) => p.text.startsWith("WalkieTalkie fleet capacity")).length;
      expect(n, `${cfg.name} ${pattern}`).toBeGreaterThan(0);
      expect(n, `${cfg.name} ${pattern} posted ${n}`).toBeLessThanOrEqual(3);
      expect(posts("general").filter((p) => p.text.includes("WalkieTalkie fleet capacity"))).toEqual([]);
    }
  }
}, 120_000);

test("a host whose seats channel the lead is not on is listed as seats hidden, with no score", async () => {
  const { fleet, run, posts, summaries } = setup();
  fleet.hosts = [host({ member: false, availability: undefined })];
  await run();
  const line = summaries().map((p) => p.text).join("\n").split("\n").find((text) => text.startsWith("mac-a:"));
  expect(line).toBe("mac-a: seats hidden");
  expect(line).not.toContain("score");
  expect(line).not.toContain("free");
  expect(posts("general").filter((p) => p.text.includes("WalkieTalkie fleet capacity"))).toEqual([]);
});

function hostLine(texts: readonly { text: string }[]): string | undefined {
  return texts.map((p) => p.text).join("\n").split("\n").find((text) => text.startsWith("mac-a:"));
}

test("a hidden host limited by CPU or memory is seats hidden, with the limit and no count or score", async () => {
  const cpu = setup();
  cpu.fleet.hosts = [host({ member: false })];
  cpu.fleet.nodes = [node({ stats: busy(95) })];
  await cpu.run();
  const cpuLine = hostLine(cpu.summaries());
  expect(cpuLine).toBe("mac-a: seats hidden, limited by CPU");
  expect(cpuLine).not.toContain("score");
  expect(cpuLine).not.toContain("free");
  const cpuMarker = cpu.posts(SCHEDULE_CHANNEL).find((p) => p.text.startsWith(PREFIX));
  const cpuBody = JSON.parse(cpuMarker!.text.slice(PREFIX.length)) as { machines: { factor: string; seats_hidden?: boolean; free_slots: number; score: number }[] };
  expect(cpuBody.machines[0]).toMatchObject({ node: NODE, factor: "cpu", seats_hidden: true, free_slots: 0, score: 0 });

  const memory = setup();
  memory.fleet.hosts = [host({ member: false })];
  memory.fleet.nodes = [node({ stats: { at: Date.now(), mem: { total: 16 * GIB, used: 14 * GIB, free: GIB, swap_used: 0, pressure: "normal" }, temp_c: null,
    sys: { os: "linux", arch: "x64", cpus: 8, load1: 0.5, cpu_busy_pct: 10 } } })];
  await memory.run();
  expect(hostLine(memory.summaries())).toBe("mac-a: seats hidden, limited by memory");
  const memoryMarker = memory.posts(SCHEDULE_CHANNEL).find((p) => p.text.startsWith(PREFIX));
  const memoryBody = JSON.parse(memoryMarker!.text.slice(PREFIX.length)) as { machines: { factor: string; seats_hidden?: boolean }[] };
  expect(memoryBody.machines[0]).toMatchObject({ factor: "memory", seats_hidden: true });
});

test("a member limited by CPU still shows the free-seat count and the score", async () => {
  const { fleet, run, summaries } = setup();
  fleet.nodes = [node({ stats: busy(95) })];
  await run();
  const line = hostLine(summaries());
  expect(line).toContain("limited by CPU");
  expect(line).toContain("score");
  expect(line).toContain("free");
  expect(line).not.toContain("seats hidden");
});

/** Runs `fn` with Date.now (core clock, event ts, received_at) `slowMs` behind this world's wall, then puts the wall back. */
async function whileSlow<T>(t: { wall: () => number }, slowMs: number, fn: () => Promise<T> | T): Promise<T> {
  setSystemTime(new Date(t.wall() - slowMs));
  try { return await fn(); } finally { setSystemTime(new Date(t.wall())); }
}

async function slowReaderDoesNotRepost(slowMs: number): Promise<void> {
  const { t, deps } = setup();
  const olive = t.person("olive", "owner");
  t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "olive"] });
  await prepareOrchestrationPoll(deps, () => true);
  const alex = lastPostedSummary(t.core);
  expect(alex).not.toBeNull();
  await whileSlow(t, slowMs, () => { olive.mirror(); });
  const before = summariesOn(olive.core);
  expect(before).toBe(1);
  t.tick(2 * H);
  const again = await whileSlow(t, slowMs, () => prepareOrchestrationPoll({ ...deps, core: olive.core, idx: olive.idx }, () => true));
  expect((again as { skip: string }).skip).not.toContain(POSTED);
  expect(summariesOn(olive.core)).toBe(before);
  expect(lastPostedSummary(olive.core)?.fingerprint).toBe(alex?.fingerprint);
  expect(lastPostedSummary(olive.core)?.at).toBe(alex?.at);
}

test("a reader 2 minutes slow does not post a picture another lead already posted", async () => {
  await slowReaderDoesNotRepost(2 * 60_000);
});

test("a reader 9 minutes slow does not post a picture another lead already posted", async () => {
  await slowReaderDoesNotRepost(9 * 60_000);
});

test("a reader 2 minutes slow, with an older local copy, does not post the newer picture again", async () => {
  const { t, fleet, deps } = setup();
  const olive = t.person("olive", "owner");
  t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "olive"] });
  olive.mirror();
  await prepareOrchestrationPoll({ ...deps, core: olive.core, idx: olive.idx }, () => true);
  olive.push();
  t.tick(2 * H);
  fleet.hosts = [host({ availability: { state: "available", max: 1, running: 0 } })];
  await prepareOrchestrationPoll(deps, () => true);
  const alex = lastPostedSummary(t.core);
  await whileSlow(t, 2 * 60_000, () => { olive.mirror(); });
  const before = summariesOn(olive.core);
  expect(before).toBe(2);
  t.tick(2 * H);
  const again = await whileSlow(t, 2 * 60_000, () => prepareOrchestrationPoll({ ...deps, core: olive.core, idx: olive.idx }, () => true));
  expect((again as { skip: string }).skip).not.toContain(POSTED);
  expect(summariesOn(olive.core)).toBe(before);
  expect(lastPostedSummary(olive.core)?.fingerprint).toBe(alex?.fingerprint);
  expect(lastPostedSummary(olive.core)?.at).toBe(alex?.at);
});

test("a lead whose own clock ran 20 hours fast posts again once that clock is corrected", async () => {
  const { t, fleet, run } = setup();
  const wall = t.wall();
  setSystemTime(new Date(wall + 20 * H));
  try {
    const first = await run();
    expect((first as { skip: string }).skip).toContain(POSTED);
  } finally {
    setSystemTime(new Date(wall));
  }
  // The marker and the local copy were both stamped by the fast clock. Receipt matches the stamp, and the clock no longer does.
  expect(lastPostedSummary(t.core)).toBeNull();
  t.tick(H + 60_000);
  fleet.nodes = [node({ online: false })];
  const again = await run();
  expect((again as { skip: string }).skip).toContain(POSTED);
});

test("a lead whose clock is 20 hours fast does not stop another lead posting a real change", async () => {
  const { t, fleet, deps, run } = setup();
  const olive = t.person("olive", "owner");
  t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "olive"] });
  olive.mirror();
  await run();
  olive.mirror();
  t.tick(2 * H);
  fleet.seats = [0, 1, 2].map((i) => ({ id: `s${i}`, host: { node: NODE, hostname: "mac-a", handle: "maren" }, state: "running" }) as unknown as SeatView);
  await prepareOrchestrationPoll({ ...deps, core: olive.core, idx: olive.idx, now: () => Date.now() + 20 * H }, () => true);
  olive.push();
  t.tick(H);
  fleet.nodes = [node({ online: false })];
  fleet.seats = [];
  const again = await run();
  expect((again as { skip: string }).skip).toContain(POSTED);
});

test("an unreadable newer marker does not make a lead with no local copy post the same picture again", async () => {
  const { t, deps, run } = setup();
  const olive = t.person("olive", "owner");
  t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "olive"] });
  olive.mirror();
  await run();
  t.tick(60_000);
  t.core.emit("msg.post", { text: PREFIX + "{not json" }, { channel: SCHEDULE_CHANNEL });
  olive.mirror();
  const before = olive.core.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 50 }).flatMap((row) => {
    const text = (JSON.parse(row.json) as { body?: { text?: string } }).body?.text;
    return typeof text === "string" && text.startsWith("WalkieTalkie fleet capacity") ? [text] : [];
  }).length;
  expect(before).toBe(1);
  t.tick(2 * H);
  await prepareOrchestrationPoll({ ...deps, core: olive.core, idx: olive.idx }, () => true);
  const after = olive.core.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 50 }).flatMap((row) => {
    const text = (JSON.parse(row.json) as { body?: { text?: string } }).body?.text;
    return typeof text === "string" && text.startsWith("WalkieTalkie fleet capacity") ? [text] : [];
  }).length;
  expect(after).toBe(before);
});

test("a poll reads the posted picture once", async () => {
  const { t, run } = setup();
  const orig = t.core.store.queryEvents.bind(t.core.store);
  let scheduleReads = 0;
  t.core.store.queryEvents = (filter) => {
    if (filter.channel === SCHEDULE_CHANNEL) scheduleReads++;
    return orig(filter);
  };
  await run();
  expect(scheduleReads).toBeLessThanOrEqual(1);
  scheduleReads = 0;
  t.tick(60_000);
  await run();
  expect(scheduleReads).toBe(0);
});

function busy(cpu: number): unknown {
  return { at: Date.now(), mem: { total: 16 * GIB, used: 4 * GIB, free: 8 * GIB, swap_used: 0, pressure: "normal" }, temp_c: null,
    sys: { os: "linux", arch: "x64", cpus: 8, load1: 0.5, cpu_busy_pct: cpu } };
}

function summariesOn(core: Core): number {
  const rows = core.store.db.query<{ json: string }, [string]>(
    "SELECT json FROM events WHERE channel = ? AND kind = 'msg.post' AND redacted = 0 AND status = 'ok'").all(SCHEDULE_CHANNEL);
  return rows.flatMap((row) => {
    const text = (JSON.parse(row.json) as { body?: { text?: string } }).body?.text;
    return typeof text === "string" && text.startsWith("WalkieTalkie fleet capacity") ? [text] : [];
  }).length;
}

function postsOf(t: ReturnType<typeof recsWorld>): number {
  return postsOfChannel(t, SCHEDULE_CHANNEL);
}

function postsOfChannel(t: ReturnType<typeof recsWorld>, channel: string): number {
  return t.core.store.queryEvents({ channel, kinds: ["msg.post"], limit: 100 }).length;
}

test("no fleet summary is posted while someone who is no longer an owner can still read the schedule channel (Codex pre.13 audit)", async () => {
  const { t, run, summaries } = setup();
  t.person("noor", "member"); // demoted from owner, still listed until the channel's membership is repaired
  t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "noor"] });
  await run();
  expect(summaries()).toHaveLength(0);
  // Once the channel holds only owners again, the summary goes out.
  t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex"] });
  await run();
  expect(summaries()).toHaveLength(1);
});
