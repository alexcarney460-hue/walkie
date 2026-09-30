// Seats and compute sharing are never on together on one machine (Opus seats r9 HIGH): a pool stage's rpc-server and
// a run head's llama-server listen on loopback, which a seat user can reach, and neither can tell users apart.
//   seats on   -> no sharing, no stage (even with pool_share left on in config.json), no run head; the CLI says why
//   pool on    -> seats can't be allowed (sharing on, a stage served, a run headed), enable says which to turn off
//   both in config.json (hand-edited) -> neither runs: no stage, and a seat launch fails with the reason
// Seat users: the REAL helper logic over a fake system. Pool: stand-in rpc-servers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ctx } from "../../src/cli/context.ts";
import { enableSeats } from "../../src/cli/commands/seats-enable.ts";
import { doctorChecks } from "../../src/daemon/seats/doctor.ts";
import { saveConfigField } from "../../src/daemon/config.ts";
import { PeerCallError } from "../../src/daemon/peer-client.ts";
import { SEATS_POOL_CONFLICT, TERMINAL_STATES, type SeatView } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, signInCodex } from "../helpers/fake-seat-users.ts";
import { runAsPerson } from "../helpers/person-cli.ts";
import { ACCEPT_STANDIN, fakeRuntime } from "../helpers/pool-runtime.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const CLI = join(import.meta.dir, "../../src/cli/main.ts");
const GiB = 1024 ** 3;
let c: Cluster;
let alex: TestNode;
let arvid: TestNode;

const addrOn = (from: TestNode, to: TestNode) => from.d.client.addrOf(from.d.core.roster.nodes.get(to.d.nodeId)!)!;
const run = (ch: string): string => ch.repeat(32);

async function fails(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; return { code: "ok", message: "" }; } catch (err) {
    const e = err as { status?: number; code?: string; message: string };
    return { code: err instanceof PeerCallError ? `${err.status}:${err.code}` : `${e.status ?? "?"}:${e.code ?? "?"}`, message: e.message };
  }
}

function ctxFor(node: TestNode): { ctx: Ctx; out: string[] } {
  const out: string[] = [];
  const client = node.client("");
  const ctx = { args: { pos: [], flags: new Map() }, json: false, forAgent: false, client: () => client, out: (x: string) => out.push(x), err: (x: string) => out.push(x) } as unknown as Ctx;
  return { ctx, out };
}

beforeAll(async () => {
  c = new Cluster();
  const personHome = join(c.root, "arvid-home");
  mkdirSync(join(personHome, ".claude"), { recursive: true });
  chmodSync(personHome, 0o700);
  writeFileSync(join(personHome, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "access-token", refreshToken: "rt", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference"] } }), { mode: 0o600 });
  signInCodex(personHome);
  const walkieHome = join(c.root, "arvid");
  const world = fakeSeatWorld(c.root, walkieHome);
  const dir = fakeRuntime(c.root, "fake-rpc");
  const pool = { llamaDir: dir, verifyRuntime: ACCEPT_STANDIN, leaseMs: 120_000, freeMemory: async () => 8 * GiB };
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", pool });
  mkdirSync(walkieHome, { recursive: true });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac", pool,
    seats: {
      flushMs: 100, launchesPerMinute: 100, userSwitch: world.userSwitch, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles, admin: world.admin,
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: personHome },
    },
  });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
}, 60_000);

afterAll(async () => { await c.close(); });

