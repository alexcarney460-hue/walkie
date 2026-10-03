// A seat carries only its own runtime's login (Codex pre.12 audit MUST 2): with the machine's Claude token in the seat
// environment, a Codex seat (same user and seat user) never sees it, a Claude seat does, and a Claude seat user's help
// probe sees neither the token nor a credentials file (SHOULD 1). And a seat user's runner older than this Walkie, which
// ignores the gated spec, gets no login and is stopped with the setup-user message (MUST 1). Ported from the rv-lh6
// reviewer probe. Fictional values only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { TERMINAL_STATES, seatsChannel, type SeatView } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const BUN_DIR = dirname(process.execPath);
const FAKE_TOKEN = "sk-ant-oat01-OWNLOGINFAKE0123456789abcdefghijklmnop";
let c: Cluster; let bea: TestNode; let noor: TestNode; let olive: TestNode; let world: FakeSeatWorld; let log: string;
/** Set: the seat user's runner is started behind a shim that drops `gate` from its spec (a runner older than the gate). */
let oldRunner = false;
let shim: string;
const person = (n: TestNode): WalkieClient => n.client("");
const ended = (id: string) => waitFor(async () => { const s = (await person(olive).seats(id)).seats[0] as SeatView | undefined; return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id}` });
const rows = (): Array<Record<string, unknown>> => !existsSync(log) ? [] : readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const envNames = ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_STATE", "FAKE_CODEX_LOG", "ZZ_LOG"];

function wrapper(dir: string, rt: string, real: string): void {
  writeFileSync(join(dir, rt), ["#!/bin/sh",
    'h=0; for a in "$@"; do [ "$a" = "--help" ] && h=1; done',
    't=0; [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && t=1',
    'cf=0; [ -n "$CLAUDE_CONFIG_DIR" ] && [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ] && cf=1',
    'xf=0; [ -n "$CODEX_HOME" ] && [ -f "$CODEX_HOME/auth.json" ] && xf=1',
    `echo "{\\"rt\\":\\"${rt}\\",\\"help\\":$h,\\"token\\":$t,\\"claude_file\\":$cf,\\"codex_file\\":$xf}" >> "$ZZ_LOG"`,
    `exec ${JSON.stringify(real)} "$@"`, ""].join("\n"), { mode: 0o755 });
  chmodSync(join(dir, rt), 0o755);
}

beforeAll(async () => {
  c = new Cluster();
  const home = join(c.root, "olive-home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  chmodSync(home, 0o700);
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { access_token: "probe-codex-access", refresh_token: "", account_id: "probe" } }), { mode: 0o600 });
  log = join(c.root, "zz.jsonl");
  const wrapDir = join(c.root, "wrap");
  mkdirSync(wrapDir, { recursive: true }); chmodSync(wrapDir, 0o755);
  wrapper(wrapDir, "codex", join(FIXTURES, "fake-codex", "codex"));
  wrapper(wrapDir, "claude", join(FIXTURES, "fake-claude", "claude"));
  world = fakeSeatWorld(c.root, join(c.root, "olive"));
  world.sys.acl = (p: string) => `drwx------  2 x  staff  64 Jan  1 00:00 ${p}`;
  shim = join(c.root, "old-runner-shim.ts");
  writeFileSync(shim, [
    "// Passes everything through to the real runner, except the gate flag in the first line (the spec).",
    "const child = Bun.spawn(process.argv.slice(2), { stdin: \"pipe\", stdout: \"inherit\", stderr: \"inherit\" });",
    "void child.exited.then((code) => process.exit(code ?? 1)); // the shim ends with the runner, as the runner itself would",
    "const sink = child.stdin;",
    "let head = true; let pending = new Uint8Array(0);",
    "for await (const chunk of Bun.stdin.stream()) {",
    "  if (!head) { sink.write(chunk); sink.flush(); continue; }",
    "  const all = new Uint8Array(pending.length + chunk.length); all.set(pending); all.set(chunk, pending.length);",
    "  const i = all.indexOf(10);",
    "  if (i < 0) { pending = all; continue; }",
    "  const spec = JSON.parse(new TextDecoder().decode(all.subarray(0, i))); delete spec.gate;",
    "  sink.write(JSON.stringify(spec) + \"\\n\"); sink.write(all.subarray(i + 1)); sink.flush(); head = false;",
    "}",
    "sink.end();",
    "process.exit(await child.exited);", ""].join("\n"));
  const realSwitch = world.userSwitch;
  world.userSwitch = (user, runner, purpose) => realSwitch(user, oldRunner && purpose === "run" ? [process.execPath, shim, ...runner] : runner, purpose);
  bea = await c.add({ name: "bea", login: "bea@example.com", hostname: "bea-mbp" });
  noor = await c.add({ name: "noor", login: "noor@example.com", hostname: "noor-mbp" });
  olive = await c.add({ name: "olive", login: "olive@example.com", hostname: "olive-mac",
    machineStats: { intervalMs: 200, read: async () => ({ mem: null, temp_c: null }) },
    seats: { flushMs: 100, launchesPerMinute: 100, userSwitch: world.userSwitch, admin: world.admin, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
      keychain: async () => null,
      env: { PATH: `${wrapDir}:${BUN_DIR}:/usr/bin:/bin`, HOME: home, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN,
        FAKE_CLAUDE_LOG: join(c.root, "claude.jsonl"), FAKE_CLAUDE_STATE: join(c.root, "fake-state"), FAKE_CODEX_LOG: join(c.root, "codex.jsonl"), ZZ_LOG: log } } });
  await bea.client().init("aka", "bea");
  for (const [n, h] of [[noor, "noor"], [olive, "olive"]] as const) {
    await bea.client().invite(`${h}@example.com`, h, "member");
    expect((await n.client().join(bea.peerAddr)).admitted).toBe(true);
  }
  await person(olive).seatsConfig({ allow: true, same_user: true, env: envNames, launchers: ["@noor"] });
  const channel = seatsChannel(olive.d.nodeId);
  await waitFor(() => noor.d.core.roster.channels.get(channel)?.members?.includes("noor") ? true : null, { timeoutMs: 15_000, what: "noor in channel" });
  await waitFor(() => noor.d.sync.peerState(olive.d.nodeId)?.stats?.sys?.caps?.includes("seats_v2") ?? null, { timeoutMs: 30_000, what: "seats_v2 cap" });
}, 90_000);
afterAll(async () => { await c.close(); });

for (const mode of ["same-user", "seat-user"] as const) {
  for (const rt of ["codex", "claude"] as const) {
    test(`${mode} ${rt} seat: the machine's Claude token reaches ${rt === "claude" ? "it" : "it never"}`, async () => {
      rmSync(log, { force: true });
      await person(olive).seatsConfig(mode === "seat-user"
        ? { allow: true, ephemeral: true, same_user: false, runtimes: ["codex", "claude"], env: envNames, launchers: ["@noor"] }
        : { allow: true, ephemeral: false, same_user: true, runtimes: ["codex", "claude"], env: envNames, launchers: ["@noor"] });
      const id = (await person(noor).seatRun({ machine: "olive-mac", runtime: rt, brief: `zz ${mode} ${rt}` })).seat;
      const s = await ended(id);
      expect(s.state).toBe("done");
      const runtimeRows = rows().filter((r) => r.rt === rt && r.help === 0);
      expect(runtimeRows.length).toBeGreaterThan(0);
      if (rt === "codex") expect(runtimeRows.every((r) => r.token === 0)).toBe(true);
      else expect(runtimeRows.every((r) => r.token === 1)).toBe(true);
      if (mode === "seat-user") expect(rows().filter((r) => r.help === 1).every((r) => r.token === 0 && r.claude_file === 0)).toBe(true);
    }, 60_000);
  }
}

test("a seat user's runner older than this Walkie (it ignores the gate) gets no login and is stopped", async () => {
  rmSync(log, { force: true });
  await person(olive).seatsConfig({ allow: true, ephemeral: true, same_user: false, runtimes: ["codex", "claude"], env: envNames, launchers: ["@noor"] });
  oldRunner = true;
  try {
    const id = (await person(noor).seatRun({ machine: "olive-mac", runtime: "codex", brief: "old runner" })).seat;
    const s = await ended(id);
    expect(s.state).toBe("failed");
    expect(s.reason ?? "").toContain("setup-user --apply");
    // Whatever it started had no login: no token, no Codex auth file, no Claude credentials file.
    expect(rows().every((r) => r.token === 0 && r.codex_file === 0 && r.claude_file === 0)).toBe(true);
  } finally { oldRunner = false; }
}, 60_000);
