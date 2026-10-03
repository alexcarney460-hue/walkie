// TALKIE-OPS-1, the orchestration poll's pure part: how much a machine can take now (seat slots within its caps, memory and CPU
// headroom, accounts with the 10% reserve) and which waiting work goes to which free slot, as recommendations in plain English.
import { describe, expect, test } from "bun:test";
import {
  CPU_BUSY_MAX_PCT, FREE_MEM_MIN_BYTES, PER_PROJECT_CAP, machineCapacity, planPoll, usableRuntimes,
  type PollMachine, type WaitingWork,
} from "../../src/daemon/orchestrator/poll-plan.ts";
import { REC_TTL_MS, RecCreate, recKey } from "../../src/protocol/talkie-recs.ts";
import type { AccountUsage, AccountView } from "../../src/protocol/accounts.ts";

const NOW = Date.UTC(2026, 9, 1, 12, 0);
const H = 3_600_000;
const GIB = 1024 ** 3;
const node = (n: number) => `${String(n).padStart(16, "0")}`;
const cardId = (n: number) => `${"abcdef0123456789"}:${n}`;

const machine = (name: string, over: Partial<PollMachine> = {}): PollMachine => ({
  node: node(name.length * 7), hostname: name, handle: "maren", online: true,
  seats: { allows: true, max: 4, active: 1 }, mem: { pressure: "normal", free: 8 * GIB }, cpuBusyPct: 20, runtimes: ["claude", "codex"], ...over,
});
const work = (n: number, role: "build" | "review", over: Partial<WaitingWork> = {}): WaitingWork => ({
  card: cardId(n), channel: "p-0a1b2c3d", project: "Website", prefixes: ["WEB"], title: `Card ${n}`, role, since: NOW - 5 * H,
  audience: "team", builderRuntime: null, ...over,
});

describe("what a machine can take now", () => {
  test("its free seats are its limit less what runs, pauses and queues there", () => {
    expect(machineCapacity(machine("mac-a", { seats: { allows: true, max: 4, active: 1 } }))).toMatchObject({ slots: 3, why: null });
    expect(machineCapacity(machine("mac-a", { seats: { allows: true, max: 2, active: 2 } }))).toMatchObject({ slots: 0, why: "all 2 seats are in use" });
    expect(machineCapacity(machine("mac-a", { seats: { allows: true, max: 1, active: 3 } }))).toMatchObject({ slots: 0, why: "its only seat is in use" });
  });

  test("an offline machine, one whose seats are off and one that never said how many take none, and say why", () => {
    expect(machineCapacity(machine("mac-a", { online: false }))).toMatchObject({ slots: 0, why: "it is offline" });
    expect(machineCapacity(machine("mac-a", { seats: { allows: false, max: 4, active: 0 } }))).toMatchObject({ slots: 0, why: "its seats are turned off" });
    expect(machineCapacity(machine("mac-a", { seats: null }))).toMatchObject({ slots: 0, why: "it has not said how many seats it takes" });
    expect(machineCapacity(machine("mac-a", { seats: { allows: true, max: null, active: 0 } }))).toMatchObject({ slots: 0, why: "it has not said how many seats it takes" });
  });

  test("memory and CPU headroom: pressure, under 2 GB free, or a busy processor hold work back; a missing reading does not", () => {
    expect(machineCapacity(machine("mac-a", { mem: { pressure: "warn", free: 8 * GIB } }))).toMatchObject({ slots: 0, why: "its memory is under pressure" });
    expect(machineCapacity(machine("mac-a", { mem: { pressure: "critical", free: null } })).slots).toBe(0);
    expect(machineCapacity(machine("mac-a", { mem: { pressure: "normal", free: FREE_MEM_MIN_BYTES - 1 } }))).toMatchObject({ slots: 0, why: "less than 2 GB of memory is free" });
    expect(machineCapacity(machine("mac-a", { mem: { pressure: "normal", free: FREE_MEM_MIN_BYTES } })).slots).toBe(3);
    expect(machineCapacity(machine("mac-a", { cpuBusyPct: CPU_BUSY_MAX_PCT + 1 }))).toMatchObject({ slots: 0, why: "its processor is busy" });
    expect(machineCapacity(machine("mac-a", { cpuBusyPct: CPU_BUSY_MAX_PCT })).slots).toBe(3);
    expect(machineCapacity(machine("mac-a", { mem: null, cpuBusyPct: null })).slots).toBe(3);
  });

  test("with no account that has room past the reserve, there is nothing to run on", () => {
    expect(machineCapacity(machine("mac-a", { runtimes: [] }))).toMatchObject({ slots: 3, usable: false, why: "no account has room beyond the 10% reserve" });
    expect(machineCapacity(machine("mac-a"))).toMatchObject({ slots: 3, usable: true });
  });
});

