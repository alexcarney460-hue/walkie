import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSeatUser, destroySeatUser, pendingSeatUsers } from "../../src/daemon/seats/admin.ts";
import { stopMacSeatServices } from "../../src/daemon/seats/admin-sys.ts";
import { SeatsHost } from "../../src/daemon/seats/host.ts";
import { seatAgentName } from "../../src/protocol/seats.ts";
import { CleanupQueue } from "../../src/daemon/seats/cleanup-queue.ts";
import { Ledger } from "../../src/daemon/seats/admin-ledger.ts";
import { quarantineLines, retiredResidueLine } from "../../src/cli/commands/seats.ts";
import { doctorChecks } from "../../src/daemon/seats/doctor.ts";
import type { SeatsLocalView } from "../../src/protocol/seats.ts";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("helper distinguishes idle backlog from live and unknown process state", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".cleanup-backlog-"));
  dirs.push(dir);
  const world = fakeSeatWorld(dir, join(dir, "walkie-home"));
  expect((await createSeatUser(1, world.sys)).ok).toBe(true);
  expect((await createSeatUser(2, world.sys)).ok).toBe(true);
  const live = { ...world.sys, procs: (uid: number) => uid === 600_002 ? [{ pid: 42, stat: "S" }] : [] };
  expect(pendingSeatUsers(live)).toMatchObject({ ok: true, ids: [1, 2], idleIds: [1] });
  world.broken.add("destroy-files");
  expect(await destroySeatUser(1, world.sys)).toMatchObject({ ok: false, processesGone: true });
  expect(await destroySeatUser(2, { ...world.sys, procs: () => { throw new Error("ps failed"); } }))
    .toMatchObject({ ok: false });
});

test("destroy's internal deadline bounds a stuck fake sweep and releases its ledger claim", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".cleanup-deadline-"));
  dirs.push(dir);
  const world = fakeSeatWorld(dir, join(dir, "walkie-home"));
  expect((await createSeatUser(1, world.sys)).ok).toBe(true);
  let receivedTimeout = 0;
  world.sys.sweepAsUser = async (_name, _uid, _roots, _residue, timeoutMs) => {
    receivedTimeout = timeoutMs ?? 50;
    await Bun.sleep(receivedTimeout);
    return { ok: false, left: ["fake sweep did not finish"] };
  };
  const result = await destroySeatUser(1, world.sys, 15);
  expect(result.ok).toBe(false);
  expect(result.why).toContain("cleanup timed out; retried later");
  expect(receivedTimeout).toBeLessThanOrEqual(15);
  expect(world.sys.ledger().pending(501)).toContain(1);
});

test("doctor shows an overdue in-flight user and an unfinished outer-bound helper", () => {
  const local = { allow: true, ephemeral: true, quarantined: ["walkie-s1"],
    cleanup_in_flight: { user: 1, since: Date.now() - 61_000 }, cleanup_helper_unfinished_since: 1_000,
    claude_login: "machine", codex_login: "machine", channel_ok: true } as SeatsLocalView;
  const facts = { team: "test", release: false, runnerProblem: null, helper: "ok", rootsFile: "ok", runtimes: { claude: "/fake/claude", codex: "/fake/codex" } };
  const checks = doctorChecks(local, facts).map((check) => check.what).join("\n");
  expect(checks).toContain("walkie-s1 cleanup has been running");
  expect(checks).toContain("a cleanup helper did not finish (since");
  expect(quarantineLines(local).map(plain).join("\n")).toContain("walkie-s1");
});

test("repeated busy lock replies stay retryable and doctor names the running helper", async () => {
  const host = Object.create(SeatsHost.prototype) as Record<string, unknown>;
  Object.assign(host, { quarantine: new Set(["walkie-s1"]), quarantineWhy: new Map(), liveUsers: new Set([1]), recoveredIdle: new Set<number>(), runningLeftovers: new Set<string>(),
    seats: new Map(), closing: false, save: () => true, rebalance: () => undefined,
    log: { warn: () => undefined }, cleanupBusyAttempts: 0, cleanupBusySince: null,
    adminOp: async () => ({ ok: false, code: "busy", why: "busy: another cleanup helper is still running" }) });
  const destroy = host.destroyOnce as (n: number) => Promise<{ ok: boolean }>;
  expect((await destroy.call(host, 1)).ok).toBe(false);
  expect(host.cleanupBusySince).toBeNull();
  expect((await destroy.call(host, 1)).ok).toBe(false);
  expect(host.cleanupBusySince).toBeNumber();
  const local = { allow: true, ephemeral: true, channel_ok: true, claude_login: "machine", codex_login: "machine",
    cleanup_helper_busy_since: host.cleanupBusySince } as SeatsLocalView;
  const facts = { team: "test", release: false, runnerProblem: null, helper: "ok", rootsFile: "ok",
    runtimes: { claude: "/fake/claude", codex: "/fake/codex" } };
  expect(doctorChecks(local, facts).map((check) => check.what).join("\n")).toContain("a cleanup helper is still running");
});

