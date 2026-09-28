// SEATS-FIX-8 end to end: a restart whose helper can't list the seat users it still holds makes no new seat user
// until it can (retried), and says so (Codex r8 MEDIUM 2); `seats enable` stores a dedicated Claude token before it
// allows seats (Codex r8 MEDIUM 5). Seat users: the REAL helper logic over a fake system.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { doctorChecks, enableSeats } from "../../src/cli/commands/seats-enable.ts";
import type { AdminResult, AdminVerb } from "../../src/daemon/seats/admin.ts";
import { TERMINAL_STATES, type SeatView } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, signInCodex, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
let c: Cluster;
let alex: TestNode;
let arvid: TestNode;
let world: FakeSeatWorld;
let pendingFails = false;

const seatOn = async (id: string): Promise<SeatView | undefined> => (await alex.client().seats(id)).seats[0];
const ended = (id: string) =>
  waitFor(async () => { const s = await seatOn(id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id} to end` });

beforeAll(async () => {
  c = new Cluster();
  const personHome = join(c.root, "arvid-home");
  mkdirSync(join(personHome, ".claude"), { recursive: true });
  chmodSync(personHome, 0o700);
  writeFileSync(join(personHome, ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"at","refreshToken":"rt"}}', { mode: 0o600 });
  signInCodex(personHome);
  const walkieHome = join(c.root, "arvid");
  world = fakeSeatWorld(c.root, walkieHome);
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  mkdirSync(walkieHome, { recursive: true });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: {
      flushMs: 100, launchesPerMinute: 100, reconcileRetryMs: 300, userSwitch: world.userSwitch, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
      admin: async (verb: AdminVerb, n: number): Promise<AdminResult> => (verb === "pending" && pendingFails ? { ok: false, code: "refused", why: "sudo: a password is required" } : world.admin(verb, n)),
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: personHome },
    },
  });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  await arvid.client("").seatsConfig({ allow: true, ephemeral: true });
  await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "arvid-mac takes seats" });
}, 60_000);

afterAll(async () => { await c.close(); });

describe("SEATS-FIX-8", () => {
  test("Codex r8 MEDIUM 2: after a restart whose pending list failed, no seat user is made (and the doctor says why) until it succeeds", async () => {
    pendingFails = true;
    await arvid.restart();
    const { local } = await arvid.client("").seats();
    expect(local.reconcile_error).toContain("sudo: a password is required");
    const bad = doctorChecks(local, { team: "aka", release: false, runnerProblem: null, helper: "ok", rootsFile: "ok", runtimes: { claude: "/x", codex: "/x" } });
    expect(bad.some((k) => k.ok === false && k.what.includes("new seats wait"))).toBe(true);
    const before = world.created.length;
    const s = await ended((await alex.client().seatRun({ machine: arvid.d.nodeId, runtime: "codex", prompt: "while unknown" })).seat);
    expect(s.state).toBe("failed");
    expect(s.reason).toMatch(/no seat user can be made yet: Walkie couldn't list the seat users its helper still holds/);
    expect(world.created.length).toBe(before);
    pendingFails = false; // the next retry lists them
    await waitFor(async () => ((await arvid.client("").seats()).local.reconcile_error === undefined ? true : null), { what: "reconciled on retry" });
    expect((await ended((await alex.client().seatRun({ machine: arvid.d.nodeId, runtime: "codex", prompt: "after it" })).seat)).state).toBe("done");
  }, 90_000);

  test("Codex r8 MEDIUM 5: enable stores the dedicated Claude token before it allows seats", async () => {
    await arvid.client("").seatsConfig({ allow: false, ephemeral: true });
    const calls: string[] = [];
    const real = arvid.client("");
    const client = new Proxy(real, {
      get(t, k) {
        const v = Reflect.get(t, k) as unknown;
        if (k === "seatsToken" || k === "seatsConfig") return (...a: unknown[]) => { calls.push(`${String(k)}${k === "seatsConfig" ? `:${(a[0] as { allow: boolean }).allow}` : ""}`); return (v as (...x: unknown[]) => unknown).apply(t, a); };
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    }) as WalkieClient;
    const out: string[] = [];
    const ctx = { args: { pos: [], flags: new Map() }, json: false, forAgent: false, client: () => client, out: (x: string) => out.push(x), err: (x: string) => out.push(x) } as unknown as Ctx;
    const local = await enableSeats(ctx, { claudeToken: `Your token:\nsk${""}-ant-oat01-${"z".repeat(60)}\n` });
    expect(local?.claude_login).toBe("dedicated");
    expect(calls).toEqual(["seatsToken", "seatsConfig:true"]);
    // A text that isn't a token turns nothing on.
    await arvid.client("").seatsConfig({ allow: false, ephemeral: true });
    expect(await enableSeats(ctx, { claudeToken: "nope" })).toBeNull();
    expect((await arvid.client("").seats()).local.allow).toBe(false);
    await arvid.client("").seatsToken(null);
  }, 30_000);
});
