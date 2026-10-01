// "This should all be handled by the sign-up link" (the seats product requirement), end to end with the REAL CLI
// (`bun src/cli/main.ts …`) against two in-process daemons, seat users made by the real helper logic over a fake
// system (test/helpers/fake-seat-users.ts): `walkie seats doctor` says what isn't ready and the fix; `walkie seats
// enable --yes` turns seats on in one step and says what it did (in a source build it can't install the root helper,
// and says so); `walkie seats start <machine> --count N --provider … --brief file` starts N agents there; Codex seats
// run on the machine's own Codex sign-in, handed to each run only; without it they are refused with the fix.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "../../src/cli/args.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import { teamAgentsStep } from "../../src/cli/commands/team-agents.ts";
import { WalkieClient } from "../../src/client/index.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { doctorLines, enableSeats } from "../../src/cli/commands/seats-enable.ts";
import { doctorChecks } from "../../src/daemon/seats/doctor.ts";
import { TERMINAL_STATES, type SeatView, type SeatsLocalView } from "../../src/protocol/seats.ts";
import { seatsFor } from "../../src/daemon/seats/host.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";
import { FAKE_CODEX_AUTH, fakeSeatWorld, signInCodex, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";
import { noKeychainSeats } from "../helpers/no-keychain.ts";

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
  writeFileSync(join(personHome, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "the-machines-own-login", refreshToken: "the-machines-refresh-token", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference"] } }), { mode: 0o600 });
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

  test("AGENT-ADMIN-1: an agent needs admin permission; default company enable needs no helper or sudo", async () => {
    await arvid.client("").adminSwitches({ agent_admin: false });
    const off = await walkie(arvid, ["seats", "enable", "--yes"], { CLAUDECODE: "1" });
    expect([off.code, off.err.includes("agent_admin_off")]).toEqual([1, true]);
    await arvid.client("").adminSwitches({ agent_admin: true });
    const src = await walkie(arvid, ["seats", "enable", "--yes"]);
    expect(src.code).toBe(0);
    expect(src.out).toContain("as your own OS user");
    expect(src.out).not.toContain("Setting up seat users");
    expect((await arvid.client("").seats()).local).toMatchObject({ allow: true, same_user: true, ephemeral: false });
    const saved = JSON.parse(readFileSync(join(arvid.home, "config.json"), "utf8")) as { seats: { mode?: string } };
    expect(saved.seats.mode).toBe("same_user");
  }, 30_000);

  test("--seat-users explicitly opts into helper setup, while default enable never does", async () => {
    const r = await walkie(arvid, ["seats", "enable", "--yes", "--seat-users"]);
    expect(r.code).toBe(1); // source build has no installable root helper
    expect(r.out).toContain("Setting up seat users");
    expect(r.err).toContain("run it from an installed walkie");
    expect((await arvid.client("").seats()).local).toMatchObject({ allow: true, same_user: true, ephemeral: false });
  }, 30_000);

  test("enable --yes with seat users set up: one step, what it did, and the doctor's verdict", async () => {
    // What `walkie seats setup-user --apply` leaves (in a test: the fake seat users of the helper's real logic).
    await arvid.client("").seatsConfig({ allow: false, ephemeral: true, env: ["FAKE_CODEX_LOG"] });
    const r = await walkie(arvid, ["seats", "enable", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Seats are on for this machine.");
    expect(r.out).toContain("✓ seat users were already set up");
    expect(r.out).toContain("✓ seats allowed: the team's owners and their agents may start up to 3 at once here, each as a fresh seat user");
    expect(r.out).toContain("✓ Claude seats: using this machine's login");
    expect(r.out).toContain("a running seat can read this machine's short-lived Claude access token, never the refresh token");
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
      expect(d.out).toContain("✗ Codex seats: this machine's Codex isn't signed in where a seat user can use it (no ~/.codex/auth.json): its person runs codex login (file credential store), then walkie seats doctor");
      expect(d.out).toContain("Not ready");
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
    const local = await enableSeats(ctx, { seatUsers: true,
      setupSeatUsers: async () => { setupRan++; await arvid.client("").seatsConfig({ allow: false, ephemeral: true }); return { ok: true, applied: true }; },
    });
    expect(setupRan).toBe(1);
    expect(local).toMatchObject({ allow: true, ephemeral: true });
    expect(local?.disabled_reason).toBeUndefined();
    const text = out.join("\n");
    expect(text).toContain("Setting up seat users");
    expect(text).toContain("✓ set up seat users: the group walkie-seats");
    expect(text).toContain("✓ seats allowed");
    expect((JSON.parse(readFileSync(join(arvid.home, "config.json"), "utf8")) as { seats: { mode?: string } }).seats.mode).toBe("seat_users");
    // A failed setup leaves seats off and says why.
    await arvid.client("").seatsConfig({ allow: false, ephemeral: false });
    const failed = await enableSeats(ctx, { seatUsers: true, setupSeatUsers: async () => ({ ok: false, applied: false, why: "sudo: a password is required" }) });
    expect(failed).toBeNull();
    expect(out.join("\n")).toContain("seats were not turned on: sudo: a password is required");
    expect((await arvid.client("").seats()).local.allow).toBe(false);
    await arvid.client("").seatsConfig({ allow: true, ephemeral: true, env: ["FAKE_CODEX_LOG"] });
  }, 30_000);

  test("an existing seat-user machine stays in that mode and doctor offers a read-only migration inventory", async () => {
    const out: string[] = [];
    const ctx = { args: { pos: [], flags: new Map() }, json: false, forAgent: false, client: () => arvid.client(""), out: (x: string) => out.push(x), err: (x: string) => out.push(x) } as unknown as Ctx;
    const local = await enableSeats(ctx, { setupSeatUsers: async () => { throw new Error("unexpected helper setup"); } });
    expect(local).toMatchObject({ ephemeral: true, same_user: false });
    const doctor = await walkie(arvid, ["seats", "doctor"]);
    expect(doctor.out).toContain("mode: seat users");
    expect(doctor.out).toContain("walkie seats migration-preflight");
    const pre = await walkie(arvid, ["seats", "migration-preflight", "--json"]);
    expect(pre.code).toBe(0);
    expect(JSON.parse(pre.out)).toMatchObject({ mode: "seat_users", quarantined: [], running: 0, queued: 0 });
    const refused = await enableSeats(ctx, { sameUser: true });
    expect(refused).toBeNull();
    expect(out.join("\n")).toContain("migration-preflight");
    await arvid.client("").seatsConfig({ allow: false });
    await expect(arvid.client("").seatsConfig({ allow: true, mode: "same_user" })).rejects.toThrow(/migration/i);
    await expect(arvid.client("worker").seatsConfig({ allow: true, mode: "same_user", migration_confirm: "migrate same-user seats" })).rejects.toThrow(/person/i);
    const migrated = await enableSeats(ctx, { sameUser: true });
    expect(migrated).toBeNull();
    expect((await arvid.client("").seats()).local).toMatchObject({ allow: false, ephemeral: true });
    const migratedView = await arvid.client("").seatsConfig({ allow: true, mode: "same_user", migration_confirm: "migrate same-user seats" });
    expect(migratedView.local).toMatchObject({ allow: true, same_user: true, ephemeral: false });
    await arvid.client("").seatsConfig({ allow: true, mode: "seat_users" });
  }, 30_000);

  const SEATS_PATH = `${join(FIXTURES, "fake-codex")}:${join(FIXTURES, "fake-claude")}:${dirname(process.execPath)}:/usr/bin:/bin`;
  /** A person's home signed in to Claude and Codex, which is what the doctor asks of a machine that takes seats. */
  function signedInHome(name: string): string {
    const home = join(c.root, `${name}-home`);
    mkdirSync(join(home, ".claude"), { recursive: true });
    chmodSync(home, 0o700);
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "the-machines-own-login", refreshToken: "the-machines-refresh-token", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference"] } }), { mode: 0o600 });
    signInCodex(home);
    return home;
  }

  /** A new machine of its own on alex's team (joined, seats off), so a test controls every switch. */
  async function freshMember(name: string): Promise<TestNode> {
    // Seats get turned on here: its Keychain and home are the test's own (never this machine's login Keychain or logins).
    const node = await c.add({ name, login: `${name}@example.com`, hostname: `${name}-mac`, seats: noKeychainSeats(signedInHome(name), { env: { PATH: SEATS_PATH } }) });
    await alex.client().invite(`${name}@example.com`, name, "member");
    expect((await node.client().join(alex.peerAddr)).admitted).toBe(true);
    return node;
  }
  const auditOf = (node: TestNode): string => {
    const path = join(node.home, "admin-audit.jsonl");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  /** The audit log's entries, parsed. */
  const auditEntries = (node: TestNode): Array<{ actor: string; action: string; via: string; refused?: string }> =>
    auditOf(node).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { actor: string; action: string; via: string; refused?: string });
  /** The "allowed seats" entries of the audit log: what a gate wrote for a change to this machine's seats. */
  const seatsEntries = (node: TestNode) => auditEntries(node).filter((e) => e.action.startsWith("allowed seats on this machine"));
  const savedSeats = (node: TestNode) => (JSON.parse(readFileSync(join(node.home, "config.json"), "utf8")) as { seats: { allow: boolean; mode?: string } }).seats;

  test("AGENT-ADMIN-1: an agent of the person's turns team agents on with the flags it gave (audited as it), and is refused while agent admin is off", async () => {
    const co = await freshMember("agentco");
    // Off: refused by the CLI before any request, and by the daemon for a request that names an agent; seats stay off.
    await co.client("").adminSwitches({ agent_admin: false });
    const off = await walkie(co, ["seats", "enable", "--yes"], { CLAUDECODE: "1" });
    expect([off.code, off.err.includes("agent_admin_off")]).toEqual([1, true]);
    const offDaemon = await co.client("worker").seatsConfig({ allow: true }).then(() => null, (e: { code?: string }) => e.code);
    expect(offDaemon).toBe("agent_admin_off");
    expect(auditOf(co)).toContain('"refused":"agent_admin_off"');
    expect((await co.client("").seats()).local.allow).toBe(false);
    // On: the CLI under an agent (no --yes needed: it goes ahead with what it gave) turns same-user seats on.
    await co.client("").adminSwitches({ agent_admin: true });
    const on = await walkie(co, ["seats", "enable"], { CLAUDECODE: "1" });
    expect(on.code).toBe(0);
    expect(on.out).toContain("Seats are on for this machine.");
    expect((await co.client("").seats()).local).toMatchObject({ allow: true, same_user: true, ephemeral: false });
    expect((JSON.parse(readFileSync(join(co.home, "config.json"), "utf8")) as { seats: { mode?: string } }).seats.mode).toBe("same_user");
    expect(auditOf(co)).toMatch(/"actor":"@agentco\/agentco-mac\/claude-code \(unnamed\)","action":"allowed seats on this machine: same-user/);
    // `walkie seats allow` (the older spelling) is the same gate.
    await co.client("").seatsConfig({ allow: false });
    const allow = await walkie(co, ["seats", "allow"], { CLAUDECODE: "1" });
    expect(allow.code).toBe(0);
    expect((await co.client("").seats()).local).toMatchObject({ allow: true, same_user: true });
    // The daemon alone (a named agent, no CLI) is the same gate: accepted and audited while on.
    await co.client("").seatsConfig({ allow: false });
    const named = await co.client("worker").seatsConfig({ allow: true });
    expect(named.local).toMatchObject({ allow: true, same_user: true });
    expect(auditOf(co)).toContain("@agentco/agentco-mac/worker");
    // What stays the person's, whatever agent admin says: migrating seat users, and inheriting personal provider config.
    const migrate = await co.client("worker").seatsConfig({ allow: true, mode: "same_user", migration_confirm: "migrate same-user seats" })
      .then(() => null, (e: { code?: string }) => e.code);
    expect(migrate).toBe("person_only");
    const inherit = await co.client("worker").seatsConfig({ allow: true, inherit_person_config: true }).then(() => null, (e: { code?: string }) => e.code);
    expect(inherit).toBe("person_only");
  }, 60_000);

  test("walkie setup's team-agents step under an agent applies --allow-team-agents against the real daemon, audited as the agent, and not while agent admin is off", async () => {
    const co = await freshMember("setupco");
    const lines: string[] = [];
    // What setup.ts builds under an agent: a client whose requests are marked, and a ctx whose agent marker is set.
    const ctx = { args: parseArgs(["--allow-team-agents"], CLI_BOOLEANS), json: false, forAgent: true,
      agentMarker: () => "CLAUDECODE is set in its environment", client: () => co.client(),
      out: (x: string) => lines.push(x), err: (x: string) => lines.push(x) } as unknown as Ctx;
    const deps = { interactive: false, ask: async () => "", checkRuntime: async () => ({ installed: true, loggedIn: true }), installSeatUsers: async () => true };
    const step = () => teamAgentsStep(ctx, new WalkieClient({ socket: co.socket, underAgent: true, timeoutMs: 15_000 }), deps, () => undefined);
    const prev = process.env.WALKIE_HOME;
    process.env.WALKIE_HOME = co.home; // agentAdminOn() reads this machine's own switch file
    try {
      await co.client("").adminSwitches({ agent_admin: false });
      expect(await step()).toBe("refused");
      expect(lines.join("\n")).toContain("agent admin is off");
      expect((await co.client("").seats()).local.allow).toBe(false);
      await co.client("").adminSwitches({ agent_admin: true });
      expect(await step()).toBe("allowed");
      expect((await co.client("").seats()).local).toMatchObject({ allow: true, same_user: true, ephemeral: false });
      expect(auditOf(co)).toMatch(/"actor":"@setupco\/setupco-mac\/[^"]+ \(unnamed\)","action":"allowed seats on this machine: same-user/);
    } finally {
      if (prev === undefined) delete process.env.WALKIE_HOME; else process.env.WALKIE_HOME = prev;
    }
  }, 60_000);

  test("a remote admin run (an owner's agent elsewhere) cannot turn same-user seats on for a machine whose person has not", async () => {
    const co = await freshMember("remoteco");
    const ran = await alex.client().adminRun({ machines: "remoteco-mac", argv: ["seats", "enable", "--yes"] });
    expect(ran.results[0]?.exit).not.toBe(0);
    expect(`${ran.results[0]?.stdout}${ran.results[0]?.stderr}`).toContain("its person turns them on here");
    expect((await co.client("").seats()).local.allow).toBe(false);
    // The refused attempt is audited as refused, never as an allowed change.
    expect(seatsEntries(co).length).toBeGreaterThan(0);
    expect(seatsEntries(co).every((e) => e.refused === "person_only" && e.via === "remote")).toBe(true);
    // Once its person has turned them on, remote admin tunes them as before.
    await co.client("").seatsConfig({ allow: true });
    const tuned = await alex.client().adminRun({ machines: "remoteco-mac", argv: ["seats", "enable", "--yes", "--max", "5"] });
    expect(tuned.results[0]?.exit).toBe(0);
    expect((await co.client("").seats()).local).toMatchObject({ allow: true, max: 5 });
  }, 60_000);

  test("a remote admin run cannot turn same-user seats back on after its person turned them off, and each refused attempt is audited as refused", async () => {
    const co = await freshMember("redeny");
    await co.client("").seatsConfig({ allow: true });
    await co.client("").seatsConfig({ allow: false });
    expect(savedSeats(co)).toMatchObject({ allow: false, mode: "same_user" }); // what `seats deny` leaves: off, with its mode kept
    for (const argv of [["seats", "allow"], ["seats", "enable", "--yes"]]) {
      const ran = await alex.client().adminRun({ machines: "redeny-mac", argv });
      expect(ran.results[0]?.exit).not.toBe(0);
      expect(`${ran.results[0]?.stdout}${ran.results[0]?.stderr}`).toContain("its person turns them on here");
      expect((await co.client("").seats()).local.allow).toBe(false);
    }
    expect(savedSeats(co).allow).toBe(false);
    const attempts = seatsEntries(co).filter((e) => e.via === "remote");
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.every((e) => e.refused === "person_only" && e.actor === "@alex/alex-mbp")).toBe(true);
    // Its own agent (agent admin on) may turn them on again, audited as that agent and not as refused.
    const named = await co.client("worker").seatsConfig({ allow: true });
    expect(named.local).toMatchObject({ allow: true, same_user: true });
    const local = seatsEntries(co).filter((e) => e.actor === "@redeny/redeny-mac/worker");
    expect(local).toHaveLength(1);
    expect([local[0]?.via, local[0]?.refused]).toEqual(["local", undefined]);
  }, 60_000);

  test("an unattended caller (no terminal, no agent marker) is gated like an agent: it needs agent admin on", async () => {
    const co = await freshMember("unattended");
    await co.client("").adminSwitches({ agent_admin: false });
    const off = await walkie(co, ["seats", "enable"]);
    expect([off.code, off.err.includes("agent_admin_off")]).toEqual([1, true]);
    expect((await co.client("").seats()).local.allow).toBe(false);
  }, 30_000);

  test("an unattended --yes (no terminal, no agent marker) is gated like an agent too: refused while agent admin is off, allowed and audited as an unnamed agent while it is on", async () => {
    const co = await freshMember("unattyes");
    await co.client("").adminSwitches({ agent_admin: false });
    for (const argv of [["seats", "enable", "--yes"], ["seats", "allow", "--yes"]]) {
      const refused = await walkie(co, argv);
      expect([refused.code, refused.err.includes("agent_admin_off")]).toEqual([1, true]);
    }
    expect((await co.client("").seats()).local.allow).toBe(false);
    await co.client("").adminSwitches({ agent_admin: true });
    const on = await walkie(co, ["seats", "enable", "--yes"]);
    expect(on.code).toBe(0);
    expect((await co.client("").seats()).local).toMatchObject({ allow: true, same_user: true });
    expect(auditOf(co)).toMatch(/"actor":"@unattyes\/unattyes-mac\/[^"]+ \(unnamed\)","action":"allowed seats on this machine: same-user/);
    // `seats allow --yes` is the same gate: turned off again, then on by the unattended caller, audited the same way.
    await co.client("").seatsConfig({ allow: false });
    expect((await walkie(co, ["seats", "allow", "--yes"])).code).toBe(0);
    expect((await co.client("").seats()).local.allow).toBe(true);
    expect(seatsEntries(co).filter((e) => e.actor.endsWith("(unnamed)") && e.refused === undefined).length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  test("a fresh joined machine's allow-only config selects company same-user mode", async () => {
    const fresh = await freshMember("company");
    const { local } = await fresh.client("").seatsConfig({ allow: true });
    expect(local).toMatchObject({ allow: true, same_user: true, ephemeral: false });
    const cfg = JSON.parse(readFileSync(join(fresh.home, "config.json"), "utf8")) as { seats: { mode?: string; same_user?: boolean; ephemeral?: boolean } };
    expect(cfg.seats).toMatchObject({ mode: "same_user", same_user: true, ephemeral: false });
  }, 30_000);

  test("doctor warns when a projected Claude login will expire before a default seat ends", () => {
    const local = { allow: true, ephemeral: false, same_user: true, claude_login: "machine", codex_login: "machine", claude_projection_near_expiry: true } as SeatsLocalView;
    const checks = doctorChecks(local, { team: "aka", release: false, runnerProblem: null, helper: "ok", rootsFile: "ok", runtimes: { claude: "fake", codex: "fake" } });
    expect(checks.some((x) => x.ok === "warn" && x.what.includes("projected access-only login is near expiry"))).toBe(true);
  });
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
    expect(kc).toContain("✗ Claude seats: this machine has no usable access token or it is near expiry");
    expect(kc).toContain("Ready: the team can start Codex seats on this machine.");
    const noHelper = plain(doctorLines(doctorChecks(base, { ...facts, helper: "sudo -n … didn't answer (a password is required)" })));
    expect(noHelper).toContain("✗ the user helper: sudo -n … didn't answer (a password is required)  → walkie seats setup-user --apply");
    expect(noHelper).toContain("Not ready");
  });

  test("seat readiness does not depend on a crontab utility", () => {
    const text = plain(doctorLines(doctorChecks(base, facts)));
    expect(text).not.toContain("crontab is missing");
    expect(text).toContain("Ready: the team can start Claude and Codex seats on this machine.");
  });
});
