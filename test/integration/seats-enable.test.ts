// "This should all be handled by the sign-up link" (the seats product requirement), end to end with the REAL CLI
// (`bun src/cli/main.ts …`) against two in-process daemons, seat users made by the real helper logic over a fake
// system (test/helpers/fake-seat-users.ts): `walkie seats doctor` says what isn't ready and the fix; `walkie seats
// enable --yes` turns seats on in one step and says what it did (in a source build it can't install the root helper,
// and says so); `walkie seats start <machine> --count N --provider … --brief file` starts N agents there; Codex seats
// run on the machine's own Codex sign-in, handed to each run only; without it they are refused with the fix.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ctx } from "../../src/cli/context.ts";
import { doctorChecks, doctorLines, enableSeats } from "../../src/cli/commands/seats-enable.ts";
import { TERMINAL_STATES, type SeatView, type SeatsLocalView } from "../../src/protocol/seats.ts";
import { seatsFor } from "../../src/daemon/seats/host.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";
import { FAKE_CODEX_AUTH, fakeSeatWorld, signInCodex, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
const FIXTURES = join(import.meta.dir, "..", "fixtures");
let c: Cluster;
let alex: TestNode;
let arvid: TestNode;
let world: FakeSeatWorld;
let log: string;
let personHome: string;

async function walkie(node: TestNode, args: string[], env: Record<string, string> = {}) {
  // As a person would (test/helpers/person-cli.ts): detached from this test's own process ancestry, which may include
  // an agent runtime that agent-detect.ts would rightly count.
  return runAsPerson([process.execPath, CLI, ...args], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: node.home, WALKIE_SOCKET: node.socket, ...env });
}
const seatOn = async (id: string): Promise<SeatView | undefined> => (await alex.client().seats(id)).seats[0];
const ended = (id: string) =>
  waitFor(async () => { const s = await seatOn(id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id} to end` });
const lines = (): Array<Record<string, unknown>> =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];

beforeAll(async () => {
  c = new Cluster();
  personHome = join(c.root, "arvid-home");
  mkdirSync(join(personHome, ".claude"), { recursive: true });
  chmodSync(personHome, 0o700);
  writeFileSync(join(personHome, ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"the-machines-own-login","refreshToken":"the-machines-refresh-token"}}', { mode: 0o600 });
  signInCodex(personHome);
  log = join(c.root, "codex.jsonl");
  const walkieHome = join(c.root, "arvid");
  world = fakeSeatWorld(c.root, walkieHome);
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  mkdirSync(walkieHome, { recursive: true });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: {
      flushMs: 100, launchesPerMinute: 100, userSwitch: world.userSwitch, admin: world.admin, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${join(FIXTURES, "fake-claude")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: personHome, FAKE_CODEX_LOG: log },
    },
  });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
}, 60_000);

afterAll(async () => { await c.close(); });

describe("seats from the sign-up link", () => {
  test("doctor before: seats off, with the one command that fixes it", async () => {
    const r = await walkie(arvid, ["seats", "doctor"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("✓ in the team aka");
    expect(r.out).toContain("✗ seats are off here  → walkie seats enable");
    expect(r.out).toContain("Not ready");
  }, 30_000);

  test("AGENT-ADMIN-1: an agent (or no terminal) needs no yes, but not while agent admin is off; a source build can't install the helper; seats stay off", async () => {
    await arvid.client("").adminSwitches({ agent_admin: false });
    const off = await walkie(arvid, ["seats", "enable", "--yes"], { CLAUDECODE: "1" });
    expect([off.code, off.err.includes("agent_admin_off")]).toEqual([1, true]);
    await arvid.client("").adminSwitches({ agent_admin: true });
    for (const env of [{}, { CLAUDECODE: "1" }] as Record<string, string>[]) {
      const r = await walkie(arvid, ["seats", "enable"], env); // no terminal: an agent of the person's, no prompt
      expect([r.code, r.err.includes("run it from an installed walkie")]).toEqual([1, true]);
    }
    const src = await walkie(arvid, ["seats", "enable", "--yes"]);
    expect(src.code).toBe(1);
    expect(src.err).toContain("run it from an installed walkie");
    expect(src.err).toContain("seats were not turned on");
    expect((await arvid.client("").seats()).local.allow).toBe(false);
  }, 30_000);

  test("enable --yes with seat users set up: one step, what it did, and the doctor's verdict", async () => {
    // What `walkie seats setup-user --apply` leaves (in a test: the fake seat users of the helper's real logic).
    await arvid.client("").seatsConfig({ allow: false, ephemeral: true, env: ["FAKE_CODEX_LOG"] });
    const r = await walkie(arvid, ["seats", "enable", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Seats are on for this machine.");
    expect(r.out).toContain("✓ seat users were already set up");
    expect(r.out).toContain("✓ seats allowed: the team's owners may start up to 3 at once here, each as a fresh seat user");
    expect(r.out).toContain("✓ Claude seats: logged in (this machine's own login)");
    expect(r.out).toContain("✓ Codex seats: signed in (this machine's own sign-in)");
    expect(r.out).toContain("Ready: the team can start Claude and Codex seats on this machine.");
    await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.hostname === "arvid-mac" && h.allows && h.member), { what: "alex sees arvid-mac take seats" });
  }, 30_000);

  test("seats start --count 3 --provider codex --brief file: three agents there, each on the machine's own Codex sign-in, handed to that run only", async () => {
    const brief = join(c.root, "brief.md");
    writeFileSync(brief, "codex-auth\nDo the thing described here.\n");
    const r = await walkie(alex, ["seats", "start", "arvid-mac", "--count", "3", "--provider", "codex", "--brief", brief]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("requested 3 codex seats on arvid-mac");
    const ids = r.out.split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{16}:\d+$/.test(l));
    expect(ids.length).toBe(3);
    for (const id of ids) expect((await ended(id)).state).toBe("done");
    const auths = lines().filter((l) => "codex_auth" in l);
    expect(auths.length).toBe(3);
    for (const a of auths) expect(a.codex_auth).toEqual({ text: FAKE_CODEX_AUTH, mode: "600" });
    expect(new Set(auths.map((a) => a.codex_home)).size).toBe(3); // three runs, three fresh homes
    for (const a of auths) expect(existsSync(a.codex_home as string)).toBe(false); // gone with their users
  }, 90_000);

  test("start refuses a count over 10 and a missing task", async () => {
    expect((await walkie(alex, ["seats", "start", "arvid-mac", "--count", "11", "--prompt", "x"])).err).toContain("--count must be 1–10");
    expect((await walkie(alex, ["seats", "start", "arvid-mac"])).err).toContain("--prompt");
  }, 30_000);

  test("without the machine's Codex sign-in, Codex seats are refused with the fix; the doctor says so", async () => {
    const auth = join(personHome, ".codex", "auth.json");
    rmSync(auth);
    try {
      const d = await walkie(arvid, ["seats", "doctor"]);
      expect(d.out).toContain("✗ Codex seats: not signed in where seat users can use it (no ~/.codex/auth.json)  → codex login");
      expect(d.out).toContain("Ready: the team can start Claude seats on this machine.");
      const r = await walkie(alex, ["seats", "start", "arvid-mac", "--provider", "codex", "--prompt", "hello"]);
      const id = r.out.split("\n").map((l) => l.trim()).find((l) => /^[0-9a-f]{16}:\d+$/.test(l)) as string;
      const s = await ended(id);
      expect(s.state).toBe("failed");
      expect(s.reason).toContain("codex login");
    } finally {
      signInCodex(personHome);
    }
  }, 60_000);

  test("enable on a machine without seat users runs the setup (its sudo step) first, then allows, and prints both", async () => {
    await arvid.client("").seatsConfig({ allow: false, ephemeral: false });
    const out: string[] = [];
    let setupRan = 0;
    const ctx = { args: { pos: [], flags: new Map() }, json: false, forAgent: false, client: () => arvid.client(""), out: (x: string) => out.push(x), err: (x: string) => out.push(x) } as unknown as Ctx;
    const local = await enableSeats(ctx, {
      setupSeatUsers: async () => { setupRan++; await arvid.client("").seatsConfig({ allow: false, ephemeral: true }); return { ok: true, applied: true }; },
    });
    expect(setupRan).toBe(1);
    expect(local).toMatchObject({ allow: true, ephemeral: true });
    expect(local?.disabled_reason).toBeUndefined();
    const text = out.join("\n");
    expect(text).toContain("Setting up seat users");
    expect(text).toContain("✓ set up seat users: the group walkie-seats");
    expect(text).toContain("✓ seats allowed");
    // A failed setup leaves seats off and says why.
    await arvid.client("").seatsConfig({ allow: false, ephemeral: false });
    const failed = await enableSeats(ctx, { setupSeatUsers: async () => ({ ok: false, applied: false, why: "sudo: a password is required" }) });
    expect(failed).toBeNull();
    expect(out.join("\n")).toContain("seats were not turned on: sudo: a password is required");
    expect((await arvid.client("").seats()).local.allow).toBe(false);
    await arvid.client("").seatsConfig({ allow: true, ephemeral: true, env: ["FAKE_CODEX_LOG"] });
  }, 30_000);
});

describe("ready for Walkie Direct (the Direct-only host itself runs on the release branch, which has Direct)", () => {
  test("the repo bundle is fetched where the peer client says the host is reached (its key on Direct), never a hard-coded ip:port", async () => {
    // Seat requests and output are events in the host's seats channel (sync over the peer client, whatever its
    // transport). The one peer call of its own, the bundle fetch, asks the client for the address when it can.
    const repo = join(c.root, "direct-repo");
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd: repo, stderr: "pipe" });
    git("init", "-q");
    writeFileSync(join(repo, "README.md"), "hello\n");
    git("add", "."); git("commit", "-qm", "first");
    const client = (seatsFor(arvid.d.core) as unknown as { deps: { client: { addrOf?: (n: { node_id: string; ip: string; port: number }) => unknown } } }).deps.client;
    const asked: string[] = [];
    client.addrOf = (n) => { asked.push(n.node_id); return { ip: n.ip, port: n.port }; };
    try {
      const r = await walkie(alex, ["seat", "run", "--machine", "arvid-mac", "--runtime", "codex", "--repo", repo, "--", "read the repo"]);
      expect(r.code).toBe(0);
      const id = /seat ([0-9a-f]{16}:\d+)/.exec(r.out)?.[1] as string;
      expect((await ended(id)).state).toBe("done");
      expect(asked).toContain(alex.d.nodeId);
    } finally {
      delete client.addrOf;
    }
  }, 60_000);
});

describe("the doctor's verdict", () => {
  const base = {
    allow: true, ephemeral: true, same_user: false, channel_ok: true, launchers: [], claude_login: "machine", codex_login: "machine", max: 3,
  } as unknown as SeatsLocalView;
  const facts = { team: "aka", release: true, runnerProblem: null, helper: "ok", rootsFile: "ok", runtimes: { claude: "/x/claude", codex: "/x/codex" } } as const;
  const plain = (l: string[]) => l.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  test("ready with both; Keychain-only Claude still ready for Codex; a helper sudo can't reach is not ready", () => {
    expect(plain(doctorLines(doctorChecks(base, facts)))).toContain("Ready: the team can start Claude and Codex seats on this machine.");
    const kc = plain(doctorLines(doctorChecks({ ...base, claude_login: "unavailable" }, facts)));
    expect(kc).toContain("✗ Claude seats: this machine's Claude login is only in its Keychain, which seat users can't use  → claude setup-token, then walkie seats token set < token.txt");
    expect(kc).toContain("Ready: the team can start Codex seats on this machine.");
    const noHelper = plain(doctorLines(doctorChecks(base, { ...facts, helper: "sudo -n … didn't answer (a password is required)" })));
    expect(noHelper).toContain("✗ the user helper: sudo -n … didn't answer (a password is required)  → walkie seats setup-user --apply");
    expect(noHelper).toContain("Not ready");
  });
});
