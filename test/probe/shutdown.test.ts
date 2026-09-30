// PROBE (reviewer): how long does a graceful daemon stop take while a restart backlog is queued? Same file on base and tip.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdminVerb } from "../../src/daemon/seats/admin.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, signInCodex, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const N = Number(process.env.BACKLOG ?? 10);
const D = Number(process.env.DESTROY_MS ?? 400);
const TREE = process.env.TREE_LABEL ?? "?";
let c: Cluster; let arvid: TestNode; let world: FakeSeatWorld;
const t00 = Date.now(); const now = () => Date.now() - t00;
const calls: Array<{ n: number; start: number; end: number }> = [];
let inflightAtStop = 0; let active = 0;

beforeAll(async () => {
  c = new Cluster();
  const personHome = join(c.root, "arvid-home");
  mkdirSync(join(personHome, ".claude"), { recursive: true });
  chmodSync(personHome, 0o700);
  signInCodex(personHome);
  const walkieHome = join(c.root, "arvid");
  world = fakeSeatWorld(c.root, walkieHome);
  world.sys.acl = () => "";
  for (let n = 1; n <= N; n++) { const r = await world.admin("create", n); if (!r.ok) throw new Error(`backlog create ${n}: ${r.why}`); }
  mkdirSync(walkieHome, { recursive: true });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: {
      flushMs: 100, userSwitch: world.userSwitch, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
      admin: async (verb: AdminVerb, n: number) => {
        if (verb !== "destroy") return world.admin(verb, n);
        active++; const rec = { n, start: now(), end: 0 }; calls.push(rec);
        try { await Bun.sleep(D); return await world.admin(verb, n); } finally { active--; rec.end = now(); }
      },
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: personHome },
    },
  });
}, 120_000);
afterAll(async () => { try { await c.close(); } catch { /* already stopped */ } });

test(`shutdown latency ${TREE} backlog=${N} destroyMs=${D}`, async () => {
  await Bun.sleep(400); // the daemon is up and reconcile has queued the backlog
  const started = now();
  const before = calls.length;
  await arvid.stop();
  const took = now() - started;
  console.log("SHUTDOWN_RESULT " + JSON.stringify({ tree: TREE, backlog: N, destroyMs: D, stopTookMs: took, destroysStartedBeforeStop: before, destroysTotalByStopEnd: calls.length, destroysCompletedByStopEnd: calls.filter((x) => x.end).length }));
  expect(calls.length).toBeLessThanOrEqual(before + 1);
  expect(took).toBeLessThan(20_000);
}, 180_000);
