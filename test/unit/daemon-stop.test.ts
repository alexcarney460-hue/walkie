// `walkie daemon stop` waits for the daemon's own bounded shutdown. The daemon halts the orchestrator (2 s), then gives running
// seats up to 14 s to finish (src/daemon/seats/host.ts close()), then closes the rest, and it answers on its socket until its
// listeners close; `stop` used to give up after 10 s, so `walkie daemon stop && walkie daemon start` (the command `walkie update`
// prints on a machine with no service) failed on a seat host that was still draining, and a `start` right after found the dying
// daemon "already running".
// Three kinds of stand-in keep this honest without a 30 s sleep: a shell that SURVIVES the first SIGTERM and logs every one it
// gets (a second SIGTERM shows in its log and in a count of process.kill calls), a socket whose seats route never answers, and
// a clock and daemon the test owns (virtual time), which is how the defaults (30 s wait, 3 s notice delay) are pinned.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STOP_NOTICE_AFTER_MS, STOP_WAIT_MS, stop, type StopSys } from "../../src/cli/commands/daemon.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { fakeDaemon, type FakeDaemon } from "../helpers/fake-daemon.ts";

function capture(): Ctx & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return { args: { pos: [], flags: new Map() }, json: false, forAgent: false, out: (s: string) => outs.push(s), err: (s: string) => errs.push(s), outs, errs } as unknown as Ctx & { outs: string[]; errs: string[] };
}

let home = "";
let saved: { home: string | undefined; socket: string | undefined } = { home: undefined, socket: undefined };
let standIns: Array<ReturnType<typeof Bun.spawn>> = [];
let fakes: FakeDaemon[] = [];
let servers: Array<{ stop(force?: boolean): void }> = [];
let launched = 0;

