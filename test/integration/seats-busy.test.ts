// "I'm using this computer" end to end (PROTOCOL §11, busy) on a 2-machine team with a FAKE codex (its "ticker <n>"
// logs a tick every 100 ms): alex launches seats on arvid-mac; arvid says he's using it. Covers: only arvid (in
// person, on his machine) sets it; the newest running seats pause (their whole process group stopped, `ps -o stat`
// T) and stop making progress; a new launch queues; alex sees arvid-mac busy; resuming continues the paused seats
// (their time limit didn't run meanwhile) and starts the queued one; a stop (and a revoke) end paused and queued
// seats; the --for timer; the setting outlives a daemon restart; the CLI (busy/resume, run while busy).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { TERMINAL_STATES, seatOf, seatsChannel, type SeatView } from "../../src/protocol/seats.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";
import { signInCodex } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const CLI = join(import.meta.dir, "../../src/cli/main.ts");

let c: Cluster;
let alex: TestNode;
let arvid: TestNode;
let log: string;
let channel: string;

function person(n: TestNode): WalkieClient { return n.client(""); }

async function seatOn(n: TestNode, id: string): Promise<SeatView | undefined> {
  return (await n.client().seats(id)).seats[0];
}

async function inState(n: TestNode, id: string, state: SeatView["state"], timeoutMs = 20_000): Promise<SeatView> {
  return waitFor(async () => {
    const s = await seatOn(n, id);
    return s?.state === state ? s : null;
  }, { timeoutMs, what: `seat ${id} ${state}` });
}

async function ended(n: TestNode, id: string, timeoutMs = 40_000): Promise<SeatView> {
  return waitFor(async () => {
    const s = await seatOn(n, id);
    return s && TERMINAL_STATES.has(s.state) ? s : null;
  }, { timeoutMs, what: `seat ${id} to end` });
}

function lines(): Array<Record<string, unknown>> {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The pid of the runtime whose prompt was exactly `prompt`. */
async function runtimePid(prompt: string): Promise<number> {
  return waitFor(() => lines().find((l) => typeof l.prompt === "string" && l.prompt.trim() === prompt)?.pid as number | undefined, { what: `the runtime for "${prompt}"` });
}

function ticks(pid: number): number {
  return lines().filter((l) => l.pid === pid && typeof l.tick === "number").length;
}

/** `ps -o stat=`: "T…" while stopped; "" once the process is gone. */
function stat(pid: number): string {
  const r = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  return r.stdout.toString().trim();
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function launch(prompt: string, timeoutS = 600): Promise<string> {
  const res = await person(alex).seatRun({ machine: "arvid-mac", runtime: "codex", prompt, timeout_s: timeoutS });
  return res.seat;
}

/** The latest host post arvid-mac's daemon made, as alex's store has it. */
async function hostPost(): Promise<Record<string, unknown> | null> {
  const { events } = await alex.client().events({ channel, limit: 200 });
  const posts = events.filter((ev: Event) => seatOf(ev.body)?.op === "host" && ev.origin === arvid.d.nodeId).sort((x, y) => y.ts - x.ts || y.seq - x.seq);
  return posts[0] ? (seatOf(posts[0].body) as unknown as Record<string, unknown>) : null;
}

async function walkie(node: TestNode, args: string[], env: Record<string, string> = {}) {
  // As a person would (test/helpers/person-cli.ts): detached from this test's own process ancestry, which may include
  // an agent runtime that agent-detect.ts would rightly count.
  return runAsPerson([process.execPath, CLI, ...args], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: node.home, WALKIE_SOCKET: node.socket, ...env });
}

const leftovers: number[] = [];

beforeAll(async () => {
  c = new Cluster();
  const home = join(c.root, "arvid-home");
  mkdirSync(home, { recursive: true });
  signInCodex(home);
  log = join(c.root, "codex.jsonl");
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: { flushMs: 100, launchesPerMinute: 100, env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, FAKE_CODEX_LOG: log } },
  });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  channel = seatsChannel(arvid.d.nodeId);
}, 60_000);

