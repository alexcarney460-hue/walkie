// Admission of a Grok launch that carries a tool policy (WALK-76). The host reads `grok --version` before it admits
// the run, so a run can be stopped, or the daemon shut down, while that read is in flight; and a read that is slow
// must hold up only that Grok launch. Drives SeatsHost through the seats API with a Grok whose `--version` is slow.
// No model is called.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { TERMINAL_STATES, type SeatView } from "../../src/protocol/seats.ts";
import { clearGrokVersionCache } from "../../src/daemon/seats/tool-policy.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { signInCodex } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const BUN_DIR = dirname(process.execPath);
const VERSION_LINE = "grok 1.0.46 (2765805b9442) [stable]";

let cluster: Cluster;
let alex: TestNode;
let arvid: TestNode;
let bin: string;
let claudeLog: string;
let grokLog: string;
let marks = 0;

const person = (n: TestNode): WalkieClient => n.client("");
const seatOn = async (id: string): Promise<SeatView | undefined> => (await alex.client().seats(id)).seats[0];
const ended = (id: string) => waitFor(async () => {
  const row = await seatOn(id);
  return row && TERMINAL_STATES.has(row.state) ? row : null;
}, { timeoutMs: 25_000, what: `seat ${id} to end` });

function lines(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A Grok whose `--version` runs `versionBody` (under the probe's own PATH) and whose launches are the fake Grok. */
function grokWith(versionBody: string): void {
  const path = join(cluster.root, `grok-admission-${++marks}`);
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then\n${versionBody}\nfi\nexec bun ${join(FIXTURES, "fake-grok", "grok.ts")} "$@"\n`, { mode: 0o755 });
  rmSync(join(bin, "grok"), { force: true });
  symlinkSync(path, join(bin, "grok"));
  clearGrokVersionCache();
}

/** A version script that notes it started, waits `seconds`, notes it finished, then prints the verified line. */
function slowVersion(seconds: number): { started: string; finished: string; body: string } {
  const started = join(cluster.root, `version-started-${++marks}`);
  const finished = join(cluster.root, `version-finished-${marks}`);
  return { started, finished, body: `echo x > ${started}\nsleep ${seconds}\necho x > ${finished}\necho '${VERSION_LINE}'\nexit 0` };
}

beforeAll(async () => {
  cluster = new Cluster();
  const home = join(cluster.root, "arvid-home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "fixture-access", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference"] },
  }), { mode: 0o600 });
  signInCodex(home);
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok", "auth.json"), "fixture", { mode: 0o600 });
  bin = join(cluster.root, "seat-bin");
  mkdirSync(bin);
  symlinkSync(join(FIXTURES, "fake-claude", "claude"), join(bin, "claude"));
  claudeLog = join(cluster.root, "claude.jsonl");
  grokLog = join(cluster.root, "grok.jsonl");
  grokWith(`echo '${VERSION_LINE}'\nexit 0`);
  alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  arvid = await cluster.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: {
      flushMs: 50, launchesPerMinute: 100,
      env: {
        PATH: `${bin}:${BUN_DIR}:/usr/bin:/bin`, HOME: home,
        FAKE_CLAUDE_LOG: claudeLog, FAKE_CLAUDE_STATE: join(cluster.root, "claude-state"), FAKE_GROK_LOG: grokLog,
      },
    },
  });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  await person(arvid).seatsConfig({
    allow: true, same_user: true, runtimes: ["claude", "grok"],
    env: ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_STATE", "FAKE_GROK_LOG"],
    tools: { allow: ["Read"] },
  });
  await waitFor(() => alex.d.sync.peerCapabilities(arvid.d.nodeId)?.caps.includes("seats_v2") ?? false, { what: "seats v2" });
  await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "seat host" });
}, 90_000);

afterAll(async () => {
  clearGrokVersionCache();
  await cluster?.close();
});

describe.serial("a Grok launch while its version is being read", () => {
  test("a stop during the version read ends the seat as stopped and nothing is spawned", async () => {
    const slow = slowVersion(2);
    grokWith(slow.body);
    const before = lines(grokLog).length;
    const run = await person(alex).seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture stop in version read", permission_mode: "default" });
    await waitFor(() => existsSync(slow.started), { what: "the version read to start" });
    expect(existsSync(slow.finished)).toBe(false);
    await person(alex).seatStop(run.seat);
    const row = await ended(run.seat);
    expect(row.state).toBe("stopped");
    expect(row.reason).toBe("stopped by @alex");
    // The read finishes after the stop; the seat must stay stopped and Grok must never start.
    await waitFor(() => existsSync(slow.finished), { what: "the version read to finish" });
    await Bun.sleep(800);
    expect(lines(grokLog).length).toBe(before);
    const after = await seatOn(run.seat);
    expect(after?.state).toBe("stopped");
    // The pending stop does not outlive its run: the next launch is judged on its own.
    grokWith(`echo '${VERSION_LINE}'\nexit 0`);
    const next = await person(alex).seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture after a stop", permission_mode: "default" });
    expect((await ended(next.seat)).state).toBe("done");
    expect(lines(grokLog).length).toBe(before + 1);
  }, 90_000);

  test("a shutdown during the version read ends the seat as refused, so the row is not left requested", async () => {
    const slow = slowVersion(2);
    grokWith(slow.body);
    const before = lines(grokLog).length;
    const run = await person(alex).seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture shutdown in version read", permission_mode: "default" });
    await waitFor(() => existsSync(slow.started), { what: "the version read to start" });
    expect(existsSync(slow.finished)).toBe(false);
    await arvid.restart();
    const row = await ended(run.seat);
    expect(row.state).toBe("refused");
    expect(row.reason).toBe("the host shut down before this seat started; run it again");
    expect(lines(grokLog).length).toBe(before);
    // The restarted host takes launches again.
    await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "seat host after restart" });
    grokWith(`echo '${VERSION_LINE}'\nexit 0`);
    const next = await person(alex).seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture after restart", permission_mode: "default" });
    expect((await ended(next.seat)).state).toBe("done");
  }, 120_000);

  test("a Claude seat does not wait behind a Grok version read", async () => {
    // The Grok read waits for this file, up to 2.75 s (under the 3 s probe limit). The Claude seat must finish first.
    const gate = join(cluster.root, `gate-${++marks}`);
    const started = join(cluster.root, `gate-started-${marks}`);
    grokWith(`echo x > ${started}\nn=0\nwhile [ ! -f ${gate} ] && [ $n -lt 55 ]; do sleep 0.05; n=$((n+1)); done\necho '${VERSION_LINE}'\nexit 0`);
    const before = lines(grokLog).length;
    const grok = await person(alex).seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture gated version", permission_mode: "default" });
    await waitFor(() => existsSync(started), { what: "the version read to start" });
    const claude = await person(alex).seatRun({ machine: "arvid-mac", runtime: "claude", prompt: "behind a grok version read" });
    expect((await ended(claude.seat)).state).toBe("done");
    // The Claude seat is over and the Grok version read is still waiting: Grok has not been started.
    expect(lines(grokLog).length).toBe(before);
    writeFileSync(gate, "go");
    expect((await ended(grok.seat)).state).toBe("done");
    expect(lines(grokLog).length).toBe(before + 1);
  }, 90_000);

  test("two Grok runs that finish their version read together still respect max_concurrent", async () => {
    const slow = slowVersion(1.5);
    grokWith(slow.body);
    const before = lines(grokLog).length;
    const first = await person(alex).seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture cap first", permission_mode: "default", max_concurrent: 1 });
    const second = await person(alex).seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture cap second", permission_mode: "default", max_concurrent: 1 });
    const rows = [await ended(first.seat), await ended(second.seat)];
    const refused = rows.filter((row) => row.state === "refused");
    expect(refused.length).toBe(1);
    expect(refused[0]!.reason).toContain("at capacity");
    expect(rows.filter((row) => row.state === "done").length).toBe(1);
    expect(lines(grokLog).length).toBe(before + 1);
  }, 90_000);
});
