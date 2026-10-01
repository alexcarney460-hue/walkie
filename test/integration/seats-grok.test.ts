import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TERMINAL_STATES, type SeatView } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

let cluster: Cluster;
let alex: TestNode;
let arvid: TestNode;
let log: string;
let home: string;

const seat = async (id: string): Promise<SeatView | undefined> => (await alex.client().seats(id)).seats[0];
const ended = (id: string) => waitFor(async () => { const row = await seat(id); return row && TERMINAL_STATES.has(row.state) ? row : null; }, { timeoutMs: 20_000, what: `Grok seat ${id}` });
const launches = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s) as {
  argv: string[]; brief: string; pid: number; child_pid: number | null; env: string[];
  grok_home: string | null; auth_link: boolean; config_has_api_key: boolean;
}) : [];

beforeAll(async () => {
  cluster = new Cluster();
  home = join(cluster.root, "arvid-home");
  mkdirSync(join(home, ".grok"), { recursive: true });
  log = join(cluster.root, "fake-grok.jsonl");
  const bin = join(cluster.root, "bin");
  mkdirSync(bin);
  const fixture = join(import.meta.dir, "..", "fixtures", "fake-grok", "grok");
  symlinkSync(fixture, join(bin, "grok"));
  alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  arvid = await cluster.add({ name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    machineStats: { intervalMs: 200, read: async () => ({ mem: null, temp_c: null }) },
    seats: { flushMs: 50, launchesPerMinute: 100, env: { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_GROK_LOG: log, XAI_API_KEY: "fixture", GROK_API_KEY: "fixture", XAI_BASE_URL: "https://example.test" } },
  });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  const { local } = await arvid.client("").seatsConfig({ allow: true, same_user: true, runtimes: ["claude", "grok"], env: ["FAKE_GROK_LOG"] });
  expect(local.runtimes).toEqual(["claude", "grok"]);
  await waitFor(() => alex.d.sync.peerCapabilities(arvid.d.nodeId)?.caps.includes("seats_v2") ?? false, { what: "Grok host v2 capability" });
  await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "Grok seat host" });
}, 60_000);

afterAll(async () => { await cluster?.close(); });