test("a busy create releases its unreserved id without quarantining a seat slot", async () => {
  const host = Object.create(SeatsHost.prototype) as Record<string, unknown>;
  let destroys = 0;
  Object.assign(host, {
    userHigh: 0, liveUsers: new Set<number>(), quarantine: new Set<string>(), seats: new Map(),
    reconciled: true, reconcileError: null, helperReconciled: Promise.resolve(),
    startReconcile: () => undefined, save: () => true,
    adminOp: async () => ({ ok: false, code: "busy", why: "busy: another cleanup helper is still running" }),
    destroyUser: () => { destroys++; },
  });
  await expect((host.makeSeatUser as () => Promise<unknown>).call(host)).rejects.toThrow("busy");
  expect(host.liveUsers).toEqual(new Set());
  expect(host.quarantine).toEqual(new Set());
  expect((host.blockingQuarantine as () => number).call(host)).toBe(0);
  expect(destroys).toBe(0);
});


test("ledger finalization failures remain unverified even after complete cleanup", async () => {
  for (const failure of ["services", "schedules", "destroy-files", "account-enabled", "none"]) {
    const dir = mkdtempSync(join(import.meta.dir, `.cleanup-proof-${failure}-`));
    dirs.push(dir);
    const world = fakeSeatWorld(dir, join(dir, "walkie-home"));
    expect((await createSeatUser(1, world.sys)).ok).toBe(true);
    const ledger = world.sys.ledger();
    const finish = ledger.finish.bind(ledger);
    ledger.finish = ((n, op, state) => {
      if (state === "destroyed") throw new Error("ledger finalization failed");
      return finish(n, op, state);
    }) as typeof ledger.finish;
    if (failure === "account-enabled") world.sys.deleteUser = () => undefined;
    else if (failure !== "none") world.broken.add(failure);
    if (failure === "destroy-files") writeFileSync(join(world.outside, `${world.markers.get("walkie-s1")}-readable`), "leftover", { mode: 0o644 });
    const result = await destroySeatUser(1, world.sys);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("fileOnlyVerified");
  }
});

test("host counts every failed destroy until ok:true", async () => {
  const host = Object.create(SeatsHost.prototype) as Record<string, unknown>;
  const quarantine = new Set(["walkie-s1"]);
  let rebalanced = 0;
  Object.assign(host, {
    quarantine, quarantineWhy: new Map(),
    liveUsers: new Set([1]), recoveredIdle: new Set<number>(), runningLeftovers: new Set<string>(), seats: new Map(), closing: false, save: () => true, rebalance: () => { rebalanced++; },
    log: { warn: () => undefined },
    opts: {}, seatScope: () => ({ state: "own" }),
    keptSeats: new Map(), keptReady: new Set(), keptEnded: new Set(), keptStatePosted: new Set(),
    adminOp: async () => ({ ok: false, processesGone: true, why: "services remain" }),
  });
  await (host.destroyOnce as (n: number) => Promise<{ ok: boolean }>).call(host, 1);
  expect((host.blockingQuarantine as () => number).call(host)).toBe(1);
  host.adminOp = async () => ({ ok: false, why: "ledger finalization failed" });
  await (host.destroyOnce as (n: number) => Promise<{ ok: boolean }>).call(host, 1);
  expect((host.blockingQuarantine as () => number).call(host)).toBe(1);
  host.adminOp = async () => ({ ok: true });
  await (host.destroyOnce as (n: number) => Promise<{ ok: boolean }>).call(host, 1);
  expect((host.blockingQuarantine as () => number).call(host)).toBe(0);
  expect(rebalanced).toBe(1);
});

test("launchd domains must be checked absent after bootout", () => {
  const gone = { code: 113, out: "", err: "Could not find domain for" };
  const running = { code: 0, out: "service = running", err: "" };
  const exec = (argv: string[]) => argv[1] === "print" && argv[2] === "user/600001" ? running : gone;
  expect(stopMacSeatServices(600001, exec)).toContain("user/600001 remains loaded");
  expect(stopMacSeatServices(600001, () => gone)).toBeNull();
});