const usage = (windows: Array<[string, number]>, over: Partial<AccountUsage> = {}): AccountUsage => ({
  at: NOW - 60_000, state: "ok", reason: null, source: "api", until: null,
  windows: windows.map(([kind, used]) => ({ kind: kind as "session" | "weekly", scope: null, used_pct: used, resets_at: NOW + 3 * H, window_s: null })), ...over,
}) as AccountUsage;
const account = (provider: string, u: AccountUsage | null, nodeId = node(1), online = true): AccountView => ({
  key: `maren:${provider}`, id: provider, provider, label: provider, plan: null, owners: ["maren"], claimed_by: [],
  machines: [{ node_id: nodeId, hostname: "mac-a", handle: "maren", online, self: false, agents: [], usage: u }], usage: u, usage_host: "mac-a", last_seen: NOW,
}) as unknown as AccountView;

describe("which runtimes a machine can run on", () => {
  test("an account on that machine with a fresh reading and more than 10% left past the reserve counts, the roomiest first", () => {
    const accounts = [account("codex", usage([["session", 20], ["weekly", 50]])), account("claude", usage([["session", 10], ["weekly", 30]]))];
    expect(usableRuntimes(accounts, node(1), NOW)).toEqual(["claude", "codex"]);
  });

  test("the last 10% is the reserve: an account at 90% or more used is not usable, at 89% it is", () => {
    expect(usableRuntimes([account("claude", usage([["session", 90]]))], node(1), NOW)).toEqual([]);
    expect(usableRuntimes([account("claude", usage([["session", 89]]))], node(1), NOW)).toEqual(["claude"]);
  });

  test("a stale, unknown or exhausted reading, another machine's account and an offline machine are not usable", () => {
    expect(usableRuntimes([account("claude", usage([["session", 10]], { at: NOW - 2 * H }))], node(1), NOW)).toEqual([]);
    expect(usableRuntimes([account("claude", null)], node(1), NOW)).toEqual([]);
    expect(usableRuntimes([account("claude", usage([], { state: "unknown" }))], node(1), NOW)).toEqual([]);
    expect(usableRuntimes([account("claude", usage([["session", 10]], { state: "exhausted" }))], node(1), NOW)).toEqual([]);
    expect(usableRuntimes([account("claude", usage([["session", 10]]))], node(2), NOW)).toEqual([]);
    expect(usableRuntimes([account("claude", usage([["session", 10]]), node(1), false)], node(1), NOW)).toEqual([]);
  });

  test("only the runtimes a plain seat request carries are offered: an account for another is not a seat to recommend", () => {
    const accounts = [account("kimi", usage([["session", 5]])), account("grok", usage([["session", 5]])), account("codex", usage([["session", 30]]))];
    expect(usableRuntimes(accounts, node(1), NOW)).toEqual(["codex"]);
  });

  test("a runtime is listed once however many accounts it has", () => {
    const accounts = [account("claude", usage([["session", 10]])), { ...account("claude", usage([["session", 40]])), key: "maren:claude-2" }];
    expect(usableRuntimes(accounts, node(1), NOW)).toEqual(["claude"]);
  });
});