describe("Grok v2 seat route and host", () => {
  test("rejects a vault account before dispatch", async () => {
    await expect(alex.client("").seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture", account: `alex:${"a".repeat(24)}` }))
      .rejects.toThrow("Grok seats use only the host user's subscription login");
    expect(launches()).toHaveLength(0);
  });

  test("requires the host user's subscription login and keeps the brief out of argv and provider keys out of env", async () => {
    const absent = await alex.client("").seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture private brief", permission_mode: "default" });
    expect((await ended(absent.seat)).reason).toContain("Grok subscription login");
    expect(launches()).toHaveLength(0);
    writeFileSync(join(home, ".grok", "auth.json"), "fixture", { mode: 0o600 });
    writeFileSync(join(home, ".grok", "config.toml"), '[model.grok-build]\napi_key = "fixture-only"\n');
    const run = await alex.client("").seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture private brief", permission_mode: "default" });
    const done = await ended(run.seat);
    expect(done.state).toBe("done");
    expect(done.output.map((o) => o.text).join("\n")).toContain("fake grok finished");
    expect(done.output.map((o) => o.text).join("\n")).toContain("Read");
    const launch = launches()[0]!;
    expect(launch.argv).toContain("dontAsk");
    expect(launch.argv.slice(launch.argv.indexOf("--tools"), launch.argv.indexOf("--tools") + 2)).toEqual(["--tools", "read_file,grep,list_dir"]);
    expect(launch.argv.filter((arg) => arg === "--deny").length).toBeGreaterThan(3);
    expect(launch.argv).toContain(`Read(${home}/.grok/**)`);
    expect(launch.argv).toContain("read-only");
    expect(JSON.stringify(launch.argv)).not.toContain("fixture private brief");
    expect(launch.brief).toBe("fixture private brief");
    expect(launch.env).toEqual([]);
    expect(launch.grok_home).toContain("grok-home");
    expect(launch.auth_link).toBe(true);
    expect(launch.config_has_api_key).toBe(false);
    expect(existsSync(launch.grok_home!)).toBe(false);
  });

  test("credential-shaped output stops the seat before sharing the token", async () => {
    writeFileSync(join(home, ".grok", "auth.json"), "fixture", { mode: 0o600 });
    const run = await alex.client("").seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture leak", permission_mode: "default" });
    const done = await ended(run.seat);
    expect(done.state).toBe("refused");
    expect(done.reason).toContain("resembled a credential");
    expect(JSON.stringify(done.output)).not.toContain("fixture-session-token-1234567890");
  });

  test("a token split across output records stays private past the flush timer", async () => {
    writeFileSync(join(home, ".grok", "auth.json"), "fixture", { mode: 0o600 });
    const run = await alex.client("").seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture split leak", permission_mode: "default" });
    const done = await ended(run.seat);
    expect(done.state).toBe("refused");
    expect(done.reason).toContain("resembled a credential");
    const shared = done.output.map((o) => o.text).join("\n");
    expect(shared).not.toContain("fixture-session-token-");
    expect(shared).not.toContain('"refresh_token"');
  });

  test("an unfinished JWT prefix is withheld on final signal and plain stream exit", async () => {
    writeFileSync(join(home, ".grok", "auth.json"), "fixture", { mode: 0o600 });
    for (const brief of ["fixture partial jwt", "fixture partial jwt without final"]) {
      const run = await alex.client("").seatRun({ machine: "arvid-mac", runtime: "grok", brief, permission_mode: "default" });
      const done = await ended(run.seat);
      const shared = done.output.map((o) => o.text).join("\n");
      expect(shared).toContain("safe before");
      expect(shared).toContain("[output withheld]");
      expect(shared).not.toContain("eyJ12345678.eyJ123");
    }
  });

  test("maps edit and full access modes and reports stream errors", async () => {
    for (const [mode, mapped] of [["acceptEdits", "acceptEdits"], ["bypassPermissions", "bypassPermissions"]] as const) {
      const run = await alex.client("").seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture fail", permission_mode: mode });
      const done = await ended(run.seat);
      expect(done.state).toBe("failed");
      expect(done.reason).toContain("fixture failur");
      expect(done.reason).toContain("[output withheld]");
      expect(launches().at(-1)?.argv).toContain(mapped);
    }
  });

  test("keeps the withheld marker when a long failure reason is truncated", async () => {
    writeFileSync(join(home, ".grok", "auth.json"), "fixture", { mode: 0o600 });
    const run = await alex.client("").seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture long partial fail", permission_mode: "default" });
    const done = await ended(run.seat);
    expect(done.state).toBe("failed");
    expect(done.reason).toContain("fixture failure");
    expect(done.reason).toContain("[output withheld]");
    expect(done.reason).not.toContain("eyJ12345678.eyJ123");
    expect(done.reason?.length).toBeLessThanOrEqual(280);
  });

  test("stop ends this seat's process group without signaling an unrelated process", async () => {
    writeFileSync(join(home, ".grok", "auth.json"), "fixture", { mode: 0o600 });
    const unrelated = Bun.spawn(["/bin/sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    try {
      const run = await alex.client("").seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture slow", permission_mode: "bypassPermissions" });
      const launch = await waitFor(() => launches().find((r) => r.brief === "fixture slow"), { what: "fake Grok spawn" });
      const saved = JSON.parse(readFileSync(join(arvid.home, "seats.json"), "utf8")) as { running: Array<{ id: string; runtime?: string }> };
      expect(saved.running.find((row) => row.id === run.seat)?.runtime).toBe("grok");
      expect(launch.child_pid).toBeNumber();
      await alex.client("").seatStop(run.seat);
      expect((await ended(run.seat)).state).toBe("stopped");
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
      expect(() => process.kill(launch.child_pid!, 0)).toThrow();
    } finally { unrelated.kill("SIGKILL"); await unrelated.exited; }
  });
});
