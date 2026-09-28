// SEATS-FIX-2 end to end (docs/audits/2026-09-26-*-seats-r2.md) on a 3-machine team with a FAKE codex: alex and kira
// (owners, so both launchers by default) start seats on arvid-mac (a member who opted in). Covers: a host demoted to
// observer runs nothing new (Codex HIGH 1); deny stops seats even when config.json can't be written (Codex MEDIUM
// 3); a failure summary never shows part of a secret (Codex MEDIUM 4); only a seat's own launcher or the host's
// person may stop it (Opus LOW 4); the host's local stop aborts the post-run git (Opus INFO 5).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { TERMINAL_STATES, seatsChannel, type SeatView } from "../../src/protocol/seats.ts";
import { seatsFor } from "../../src/daemon/seats/host.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

let c: Cluster;
let alex: TestNode;
let arvid: TestNode;
let kira: TestNode;
let log: string;

function person(n: TestNode): WalkieClient { return n.client(""); }
const seatOn = async (n: TestNode, id: string): Promise<SeatView | undefined> => (await n.client().seats(id)).seats[0];
const inState = (n: TestNode, id: string, state: SeatView["state"]) =>
  waitFor(async () => ((await seatOn(n, id))?.state === state ? seatOn(n, id) : null), { timeoutMs: 20_000, what: `seat ${id} ${state}` });
const ended = (n: TestNode, id: string) =>
  waitFor(async () => { const s = await seatOn(n, id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id} to end` });
const launched = (prompt: string) => existsSync(log) && readFileSync(log, "utf8").split("\n").some((l) => l.includes(`"prompt":${JSON.stringify(prompt)}`));
const running = (id: string) => (seatsFor(arvid.d.core) as unknown as { isRunning(id: string): boolean }).isRunning(id);

beforeAll(async () => {
  c = new Cluster();
  const home = join(c.root, "arvid-home");
  mkdirSync(home, { recursive: true });
  log = join(c.root, "codex.jsonl");
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp" });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: { flushMs: 100, launchesPerMinute: 100, env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, FAKE_CODEX_LOG: log } },
  });
  await alex.client().init("aka", "alex");
  await alex.client().invite("kira@example.com", "kira", "owner");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await kira.client().join(alex.peerAddr)).admitted).toBe(true);
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  await person(arvid).seatsConfig({ allow: true, env: ["FAKE_CODEX_LOG"], same_user: true });
  for (const n of [alex, kira]) {
    await waitFor(async () => (await n.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { timeoutMs: 20_000, what: "arvid-mac takes seats" });
  }
}, 90_000);

afterAll(async () => { await c.close(); });

const launch = async (n: TestNode, prompt: string, bundle?: string) =>
  (await person(n).seatRun({ machine: "arvid-mac", runtime: "codex", prompt, ...(bundle ? { bundle } : {}) })).seat;

/** A one-commit repo bundled and shared in arvid-mac's seats channel (the seat commits on top of it). */
async function repoBundle(): Promise<string> {
  const repo = join(c.root, `repo-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd: repo });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  git("bundle", "create", `${repo}.bundle`, "HEAD", "main");
  return (await alex.client().seatsBundle(new Uint8Array(readFileSync(`${repo}.bundle`)))).hash;
}

describe("SEATS-FIX-2", () => {
  test("Codex HIGH 1: a host demoted to observer starts nothing new, even for an allowed launcher", async () => {
    const setRole = (role: string) => alex.client().request("POST", "/v1/team/member", { handle: "arvid", role });
    await setRole("observer");
    await waitFor(async () => (await arvid.client().me()).role === "observer", { what: "arvid an observer" });
    const id = await launch(alex, "codex after demotion");
    await Bun.sleep(2_000);
    expect(launched("codex after demotion")).toBe(false);
    expect(running(id)).toBe(false);
    expect((await seatOn(alex, id))?.state).toBe("requested"); // an observer answers nothing
    await setRole("member");
    await waitFor(async () => (await arvid.client().me()).role === "member", { what: "arvid a member again" });
    const again = await launch(alex, "codex once a member again");
    expect((await ended(alex, again)).state).toBe("done");
    expect(launched("codex after demotion")).toBe(false); // the request from the observer time never runs later
  }, 60_000);

  test("Codex MEDIUM 4: a failure summary never shows part of a secret", async () => {
    const s = await ended(alex, await launch(alex, "fail-secret"));
    expect(s.state).toBe("failed");
    expect(s.reason).toContain("token");
    expect(s.reason).not.toContain("ghp_");
    expect(s.reason).not.toContain("A1b2C3d4E5A1");
  }, 60_000);

  test("Opus LOW 4: another launcher can't stop someone's seat; its own launcher and the host's person can", async () => {
    const a = await launch(alex, "slow for kira to try");
    await inState(alex, a, "running");
    await person(kira).seatStop(a); // kira is an allowed launcher, but not this seat's
    await Bun.sleep(1_500);
    expect(running(a)).toBe(true);
    expect((await seatOn(alex, a))?.state).toBe("running");
    await person(alex).seatStop(a);
    expect((await ended(alex, a)).reason).toBe("stopped by @alex");
    const k = await launch(kira, "slow kira's own");
    await inState(kira, k, "running");
    await person(arvid).seatStop(k); // the host's person, on the host
    expect((await ended(kira, k)).reason).toBe("stopped by @arvid");
  }, 60_000);

  test("Opus INFO 5: the host's local stop aborts the post-run git; the launcher's stop still returns the commits", async () => {
    const bundle = await repoBundle();
    const byLauncher = await launch(alex, "commit then slow (launcher stop)", bundle);
    await inState(alex, byLauncher, "running");
    await waitFor(() => launched("commit then slow (launcher stop)"), { what: "launched" });
    await Bun.sleep(500);
    await person(alex).seatStop(byLauncher);
    const s1 = await ended(alex, byLauncher);
    expect(s1.state).toBe("stopped");
    expect(s1.commits).toBe(1);
    const byHost = await launch(alex, "commit then slow (host stop)", bundle);
    await inState(alex, byHost, "running");
    await Bun.sleep(500);
    expect((await person(arvid).seatStop(byHost)).stopped).toBe("local");
    const s2 = await ended(alex, byHost);
    expect(s2.state).toBe("stopped");
    expect(s2.commits).toBeUndefined();
    expect(s2.result_bundle).toBeUndefined();
  }, 60_000);

  test("Codex MEDIUM 3: deny stops every seat even when config.json can't be written, and says so", async () => {
    const id = await launch(alex, "slow before a full disk");
    await inState(alex, id, "running");
    const blocker = join(arvid.home, "config.json.tmp");
    mkdirSync(blocker); // the atomic write's temp file can't be created: like a full disk or a read-only home
    try {
      await expect(person(arvid).seatsConfig({ allow: false })).rejects.toThrow(/every seat was stopped.*config\.json could not be written/);
      expect(running(id)).toBe(false);
      expect((await ended(alex, id)).reason).toBe("seats were turned off on this machine");
      expect((await person(arvid).seats()).local.allow).toBe(false);
    } finally {
      rmSync(blocker, { recursive: true, force: true });
    }
    await person(arvid).seatsConfig({ allow: true, same_user: true });
  }, 60_000);
});