describe("which waiting work goes to which free seat", () => {
  test("reviews first, then builds, each oldest first, one free seat each; what does not fit is counted", () => {
    const m = machine("mac-a", { seats: { allows: true, max: 3, active: 0 } });
    const r = planPoll({ machines: [m], now: NOW, waiting: [
      work(1, "build", { since: NOW - 9 * H }), work(2, "review", { since: NOW - 2 * H }), work(3, "build", { since: NOW - 20 * H }), work(4, "review", { since: NOW - 6 * H }),
    ] });
    expect(r.recs.map((x) => (x.action as { card: string; role: string }).card)).toEqual([cardId(4), cardId(2), cardId(3)]);
    expect(r.recs.map((x) => (x.action as { role: string }).role)).toEqual(["reviewer", "reviewer", "builder"]);
    expect(r.unplaced).toBe(1);
  });

  test("each goes to the machine with the most free seats left, ties by name, and the slots run down as they are used", () => {
    const a = machine("mac-a", { seats: { allows: true, max: 2, active: 0 } });
    const b = machine("mac-bb", { seats: { allows: true, max: 3, active: 0 } });
    const r = planPoll({ machines: [a, b], now: NOW, waiting: [1, 2, 3, 4, 5].map((n) => work(n, "build", { channel: `p-0000000${n}` })) });
    expect(r.recs.map((x) => (x.action as { machine: string }).machine)).toEqual([b.node, a.node, b.node, a.node, b.node]);
    expect(r.unplaced).toBe(0);
  });

  test("a machine with no seat free or no usable account is passed over and reported with its reason", () => {
    const full = machine("mac-a", { seats: { allows: true, max: 1, active: 1 } });
    const poor = machine("mac-bb", { runtimes: [] });
    const r = planPoll({ machines: [full, poor], now: NOW, waiting: [work(1, "build")] });
    expect(r.recs).toEqual([]);
    expect(r.unplaced).toBe(1);
    expect(r.machines).toEqual([
      { node: full.node, hostname: "mac-a", slots: 0, why: "its only seat is in use" },
      { node: poor.node, hostname: "mac-bb", slots: 3, why: "no account has room beyond the 10% reserve" },
    ]);
  });

  test("a builder gets the machine's best runtime; a reviewer prefers a different one from the builder's", () => {
    const m = machine("mac-a", { runtimes: ["claude", "codex"] });
    const r = planPoll({ machines: [m], now: NOW, waiting: [work(1, "build"), work(2, "review", { builderRuntime: "claude" }), work(3, "review", { builderRuntime: "kimi" })] });
    const by = Object.fromEntries(r.recs.map((x) => [(x.action as { card: string }).card, (x.action as { runtime: string }).runtime]));
    expect(by[cardId(1)]).toBe("claude");
    expect(by[cardId(2)]).toBe("codex");
    expect(by[cardId(3)]).toBe("claude");
    const only = planPoll({ machines: [machine("mac-a", { runtimes: ["claude"] })], now: NOW, waiting: [work(2, "review", { builderRuntime: "claude" })] });
    expect((only.recs[0]?.action as { runtime: string }).runtime).toBe("claude");
  });

  test("at most three of each kind a project per run, so one busy project does not take every seat", () => {
    const m = machine("mac-a", { seats: { allows: true, max: 20, active: 0 } });
    const many = Array.from({ length: 6 }, (_, i) => work(i + 1, "build"));
    const other = work(9, "build", { channel: "p-ffffffff", project: "Ops" });
    const r = planPoll({ machines: [m], now: NOW, waiting: [...many, other] });
    expect(PER_PROJECT_CAP).toBe(3);
    expect(r.recs).toHaveLength(4);
    expect(r.unplaced).toBe(3);
  });

  test("the same input in any order gives the same recommendations", () => {
    const machines = [machine("mac-a"), machine("mac-bb", { seats: { allows: true, max: 5, active: 0 } })];
    const waiting = [work(1, "build"), work(2, "review"), work(3, "build", { since: NOW - 30 * H })];
    const a = planPoll({ machines, now: NOW, waiting });
    const b = planPoll({ machines: [...machines].reverse(), now: NOW, waiting: [...waiting].reverse() });
    expect(b.recs).toEqual(a.recs);
  });
});

describe("a recommendation in plain English", () => {
  test("it is valid, keyed by the card and the role, names no card key, and says how long it has waited", () => {
    const m = machine("mac-a");
    const r = planPoll({ machines: [m], now: NOW, waiting: [work(1, "build", { title: "WEB-12 Fix the login page", since: NOW - 5 * H }), work(2, "review", { since: NOW - 30 * 60_000 })] });
    const [review, build] = [r.recs[0], r.recs[1]];
    for (const rec of r.recs) expect(RecCreate.safeParse({ v: 1, op: "create", ...rec }).success).toBe(true);
    expect(review).toMatchObject({ key: recKey.seat(cardId(2), "reviewer"), group: "reviews", source: "poll", audience: "team", ttl_ms: REC_TTL_MS });
    // The machine is chosen again when a person approves it, so the sentence names the card and the role, not the machine.
    expect(build).toMatchObject({ key: recKey.seat(cardId(1), "builder"), group: "work", summary: "Start a builder for “Fix the login page”" });
    expect(build?.reason).toBe("A machine has a free seat and the work has waited 5 hours.");
    expect(review?.summary).toBe("Start a reviewer for “Card 2”");
    expect(review?.reason).toBe("It has waited less than an hour for review and a machine has a free seat.");
    for (const rec of r.recs) expect(`${rec.summary} ${rec.reason}`).not.toMatch(/WEB-\d|[0-9a-f]{16}:\d/);
    expect(build?.evidence).toEqual(expect.arrayContaining([expect.stringContaining("when recommended, mac-a had 3 free seats of 4")]));
  });

  test("an owners-only card or project is recommended to the owners and says which project in the record", () => {
    const m = machine("mac-a");
    const r = planPoll({ machines: [m], now: NOW, waiting: [work(1, "build", { audience: "owners" })] });
    expect(r.recs[0]).toMatchObject({ audience: "owners", project: "p-0a1b2c3d" });
  });

  test("an hour reads as an hour, a day as days", () => {
    const m = machine("mac-a", { seats: { allows: true, max: 9, active: 0 } });
    const r = planPoll({ machines: [m], now: NOW, waiting: [work(1, "build", { since: NOW - H }), work(2, "build", { since: NOW - 50 * H, channel: "p-ffffffff" })] });
    expect(r.recs.map((x) => x.reason)).toEqual(["A machine has a free seat and the work has waited 2 days.", "A machine has a free seat and the work has waited 1 hour."]);
  });
});
