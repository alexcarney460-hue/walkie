// "I'm using this computer" (PROTOCOL §11, busy): which seats pause (newest first) and continue (oldest first), which
// queued launches start, a time limit that doesn't run while paused, `--for` durations, the host post, a queued
// launch re-judged without its age, and a host's availability taken only from that host's own daemon.
import { afterEach, describe, expect, test } from "bun:test";
import { SeatLimit, parseDuration, planPauses, planStarts } from "../../src/daemon/seats/busy.ts";
import { decideRun, parseLaunchers, type SeatsPolicy } from "../../src/daemon/seats/rules.ts";
import { hostAvailability } from "../../src/daemon/seats/view.ts";
import { hostText, seatOf, seatsChannel, stateText, type SeatRun } from "../../src/protocol/seats.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const s = (id: string, order: number) => ({ id, order });

describe("pausing and continuing seats", () => {
  test("above the limit the newest running seats pause, newest first", () => {
    const active = [s("b", 2), s("a", 1), s("c", 3)];
    expect(planPauses(active, [], 1)).toEqual({ pause: ["c", "b"], resume: [] });
    expect(planPauses(active, [], 0)).toEqual({ pause: ["c", "b", "a"], resume: [] });
    expect(planPauses(active, [], 3)).toEqual({ pause: [], resume: [] });
  });

  test("below the limit the oldest paused seats continue, oldest first; not busy (Infinity) continues all", () => {
    const paused = [s("c", 3), s("a", 1), s("b", 2)];
    expect(planPauses([], paused, 2)).toEqual({ pause: [], resume: ["a", "b"] });
    expect(planPauses([s("d", 4)], paused, 2)).toEqual({ pause: [], resume: ["a"] });
    expect(planPauses([], paused, Infinity)).toEqual({ pause: [], resume: ["a", "b", "c"] });
    expect(planPauses([], paused, 0)).toEqual({ pause: [], resume: [] });
  });
});

describe("starting queued launches", () => {
  const q = (id: string, launcher: string, maxConcurrent = 9) => ({ id, launcher, maxConcurrent });
  const counts = (active: number, total: number, byLauncher: Record<string, number> = {}) => ({ active, total, byLauncher: new Map(Object.entries(byLauncher)) });

  test("in queue order, while under the busy limit and the host's max", () => {
    const queue = [q("1", "alex"), q("2", "kira"), q("3", "alex")];
    expect(planStarts(queue, counts(0, 0), Infinity, 3)).toEqual(["1", "2", "3"]);
    expect(planStarts(queue, counts(0, 0), 0, 3)).toEqual([]); // still busy with limit 0: nothing starts
    expect(planStarts(queue, counts(1, 1), 2, 3)).toEqual(["1"]);
    expect(planStarts(queue, counts(0, 2), Infinity, 3)).toEqual(["1"]); // paused seats count against the host's max
  });

  test("a launcher at its own cap is skipped, the ones behind it may start", () => {
    const queue = [q("1", "alex", 1), q("2", "kira"), q("3", "alex", 1)];
    expect(planStarts(queue, counts(1, 1, { alex: 1 }), Infinity, 5)).toEqual(["2"]);
    expect(planStarts(queue, counts(0, 0), Infinity, 5)).toEqual(["1", "2"]); // the second alex waits for the first
  });
});

describe("a time limit that doesn't run while paused", () => {
  test("pause keeps what is left; start continues with it", () => {
    const l = new SeatLimit(10_000);
    expect(l.start(1_000)).toBe(10_000);
    expect(l.remaining(4_000)).toBe(7_000);
    expect(l.pause(4_000)).toBe(7_000);
    expect(l.running).toBe(false);
    expect(l.remaining(100_000)).toBe(7_000); // paused for a long time: nothing used
    expect(l.start(100_000)).toBe(7_000);
    expect(l.remaining(106_000)).toBe(1_000);
    expect(l.pause(200_000)).toBe(0); // past its end: nothing left, never negative
  });

  test("pausing a limit that never started keeps the whole limit (a seat paused while preparing)", () => {
    const l = new SeatLimit(60_000);
    expect(l.pause(5_000)).toBe(60_000);
    expect(l.start(9_000)).toBe(60_000);
  });
});

describe("--for durations", () => {
  test("h/m/s and plain minutes", () => {
    expect(parseDuration("2h")).toBe(7_200);
    expect(parseDuration("30m")).toBe(1_800);
    expect(parseDuration("90s")).toBe(90);
    expect(parseDuration("1h30m")).toBe(5_400);
    expect(parseDuration("45")).toBe(2_700);
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("2 hours")).toBeNull();
    expect(parseDuration("-5m")).toBeNull();
  });
});