beforeEach(() => {
  home = mkdtempSync("/tmp/walkie-stop-");
  saved = { home: process.env.WALKIE_HOME, socket: process.env.WALKIE_SOCKET };
  process.env.WALKIE_HOME = home;
  delete process.env.WALKIE_SOCKET;
});
afterEach(() => {
  for (const p of standIns) { try { p.kill("SIGKILL"); } catch { /* already gone */ } }
  for (const f of fakes) f.stop();
  for (const s of servers) s.stop(true);
  standIns = [];
  fakes = [];
  servers = [];
  for (const [name, value] of [["WALKIE_HOME", saved.home], ["WALKIE_SOCKET", saved.socket]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

/**
 * A stand-in daemon: its pid in the pid file. It SURVIVES a SIGTERM (a daemon draining its seats does), logs every SIGTERM it
 * gets, and leaves about `lingerMs` after the first. Resolves once it is listening for the signal (a SIGTERM before that would
 * just end the shell).
 */
async function standIn(lingerMs: number): Promise<{ pid: number; signals: () => number }> {
  const log = join(home, "signals.log");
  const ready = join(home, `ready-${++launched}`);
  const polls = Math.max(1, Math.ceil(lingerMs / 50));
  const script = [
    "term=0; n=0",
    `trap 'echo term >> "${log}"; term=1' TERM`,
    `: > "${ready}"`,
    "while :; do",
    "  sleep 0.05",
    `  if [ "$term" = 1 ]; then n=$((n + 1)); if [ "$n" -ge ${polls} ]; then exit 0; fi; fi`,
    "done",
  ].join("\n");
  const p = Bun.spawn(["/bin/sh", "-c", script], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  standIns.push(p);
  for (let i = 0; i < 200 && !existsSync(ready); i++) await Bun.sleep(25);
  expect(existsSync(ready)).toBe(true);
  writeFileSync(join(home, "daemon.pid"), `${p.pid}\n`);
  return { pid: p.pid, signals: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0) };
}

/** Runs `run` and reports every signal process.kill was asked to send meanwhile, as "pid:signal" (a probe is "pid:0"). */
async function signalled<T>(run: () => Promise<T>): Promise<{ result: T; sent: string[] }> {
  const real = process.kill;
  const sent: string[] = [];
  process.kill = ((pid: number, signal?: string | number) => { sent.push(`${pid}:${signal ?? "SIGTERM"}`); return real.call(process, pid, signal as never); }) as typeof process.kill;
  try { return { result: await run(), sent }; } finally { process.kill = real; }
}

/**
 * A clock and a daemon the test owns: the daemon leaves `leavesAfterMs` of virtual time after it is told to stop (Infinity:
 * never), sleeping advances the clock, and nothing real is signalled. A wait that never ends fails instead of spinning.
 */
function virtualDaemon(leavesAfterMs: number) {
  let t = 0;
  let told: number | null = null;
  const terms: number[] = [];
  const sys: StopSys = {
    now: () => t,
    sleep: async (ms) => { t += ms; if (t > 120_000) throw new Error("the wait never ended"); },
    alive: () => told === null || t < told + leavesAfterMs,
    terminate: () => { terms.push(t); told ??= t; },
  };
  writeFileSync(join(home, "daemon.pid"), "424242\n"); // never signalled: the clock and the daemon are the test's
  return { sys, terms, now: () => t };
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("how long `walkie daemon stop` waits", () => {
  test("the defaults outlast the daemon's own bounded shutdown (orchestrator 2 s, seats up to 14 s, then the rest)", () => {
    expect(STOP_WAIT_MS).toBe(30_000);
    expect(STOP_WAIT_MS).toBeGreaterThan(2_000 + 14_000);
    expect(STOP_NOTICE_AFTER_MS).toBe(3_000);
  });

  test("a daemon that takes a while to leave is waited for: stopped, exit 0, and it really is gone", async () => {
    const d = await standIn(500);
    const ctx = capture();
    const t0 = Date.now();
    expect(await stop(ctx, { waitMs: 8_000 })).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    expect(ctx.outs.join("\n")).toContain("daemon stopped");
    expect(ctx.errs).toEqual([]);
    expect(alive(d.pid)).toBe(false);
  });

  test("the same daemon with a shorter wait: the existing \"did not exit\" error, naming the limit, after about that long", async () => {
    const d = await standIn(5_000);
    const ctx = capture();
    const t0 = Date.now();
    expect(await stop(ctx, { waitMs: 400 })).toBe(1);
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(400);
    expect(waited).toBeLessThan(3_000); // it did not sit out the stand-in's 5 s
    expect(ctx.errs.join("\n")).toContain(`daemon (pid ${d.pid}) did not exit within 0.4s`);
    expect(ctx.outs.join("\n")).not.toContain("daemon stopped");
  });

  test("it asks the daemon to stop once and only once, however long the wait: a second SIGTERM would cut the daemon's own shutdown short", async () => {
    const d = await standIn(900); // survives the first SIGTERM and logs every one: about 18 polls in which a re-send could happen
    const { result, sent } = await signalled(() => stop(capture(), { waitMs: 8_000, runningSeats: async () => null }));
    expect(result).toBe(0);
    expect(sent.filter((s) => s === `${d.pid}:SIGTERM`)).toHaveLength(1); // counted at the call: two sent back to back are two
    expect(d.signals()).toBe(1); // and counted by the daemon that received them
  });

  test("the paths that never waited are as they were: no pid file, or a pid that is gone, says so and exits 0", async () => {
    const none = capture();
    expect(await stop(none, { waitMs: 400 })).toBe(0);
    expect(none.outs).toEqual(["daemon not running"]);

    const gone = Bun.spawn(["/bin/sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    await gone.exited; // a daemon that died without cleaning up: its pid file stays behind
    writeFileSync(join(home, "daemon.pid"), `${gone.pid}\n`);
    const stale = capture();
    expect(await stop(stale, { waitMs: 400 })).toBe(0);
    expect(stale.outs).toEqual(["daemon not running"]);
  });
});

describe("the defaults, on a clock the test owns", () => {
  test("a daemon that takes 12 s to leave (the shutdown that used to fail the printed command) is waited for, and the seats are asked at 3 s", async () => {
    const v = virtualDaemon(12_000);
    const ctx = capture();
    const asked: number[] = [];
    expect(await stop(ctx, { sys: v.sys, runningSeats: async () => { asked.push(v.now()); return 2; } })).toBe(0);
    expect(v.terms).toEqual([0]);
    expect(v.now()).toBeGreaterThanOrEqual(12_000);
    expect(v.now()).toBeLessThan(12_200);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeGreaterThanOrEqual(3_000);
    expect(asked[0]).toBeLessThan(3_200);
    expect(ctx.outs[0]).toBe("waiting for 2 running seats to finish before the daemon exits (up to 30 s)…");
    expect(ctx.outs[1]).toContain("daemon stopped");
    expect(ctx.errs).toEqual([]);
  });

  test("a daemon that never leaves is given up on at 30 s, after one SIGTERM and one question, with the error naming it and the limit", async () => {
    const v = virtualDaemon(Infinity);
    const ctx = capture();
    const asked: number[] = [];
    expect(await stop(ctx, { sys: v.sys, runningSeats: async () => { asked.push(v.now()); return 1; } })).toBe(1);
    expect(v.terms).toEqual([0]);
    expect(v.now()).toBeGreaterThanOrEqual(30_000);
    expect(v.now()).toBeLessThan(30_200);
    expect(asked).toHaveLength(1);
    expect(ctx.errs.join("\n")).toContain("daemon (pid 424242) did not exit within 30s");
    expect(ctx.outs).toEqual(["waiting for 1 running seat to finish before the daemon exits (up to 30 s)…"]);
  });

  test("a daemon that leaves before 3 s is never asked about its seats", async () => {
    const v = virtualDaemon(2_500);
    const ctx = capture();
    let asked = 0;
    expect(await stop(ctx, { sys: v.sys, runningSeats: async () => { asked++; return 5; } })).toBe(0);
    expect(asked).toBe(0);
    expect(ctx.outs).toHaveLength(1);
    expect(ctx.outs[0]).toContain("daemon stopped");
  });
});

describe("telling a person what a slow stop is waiting for", () => {
  test("running seats, once the wait runs long: says how many, once, then the daemon stopped", async () => {
    await standIn(500);
    const ctx = capture();
    let asked = 0;
    expect(await stop(ctx, { waitMs: 8_000, noticeAfterMs: 200, runningSeats: async () => { asked++; return 2; } })).toBe(0);
    expect(asked).toBe(1);
    expect(ctx.outs).toHaveLength(2);
    expect(ctx.outs[0]).toBe("waiting for 2 running seats to finish before the daemon exits (up to 8 s)…");
    expect(ctx.outs[1]).toContain("daemon stopped");
  });

  test("one seat is said in the singular", async () => {
    await standIn(450);
    const ctx = capture();
    await stop(ctx, { waitMs: 8_000, noticeAfterMs: 100, runningSeats: async () => 1 });
    expect(ctx.outs[0]).toBe("waiting for 1 running seat to finish before the daemon exits (up to 8 s)…");
  });

  test("no seats, or no answer: nothing is said, the wait is just the wait", async () => {
    for (const answer of [0, null] as const) {
      await standIn(450);
      const ctx = capture();
      expect(await stop(ctx, { waitMs: 8_000, noticeAfterMs: 100, runningSeats: async () => answer })).toBe(0);
      expect(ctx.outs).toHaveLength(1);
      expect(ctx.outs[0]).toContain("daemon stopped");
    }
  });

  test("a stop that ends before the delay never asks the daemon anything", async () => {
    await standIn(250);
    const ctx = capture();
    let asked = 0;
    expect(await stop(ctx, { waitMs: 8_000, noticeAfterMs: 1_500, runningSeats: async () => { asked++; return 3; } })).toBe(0);
    expect(asked).toBe(0);
    expect(ctx.outs).toHaveLength(1);
  });

  test("the daemon is asked once, and not before the delay", async () => {
    await standIn(1_300);
    const ctx = capture();
    const t0 = Date.now();
    const askedAt: number[] = [];
    expect(await stop(ctx, { waitMs: 8_000, noticeAfterMs: 600, runningSeats: async () => { askedAt.push(Date.now() - t0); return 2; } })).toBe(0);
    expect(askedAt).toHaveLength(1);
    expect(askedAt[0]).toBeGreaterThanOrEqual(600);
    expect(askedAt[0]).toBeLessThan(1_200); // while the daemon was still there to be waited for
  });

  test("a stop that gives up still ends with the error, after the notice", async () => {
    const d = await standIn(5_000);
    const ctx = capture();
    expect(await stop(ctx, { waitMs: 600, noticeAfterMs: 100, runningSeats: async () => 4 })).toBe(1);
    expect(ctx.outs).toEqual(["waiting for 4 running seats to finish before the daemon exits (up to 0.6 s)…"]);
    expect(ctx.errs.join("\n")).toContain(`daemon (pid ${d.pid}) did not exit within 0.6s`);
  });

  test("by default it asks the daemon itself (GET /v1/seats) and reads the running count", async () => {
    const fake = fakeDaemon({ "GET /v1/seats": { local: { running: 3 }, hosts: [], seats: [] } });
    fakes.push(fake);
    process.env.WALKIE_SOCKET = fake.socket;
    await standIn(500);
    const ctx = capture();
    expect(await stop(ctx, { waitMs: 8_000, noticeAfterMs: 200 })).toBe(0);
    expect(ctx.outs[0]).toBe("waiting for 3 running seats to finish before the daemon exits (up to 8 s)…");
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/seats"]);
  });

  test("by default, a daemon that has no such answer (an older one, a 404, nothing listening) costs nothing: no notice, same stop", async () => {
    const older = fakeDaemon({}); // every route 404s
    fakes.push(older);
    process.env.WALKIE_SOCKET = older.socket;
    await standIn(450);
    const a = capture();
    expect(await stop(a, { waitMs: 8_000, noticeAfterMs: 100 })).toBe(0);
    expect(a.outs).toHaveLength(1);
    expect(a.outs[0]).toContain("daemon stopped");

    process.env.WALKIE_SOCKET = join(home, "nobody-listens.sock");
    await standIn(450);
    const b = capture();
    expect(await stop(b, { waitMs: 8_000, noticeAfterMs: 100 })).toBe(0);
    expect(b.outs).toHaveLength(1);
    expect(b.errs).toEqual([]);
  });

  test("a seats route that never answers is given up on after 1 s: the stop is not held up for the 10 s a client would wait", async () => {
    let requests = 0;
    const socket = join(home, "hang.sock");
    servers.push(Bun.serve({ unix: socket, fetch() { requests++; return new Promise<Response>(() => undefined); } }));
    process.env.WALKIE_SOCKET = socket;
    await standIn(1_400);
    const ctx = capture();
    const t0 = Date.now();
    expect(await stop(ctx, { waitMs: 8_000, noticeAfterMs: 100 })).toBe(0);
    const took = Date.now() - t0;
    expect(requests).toBe(1); // the question was really asked, and never answered
    expect(took).toBeGreaterThanOrEqual(1_300); // it waited for the daemon
    expect(took).toBeLessThan(3_500); // and not for the route
    expect(ctx.outs).toHaveLength(1);
    expect(ctx.outs[0]).toContain("daemon stopped");
  });
});