test("57 unverified quarantined users all hold slots", () => {
  const host = Object.create(SeatsHost.prototype) as Record<string, unknown>;
  host.current = { max: 2 };
  host.opts = {};
  host.core = { hostname: "fleet-mac" };
  host.quarantine = new Set(Array.from({ length: 57 }, (_, i) => `walkie-s${i + 1}`));
  host.seats = new Map([["running", { launcher: "alex" }]]);
  host.launches = new Map();
  host.launchesDay = new Map();
  host.busy = null;
  host.queue = [];
  host.liveSeats = () => [];
  host.save = () => true;
  const admit = host.admit as (launcher: string, run: { max_concurrent: number }) => string | null;
  expect(admit.call(host, "alex", { max_concurrent: 4 })).toContain("still being removed");
});

test("a concluding seat's own user occupies one slot, not two", () => {
  const host = Object.create(SeatsHost.prototype) as Record<string, unknown>;
  host.quarantine = new Set(["walkie-s1", "walkie-s2"]);
  host.seats = new Map([["concluding", { userN: 1 }]]);
  expect((host.blockingQuarantine as () => number).call(host)).toBe(1);
});

test("host reconciles 62 idle users into one slow cleanup lane and drains to zero", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".host-cleanup-"));
  dirs.push(dir);
  const path = join(dir, "ids.sqlite");
  const seed = new Ledger(path);
  const create = { pid: process.pid, start: "seed" };
  for (let n = 1; n <= 62; n++) {
    seed.reserve(n, 501, create);
    seed.advance(n, create, "reserved", "making");
    seed.finish(n, create, "created");
  }
  seed.close();
  let active = 0;
  let peak = 0;
  const order: number[] = [];
  let releaseDestroy: () => void = () => undefined;
  const holdDestroy = new Promise<void>((resolve) => { releaseDestroy = resolve; });
  const host = Object.create(SeatsHost.prototype) as Record<string, unknown>;
  Object.assign(host, {
    current: { max: 2 }, opts: {}, core: { hostname: "fleet-mac" },
    quarantine: new Set<string>(), quarantineWhy: new Map(),
    liveUsers: new Set<number>(), recoveredIdle: new Set<number>(), runningLeftovers: new Set<string>(), seatScope: () => ({ state: "own" }), userHigh: 0, closing: false, reconciled: false, reconcileError: null,
    keptSeats: new Map(), keptReady: new Set(), keptEnded: new Set(), keptStatePosted: new Set(),
    seats: new Map([["running", { launcher: "alex" }]]), launches: new Map(), launchesDay: new Map(), busy: null, queue: [],
    liveSeats: () => [], save: () => true, rebalance: () => undefined,
    log: { info: () => undefined, warn: () => undefined },
    adminOp: async (verb: string, n: number) => {
      const ledger = new Ledger(path);
      try {
        if (verb === "pending") return { ok: true, ids: ledger.pending(501), idleIds: ledger.pending(501) };
        active++;
        peak = Math.max(peak, active);
        order.push(n);
        const op = { pid: process.pid, start: `destroy-${n}` };
        if (!ledger.takeForDestroy(n, 501, op).ok) return { ok: false, why: "database is locked" };
        await holdDestroy;
        await Bun.sleep(2);
        ledger.finish(n, op, "destroyed");
        active--;
        return { ok: true };
      } finally { ledger.close(); }
    },
  });
  host.cleanup = new CleanupQueue((n) => (host.destroyOnce as (n: number) => Promise<{ ok: boolean }>).call(host, n));
  await (host.reconcileHelper as () => Promise<void>).call(host);
  expect((host.admit as (launcher: string, run: { max_concurrent: number }) => string | null).call(host, "alex", { max_concurrent: 4 })).toContain("still being removed");
  releaseDestroy();
  while ((host.quarantine as Set<string>).size && order.length < 62) await Bun.sleep(10);
  while ((host.quarantine as Set<string>).size) await Bun.sleep(10);
  await (host.cleanup as CleanupQueue<{ ok: boolean }>).close();
  expect((host.admit as (launcher: string, run: { max_concurrent: number }) => string | null).call(host, "alex", { max_concurrent: 4 })).toBeNull();
  const ledger = new Ledger(path);
  expect(ledger.pending(501)).toEqual([]);
  ledger.close();
  expect(peak).toBe(1);
  expect(order).toEqual(Array.from({ length: 62 }, (_, i) => i + 1));
  expect((host.quarantine as Set<string>).size).toBe(0);
});

