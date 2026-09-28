// Seats round 11 (Opus r11), from its probes (opus-seats11-probes/):
//   MEDIUM  the startup window: before seats.init() has read seats.json, the pool gate fails closed, so a restart
//           with a quarantined seat user on disk and a slow tailnet accepts no split run (and starts no llama-server)
//   LOW     the helper's list of seat users unreadable: it blocks the pool only while it matters (seat users on, or
//           one still held); turning seat users off with none left releases it at once and stops the retry
// Seat users: the REAL helper logic over a fake system. Pool: stand-in rpc-servers and llama-server.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WalkieClient } from "../../src/client/index.ts";
import type { FakeIdentity } from "../../src/daemon/identity.ts";
import type { AdminVerb } from "../../src/daemon/seats/admin.ts";
import { SEATS_POOL_CONFLICT, type SeatView } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, signInCodex, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";
import { ACCEPT_STANDIN, fakeRuntime } from "../helpers/pool-runtime.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const GiB = 1024 ** 3;
let c: Cluster;
let alex: TestNode;
let arvid: TestNode;
let kira: TestNode;
let world: FakeSeatWorld;
let kiraWorld: FakeSeatWorld;
let brokenPending = false;
let pendingCalls = 0;
const block = (n: TestNode) => (n.d as unknown as { core: { pool: { d: { seatsBlock: () => string | null } } } }).core.pool.d.seatsBlock();
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

function seatHome(name: string): string {
  const personHome = join(c.root, `${name}-home`);
  mkdirSync(join(personHome, ".claude"), { recursive: true });
  chmodSync(personHome, 0o700);
  signInCodex(personHome);
  return personHome;
}

beforeAll(async () => {
  c = new Cluster();
  const pool = { llamaDir: fakeRuntime(c.root, "fake-rpc"), verifyRuntime: ACCEPT_STANDIN, leaseMs: 120_000, freeMemory: async () => 8 * GiB };
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", pool });
  const arvidHome = seatHome("arvid");
  world = fakeSeatWorld(c.root, join(c.root, "arvid"));
  mkdirSync(join(c.root, "arvid"), { recursive: true });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac", pool,
    seats: {
      flushMs: 100, launchesPerMinute: 100, userSwitch: world.userSwitch, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
      admin: async (verb: AdminVerb, n: number) => world.admin(verb, n),
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: arvidHome },
    },
  });
  const kiraHome = seatHome("kira");
  const kiraRoot = join(c.root, "kira-world");
  mkdirSync(kiraRoot, { recursive: true });
  kiraWorld = fakeSeatWorld(kiraRoot, join(c.root, "kira"));
  mkdirSync(join(c.root, "kira"), { recursive: true });
  kira = await c.add({
    name: "kira", login: "kira@example.com", hostname: "kira-mbp", pool,
    seats: {
      flushMs: 100, launchesPerMinute: 100, userSwitch: kiraWorld.userSwitch, lookupUser: kiraWorld.lookup, schedulerFiles: kiraWorld.schedulerFiles,
      reconcileRetryMs: 200,
      admin: async (verb: AdminVerb, n: number) => {
        if (verb === "pending") { pendingCalls++; if (brokenPending) return { ok: false, why: "sudo: a password is required" } as never; }
        return kiraWorld.admin(verb, n);
      },
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: kiraHome },
    },
  });
  await alex.client().init("aka", "alex");
  for (const [n, login, handle] of [[arvid, "arvid@example.com", "arvid"], [kira, "kira@example.com", "kira"]] as const) {
    await alex.client().invite(login, handle, "member");
    expect((await n.client().join(alex.peerAddr)).admitted).toBe(true);
  }
}, 90_000);
afterAll(async () => { await c.close(); });