afterAll(async () => {
  for (const pid of leftovers) if (alive(pid)) { try { process.kill(pid, "SIGCONT"); process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  await c.close();
});

describe("I'm using this computer (seats busy)", () => {
  test("the machine's person (or an agent of theirs while agent admin is on) sets it, only where seats are on", async () => {
    await expect(person(arvid).seatsBusy({ max: 0 })).rejects.toThrow(/seats are off on this machine/);
    await person(arvid).seatsConfig({ allow: true, same_user: true, env: ["FAKE_CODEX_LOG"] });
    await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "alex sees arvid-mac" });
    await expect(person(arvid).seatsBusy({ max: -1 })).rejects.toThrow(/max/);
    // AGENT-ADMIN-1: with agent admin off, an agent (header or the CLI's session marker) is refused…
    await person(arvid).adminSwitches({ agent_admin: false });
    await expect(arvid.client("cc-1").seatsBusy({ max: 0 })).rejects.toThrow(/agent admin is off/);
    const agent = await walkie(arvid, ["seats", "busy"], { CLAUDECODE: "1" });
    expect([agent.code, agent.err.includes("agent_admin_off")]).toEqual([1, true]);
    await person(arvid).adminSwitches({ agent_admin: true });
    // …and with it on (the default) it says so for its person, and resumes.
    await arvid.client("cc-1").seatsBusy({ max: 1 });
    await arvid.client("cc-1").seatsResume();
    expect((await person(arvid).seats()).local.availability).toMatchObject({ state: "available", max: 3, running: 0 });
  }, 60_000);

  test("busy pauses the newest seats (process group stopped), queues a launch; resume continues both and starts it", async () => {
    // Two seats with a 10 s limit that need ~6 s of work each: the pause below outlasts the limit on the wall clock.
    const a = await launch("ticker 60", 10);
    const aPid = await runtimePid("ticker 60");
    await inState(alex, a, "running");
    const b = await launch("ticker 61", 10);
    const bPid = await runtimePid("ticker 61");
    await inState(alex, b, "running");
    await waitFor(() => ticks(aPid) >= 3 && ticks(bPid) >= 3, { what: "both ticking" });
    leftovers.push(aPid, bPid);

    // Limit 1: the newer seat (b) pauses, a keeps running.
    const one = await person(arvid).seatsBusy({ max: 1 });
    expect(one.local.availability).toMatchObject({ state: "busy", max: 1, running: 1, paused: 1, queued: 0, by: "arvid" });
    await waitFor(() => stat(bPid).startsWith("T"), { what: "b stopped" });
    expect(stat(aPid).startsWith("T")).toBe(false);
    // Limit 0: a pauses too.
    const zero = await person(arvid).seatsBusy({ max: 0 });
    expect(zero.local.availability).toMatchObject({ state: "busy", max: 0, running: 0, paused: 2 });
    await waitFor(() => stat(aPid).startsWith("T"), { what: "a stopped" });
    const pausedAt = Date.now();
    const [ta, tb] = [ticks(aPid), ticks(bPid)];
    await inState(alex, a, "paused");
    expect((await inState(alex, b, "paused")).reason).toBe("the host's person is using the machine");

    // A new launch queues (accepted, answered "queued: host busy"); alex sees arvid-mac busy.
    const q = await launch("ticker 5");
    const qs = await inState(alex, q, "queued");
    expect(qs.reason).toBe("host busy: its person is using the machine");
    const seen = await waitFor(async () => {
      const h = (await alex.client().seats()).hosts.find((x) => x.node === arvid.d.nodeId);
      return h?.availability?.state === "busy" && h.availability.queued === 1 ? h.availability : null;
    }, { what: "alex sees arvid-mac busy with one queued" });
    expect(seen).toMatchObject({ state: "busy", max: 0, running: 0, paused: 2, queued: 1, by: "arvid" });
    expect(await hostPost()).toMatchObject({ op: "host", state: "busy", queued: 1 });
    const list = await walkie(alex, ["seats"]);
    expect(list.out).toContain("arvid-mac (@arvid) · seats allowed · online · you can launch · busy (@arvid is using it · limit 0 · 0 running · 2 paused · 1 queued)");
    expect((await person(arvid).seats()).local).toMatchObject({ running: 2, paused: 2, queued: 1 });

    // Held past the seats' 10 s limit on the wall clock; no progress while stopped.
    await Bun.sleep(Math.max(0, 10_500 - (Date.now() - pausedAt)));
    expect([ticks(aPid), ticks(bPid)]).toEqual([ta, tb]);
    expect(stat(aPid).startsWith("T") && stat(bPid).startsWith("T")).toBe(true);

    const resumed = await person(arvid).seatsResume();
    expect(resumed.local.availability).toMatchObject({ state: "available", max: 3 });
    await waitFor(() => ticks(aPid) > ta && ticks(bPid) > tb, { what: "both ticking again" });
    // Their limits didn't run while paused: both finish their work (not "timeout"), and the queued seat ran too.
    expect((await ended(alex, a)).state).toBe("done");
    expect((await ended(alex, b)).state).toBe("done");
    const qe = await ended(alex, q);
    expect(qe.state).toBe("done");
    expect(qe.started_at).toBeGreaterThan(pausedAt);
    expect(await hostPost()).toMatchObject({ op: "host", state: "available" });
  }, 90_000);

  test("stop while paused ends the whole group; a queued seat is stopped without ever starting", async () => {
    const s = await launch("spawn ticker 600");
    const pid = await runtimePid("spawn ticker 600");
    const grandchild = await waitFor(() => {
      const all = lines();
      return all.slice(all.findIndex((x) => x.pid === pid)).find((l) => typeof l.grandchild === "number")?.grandchild as number | undefined;
    }, { what: "its sleep" });
    leftovers.push(pid, grandchild);
    await inState(alex, s, "running");
    await person(arvid).seatsBusy({ max: 0 });
    await waitFor(() => stat(pid).startsWith("T") && stat(grandchild).startsWith("T"), { what: "the runtime and its child stopped" });
    const q = await launch("ticker 7");
    await inState(alex, q, "queued");

    // The launcher stops the paused seat: it continues just to exit; nothing of its group is left.
    await person(alex).seatStop(s);
    const st = await ended(alex, s);
    expect(st.state).toBe("stopped");
    expect(st.reason).toBe("stopped by @alex");
    await waitFor(() => !alive(pid) && !alive(grandchild), { what: "the group gone" });
    // The host's person stops the queued one on their own machine.
    expect((await person(arvid).seatStop(q)).stopped).toBe("local");
    const qe = await ended(alex, q);
    expect(qe.state).toBe("stopped");
    expect(qe.reason).toBe("stopped by @arvid (while queued)");
    expect(lines().some((l) => typeof l.prompt === "string" && l.prompt.trim() === "ticker 7")).toBe(false);
    await person(arvid).seatsResume();
  }, 60_000);

  test("seats deny while busy ends paused and queued seats and the busy setting", async () => {
    const s = await launch("ticker 601");
    const pid = await runtimePid("ticker 601");
    leftovers.push(pid);
    await inState(alex, s, "running");
    await person(arvid).seatsBusy({ max: 0 });
    await waitFor(() => stat(pid).startsWith("T"), { what: "stopped" });
    const q = await launch("ticker 8");
    await inState(alex, q, "queued");
    const off = await person(arvid).seatsConfig({ allow: false });
    expect(off.local).toMatchObject({ allow: false, running: 0, paused: 0, queued: 0, availability: { state: "available" } });
    expect(alive(pid)).toBe(false);
    expect((await ended(alex, s)).reason).toBe("seats were turned off on this machine");
    expect((await ended(alex, q)).reason).toBe("seats were turned off on this machine");
    await person(arvid).seatsConfig({ allow: true, same_user: true });
  }, 60_000);

  test("--for resumes by itself; the CLI says who is using it and a launch queues until then", async () => {
    const busy = await walkie(arvid, ["seats", "busy", "--max", "0", "--for", "4s"]);
    expect(busy.code).toBe(0);
    expect(busy.out).toMatch(/this machine: busy until .+ \(@arvid is using it · limit 0 · 0 running · 0 paused · 0 queued\)/);
    await waitFor(async () => (await hostPost())?.state === "busy", { what: "the busy post on alex" });
    const run = await walkie(alex, ["seat", "run", "--machine", "arvid-mac", "--runtime", "codex", "--", "ticker", "3"]);
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/^queued: arvid-mac is busy until .+ · seat \S+ starts when its person is done/);
    const id = /seat (\S+:\d+) starts/.exec(run.out)?.[1] ?? "";
    await inState(alex, id, "queued");
    // The timer ends it: the queued seat starts and finishes; the host says it's available.
    expect((await ended(alex, id, 30_000)).state).toBe("done");
    expect((await person(arvid).seats()).local.availability).toMatchObject({ state: "available", max: 3, running: 0 });
    await waitFor(async () => (await hostPost())?.state === "available", { what: "the available post" });
  }, 60_000);

  test("seat run --wait follows a queued seat through to done; the busy setting outlives a restart", async () => {
    await walkie(arvid, ["seats", "busy", "--max", "0"]);
    await waitFor(async () => (await hostPost())?.state === "busy", { what: "busy on alex" });
    const follow = walkie(alex, ["seat", "run", "--machine", "arvid-mac", "--runtime", "codex", "--wait", "--", "ticker", "2"]);
    await waitFor(async () => (await person(arvid).seats()).local.queued === 1, { what: "queued on arvid" });
    await Bun.sleep(1_500); // the follower polls every second: it has seen "queued" before the restart ends it
    await arvid.restart(); // the queued launch is answered "stopped"; the person is still busy after the restart
    const again = await person(arvid).seats();
    expect(again.local.availability).toMatchObject({ state: "busy", max: 0, by: "arvid" });
    const r = await follow;
    expect(r.code).toBe(1);
    expect(r.out).toContain("queued: arvid-mac is busy");
    expect(r.out.trim().split("\n").pop()).toBe("stopped · the host's Walkie daemon stopped");
    // A new launch now queues on the restarted daemon, and `walkie seats resume` starts it.
    const follow2 = walkie(alex, ["seat", "run", "--machine", "arvid-mac", "--runtime", "codex", "--wait", "--", "ticker", "3"]);
    await waitFor(async () => (await person(arvid).seats()).local.queued === 1, { what: "queued after the restart" });
    await Bun.sleep(1_500); // the follower polls every second: it has seen "queued" before the resume starts it
    const done = await walkie(arvid, ["seats", "resume"]);
    expect(done.out).toContain("this machine: available");
    const r2 = await follow2;
    expect(r2.code).toBe(0);
    expect(r2.out).toContain("queued: arvid-mac is busy");
    expect(r2.out).toContain("arvid-mac is free again");
    expect(r2.out.trim().split("\n").pop()).toMatch(/^done/);
  }, 90_000);
});