test("list and doctor show the cleanup backlog count and summarized reason", () => {
  const names = Array.from({ length: 57 }, (_, i) => `walkie-s${i + 1}`);
  const local = {
    quarantined: names,
    quarantine_why: Object.fromEntries(names.map((n) => [n, "files it owns remain (protected directory)"])),
  } as unknown as SeatsLocalView;
  const lines = quarantineLines(local).map(plain);
  expect(lines[0]).toContain("57 seat users awaiting cleanup");
  expect(lines.join(" ")).toContain("protected directory");
  const checks = doctorChecks(local, { team: null, release: false, runnerProblem: null, helper: "ok", rootsFile: "ok", runtimes: { claude: null, codex: null } });
  expect(checks.some((c) => c.ok === "warn" && c.what.includes("57 seat users awaiting cleanup"))).toBe(true);
  expect(checks.find((c) => c.what.includes("awaiting cleanup") && c.ok === false)?.what).toContain("protected directory");
  expect(quarantineLines({ ...local, quarantined: ["walkie-s10", "walkie-s2", "walkie-s1"] })[0]).toContain("walkie-s1, walkie-s2, walkie-s10");
});

test("list and doctor report retained macOS residue without a readiness failure", () => {
  const local = { retired_residue: { homes: 57, vaults: 15, knownBytes: 8192 } } as SeatsLocalView;
  expect(retiredResidueLine(local)).toContain("57 retired seat homes");
  expect(retiredResidueLine(local)).toContain("8192 B");
  const checks = doctorChecks(local, { team: "team", release: false, runnerProblem: null, helper: "ok", rootsFile: "ok", runtimes: { claude: null, codex: null } });
  expect(checks.find((c) => c.what.includes("retired seat homes"))?.ok).toBe(true);
});

/** A prototype host whose destroyOnce can be called without a daemon. `tracked` is the kept user still owed an answer. */
function destroyHost(n: number, answer: Record<string, unknown>, tracked: boolean, cardUp: boolean): { host: Record<string, unknown>; quarantine: Set<string> } {
  const name = `walkie-s${n}`;
  const seat = `0123456789abcdef:${n}`;
  const quarantine = new Set([name]);
  const host = Object.create(SeatsHost.prototype) as Record<string, unknown>;
  Object.assign(host, {
    quarantine, quarantineWhy: new Map(), liveUsers: new Set([n]), recoveredIdle: new Set<number>([n]),
    runningLeftovers: new Set<string>(), seats: new Map(), closing: false, save: () => true, rebalance: () => undefined,
    log: { warn: () => undefined, info: () => undefined }, cleanupBusyAttempts: 0, cleanupBusySince: null,
    keptSeats: cardUp ? new Map([[seat, { id: seat, dir: "/tmp/s", user: n }]]) : new Map(),
    keptReady: new Set(), keptEnded: cardUp ? new Set() : new Set([seat]), keptStatePosted: new Set(),
    keptDestroyUsers: tracked ? new Map([[name, [seat]]]) : new Map(),
    seatScope: () => ({ state: "own" }), seatEndPostable: () => false,
    adminOp: async () => answer,
  });
  return { host, quarantine };
}

test("a kept destroy stops only for the helper's exact never-made sentence, including after the card has ended", async () => {
  const exact = (n: number) => ({ ok: false, name: `walkie-s${n}`, why: `walkie-s${n}: never made by this helper: not destroyed` });
  const run = async (n: number, answer: Record<string, unknown>, tracked = true, cardUp = true) => {
    const { host, quarantine } = destroyHost(n, answer, tracked, cardUp);
    const result = await (host.destroyOnce as (id: number) => Promise<{ ok: boolean }>).call(host, n);
    return { ok: result.ok, quarantined: quarantine.has(`walkie-s${n}`) };
  };
  // A seat-chosen path that merely contains the words (mounts, sweep samples) is still a failure.
  expect(await run(9, { ok: false, name: "walkie-s9", left: ["mounts of it remain: /tmp/never made by this helper"], why: "mounts of it remain: /tmp/never made by this helper" })).toEqual({ ok: false, quarantined: true });
  // The exact sentence with a left list or a code is the helper's failure shape, not its never-made shape.
  expect(await run(10, { ...exact(10), left: ["/tmp/kept"] })).toEqual({ ok: false, quarantined: true });
  expect(await run(11, { ...exact(11), code: "failed" })).toEqual({ ok: false, quarantined: true });
  expect(await run(17, { ...exact(17), left: null })).toEqual({ ok: false, quarantined: true });
  expect(await run(18, { ...exact(18), code: null })).toEqual({ ok: false, quarantined: true });
  expect(await run(19, { ...exact(19), left: [] })).toEqual({ ok: false, quarantined: true });
  expect(await run(20, { ...exact(20), code: "" })).toEqual({ ok: false, quarantined: true });
  expect(await run(14, { ok: false, why: "never made by this helper" })).toEqual({ ok: false, quarantined: true });
  // The helper's own sentence, with the uid it always includes, and nothing else, drops the kept user.
  expect(await run(15, { ...exact(15), uid: 600015 })).toEqual({ ok: true, quarantined: false });
  // The pending list already ended the card. The user is still tracked, so the same sentence is not retried.
  expect(await run(13, exact(13), true, false)).toEqual({ ok: true, quarantined: false });
  // An ordinary user the helper never kept is still retried on that sentence.
  expect(await run(16, exact(16), false, false)).toEqual({ ok: false, quarantined: true });
});

