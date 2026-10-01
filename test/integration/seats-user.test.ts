// Seats as a separate OS user (Opus r2 MEDIUM 1, PROTOCOL §11 "Seat user") on a 2-machine team with a FAKE codex.
// Tests can't create OS users, so the uid switch is the one faked part: instead of `sudo -n -u <user> <runner>`, the
// runner runs in a macOS sandbox that denies it the daemon's Walkie home (reads, writes and unix-socket connects), as
// a different user's permissions would. Everything else is the real path: the runner protocol on stdin, the seat's
// directory under the seat user's home, the shared seats socket, the token file, control of the runtime's group
// through the runner (busy, stop), the commits coming back over the pipe. The real switch is checked by hand
// (docs/INSTALL.md "Remote seats": walkie seats setup-user --apply, then the probe in docs/SECURITY.md threat 13).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { TERMINAL_STATES, seatsChannel, type SeatView } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, type FakeSeatWorld, signInCodex } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const SANDBOX = "/usr/bin/sandbox-exec";
const canSandbox = process.platform === "darwin" && existsSync(SANDBOX);

let c: Cluster;
let alex: TestNode;
let arvid: TestNode;
let log: string;
let seatHome: string;
let world: FakeSeatWorld;
let channel: string;

function person(n: TestNode): WalkieClient { return n.client(""); }
const seatOn = async (id: string): Promise<SeatView | undefined> => (await alex.client().seats(id)).seats[0];
const inState = (id: string, state: SeatView["state"]) =>
  waitFor(async () => ((await seatOn(id))?.state === state ? seatOn(id) : null), { timeoutMs: 20_000, what: `seat ${id} ${state}` });