describe("seats round 11", () => {
  test("MEDIUM: no split run is accepted in the startup window while seats.json holds a quarantined seat user", async () => {
    await arvid.client("").seatsConfig({ allow: true, ephemeral: true });
    await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "arvid takes seats" });
    const id = (await alex.client().seatRun({ machine: "arvid-mac", runtime: "codex", prompt: "ticker 600 q" })).seat;
    await waitFor(async () => (((await alex.client().seats(id)).seats[0] as SeatView | undefined)?.state === "running" ? true : null), { timeoutMs: 20_000, what: "running" });
    world.broken.add("destroy-files");
    try {
      await arvid.client("").seatsConfig({ allow: false });
      expect((await arvid.client("").seats()).local.quarantined?.length ?? 0).toBeGreaterThan(0);
      // A slow tailnet answer at startup: the local API is up long before seats.init().
      (arvid.spec as { identity?: (f: FakeIdentity) => unknown }).identity = (f: FakeIdentity) => ({
        kind: "fake", whois: (ip: string, h: Headers) => f.whois(ip, h), self: async () => { await Bun.sleep(2500); return f.self(); },
      });
      const gguf = join(c.root, "m.gguf");
      writeFileSync(gguf, "x".repeat(4096));
      const rtDir = (arvid.spec as { pool: { llamaDir: string } }).pool.llamaDir;
      const pidf = join(c.root, "srv.pid");
      writeFileSync(join(rtDir, "llama-server"), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "--list-devices" ]; then echo "Available devices:"; echo "  MTL0: Apple fake (1000 MiB, 1000 MiB free)"; exit 0; fi; done\necho $$ > ${pidf}\nexec sleep 40\n`);
      chmodSync(join(rtDir, "llama-server"), 0o755);
      await arvid.stop();
      const starting = arvid.start();
      let accepted: string | null = null;
      let refusedBySeats = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 5_000) {
        try {
          accepted = JSON.stringify(await arvid.client("").poolRun({ file: gguf, machines: ["arvid-mac"] })).slice(0, 200);
          break;
        } catch (err) {
          if ((err as Error).message.includes(SEATS_POOL_CONFLICT)) refusedBySeats++;
        }
        await Bun.sleep(20);
      }
      await starting;
      (arvid.spec as { identity?: unknown }).identity = undefined;
      expect(accepted).toBeNull();
      expect(refusedBySeats).toBeGreaterThan(0); // the API was up and said why
      expect(block(arvid)).toContain("not verified removed");
      await Bun.sleep(500);
      if (existsSync(pidf)) {
        const pid = Number(readFileSync(pidf, "utf8").trim());
        const up = alive(pid);
        if (up) process.kill(pid, "SIGKILL"); // exact PID of the stand-in this test wrote
        expect(up).toBe(false);
      }
      expect(arvid.d.core.pool!.runner.view()).toBeNull();
    } finally {
      world.broken.delete("destroy-files");
    }
  }, 90_000);

  test("Kimi r11 LOW 2: seat users seats.json lost, found by the helper at start, keep the pool off even with seat users off", async () => {
    await arvid.client("").seatsConfig({ allow: false, ephemeral: null }); // not configured for seat users now
    await arvid.restart(); // the earlier test's quarantined user is destroyed (verified) at start
    await waitFor(() => (block(arvid) === null ? true : null), { timeoutMs: 20_000, what: "clean" });
    expect((await world.admin("create", 90)).ok).toBe(true); // held by the helper, unknown to seats.json
    world.broken.add("destroy-files"); // and it can't be verified removed
    try {
      await arvid.restart();
      await waitFor(() => (block(arvid)?.includes("not verified removed") ? true : null), { timeoutMs: 20_000, what: "the found user blocks the pool" });
      const share = await arvid.client("").poolShare(true, null).then(() => "accepted", (e: Error) => e.message);
      expect(share).toContain(SEATS_POOL_CONFLICT);
      expect(share).toContain("walkie-s90");
    } finally {
      world.broken.delete("destroy-files");
    }
  }, 90_000);

  test("Kimi r11 LOW 3 / AGENT-ADMIN-1: pool writes from a CLI marked as running under an agent are admin: refused while agent admin is off", async () => {
    const under = new WalkieClient({ socket: kira.socket, underAgent: true, timeoutMs: 15_000 });
    await kira.client("").adminSwitches({ agent_admin: false });
    try {
      await expect(under.poolShare(true, null)).rejects.toMatchObject({ status: 403, code: "agent_admin_off" });
      await expect(under.poolRun({ file: "/tmp/x.gguf" })).rejects.toMatchObject({ status: 403, code: "agent_admin_off" });
      await expect(under.poolStop()).rejects.toMatchObject({ status: 403, code: "agent_admin_off" });
      expect((await under.pool()).share.on).toBe(false); // reading stays open
    } finally {
      await kira.client("").adminSwitches({ agent_admin: true });
    }
  }, 30_000);

  test("LOW: an unreadable helper list blocks only while it matters; seat users off with none left release it, retries stop", async () => {
    await kira.client("").seatsConfig({ allow: true, ephemeral: true });
    await kira.client("").seatsConfig({ allow: false });
    await waitFor(() => (block(kira) === null ? true : null), { what: "clean" });
    brokenPending = true;
    try {
      await kira.restart();
      await waitFor(() => (block(kira)?.includes("hasn't yet listed") ? true : null), { what: "blocked by the unread list (seat users still on)" });
      expect(block(kira)).toContain("walkie seats setup-user --apply");
      // Seat users off, and seats.json holds none: the list no longer matters.
      await kira.client("").seatsConfig({ allow: false, ephemeral: null });
      expect(block(kira)).toBeNull();
      expect((await kira.client("").seats()).local.reconcile_error).toBeUndefined();
      expect(await kira.client("").poolShare(true, null).then(() => "accepted", (e: Error) => e.message)).toBe("accepted");
      await kira.client("").poolShare(false, null);
      const calls = pendingCalls;
      await Bun.sleep(1_000); // five retry periods
      expect(pendingCalls).toBe(calls);
      // A restart agrees: seat users off, none held, so the unread list doesn't block.
      await kira.restart();
      await Bun.sleep(300);
      expect(block(kira)).toBeNull();
    } finally {
      brokenPending = false;
    }
  }, 90_000);
});
