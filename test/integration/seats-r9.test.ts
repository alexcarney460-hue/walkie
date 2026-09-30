// Seats round 9 end to end (docs/audits/2026-09-26-*-seats-r9.md):
//   Codex r9 MEDIUM 1  an unnamed agent's remote stop is refused, like its launch
//   Codex r9 MEDIUM 4  the helper's held list is read (at start, whatever the mode) before the first seat user
//   Codex r9 MEDIUM 5  a dashboard session can use the Seats view's routes (not the token or bundle uploads)
//   Opus r9 LOW        nothing is a sub-agent of the seats host card
// Seat users: the REAL helper logic over a fake system.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WalkieClient } from "../../src/client/index.ts";
import type { AdminVerb } from "../../src/daemon/seats/admin.ts";
import { SEATS_AGENT, TERMINAL_STATES, type SeatView } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, signInCodex, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
let c: Cluster;
let alex: TestNode;
let arvid: TestNode;
let world: FakeSeatWorld;
/** What arvid's daemon asked its helper, in order. */
const asked: string[] = [];

const seatOn = async (id: string): Promise<SeatView | undefined> => (await alex.client().seats(id)).seats[0];
const ended = (id: string) =>
  waitFor(async () => { const s = await seatOn(id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id} to end` });
const url = (n: TestNode, p: string) => `http://127.0.0.1:${n.d.localPort as number}${p}`;

/** A dashboard session on node `n` (the `walkie dashboard` login). */
async function session(n: TestNode): Promise<Record<string, string>> {
  const { nonce } = await n.client().authNonce();
  const res = await fetch(url(n, `/auth?nonce=${nonce}`), { redirect: "manual" });
  const value = /#s=([0-9a-f]{64})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
  expect(value).not.toBe("");
  return { "X-Walkie-Session": value, Origin: `http://127.0.0.1:${n.d.localPort as number}`, "Content-Type": "application/json" };
}
const call = (n: TestNode, h: Record<string, string>, method: string, path: string, body?: unknown) =>
  fetch(url(n, path), { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeAll(async () => {
  c = new Cluster();
  const personHome = join(c.root, "arvid-home");
  mkdirSync(join(personHome, ".claude"), { recursive: true });
  chmodSync(personHome, 0o700);
  writeFileSync(join(personHome, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "access-token", refreshToken: "rt", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference"] } }), { mode: 0o600 });
  signInCodex(personHome);
  const walkieHome = join(c.root, "arvid");
  world = fakeSeatWorld(c.root, walkieHome);
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  mkdirSync(walkieHome, { recursive: true });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: {
      flushMs: 100, launchesPerMinute: 100, userSwitch: world.userSwitch, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
      admin: (verb: AdminVerb, n: number) => { asked.push(verb === "pending" ? "pending" : `${verb} ${n}`); return world.admin(verb, n); },
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: personHome },
    },
  });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
}, 60_000);

afterAll(async () => { await c.close(); });

describe("seats round 9", () => {
  test("Codex r9 MEDIUM 4 (+ Kimi r11 LOW 2): the helper's held list is read at start, before the first seat user", async () => {
    // A seat user the helper holds for this person that this daemon doesn't know of (seats.json lost it).
    expect((await world.admin("create", 1)).ok).toBe(true);
    asked.length = 0;
    await arvid.restart(); // seats off, but the helper is there: its list is read at start whatever the mode
    await waitFor(() => (asked.includes("pending") ? true : null), { what: "the held list read at start" });
    await waitFor(() => (world.destroyed.includes("walkie-s1") ? true : null), { what: "the held seat user destroyed" });
    await arvid.client("").seatsConfig({ allow: true, ephemeral: true });
    await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "arvid-mac takes seats" });
    const s = await ended((await alex.client().seatRun({ machine: arvid.d.nodeId, runtime: "codex", prompt: "after enabling" })).seat);
    expect(s.state).toBe("done");
    const firstCreate = asked.findIndex((a) => a.startsWith("create"));
    expect(asked.indexOf("pending")).toBeLessThan(firstCreate);
    expect(asked[firstCreate]).toBe("create 2"); // above the held id, never a collision with it
  }, 90_000);

  test("Codex r9 MEDIUM 1: an unnamed agent's remote stop is refused; a person's goes through", async () => {
    const unnamed = new WalkieClient({ socket: alex.socket, underAgent: true, timeoutMs: 15_000 });
    const runErr = await unnamed.seatRun({ machine: arvid.d.nodeId, runtime: "codex", prompt: "unnamed" })
      .then(() => "ok", (err: { status?: number; code?: string; message: string }) => `${err.status}:${err.code}:${err.message}`);
    expect(runErr).toBe("403:agent_unnamed:a seat request from an agent must name it: set WALKIE_AGENT=<name> in this agent's environment, or add --agent <name> to this walkie seat run command (the host checks this agent against its launcher policy)");
    const id = (await alex.client().seatRun({ machine: arvid.d.nodeId, runtime: "codex", prompt: "to stop" })).seat;
    const r = await unnamed.seatStop(id).then(() => "ok", (err: { status?: number; code?: string; message: string }) => `${err.status}:${err.code}:${err.message}`);
    // The exact fix, not just that it's required (Alex: the whole seat-run failure surface should say this).
    expect(r).toBe("403:agent_unnamed:a seat stop from an agent must name it: set WALKIE_AGENT=<name> in this agent's environment, or add --agent <name> to this walkie seat stop command (the host checks this agent against its launcher policy)");
    expect((await alex.client().seatStop(id)).stopped).toBe("requested");
    await ended(id);
  }, 60_000);

  test("Codex r9 MEDIUM 5: a dashboard session reaches the Seats view's routes, not the CLI's", async () => {
    const h = await session(arvid);
    expect((await call(arvid, h, "GET", "/v1/seats")).status).toBe(200);
    expect((await call(arvid, h, "GET", "/v1/seats/busy")).status).toBe(200);
    const busy = await call(arvid, h, "POST", "/v1/seats/busy", { max: 1 });
    expect(busy.status).toBe(200);
    expect(((await busy.json()) as { local: { availability: { state: string } } }).local.availability.state).toBe("busy");
    expect((await call(arvid, h, "POST", "/v1/seats/resume", {})).status).toBe(200);
    expect(((await (await call(arvid, h, "POST", "/v1/seats/config", { allow: false })).json()) as { local: { allow: boolean } }).local.allow).toBe(false);
    expect(((await (await call(arvid, h, "POST", "/v1/seats/config", { allow: true })).json()) as { local: { allow: boolean } }).local.allow).toBe(true);
    // Only on or off (Opus r10 LOW): who may launch, runtimes, the runner and the rest stay with the CLI.
    for (const extra of [{ launchers: ["@alex"] }, { runtimes: ["codex"] }, { runner: "/tmp/x" }, { ephemeral: false }, { max: 9 }]) {
      const r = await call(arvid, h, "POST", "/v1/seats/config", { allow: true, ...extra });
      expect(r.status).toBe(403);
    }
    expect((await arvid.client("").seats()).local.launchers).toEqual([]);
    expect((await call(arvid, h, "POST", "/v1/seats/config", { allow: true, same_user: false })).status).toBe(200);
    // Not the CLI's: the seats token and repo bundles.
    expect((await call(arvid, h, "POST", "/v1/seats/token", { token: `sk${""}-ant-oat01-${"z".repeat(60)}` })).status).toBe(403);
    expect((await call(arvid, h, "POST", "/v1/seats/bundle", {})).status).toBe(403);
    // The launcher's dashboard: launch and stop.
    const ha = await session(alex);
    await waitFor(async () => (await alex.client().seats()).hosts.find((x) => x.node === arvid.d.nodeId && x.allows && x.member), { what: "arvid-mac takes seats again" });
    const run = await call(alex, ha, "POST", "/v1/seats/run", { machine: arvid.d.nodeId, runtime: "codex", prompt: "from the dashboard" });
    expect(run.status).toBe(200);
    const id = ((await run.json()) as { seat: string }).seat;
    const stop = await call(alex, ha, "POST", "/v1/seats/stop", { seat: id });
    expect(stop.status).toBe(200);
    await ended(id);
  }, 90_000);

  test("Opus r9 LOW: nothing is a sub-agent of the seats host card", async () => {
    const r = await arvid.client(`${SEATS_AGENT}.x1`).status({ agent: `${SEATS_AGENT}.x1`, parent: SEATS_AGENT, state: "working", runtime: "claude-code", activity: "spoof" })
      .then(() => "ok", (err: { status?: number; message: string }) => `${err.status}:${err.message}`);
    expect(r).toMatch(/^403:seats' status is set by the host daemon only/);
    expect(arvid.d.core.store.agent(arvid.d.nodeId, `${SEATS_AGENT}.x1`)).toBeNull();
  });
});