const ended = (id: string) =>
  waitFor(async () => { const s = await seatOn(id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id} to end` });
const lines = (): Array<Record<string, unknown>> =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
const launchLine = (prompt: string) => waitFor(() => lines().find((l) => l.prompt === prompt), { what: `the runtime for "${prompt}"` });
const stat = (pid: number) => Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const launch = async (prompt: string, bundle?: string) =>
  (await person(alex).seatRun({ machine: "arvid-mac", runtime: "codex", prompt, ...(bundle ? { bundle } : {}) })).seat;

beforeAll(async () => {
  c = new Cluster();
  const home = join(c.root, "arvid-home");
  mkdirSync(home, { recursive: true });
  chmodSync(home, 0o700); // the person's home, closed to other users (seat users included)
  signInCodex(home);
  log = join(c.root, "codex.jsonl");
  const walkieHome = join(c.root, "arvid");
  // Seat users made and destroyed by the real helper logic over a fake system (test/helpers/fake-seat-users.ts).
  world = fakeSeatWorld(c.root, walkieHome);
  seatHome = world.homes;
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: {
      flushMs: 100, launchesPerMinute: 100, userSwitch: world.userSwitch, admin: world.admin, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles, env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, FAKE_CODEX_LOG: log } },
  });
  expect(arvid.home).toBe(walkieHome);
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  channel = seatsChannel(arvid.d.nodeId);
}, 60_000);

afterAll(async () => { await c.close(); });

describe("seats as a separate OS user", () => {
  test("a fresh company's allow-only config selects same-user mode", async () => {
    const same = await person(arvid).seatsConfig({ allow: true, env: ["FAKE_CODEX_LOG"] });
    expect(same.local).toMatchObject({ allow: true, ephemeral: false, same_user: true });
    await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "arvid-mac takes seats" });
  }, 30_000);

  test("same user: the seat reaches the host's main socket by path; as the seat user it can't, and keeps its own socket", async () => {
    // Before (the residual Opus reproduced): a seat running as the daemon's user connects to the main socket.
    const before = await launch(`probe-main ${arvid.socket} as the same user`);
    expect((await ended(before)).state).toBe("done");
    expect(lines().find((l) => typeof l.probe_main === "string")?.probe_main).toBe("200");

    const { local } = await person(arvid).seatsConfig({ allow: true, ephemeral: true, same_user: false });
    expect(local).toMatchObject({ allow: true, ephemeral: true, same_user: false });
    const id = await launch(`probe-main ${arvid.socket} probe-walkie ${channel}`);
    const s = await ended(id);
    expect(s.state).toBe("done");
    expect(s.dir).toMatch(/^~walkie-s\d+\/walkie-seats\//);
    const run = lines().find((l) => typeof l.prompt === "string" && (l.prompt as string).startsWith("probe-main") && (l.prompt as string).includes("probe-walkie"));
    const main = lines().filter((l) => typeof l.probe_main === "string").pop()?.probe_main;
    const probe = lines().filter((l) => l.probe).pop() as { own_post: number; socket: string; token_mode: string; probe: Record<string, number> };
    if (canSandbox) expect(main).not.toBe("200"); // the daemon's socket is out of reach
    expect(String(run?.home)).toMatch(new RegExp(`^${seatHome}/walkie-s\\d+$`));
    expect(String(run?.cwd).startsWith(`${run?.home}/walkie-seats/`)).toBe(true);
    // Its credential: a 0600 file named in the environment, never the token itself (ps -E, Opus r2 LOW 2).
    expect(run?.env).toContain("WALKIE_SEAT_TOKEN_FILE");
    expect(run?.env).not.toContain("WALKIE_SEAT_TOKEN");
    expect(probe.token_mode).toBe("600");
    // The seats' socket is outside the daemon's home and still does its one job.
    expect(probe.socket.startsWith(arvid.home)).toBe(false);
    expect(probe.own_post).toBe(200);
    expect(Object.entries(probe.probe).filter(([, st]) => st !== 401 && st !== 403)).toEqual([]);
  }, 60_000);

  test("the repo bundle goes in and the commits come back through the runner", async () => {
    const repo = join(c.root, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd: repo });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "hi\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "init");
    git("bundle", "create", join(c.root, "repo.bundle"), "HEAD", "main");
    const { hash } = await alex.client().seatsBundle(new Uint8Array(readFileSync(join(c.root, "repo.bundle"))));
    const id = await launch("commit as the seat user", hash);
    const s = await ended(id);
    expect(s.state).toBe("done");
    expect(s.commits).toBe(1);
    expect(s.result_bundle).toMatch(/^[0-9a-f]{64}$/);
    const cwd = String((await launchLine("commit as the seat user")).cwd);
    expect(cwd).toMatch(new RegExp(`^${seatHome}/walkie-s\\d+/walkie-seats/`)); // cloned by the runner, under the seat user's home
    expect(cwd.endsWith("/repo")).toBe(true);
  }, 60_000);

  test("separate-user seat is reported by its host as an agent", async () => {
    await person(arvid).seatsConfig({ allow: true, ephemeral: true, same_user: false, env: ["FAKE_CODEX_LOG"] });
    await waitFor(async () => (await alex.client().seats()).hosts.some((h) => h.node === arvid.d.nodeId && h.allows), { what: "seat host" });
    const id = await launch("slow separate-user card");
    await inState(id, "running");
    const name = `seat-${id.split(":")[0]?.slice(0, 6)}-${id.split(":")[1]}`;
    const row = await waitFor(() => {
      const body = arvid.d.core.store.agent(arvid.d.nodeId, name)?.body;
      return body ? JSON.parse(body) as Record<string, unknown> : null;
    }, { what: "separate-user card" });
    expect(row).toMatchObject({ agent: name, parent: "seats", launcher: "alex", runtime: "codex", started_at: expect.any(Number) });
    await person(alex).seatStop(id);
    await waitFor(() => arvid.d.core.store.agent(arvid.d.nodeId, name)?.body.includes('"state":"offline"'), { what: "seat offline" });
  }, 60_000);

  test("busy pauses the seat user's runtime through the runner (process stopped), resume continues it; stop ends its group", async () => {
    // Its child a bun worker in a session of its own (the fake uid scope sees bun processes, not macOS's own binaries).
    const id = await launch("setsid-worker ticker 600");
    const run = await launchLine("setsid-worker ticker 600");
    const pid = run.pid as number;
    const kid = await waitFor(() => lines().find((l) => l.from === pid && typeof l.worker === "number")?.worker as number | undefined, { what: "its child" });
    await inState(id, "running");
    await person(arvid).seatsBusy({ max: 0 });
    await waitFor(() => stat(pid).startsWith("T") && stat(kid).startsWith("T"), { what: "the group stopped" });
    await inState(id, "paused");
    await person(arvid).seatsResume();
    await waitFor(() => !stat(pid).startsWith("T"), { what: "running again" });
    await inState(id, "running");
    await person(alex).seatStop(id);
    expect((await ended(id)).reason).toBe("stopped by @alex");
    await waitFor(() => !alive(pid) && !alive(kid), { what: "the group gone" });
  }, 60_000);

  test("the seat user can't be changed while seats run; deny ends a seat user's seat", async () => {
    const id = await launch("ticker 600 before deny");
    const pid = (await launchLine("ticker 600 before deny")).pid as number;
    await inState(id, "running");
    await expect(person(arvid).seatsConfig({ allow: true, ephemeral: false, same_user: true })).rejects.toThrow(/migration/i);
    const { local } = await person(arvid).seatsConfig({ allow: false });
    expect(local.running).toBe(0);
    await waitFor(() => !alive(pid), { what: "the runtime gone" });
    expect((await ended(id)).reason).toBe("seats were turned off on this machine");
  }, 60_000);
});
