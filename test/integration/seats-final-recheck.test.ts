// The last launcher re-check runs after the seat's environment is built (sameUserEnv can wait on the Keychain), and the
// first same-user Claude seat's `claude --help` probe finds a runtime whose interpreter sits beside it (withBinDir).
// The host's PATH has NO claude: findRuntime's fallback finds <home>/.local/bin/claude, whose `#!/usr/bin/env fakenode`
// interpreter lives in the same directory (as npm's node does next to an npm claude). Fictional names only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { TERMINAL_STATES, seatsChannel, type SeatView } from "../../src/protocol/seats.ts";
import { seatsFor } from "../../src/daemon/seats/host.ts";
import { memberByHandle } from "../../src/daemon/roster.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const BUN_DIR = dirname(process.execPath);

let c: Cluster;
let bea: TestNode;
let noor: TestNode;
let olive: TestNode;
let channel: string;
let claudeLog: string;
let inSpawn = false;
let armed: (() => Promise<void>) | null = null;
const kcCalls: boolean[] = [];

const person = (n: TestNode): WalkieClient => n.client("");
const seatOnHost = async (id: string): Promise<SeatView | undefined> => (await person(olive).seats(id)).seats[0];
const ended = (id: string) =>
  waitFor(async () => { const s = await seatOnHost(id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id} to end` });
const launches = (): Array<{ argv: string[] }> => !existsSync(claudeLog) ? [] :
  readFileSync(claudeLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => Array.isArray(r.argv)) as Array<{ argv: string[] }>;
const configure = (launchers: string[]) => person(olive).seatsConfig({ allow: true, same_user: true, launchers, env: ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_STATE"] });
const host = () => seatsFor(olive.d.core) as unknown as { permissionPrompts: boolean | null; runtimeFor: (...a: unknown[]) => string };
const run = async (brief: string) => (await person(noor).seatRun({ machine: "olive-mac", runtime: "claude", brief })).seat;

beforeAll(async () => {
  c = new Cluster();
  const home = join(c.root, "olive-home");
  mkdirSync(join(home, ".claude"), { recursive: true }); // no .credentials.json: the login is in the (fake) Keychain
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "fakenode"), "#!/bin/sh\nexec /bin/sh \"$@\"\n", { mode: 0o755 });
  writeFileSync(join(bin, "claude"), [
    "#!/usr/bin/env fakenode",
    `exec ${JSON.stringify(join(FIXTURES, "fake-claude", "claude"))} "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  chmodSync(join(bin, "claude"), 0o755);
  claudeLog = join(c.root, "claude.jsonl");
  const seats = {
    flushMs: 100, launchesPerMinute: 100,
    keychain: async () => {
      kcCalls.push(inSpawn);
      if (inSpawn && armed) { const a = armed; armed = null; await a(); }
      return JSON.stringify({ claudeAiOauth: { accessToken: "kc-access-test", expiresAt: Date.now() + 48 * 3_600_000, scopes: ["user:inference"] } });
    },
    env: { PATH: `${BUN_DIR}:/usr/bin:/bin`, HOME: home, FAKE_CLAUDE_LOG: claudeLog, FAKE_CLAUDE_STATE: join(c.root, "fake-state") },
  };
  bea = await c.add({ name: "bea", login: "bea@example.com", hostname: "bea-mbp" });
  noor = await c.add({ name: "noor", login: "noor@example.com", hostname: "noor-mbp" });
  olive = await c.add({ name: "olive", login: "olive@example.com", hostname: "olive-mac", machineStats: { intervalMs: 200, read: async () => ({ mem: null, temp_c: null }) }, seats });
  await bea.client().init("aka", "bea");
  for (const [n, h] of [[noor, "noor"], [olive, "olive"]] as const) {
    await bea.client().invite(`${h}@example.com`, h, "member");
    expect((await n.client().join(bea.peerAddr)).admitted).toBe(true);
  }
  channel = seatsChannel(olive.d.nodeId);
  await configure(["@noor"]);
  await waitFor(() => noor.d.core.roster.channels.get(channel)?.members?.includes("noor") ? true : null, { timeoutMs: 15_000, what: "noor in olive's seats channel" });
  await waitFor(() => noor.d.sync.peerState(olive.d.nodeId)?.stats?.sys?.caps?.includes("seats_v2") ?? null, { timeoutMs: 30_000, what: "olive's seats_v2 capability (noor view)" });
  const h = host();
  const orig = h.runtimeFor.bind(h);
  h.runtimeFor = (...a: unknown[]) => { inSpawn = true; return orig(...a); };
}, 90_000);

afterAll(async () => { await c.close(); });

const reset = () => { rmSync(claudeLog, { force: true }); inSpawn = false; armed = null; kcCalls.length = 0; };

test("the first same-user Claude seat's --help probe finds the runtime's interpreter (permission prompts detected)", async () => {
  reset();
  host().permissionPrompts = null;
  const s = await ended(await run("r2"));
  const argv = launches()[0]?.argv ?? [];
  expect(s.state).toBe("done");
  expect(host().permissionPrompts).toBe(true);
  expect(argv.includes("--permission-prompts")).toBe(true);
}, 60_000);

test("control: a same-user seat whose login is in the Keychain runs", async () => {
  reset();
  const s = await ended(await run("r0"));
  expect(s.state).toBe("done");
}, 60_000);

test("a launcher made an observer while spawn reads the Keychain: nothing starts", async () => {
  reset();
  armed = async () => {
    await bea.client().setRole("noor", "observer");
    await waitFor(() => memberByHandle(olive.d.core.roster, "noor")?.role === "observer" ? true : null, { intervalMs: 5, timeoutMs: 3_000, what: "olive sees noor as an observer" });
  };
  try {
    const s = await ended(await run("r1"));
    expect(armed === null).toBe(true); // the demotion fired inside the Keychain read
    expect(launches().length).toBe(0);
    expect(s.state).toBe("refused");
  } finally {
    armed = null;
    await bea.client().setRole("noor", "member");
    await waitFor(() => memberByHandle(olive.d.core.roster, "noor")?.role === "member" ? true : null, { timeoutMs: 15_000, what: "olive sees noor as a member" });
    await configure(["@noor"]);
    await waitFor(() => olive.d.core.roster.channels.get(channel)?.members?.includes("noor") ? true : null, { timeoutMs: 15_000, what: "noor back on olive" });
    await waitFor(() => noor.d.core.roster.channels.get(channel)?.members?.includes("noor") ? true : null, { timeoutMs: 15_000, what: "noor back (noor view)" });
  }
}, 90_000);
