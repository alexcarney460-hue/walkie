// Seats v2 as a seat user (FO-2): the host stages a bundle of the exact commit from its own clone (a seat user can't
// read the person's home), its runner (protocol 7) clones it, checks out the build's branch, gets the brief as
// TASK.md and returns the result file; Kimi is refused as a seat user. The uid switch is faked as in
// seats-user.test.ts (a sandboxed runner over fake seat users); everything else is the real path.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TERMINAL_STATES, type SeatView } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, signInCodex, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

let c: Cluster;
let alex: TestNode;
let arvid: TestNode;
let log: string;
let world: FakeSeatWorld;
let clone: string;
let sha0: string;

const seatOn = async (id: string): Promise<SeatView | undefined> => (await alex.client().seats(id)).seats[0];
const ended = (id: string) =>
  waitFor(async () => { const s = await seatOn(id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id} to end` });
const lines = (): Array<Record<string, unknown>> =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
function g(cwd: string, ...a: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

beforeAll(async () => {
  c = new Cluster();
  const home = join(c.root, "arvid-home");
  mkdirSync(home, { recursive: true });
  chmodSync(home, 0o700);
  signInCodex(home);
  log = join(c.root, "codex.jsonl");
  clone = join(home, "app"); // in the person's closed home: only the daemon (as the person) reads it
  mkdirSync(clone);
  g(clone, "init", "-q", "-b", "main");
  writeFileSync(join(clone, "README.md"), "app\n");
  g(clone, "add", ".");
  g(clone, "commit", "-q", "-m", "init");
  sha0 = g(clone, "rev-parse", "HEAD");
  const walkieHome = join(c.root, "arvid");
  world = fakeSeatWorld(c.root, walkieHome);
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    machineStats: { intervalMs: 200, read: async () => ({ mem: null, temp_c: null }) },
    seats: {
      flushMs: 100, launchesPerMinute: 100, userSwitch: world.userSwitch, admin: world.admin, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${join(FIXTURES, "fake-kimi")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, FAKE_CODEX_LOG: log },
    },
  });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  await arvid.client("").seatsConfig({ allow: true, same_user: true, env: ["FAKE_CODEX_LOG"] });
  const { local } = await arvid.client("").seatsConfig({ allow: true, ephemeral: true, same_user: false, runtimes: ["claude", "codex", "kimi"] });
  expect(local).toMatchObject({ allow: true, ephemeral: true });
  await arvid.client("").seatsRepoSet("app", clone);
  await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "arvid-mac takes seats" });
  await waitFor(() => alex.d.sync.peerState(arvid.d.nodeId)?.stats?.sys?.caps?.includes("seats_v2") ?? null, { what: "arvid's seats_v2 capability" });
}, 60_000);

afterAll(async () => { await c.close(); });

describe("v2 seats as a seat user", () => {
  test("a build lane: the runner clones the staged commit on lane/<label>, reads TASK.md, returns commits and the result file", async () => {
    const res = await alex.client("").seatRun({
      machine: "arvid-mac", runtime: "codex", brief: "commit the work", label: "sp-300",
      workspace: { repo: "app", ref: "main", mode: "branch" }, result_file: "codex-output.txt",
    });
    const s = await ended(res.seat);
    expect(`${s.state} ${s.reason ?? ""}`.trim()).toBe("done");
    expect(s.commits).toBe(1);
    expect(s.dir).toMatch(/^~walkie-s\d+\/walkie-seats\//);
    const run = lines().find((l) => typeof l.prompt === "string" && (l.prompt as string).includes("commit the work"));
    expect(run).toBeDefined();
    const cwd = String(run?.cwd);
    expect(cwd.startsWith(world.homes)).toBe(true); // under the seat user's home, never the person's clone
    expect(run?.stdin_prompt).toBe("Read ./TASK.md and do it"); // never the brief
    expect(run?.head_ref).toBe("refs/heads/lane/sp-300");
    expect(run?.head).toBe(sha0); // the exact commit, before the seat's own
    // Its commit comes back on top of that commit.
    const out = join(c.root, "result.bundle");
    writeFileSync(out, await alex.client().fetchArtifact(s.result_bundle as string));
    expect(g(clone, "bundle", "verify", out)).toContain(`requires this ref:\n${sha0}`);
    expect(s.result_file_blob).toMatch(/^[0-9a-f]{64}$/);
    expect(new TextDecoder().decode(await alex.client().fetchArtifact(s.result_file_blob as string))).toBe("made by a codex seat\n");
    // Staged privately in the daemon's 0700 seats-stage (never the seat users' shared socket directory), gone once the seat ended.
    const stage = join(arvid.home, "seats-stage");
    expect(statSync(stage).mode & 0o777).toBe(0o700);
    expect(readdirSync(stage)).toEqual([]);
  }, 60_000);

  test("Kimi is refused as a seat user (its rotating login can't be handed over)", async () => {
    const res = await alex.client("").seatRun({ machine: "arvid-mac", runtime: "kimi", permission_mode: "bypassPermissions", brief: "hello" });
    const s = await ended(res.seat);
    expect(s.state).toBe("refused");
    expect(s.reason).toMatch(/kimi seats run only as this machine's person/);
  }, 30_000);
});
