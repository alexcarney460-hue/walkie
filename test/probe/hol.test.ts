// PROBE (reviewer): head-of-line behaviour of the seat cleanup path behind a restart backlog. Same file runs on base and tip.
// Real daemon (Cluster), real SeatsHost, real helper logic + real ledger over the fake OS world. N seat users are left behind
// (created, never destroyed) before the daemon starts, as a crashed daemon leaves them; destroys take DESTROY_MS each.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdminVerb } from "../../src/daemon/seats/admin.ts";
import type { SeatView } from "../../src/protocol/seats.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";
import { quarantineLines } from "../../src/cli/commands/seats.ts";
import { fakeSeatWorld, signInCodex, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const N = Number(process.env.BACKLOG ?? 10);
const D = Number(process.env.DESTROY_MS ?? 400);
const MAX = Number(process.env.HOSTMAX ?? 2);
const HANG_N = Number(process.env.HANG_N ?? 0);
const FINAL_TIMEOUT = Number(process.env.FINAL_TIMEOUT_MS ?? 110_000);
let releaseHang: () => void = () => undefined;
const hangP = new Promise<void>((r) => { releaseHang = r; });
const SCENARIO = process.env.SCENARIO ?? "cleanable"; // cleanable: backlog users really are removed; stuck: their destroy keeps failing (process-free residue)
const TREE = process.env.TREE_LABEL ?? "?";
let c: Cluster; let alex: TestNode; let arvid: TestNode; let world: FakeSeatWorld;
const t00 = Date.now();
const now = () => Date.now() - t00;
const calls: Array<{ n: number; start: number; end: number }> = [];
let active = 0; let peak = 0;

beforeAll(async () => {
  c = new Cluster();
  const personHome = join(c.root, "arvid-home");
  mkdirSync(join(personHome, ".claude"), { recursive: true });
  chmodSync(personHome, 0o700);
  writeFileSync(join(personHome, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "access-token", refreshToken: "rt", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference"] } }), { mode: 0o600 });
  signInCodex(personHome);
  const walkieHome = join(c.root, "arvid");
  world = fakeSeatWorld(c.root, walkieHome);
  world.sys.acl = () => "";
  for (let n = 1; n <= N; n++) { const r = await world.admin("create", n); if (!r.ok) throw new Error(`backlog create ${n}: ${r.why}`); }
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  mkdirSync(walkieHome, { recursive: true });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: {
      flushMs: 100, launchesPerMinute: 100, userSwitch: world.userSwitch, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
      admin: async (verb: AdminVerb, n: number) => {
        if (verb !== "destroy") return world.admin(verb, n);
        active++; peak = Math.max(peak, active);
        const rec = { n, start: now(), end: 0 }; calls.push(rec);
        try {
          await Bun.sleep(D);
          if (n === HANG_N) await hangP; // a wedged helper (dscl/launchctl hung): never answers until the probe ends
          if (SCENARIO === "locked" && n <= N) return { ok: false, why: "the helper's id ledger can't be used: database is locked" } as never;
          if (SCENARIO === "stuck" && n <= N) return { ok: false, name: `walkie-s${n}`, why: "files it owns remain (probe)", left: ["files it owns remain (probe)"], processesGone: true } as never;
          return await world.admin(verb, n);
        } finally { active--; rec.end = now(); }
      },
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: personHome },
    },
  });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
}, 120_000);
afterAll(async () => { releaseHang(); await c.close(); });

const sleep = (ms: number) => Bun.sleep(ms);
async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number, everyMs = 50): Promise<{ v: T | null; at: number }> {
  const end = Date.now() + timeoutMs;
  for (;;) { const v = await fn(); if (v) return { v, at: now() }; if (Date.now() > end) return { v: null, at: now() }; await sleep(everyMs); }
}

test(`probe ${TREE} scenario=${SCENARIO} backlog=${N} destroyMs=${D} max=${MAX}`, async () => {
  const cfgAt = now();
  const cfg = await arvid.client("").seatsConfig({ allow: true, ephemeral: true, max: MAX });
  const viewAt = async () => (await arvid.client("").seats()).local;
  await sleep(150);
  const early = await viewAt();
  await sleep(Number(process.env.LAUNCH_AFTER_MS ?? 0));
  const mid = await viewAt();
  const runAt = now();
  const run = await alex.client().seatRun({ machine: "arvid-mac", runtime: "codex", prompt: "ticker 3 probe" }).then((r) => ({ ok: true as const, seat: r.seat }), (e: Error) => ({ ok: false as const, why: e.message }));
  let running: number | null = null; let final: { state: string; reason?: string } | null = null; let finalAt: number | null = null;
  if (run.ok) {
    const st = async () => ((await alex.client().seats(run.seat)).seats[0] as SeatView | undefined) ?? null;
    const r1 = await poll(async () => { const s = await st(); return s && (s.state === "running" || ["done", "stopped", "failed", "refused"].includes(s.state)) ? s : null; }, 60_000);
    running = r1.v ? r1.at : null;
    const r2 = await poll(async () => { const s = await st(); return s && ["done", "stopped", "failed", "refused"].includes(s.state) ? s : null; }, FINAL_TIMEOUT);
    final = r2.v ? { state: (r2.v as SeatView).state, reason: (r2.v as SeatView & { reason?: string }).reason } : null; finalAt = r2.v ? r2.at : null;
  }
  const late = await viewAt();
  if (process.env.SHOW_LINES) for (const l of quarantineLines(late)) console.log("LISTLINE " + l.replace(/\x1b\[[0-9;]*m/g, ""));
  console.log("PROBE_RESULT " + JSON.stringify({
    tree: TREE, scenario: SCENARIO, backlog: N, destroyMs: D, max: MAX,
    configuredAt: cfgAt, earlyQuarantined: early.quarantined?.length ?? 0,
    launch: run.ok ? { seat: run.seat } : run, launchedAt: runAt, midQuarantined: mid.quarantined?.length ?? 0, runningAt: running, finalAt, final,
    seatLifeMs: running !== null && finalAt !== null ? finalAt - running : null,
    destroyPeakConcurrency: peak, destroyCalls: calls.length,
    firstDestroyStart: calls[0]?.start ?? null, backlogDestroysDoneBy: Math.max(0, ...calls.filter((x) => x.n <= N && x.end).map((x) => x.end)),
    seatUserDestroy: calls.filter((x) => x.n > N).map((x) => ({ n: x.n, start: x.start, end: x.end })),
    lateQuarantined: late.quarantined?.length ?? 0,
  }));
  if (SCENARIO === "cleanable" && MAX > N) {
    expect(final?.state).toBe("done");
    expect(late.quarantined?.length ?? 0).toBeGreaterThan(0);
  } else if (SCENARIO === "cleanable" && MAX <= N) {
    expect(final?.state).toBe("refused");
  }
}, 180_000);