test("a kept card trusts its agent row over an older offline status", () => {
  const id = "0123456789abcdef:41";
  const agent = seatAgentName(id);
  const offlineEvent = { json: JSON.stringify({ body: { agent, state: "offline" } }) };
  let scanned = false;
  const host = Object.create(SeatsHost.prototype) as Record<string, unknown>;
  host.log = { warn: () => undefined };
  const call = (store: { agent: () => { body: string } | null; queryEvents: () => unknown }) => {
    host.core = { nodeId: "0123456789abcdef", store };
    return (host.keptCardOffline as (seat: string) => boolean).call(host, id);
  };
  expect(call({
    agent: () => ({ body: JSON.stringify({ agent, state: "working" }) }),
    queryEvents: () => { scanned = true; return [offlineEvent]; },
  })).toBe(false);
  expect(scanned).toBe(false);
  expect(call({
    agent: () => null,
    queryEvents: () => [offlineEvent],
  })).toBe(true);
  expect(call({
    agent: () => ({ body: JSON.stringify({ agent, state: "offline" }) }),
    queryEvents: () => { throw new Error("an offline row needs no event scan"); },
  })).toBe(true);
  // A row that is present but unreadable is not overruled by an older offline event.
  scanned = false;
  let lookupFailed = false;
  host.log = { warn: (msg: string) => { if (msg === "seats_leftover_end_lookup_failed") lookupFailed = true; } };
  expect(call({
    agent: () => ({ body: "not json" }),
    queryEvents: () => { scanned = true; return [offlineEvent]; },
  })).toBe(false);
  expect(scanned).toBe(false);
  expect(lookupFailed).toBe(true);
  // A lookup that throws before a row is seen still uses the recent events.
  scanned = false;
  expect(call({
    agent: () => { throw new Error("store down"); },
    queryEvents: () => { scanned = true; return [offlineEvent]; },
  })).toBe(true);
  expect(scanned).toBe(true);
});

test("a stored terminal state logs a card-end retry only while the card is still up", () => {
  const id = "0123456789abcdef:32";
  const logs: string[] = [];
  let ended = 0;
  const host = Object.create(SeatsHost.prototype) as Record<string, unknown>;
  const seat = { id, dir: "/tmp/s", user: 8 };
  const arm = (offline: boolean) => {
    logs.length = 0;
    ended = 0;
    Object.assign(host, {
      seatScope: () => ({ state: "own" }), seatEndPostable: () => true,
      keptSeats: new Map([[id, seat]]), keptReady: new Set([id]), keptEnded: new Set(), keptStatePosted: new Set(),
      keptTerminalAlreadyPosted: () => true,
      keptCardOffline: () => offline,
      endSavedSeatCard: () => { ended++; return true; },
      save: () => true,
      log: { warn: (msg: string) => logs.push(msg) },
    });
  };
  arm(false);
  (host.finishKeptSeat as (seatId: string) => void).call(host, id);
  expect(ended).toBe(1);
  expect(logs).toContain("seats_leftover_end_retry");
  expect(logs).toContain("seats_leftover_ended");
  expect(logs).not.toContain("seats_leftover_end_skipped");
  arm(true);
  (host.finishKeptSeat as (seatId: string) => void).call(host, id);
  expect(ended).toBe(0);
  expect(logs).toEqual(["seats_leftover_end_skipped"]);
});
