// Seat users: spawnAsUser reads the host's Claude login from the Keychain after the first last-check; the launcher is
// judged again after that read, with nothing awaited before the runner starts. The runner then prepares the run with no
// login, and the host judges the launcher once more before the login goes with its go-ahead (Codex pre.12 audit MUST 1,
// SHOULD 1). Fictional names only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { TERMINAL_STATES, seatsChannel, type SeatView } from "../../src/protocol/seats.ts";
import { seatsFor } from "../../src/daemon/seats/host.ts";
import { memberByHandle } from "../../src/daemon/roster.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const BUN_DIR = dirname(process.execPath);

let c: Cluster;
let bea: TestNode;
let noor: TestNode;
let olive: TestNode;
let world: FakeSeatWorld;
let probeLog: string;
let inUser = false;
let armed: (() => Promise<void>) | null = null;
const kc: string[] = [];

const person = (n: TestNode): WalkieClient => n.client("");
const seatOnHost = async (id: string): Promise<SeatView | undefined> => (await person(olive).seats(id)).seats[0];
const ended = (id: string) =>
  waitFor(async () => { const s = await seatOnHost(id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id} to end` });
const rows = (): Array<Record<string, unknown>> => !existsSync(probeLog) ? [] :
  readFileSync(probeLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const envNames = ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_STATE", "RVLH4_LOG", "RVLH4_GATE"];
let gate: string;
const configure = (launchers: string[]) => person(olive).seatsConfig({ allow: true, ephemeral: true, same_user: false, runtimes: ["claude"], env: envNames, launchers });
const host = () => seatsFor(olive.d.core) as unknown as Record<string, (...a: unknown[]) => unknown>;
const run = async (brief: string) => (await person(noor).seatRun({ machine: "olive-mac", runtime: "claude", brief })).seat;

beforeAll(async () => {
  c = new Cluster();
  const home = join(c.root, "olive-home");
  mkdirSync(join(home, ".claude"), { recursive: true }); // no .credentials.json: the login is in the (fake) Keychain
  chmodSync(home, 0o700);
  probeLog = join(c.root, "probe.jsonl");
  gate = join(c.root, "help-gate");
  const wrapDir = join(c.root, "wrap");
  mkdirSync(wrapDir, { recursive: true });
  chmodSync(wrapDir, 0o755);
  writeFileSync(join(wrapDir, "claude"), [
    "#!/bin/sh",
    'h=0; for a in "$@"; do [ "$a" = "--help" ] && h=1; done',
    'f=0; [ -n "$CLAUDE_CONFIG_DIR" ] && [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ] && f=1',
    't=0; [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && t=1',
    'echo "{\\"rt\\":\\"claude\\",\\"help\\":$h,\\"cred_file\\":$f,\\"token\\":$t}" >> "$RVLH4_LOG"',
    // Armed, the help probe (the runner preparing) waits for the test to say go on, up to 8 s.
    'if [ $h = 1 ] && [ -f "$RVLH4_GATE.armed" ]; then i=0; while [ ! -f "$RVLH4_GATE" ] && [ $i -lt 160 ]; do sleep 0.05; i=$((i+1)); done; fi',
    "exec " + JSON.stringify(join(FIXTURES, "fake-claude", "claude")) + ' "$@"', ""].join("\n"), { mode: 0o755 });
  chmodSync(join(wrapDir, "claude"), 0o755);
  world = fakeSeatWorld(c.root, join(c.root, "olive"));
  world.sys.acl = (p: string) => `drwx------  2 x  staff  64 Jan  1 00:00 ${p}`;
  bea = await c.add({ name: "bea", login: "bea@example.com", hostname: "bea-mbp" });
  noor = await c.add({ name: "noor", login: "noor@example.com", hostname: "noor-mbp" });
  olive = await c.add({
    name: "olive", login: "olive@example.com", hostname: "olive-mac",
    machineStats: { intervalMs: 200, read: async () => ({ mem: null, temp_c: null }) },
    seats: {
      flushMs: 100, launchesPerMinute: 100, userSwitch: world.userSwitch, admin: world.admin, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
      keychain: async () => {
        kc.push(inUser ? "in-spawnAsUser" : "elsewhere");
        if (inUser && armed) { const a = armed; armed = null; await a(); }
        return JSON.stringify({ claudeAiOauth: { accessToken: "kc-access-test", expiresAt: Date.now() + 48 * 3_600_000, scopes: ["user:inference"] } });
      },
      env: { PATH: `${wrapDir}:${join(FIXTURES, "fake-claude")}:${BUN_DIR}:/usr/bin:/bin`, HOME: home,
        FAKE_CLAUDE_LOG: join(c.root, "claude.jsonl"), FAKE_CLAUDE_STATE: join(c.root, "fake-state"), RVLH4_LOG: probeLog, RVLH4_GATE: join(c.root, "help-gate") },
    },
  });
  await bea.client().init("aka", "bea");
  for (const [n, h] of [[noor, "noor"], [olive, "olive"]] as const) {
    await bea.client().invite(`${h}@example.com`, h, "member");
    expect((await n.client().join(bea.peerAddr)).admitted).toBe(true);
  }
  await person(olive).seatsConfig({ allow: true, same_user: true, env: envNames, launchers: ["@noor"] });
  const { local } = await configure(["@noor"]);
  const channel = seatsChannel(olive.d.nodeId);
  await waitFor(() => noor.d.core.roster.channels.get(channel)?.members?.includes("noor") ? true : null, { timeoutMs: 15_000, what: "noor in olive's seats channel" });
  await waitFor(() => noor.d.sync.peerState(olive.d.nodeId)?.stats?.sys?.caps?.includes("seats_v2") ?? null, { timeoutMs: 30_000, what: "olive's seats_v2 capability (noor view)" });
  const h = host();
  const orig = (h.spawnAsUser as (...a: unknown[]) => Promise<void>).bind(h);
  h.spawnAsUser = (...a: unknown[]) => { inUser = true; return orig(...a); };
}, 90_000);

afterAll(async () => { await c.close(); });

const reset = () => {
  rmSync(probeLog, { force: true }); rmSync(gate, { force: true }); rmSync(`${gate}.armed`, { force: true });
  inUser = false; armed = null; kc.length = 0;
};
async function restore(): Promise<void> {
  armed = null;
  if (memberByHandle(bea.d.core.roster, "noor")?.role !== "member") {
    await bea.client().setRole("noor", "member");
    await waitFor(() => memberByHandle(olive.d.core.roster, "noor")?.role === "member" ? true : null, { timeoutMs: 15_000, what: "olive sees noor member" });
  }
  await configure(["@noor"]);
  const channel = seatsChannel(olive.d.nodeId);
  await waitFor(() => olive.d.core.roster.channels.get(channel)?.members?.includes("noor") ? true : null, { timeoutMs: 15_000, what: "noor back" });
  await waitFor(() => noor.d.core.roster.channels.get(channel)?.members?.includes("noor") ? true : null, { timeoutMs: 15_000, what: "noor back (noor view)" });
}

test("control: a seat-user Claude seat on the host's Keychain login runs, and spawnAsUser reads the Keychain", async () => {
  reset();
  const s = await ended(await run("k0"));
  expect(s.state).toBe("done");
  expect(kc).toContain("in-spawnAsUser");
  // The runner's help probe ran before any login reached it; the runtime got the login with the go-ahead.
  expect(rows().filter((r) => r.help === 1)).toEqual([{ rt: "claude", help: 1, cred_file: 0, token: 0 }]);
  expect(rows().filter((r) => r.help === 0).map((r) => r.cred_file)).toEqual([1]);
}, 60_000);

test("a launcher made an observer while the seat user's runner prepares: the login never reaches it, nothing starts", async () => {
  reset();
  writeFileSync(`${gate}.armed`, "");
  try {
    const id = await run("k2");
    // The runner is preparing (its help probe holds), with no login on disk or in its environment.
    await waitFor(() => rows().find((r) => r.help === 1) ?? null, { timeoutMs: 30_000, what: "the runner's help probe" });
    await bea.client().setRole("noor", "observer");
    await waitFor(() => memberByHandle(olive.d.core.roster, "noor")?.role === "observer" ? true : null, { intervalMs: 5, timeoutMs: 5_000, what: "olive sees noor observer" });
    writeFileSync(gate, "");
    const s = await ended(id);
    expect(s.state).toBe("refused");
    expect(s.reason ?? "").toContain("observer");
    expect(rows().filter((r) => r.help === 1)).toEqual([{ rt: "claude", help: 1, cred_file: 0, token: 0 }]);
    expect(rows().filter((r) => r.help === 0)).toEqual([]); // the runtime never started
  } finally { rmSync(`${gate}.armed`, { force: true }); await restore(); }
}, 90_000);

test("a launcher made an observer during spawnAsUser's Keychain read: nothing starts", async () => {
  reset();
  armed = async () => {
    await bea.client().setRole("noor", "observer");
    await waitFor(() => memberByHandle(olive.d.core.roster, "noor")?.role === "observer" ? true : null, { intervalMs: 5, timeoutMs: 3_000, what: "olive sees noor observer" });
  };
  try {
    const s = await ended(await run("k1"));
    expect(armed === null).toBe(true); // the demotion fired inside spawnAsUser's Keychain read
    expect(memberByHandle(olive.d.core.roster, "noor")?.role).toBe("observer");
    expect(rows().filter((r) => r.help === 0)).toEqual([]);
    expect(s.state).toBe("refused");
  } finally { await restore(); }
}, 90_000);


test("this machine's own account removed and added again while the runner prepares: the login held is not sent", async () => {
  reset();
  const id = "b".repeat(24);
  const entry = (gen: string) => ({ id, provider: "claude", label: "Claude account", plan: null, policy: "local", share_with: [], created_at: 1,
    expires_at: null, home: null, linked: false, gen, home_at: 1, personal: false });
  let entries = [entry("g1")];
  const core = olive.d.core as unknown as { vault: unknown };
  const realVault = core.vault;
  core.vault = { list: () => entries, claudeToken: async () => `sk-ant-oat01-FAKELOCAL${entries[0]?.gen ?? "x"}0123456789abcdefghijklmn` };
  writeFileSync(`${gate}.armed`, "");
  try {
    const seat = (await person(noor).seatRun({ machine: "olive-mac", runtime: "claude", brief: "k3", account: `olive:${id}` })).seat;
    await waitFor(() => rows().find((r) => r.help === 1) ?? null, { timeoutMs: 30_000, what: "the runner's help probe" });
    entries = [entry("g2")]; // removed and added again under the same id: a new credential generation
    writeFileSync(gate, "");
    const s = await ended(seat);
    expect(s.state).toBe("refused");
    expect(s.reason ?? "").toContain("the account changed while the seat was being prepared");
    expect(rows().filter((r) => r.help === 0)).toEqual([]); // the runtime never started
  } finally { core.vault = realVault; rmSync(`${gate}.armed`, { force: true }); await restore(); }
}, 90_000);

test("a held login that expires while the seat user's runner prepares is not sent (Opus review of 9ffe1f81, S1)", async () => {
  reset();
  const id = "c".repeat(24);
  const entries = [{ id, provider: "claude", label: "Claude account", plan: null, policy: "local", share_with: [], created_at: 1,
    expires_at: null, home: null, linked: false, gen: "g1", home_at: 1, personal: false }];
  const core = olive.d.core as unknown as { vault: unknown };
  const realVault = core.vault;
  core.vault = { list: () => entries, claudeToken: async () => "sk-ant-oat01-FAKEEXPIRING0123456789abcdefghijklmnop" };
  writeFileSync(`${gate}.armed`, "");
  try {
    const seat = (await person(noor).seatRun({ machine: "olive-mac", runtime: "claude", brief: "k4", account: `olive:${id}` })).seat;
    await waitFor(() => rows().find((r) => r.help === 1) ?? null, { timeoutMs: 30_000, what: "the runner's help probe" });
    // The login held for this seat runs out while the runner prepares (a hand-out's reported expiry, set here directly).
    const held = [...(host() as unknown as { seats: Map<string, { v2: { creds: { expiresAt?: number | null } | null } | null }> }).seats.values()]
      .find((s) => s.v2?.creds)?.v2?.creds;
    expect(held).toBeTruthy();
    (held as { expiresAt?: number | null }).expiresAt = Date.now() - 1_000;
    writeFileSync(gate, "");
    const s = await ended(seat);
    expect(s.state).toBe("refused");
    expect(s.reason ?? "").toContain("expired before launch");
    expect(rows().filter((r) => r.help === 0)).toEqual([]);
  } finally { core.vault = realVault; rmSync(`${gate}.armed`, { force: true }); await restore(); }
}, 90_000);

test("the seat tool policy tightened while the runner prepares: the seat is refused, the runtime never starts (Codex pre.13 audit)", async () => {
  reset();
  await person(olive).seatsConfig({ allow: true, ephemeral: true, same_user: false, runtimes: ["claude"], env: envNames, launchers: ["@noor"], tools: { allow: ["Read", "Grep"] } });
  writeFileSync(`${gate}.armed`, "");
  try {
    const seat = (await person(noor).seatRun({ machine: "olive-mac", runtime: "claude", brief: "k5" })).seat;
    await waitFor(() => rows().find((r) => r.help === 1) ?? null, { timeoutMs: 30_000, what: "the runner's help probe" });
    await person(olive).seatsConfig({ allow: true, ephemeral: true, same_user: false, runtimes: ["claude"], env: envNames, launchers: ["@noor"], tools: { allow: ["Read"] } });
    writeFileSync(gate, "");
    const s = await ended(seat);
    expect(s.state).toBe("refused");
    expect(s.reason ?? "").toContain("seat tool policy changed while the seat was being prepared");
    expect(rows().filter((r) => r.help === 0)).toEqual([]);
  } finally { rmSync(`${gate}.armed`, { force: true }); await restore(); }
}, 90_000);