describe("the host post", () => {
  test("seatOf accepts a well-formed host post only", () => {
    const busy = { op: "host", v: 1, state: "busy", max: 1, running: 1, paused: 2, queued: 0, by: "arvid", since: 1, until: 2 };
    expect(seatOf({ text: "x", seat: busy })).toEqual(busy as never);
    expect(seatOf({ text: "x", seat: { op: "host", v: 1, state: "available" } })).not.toBeNull();
    expect(seatOf({ text: "x", seat: { ...busy, state: "away" } })).toBeNull();
    expect(seatOf({ text: "x", seat: { ...busy, max: -1 } })).toBeNull();
    expect(seatOf({ text: "x", seat: { ...busy, run: "x" } })).toBeNull();
  });

  test("texts say who is using it, the limit and the counts, and the time in UTC", () => {
    const until = Date.UTC(2026, 8, 26, 15, 40);
    const text = hostText({ state: "busy", max: 1, running: 1, paused: 2, queued: 3, by: "arvid", until }, "arvid-mac");
    expect(text).toBe("arvid-mac is busy: @arvid is using it · limit 1 · 1 running · 2 paused · 3 queued until 15:40 UTC. New seats queue here meanwhile.");
    expect(hostText({ state: "available" }, "arvid-mac")).toBe("arvid-mac is available for seats again");
    expect(stateText({ op: "state", v: 1, seat: "0123456789abcdef:1", state: "queued", reason: "host busy", until })).toBe("Seat queued: host busy · until 15:40 UTC");
  });
});

/**
 * alex (owner) + arvid (member, the host arvid-mac) + kira (member); the seats channel [arvid, alex], plus kira when
 * the store is kira's (a launcher reading arvid-mac's availability).
 */
function team(self: "kira" | "arvid" = "arvid") {
  const alex = tnode("alex");
  const arvid = tnode("arvid", "arvid@example.com", "arvid-mac");
  const kira = tnode("kira");
  const { team: id, create } = createTeam(alex);
  const core = makeCore(self === "kira" ? kira : arvid, id, cleanups);
  const channel = seatsChannel(arvid.keys.nodeId);
  feed(core, [
    create, memberEv(id, alex, arvid, "member"), memberEv(id, alex, kira, "member"), nodeEv(id, alex, arvid), nodeEv(id, alex, kira),
    ev(id, alex, "channel.upsert", { name: channel, members: self === "kira" ? ["arvid", "alex", "kira"] : ["arvid", "alex"], seats: true }),
  ]);
  return { id, core, alex, arvid, kira, channel };
}

describe("queued launches and availability", () => {
  const RUN: SeatRun = { op: "run", v: 1, runtime: "codex", prompt: "go", timeout_s: 600, max_concurrent: 9 };
  const POLICY: SeatsPolicy = { allow: true, launchers: null, runtimes: ["claude", "codex"] };

  test("a queued launch is re-judged without its age, but everything else is judged again", () => {
    const t = team();
    const req = ev(t.id, t.alex, "msg.post", { text: "go", seat: RUN } as never, { channel: t.channel });
    const later = { roster: t.core.roster, node: t.arvid.keys.nodeId, me: "arvid", policy: POLICY, now: req.ts + 3 * 3_600_000, maxAgeMs: 10 * 60_000 };
    expect(decideRun(req, later)).toMatchObject({ ok: false, reason: "stale" });
    expect(decideRun(req, { ...later, queued: true })?.ok).toBe(true);
    // The host narrowed its launchers while the launch waited: it doesn't start.
    expect(decideRun(req, { ...later, queued: true, policy: { ...POLICY, launchers: parseLaunchers(["@alex/alex-studio"]) } })).toMatchObject({ ok: false, reason: "not_a_launcher" });
    expect(decideRun(req, { ...later, queued: true, policy: { ...POLICY, allow: false } })).toMatchObject({ ok: false, reason: "seats_not_allowed" });
  });

  test("a host's availability comes only from its own daemon's host post, and only for its channel's members", () => {
    const t = team("kira");
    const busy = { op: "host", v: 1, state: "busy", max: 0, running: 0, paused: 1, queued: 0, by: "arvid", since: now() };
    // alex (a launcher) posting a host post in arvid's channel, even as agent `seats`, says nothing about arvid-mac.
    feed(t.core, [ev(t.id, t.alex, "msg.post", { text: "fake", seat: { ...busy, state: "available" } } as never, { channel: t.channel, agent: "seats" })]);
    expect(hostAvailability(t.core, t.arvid.keys.nodeId)).toBeUndefined();
    feed(t.core, [ev(t.id, t.arvid, "msg.post", { text: "busy", seat: busy } as never, { channel: t.channel, agent: "seats" })]);
    expect(hostAvailability(t.core, t.arvid.keys.nodeId)).toMatchObject({ state: "busy", max: 0, paused: 1, by: "arvid" });
    // A post by the host's person (not its daemon) doesn't count either.
    feed(t.core, [ev(t.id, t.arvid, "msg.post", { text: "free", seat: { op: "host", v: 1, state: "available" } } as never, { channel: t.channel })]);
    expect(hostAvailability(t.core, t.arvid.keys.nodeId)?.state).toBe("busy");
    feed(t.core, [ev(t.id, t.arvid, "msg.post", { text: "free", seat: { op: "host", v: 1, state: "available" } } as never, { channel: t.channel, agent: "seats" })]);
    expect(hostAvailability(t.core, t.arvid.keys.nodeId)).toEqual({ state: "available" });
  });
});