describe("seats on: nothing of the pool runs here", () => {
  test("sharing can't be turned on (daemon and CLI), no run is headed from here, and nothing is offered to the team", async () => {
    await arvid.client("").seatsConfig({ allow: true, ephemeral: true });
    const share = await fails(arvid.client("").poolShare(true, null));
    expect(share.code).toBe("409:seats_pool_conflict");
    expect(share.message).toContain(SEATS_POOL_CONFLICT);
    expect(share.message).toContain("walkie seats deny");
    expect((await arvid.client("").pool()).share.on).toBe(false);
    const cli = await runAsPerson([process.execPath, CLI, "pool", "share", "on"], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: arvid.home, WALKIE_SOCKET: arvid.socket });
    expect(cli.code).not.toBe(0);
    expect(cli.err).toContain(SEATS_POOL_CONFLICT);
    expect(cli.err).toContain("walkie seats deny");
    // The head side: llama-server listens on loopback too.
    const head = await fails(arvid.client("").poolRun({ file: "/tmp/x.gguf", machines: ["alex-mbp"] }));
    expect(head.code).toBe("409:seats_pool_conflict");
    expect(head.message).toContain("walkie seats deny");
    await arvid.client("").seatsConfig({ allow: false, ephemeral: true });
  }, 60_000);

  test("pool_share left on in config.json: no stage starts here, sharing isn't offered, and a seat launch fails saying why", async () => {
    await arvid.client("").seatsConfig({ allow: true, ephemeral: true });
    saveConfigField(arvid.d.core.paths.config, "pool_share", true); // hand-edited, or an older release's config
    await arvid.restart();
    expect((await arvid.client("").pool()).share.on).toBe(true);
    expect(arvid.d.core.pool!.published().share).toBe(false);
    const stage = await fails(alex.d.client.stage(addrOn(alex, arvid), { action: "start", run: run("b"), bytes: 1024, model: "x" }));
    expect(stage.code).toBe("409:seats_pool_conflict");
    expect(arvid.d.core.pool!.view().stage).toBeNull();
    const { local } = await arvid.client("").seats();
    expect(local.disabled_reason).toContain(SEATS_POOL_CONFLICT);
    expect(local.disabled_reason).toContain("walkie pool share off");
    const checks = doctorChecks(local, { team: "aka", release: false, runnerProblem: null, helper: "ok", rootsFile: "ok", runtimes: { claude: "/x", codex: "/x" } });
    expect(checks.some((k) => k.ok === false && k.what.includes(SEATS_POOL_CONFLICT))).toBe(true);
    await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "arvid-mac takes seats" });
    const id = (await alex.client().seatRun({ machine: arvid.d.nodeId, runtime: "codex", prompt: "while sharing" })).seat;
    const s = await waitFor(async () => {
      const v = (await alex.client().seats(id)).seats[0] as SeatView | undefined;
      return v && TERMINAL_STATES.has(v.state) ? v : null;
    }, { timeoutMs: 40_000, what: "the seat to end" });
    expect(s.state).toBe("failed");
    expect(s.reason).toContain(SEATS_POOL_CONFLICT);
    await arvid.client("").seatsConfig({ allow: false, ephemeral: true });
    await arvid.client("").poolShare(false, null);
  }, 90_000);
});

describe("pool on: seats can't be allowed", () => {
  test("sharing on: allow is refused naming `walkie pool share off`, and enable says so before any setup", async () => {
    await arvid.client("").poolShare(true, null);
    const allow = await fails(arvid.client("").seatsConfig({ allow: true, ephemeral: true }));
    expect(allow.code).toBe("409:seats_pool_conflict");
    expect(allow.message).toContain(SEATS_POOL_CONFLICT);
    expect(allow.message).toContain("Compute sharing is on here");
    expect(allow.message).toContain("walkie pool share off");
    expect((await arvid.client("").seats()).local.allow).toBe(false);
    const { ctx, out } = ctxFor(arvid);
    let setupRan = false;
    const r = await enableSeats(ctx, { setupSeatUsers: async () => { setupRan = true; return { ok: true, applied: true }; } });
    expect(r).toBeNull();
    expect(setupRan).toBe(false);
    expect(out.join("\n")).toContain("walkie pool share off");
    expect((await arvid.client("").seats()).local.pool_conflict).toContain(SEATS_POOL_CONFLICT);
  }, 60_000);

  test("a stage served here: allow is refused while it runs; sharing off ends it and seats can then be allowed", async () => {
    const R = run("c");
    expect((await alex.d.client.stage(addrOn(alex, arvid), { action: "start", run: R, bytes: 1024, model: "x" })).ok).toBe(true);
    const allow = await fails(arvid.client("").seatsConfig({ allow: true, ephemeral: true }));
    expect(allow.code).toBe("409:seats_pool_conflict");
    expect(allow.message).toContain("This machine is serving a stage of a split run");
    expect(allow.message).toContain("walkie pool share off");
    await arvid.client("").poolShare(false, null);
    expect(arvid.d.core.pool!.view().stage).toBeNull();
    expect((await arvid.client("").seatsConfig({ allow: true, ephemeral: true })).local.allow).toBe(true);
    await arvid.client("").seatsConfig({ allow: false, ephemeral: true });
  }, 60_000);

  test("a run headed here: allow is refused naming `walkie pool stop`", () => {
    const pool = arvid.d.core.pool!;
    const runner = pool.runner as unknown as { view: () => unknown };
    const real = runner.view;
    runner.view = () => ({ state: "serving" }); // a live head run (a real one needs a real llama-server)
    try {
      const why = pool.seatsConflict();
      expect(why).toContain(SEATS_POOL_CONFLICT);
      expect(why).toContain("A split run is running from here");
      expect(why).toContain("walkie pool stop");
    } finally {
      runner.view = real;
    }
    expect(pool.seatsConflict()).toBeNull();
  });
});
