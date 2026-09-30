// Seats round 10 (docs/audits/2026-09-26-*-seats-r10.md), Codex r10 HIGH / Opus r10: turning seats off doesn't
// release the pool until nothing of a seat can still run — not while a deny is still stopping seats, and not while a
// seat user isn't verified removed (quarantined). From the audit's probe (seats10-probes/deny-quarantine-pool).
// Seat users: the REAL helper logic over a fake system. Pool: stand-in rpc-servers.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdminVerb } from "../../src/daemon/seats/admin.ts";
import { PeerCallError } from "../../src/daemon/peer-client.ts";
import { SEATS_POOL_CONFLICT, type SeatView } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, signInCodex, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";
import { ACCEPT_STANDIN, fakeRuntime } from "../helpers/pool-runtime.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const GiB = 1024 ** 3;
let c: Cluster;
let alex: TestNode;
let arvid: TestNode;
let world: FakeSeatWorld;
/** While set, the helper's destroys wait for it (a deny that is still stopping seats). */
let holdDestroy: Promise<void> | null = null;
const addrOn = (from: TestNode, to: TestNode) => from.d.client.addrOf(from.d.core.roster.nodes.get(to.d.nodeId)!)!;

async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p; return "accepted"; } catch (err) {
    const e = err as { status?: number; code?: string; message: string };
    return err instanceof PeerCallError ? `${err.status}:${err.code}:${e.message}` : `${e.status}:${e.code}:${e.message}`;
  }
}

async function runningSeat(prompt: string): Promise<string> {
  const id = (await alex.client().seatRun({ machine: "arvid-mac", runtime: "codex", prompt })).seat;
  await waitFor(async () => (((await alex.client().seats(id)).seats[0] as SeatView | undefined)?.state === "running" ? true : null), { timeoutMs: 20_000, what: "running" });
  return id;
}

beforeAll(async () => {
  c = new Cluster();
  const personHome = join(c.root, "arvid-home");
  mkdirSync(join(personHome, ".claude"), { recursive: true });
  chmodSync(personHome, 0o700);
  writeFileSync(join(personHome, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "access-token", refreshToken: "rt", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference"] } }), { mode: 0o600 });
  signInCodex(personHome);
  const walkieHome = join(c.root, "arvid");
  world = fakeSeatWorld(c.root, walkieHome);
  const pool = { llamaDir: fakeRuntime(c.root, "fake-rpc"), verifyRuntime: ACCEPT_STANDIN, leaseMs: 120_000, freeMemory: async () => 8 * GiB };
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", pool });
  mkdirSync(walkieHome, { recursive: true });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac", pool,
    seats: {
      flushMs: 100, launchesPerMinute: 100, userSwitch: world.userSwitch, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
      admin: async (verb: AdminVerb, n: number) => { if (verb === "destroy" && holdDestroy) await holdDestroy; return world.admin(verb, n); },
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: personHome },
    },
  });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  await arvid.client("").seatsConfig({ allow: true, ephemeral: true });
  await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "arvid takes seats" });
}, 60_000);
afterAll(async () => { await c.close(); });

test("a deny still stopping seats keeps the pool off until they have stopped", async () => {
  await runningSeat("ticker 600 while denied");
  let release: () => void = () => undefined;
  holdDestroy = new Promise<void>((r) => { release = r; });
  const deny = arvid.client("").seatsConfig({ allow: false });
  await waitFor(async () => ((await arvid.client("").seats()).local.allow === false ? true : null), { what: "allow off" });
  const share = await refusal(arvid.client("").poolShare(true, null));
  expect(share).toMatch(/^409:seats_pool_conflict:/);
  expect(share).toContain(SEATS_POOL_CONFLICT);
  expect(share).toMatch(/still stopping|not verified removed/);
  holdDestroy = null;
  release();
  await deny;
  await waitFor(() => (arvid.d.core.pool!.seatsConflict() === null && seatsBlockOf(arvid) === null ? true : null), { timeoutMs: 20_000, what: "everything of the seat gone" });
  expect(await refusal(arvid.client("").poolShare(true, null))).toBe("accepted");
  await arvid.client("").poolShare(false, null);
}, 90_000);

test("a seat user left quarantined by a deny keeps sharing, stages and run heads off, and says why", async () => {
  await arvid.client("").seatsConfig({ allow: true, ephemeral: true });
  await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "arvid takes seats again" });
  await runningSeat("ticker 600 quarantined");
  world.broken.add("destroy-files");
  try {
    await arvid.client("").seatsConfig({ allow: false });
    const { local } = await arvid.client("").seats();
    expect(local.allow).toBe(false);
    expect(local.quarantined?.length ?? 0).toBeGreaterThan(0);
    const share = await refusal(arvid.client("").poolShare(true, null));
    expect(share).toMatch(/^409:seats_pool_conflict:/);
    expect(share).toContain("not verified removed");
    expect((await arvid.client("").pool()).share.on).toBe(false);
    const head = await refusal(arvid.client("").poolRun({ file: "/tmp/x.gguf", machines: ["alex-mbp"] }));
    expect(head).toMatch(/^409:seats_pool_conflict:/);
  } finally {
    world.broken.delete("destroy-files");
  }
}, 90_000);

function seatsBlockOf(n: TestNode): string | null {
  return (n.d as unknown as { core: { pool: { d: { seatsBlock?: () => string | null } } } }).core.pool.d.seatsBlock?.() ?? null;
}

test("a stage from a head is refused on a machine with a quarantined seat user, even with sharing on", async () => {
  // Still quarantined from the test above (its retry is a minute away). Sharing on as a config.json from before this
  // release would leave it (the API refuses to turn it on now): set in the running service directly.
  expect((await arvid.client("").seats()).local.quarantined?.length ?? 0).toBeGreaterThan(0);
  const pool = arvid.d.core.pool as unknown as { shareCfg: { on: boolean; maxBytes: number | null } };
  pool.shareCfg = { on: true, maxBytes: null };
  try {
    expect(arvid.d.core.pool!.published().share).toBe(false); // not offered to the team
    const stage = await refusal(alex.d.client.stage(addrOn(alex, arvid), { action: "start", run: "d".repeat(32), bytes: 1024, model: "x" }));
    expect(stage).toMatch(/^409:seats_pool_conflict:/);
    expect(stage).toContain("not verified removed");
    expect(arvid.d.core.pool!.view().stage).toBeNull();
  } finally {
    pool.shareCfg = { on: false, maxBytes: null };
  }
}, 30_000);
