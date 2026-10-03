// WALK-74 (ASYNC-PERMS-1): a seat accepted while its launcher was allowed is judged again just before it starts, and
// again before a paused seat continues. Preparing a seat takes time (the seat env file, a bundle fetch, a seat user's
// cleanup wait); a launcher demoted to observer meanwhile starts nothing: the seat ends `refused` with the plain reason,
// and the runtime never runs. A seat prepared while the host's person was busy starts stopped; a launcher demoted while
// it waits has it stopped, with the reason, when the person resumes, and the commits it made come back to the host's
// channel (which no longer holds that launcher). A refusal that isn't the launcher's own (the seats channel being
// narrowed after an unrelated demotion, a launcher entry matching two machines) never stops it: it stays paused and
// resumes once the roster settles; the host's person sees it waiting, and if nothing settles it, it is stopped after
// a bound with its commits kept on the host. A launcher made an observer is refused at start even before the channel
// is narrowed. The controls: the same slow preparation (and the same busy window) with the launcher still allowed run
// the seat to the end.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { TERMINAL_STATES, seatsChannel, type SeatView } from "../../src/protocol/seats.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { memberByHandle } from "../../src/daemon/roster.ts";
import { seatsFor } from "../../src/daemon/seats/host.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
/** Arvid's bound on a held resume (30 min in production). */
const HOLD_MS = 4_000;
const BUN_DIR = dirname(process.execPath);

let c: Cluster;
let alex: TestNode;
let bob: TestNode;
let carol: TestNode;
let arvid: TestNode;
let claudeLog: string;
let gate: string;
let channel: string;

function person(n: TestNode): WalkieClient { return n.client(""); }
const seatOnHost = async (id: string): Promise<SeatView | undefined> => (await person(arvid).seats(id)).seats[0];
const ended = (id: string) =>
  waitFor(async () => { const s = await seatOnHost(id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id} to end` });
const launches = (): string[] => existsSync(claudeLog)
  ? readFileSync(claudeLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.stringify(JSON.parse(l))) : [];
/** The seat env file blocks every launch's preparation until the gate file exists (sourcing is bounded at 10 s). */
function holdPreparation(): void {
  rmSync(gate, { force: true });
  writeFileSync(join(arvid.d.core.paths.home, "seat-env"), `while [ ! -f '${gate}' ]; do sleep 0.05; done\n`);
}
const preparing = (id: string) => waitFor(() => seatsFor(arvid.d.core)?.isRunning(id) ? true : null, { what: `seat ${id} preparing on arvid` });
/** The seat's runtime process exists (it was spawned; while the person is busy, spawned stopped). */
const spawned = (id: string) => waitFor(() => (seatsFor(arvid.d.core) as unknown as { seats: Map<string, { child: unknown }> } | undefined)?.seats.get(id)?.child ? true : null, { what: `seat ${id} spawned on arvid` });
/** Bob a member again, and back in arvid's seats channel (a launcher there). */
async function restoreBob(): Promise<void> {
  await alex.client().setRole("bob", "member");
  await waitFor(() => arvid.d.core.roster.channels.get(channel)?.members?.includes("bob") ? true : null, { timeoutMs: 15_000, what: "bob back in arvid's seats channel" });
}
async function demoteBob(): Promise<void> {
  await alex.client().setRole("bob", "observer");
  await waitFor(() => memberByHandle(arvid.d.core.roster, "bob")?.role === "observer" ? true : null, { timeoutMs: 15_000, what: "arvid sees bob as an observer" });
  // The seats channel is narrowed to the host's person (an observer is no launcher), so the reason is the launcher's
  // own, not the channel's.
  await waitFor(() => arvid.d.core.roster.channels.get(channel)?.members?.join(",") === "arvid" ? true : null, { timeoutMs: 15_000, what: "arvid's seats channel narrowed" });
}
/** A git repo with one commit, bundled on bob's machine (what `walkie seat run --repo <dir>` sends); its hash. */
async function repoBundle(name: string): Promise<string> {
  const repo = join(c.root, name);
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd: repo, stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  const file = join(c.root, `${name}.bundle`);
  git("bundle", "create", file, "HEAD", "main");
  return (await bob.client().seatsBundle(new Uint8Array(readFileSync(file)))).hash;
}
/** After a test, success or not: no busy setting and no seat of it left on arvid. */
async function settle(seat: string): Promise<void> {
  await person(arvid).seatsResume().catch(() => undefined);
  if (seatsFor(arvid.d.core)?.isRunning(seat)) await seatsFor(arvid.d.core)?.stopLocal(seat, "arvid");
}
/** The narrowing window's state on arvid only, with nothing to end it: `extra` in the seats channel. Returns the restore. */
function widen(extra: string): () => void {
  const core = arvid.d.core as unknown as { chain: { current: { channels: ReadonlyMap<string, { members?: string[] }> } } };
  const before = core.chain.current;
  const ch = before.channels.get(channel) as { members: string[] };
  core.chain.current = { ...before, channels: new Map(before.channels).set(channel, { ...ch, members: [...ch.members.filter((m) => m !== extra), extra] }) };
  return () => { core.chain.current = before; };
}
type HostSeats = { seats: Map<string, { child: unknown; paused: boolean; stop: unknown }>; held: Set<string> };
const hostSeats = () => seatsFor(arvid.d.core) as unknown as HostSeats;
/** Arvid's launchers, and the seats channel shaped for them. */
async function launchers(list: string[], members: string[]): Promise<void> {
  await person(arvid).seatsConfig({ allow: true, same_user: true, launchers: list, env: ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_STATE"] });
  await waitFor(() => [...(arvid.d.core.roster.channels.get(channel)?.members ?? [])].sort().join(",") === [...members].sort().join(",") ? true : null,
    { timeoutMs: 15_000, what: `arvid's seats channel as ${members.join(",")}` });
}
/** Launches a seat whose preparation is held, makes arvid's person busy (so it is paused), then lets it start stopped. */
async function startedStopped(prompt: string, bundle?: string): Promise<string> {
  holdPreparation();
  const { seat } = await person(bob).seatRun({ machine: "arvid-mac", runtime: "claude", prompt, ...(bundle ? { bundle } : {}) });
  await preparing(seat);
  await person(arvid).seatsBusy({ max: 0 });
  writeFileSync(gate, "");
  await spawned(seat);
  expect((await seatOnHost(seat))?.state).toBe("paused");
  return seat;
}

beforeAll(async () => {
  c = new Cluster();
  const home = join(c.root, "arvid-home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-access", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference"] } }), { mode: 0o600 });
  claudeLog = join(c.root, "claude.jsonl");
  gate = join(c.root, "gate");
  const seats = {
    flushMs: 100, keychain: async () => null, holdMaxMs: HOLD_MS, launchesPerMinute: 100, // this file launches more than 10 a minute from @bob
    env: { PATH: `${join(FIXTURES, "fake-claude")}:${BUN_DIR}:/usr/bin:/bin`, HOME: home, FAKE_CLAUDE_LOG: claudeLog, FAKE_CLAUDE_STATE: join(c.root, "fake-state") },
  };
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  bob = await c.add({ name: "bob", login: "bob@example.com", hostname: "bob-mbp" });
  carol = await c.add({ name: "carol", login: "carol@example.com", hostname: "carol-mbp" });
  arvid = await c.add({ name: "arvid", login: "arvid@example.com", hostname: "arvid-mac", seats });
  await alex.client().init("aka", "alex");
  for (const [n, h] of [[bob, "bob"], [carol, "carol"], [arvid, "arvid"]] as const) {
    await alex.client().invite(`${h}@example.com`, h, "member");
    expect((await n.client().join(alex.peerAddr)).admitted).toBe(true);
  }
  channel = seatsChannel(arvid.d.nodeId);
  await person(arvid).seatsConfig({ allow: true, same_user: true, launchers: ["@bob"], env: ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_STATE"] });
  await waitFor(() => bob.d.core.roster.channels.get(channel)?.members?.includes("bob") ? true : null, { timeoutMs: 15_000, what: "bob in arvid's seats channel" });
}, 60_000);

afterAll(async () => { writeFileSync(gate, ""); await c.close(); });

test("control: a launcher still allowed when the slow preparation ends gets the seat run", async () => {
  holdPreparation();
  const { seat } = await person(bob).seatRun({ machine: "arvid-mac", runtime: "claude", prompt: "recheck-control" });
  await preparing(seat);
  writeFileSync(gate, "");
  const s = await ended(seat);
  expect(s.state).toBe("done");
  expect(launches().some((l) => l.includes("recheck-control"))).toBe(true);
}, 60_000);

test("a launcher demoted to observer while the seat prepared: refused before it starts, with the reason", async () => {
  holdPreparation();
  const { seat } = await person(bob).seatRun({ machine: "arvid-mac", runtime: "claude", prompt: "recheck-demoted" });
  await preparing(seat);
  await demoteBob();
  writeFileSync(gate, "");
  const s = await ended(seat);
  expect(s.state).toBe("refused");
  expect(s.reason).toBe("re-checked before it started: @bob is now an observer, and observers can't start seats");
  expect(launches().some((l) => l.includes("recheck-demoted"))).toBe(false);
  await restoreBob();
}, 60_000);

test("control: a seat that started stopped while the person was busy runs when they resume, its launcher still allowed", async () => {
  const seat = await startedStopped("recheck-resume-control");
  await person(arvid).seatsResume();
  const s = await ended(seat);
  expect(s.state).toBe("done");
}, 60_000);

test("a launcher demoted while the seat waited stopped (person busy): stopped with the reason when the person resumes", async () => {
  const seat = await startedStopped("recheck-resume-demoted");
  await demoteBob();
  await person(arvid).seatsResume();
  const s = await ended(seat);
  expect(s.state).toBe("stopped");
  expect(s.reason).toBe("re-checked before it resumed: @bob is now an observer, and observers can't start seats");
  await restoreBob();
}, 60_000);

test("a launcher who lost the right while the seat was paused mid-run: stopped, and its commits come back to the host's channel only", async () => {
  const bundle = await repoBundle("repo-abort");
  const { seat } = await person(bob).seatRun({ machine: "arvid-mac", runtime: "claude", prompt: "please commit then go slow", bundle });
  await waitFor(async () => (await seatOnHost(seat))?.output.some((o) => o.text.includes("git commit")) ? true : null, { timeoutMs: 20_000, what: "the seat committed" });
  await person(arvid).seatsBusy({ max: 0 });
  await waitFor(async () => (await seatOnHost(seat))?.state === "paused" ? true : null, { what: "the seat paused" });
  try {
    await demoteBob();
    await person(arvid).seatsResume();
    const s = await ended(seat);
    expect(s.state).toBe("stopped");
    expect(s.reason).toBe("re-checked before it resumed: @bob is now an observer, and observers can't start seats");
    expect(s.commits).toBe(1);
    expect(s.result_bundle).toMatch(/^[0-9a-f]{64}$/);
    // The channel those commits went to holds the host's person only: bob, the launcher who lost the right, isn't in it.
    expect(arvid.d.core.roster.channels.get(channel)?.members).toEqual(["arvid"]);
  } finally { await settle(seat); await restoreBob(); }
}, 60_000);

test("an unrelated demotion narrows the channel while bob's seat waits: it stays paused, then resumes and returns its commits", async () => {
  await launchers(["@bob", "@carol"], ["arvid", "bob", "carol"]);
  const bundle = await repoBundle("repo-window");
  const seat = await startedStopped("please commit the work", bundle);
  // Carol (another launcher) made an observer: the channel still holds her until arvid's daemon narrows it (debounced
  // half a second, then the roster authority). A resume in that window is held, never a stop: bob is still allowed.
  try {
    await alex.client().setRole("carol", "observer");
    await waitFor(() => memberByHandle(arvid.d.core.roster, "carol")?.role === "observer" ? true : null, { intervalMs: 5, what: "arvid sees carol as an observer" });
    await person(arvid).seatsResume();
    expect(hostSeats().seats.get(seat)).toMatchObject({ paused: true, stop: null });
    expect(hostSeats().held.has(seat)).toBe(true);
    // The narrowing (a channel.upsert) rebalances: the held seat resumes and finishes.
    const s = await ended(seat);
    expect(s.state).toBe("done");
    expect(s.commits).toBe(1);
    expect(s.result_bundle).toMatch(/^[0-9a-f]{64}$/);
    expect(arvid.d.core.roster.channels.get(channel)?.members?.slice().sort()).toEqual(["arvid", "bob"]);
  } finally { await settle(seat); await alex.client().setRole("carol", "member"); }
}, 60_000);

test("a launcher entry that matches two machines while bob's seat waits: held, then resumed once one is revoked", async () => {
  await launchers(["@bob/bob-mbp"], ["arvid", "bob"]);
  const seat = await startedStopped("recheck-ambiguous");
  // A second admitted machine of bob's named bob-mbp makes the entry ambiguous (rules.ts machineCount).
  const twin = generateKeys();
  const node = { node_id: twin.nodeId, login: "bob@example.com", hostname: "bob-mbp", pubkey: twin.pubkey, ip: "127.0.0.1" };
  alex.d.core.emit("team.node", node);
  try {
    await waitFor(() => arvid.d.core.roster.nodes.get(twin.nodeId) ? true : null, { what: "arvid sees bob's second bob-mbp" });
    await person(arvid).seatsResume();
    await Bun.sleep(1_000);
    expect(hostSeats().seats.get(seat)).toMatchObject({ paused: true, stop: null });
    expect(hostSeats().held.has(seat)).toBe(true);
    // Revoking the twin (a team.node) settles it: the held seat resumes and finishes.
    alex.d.core.emit("team.node", { ...node, revoked: true });
    const s = await ended(seat);
    expect(s.state).toBe("done");
  } finally {
    if (!alex.d.core.roster.nodes.get(twin.nodeId)?.revoked) alex.d.core.emit("team.node", { ...node, revoked: true });
    await settle(seat);
    await launchers(["@bob"], ["arvid", "bob"]);
  }
}, 60_000);

test("a launcher made an observer while the seat prepared, the gate opening before the channel is narrowed: refused", async () => {
  holdPreparation();
  const { seat } = await person(bob).seatRun({ machine: "arvid-mac", runtime: "claude", prompt: "recheck-window-start" });
  await preparing(seat);
  try {
    await alex.client().setRole("bob", "observer");
    await waitFor(() => memberByHandle(arvid.d.core.roster, "bob")?.role === "observer" ? true : null, { intervalMs: 5, what: "arvid sees bob as an observer" });
    const atGate = [...(arvid.d.core.roster.channels.get(channel)?.members ?? [])];
    writeFileSync(gate, "");
    expect(atGate).toContain("bob"); // the window: arvid's daemon narrows the channel only half a second later
    const s = await ended(seat);
    expect(s.state).toBe("refused");
    expect(s.reason).toBe("re-checked before it started: @bob is now an observer, and observers can't start seats");
    expect(launches().some((l) => l.includes("recheck-window-start"))).toBe(false);
  } finally { await settle(seat); await restoreBob(); }
}, 60_000);

test("a held resume is shown waiting on the host; nothing settling it, it is stopped after the bound with its commits kept on the host", async () => {
  const bundle = await repoBundle("repo-hold");
  const { seat } = await person(bob).seatRun({ machine: "arvid-mac", runtime: "claude", prompt: "please commit then go slow", bundle });
  await waitFor(async () => (await seatOnHost(seat))?.output.some((o) => o.text.includes("git commit")) ? true : null, { timeoutMs: 20_000, what: "the seat committed" });
  await person(arvid).seatsBusy({ max: 0 });
  await waitFor(async () => (await seatOnHost(seat))?.state === "paused" ? true : null, { what: "the seat paused" });
  const restore = widen("alex"); // no roster event will come to narrow it
  try {
    await person(arvid).seatsResume();
    const waiting = await seatOnHost(seat);
    expect(waiting?.state).toBe("paused");
    expect(waiting?.reason).toMatch(/^waiting for the seats channel to be narrowed \(held since \d{4}-\d\d-\d\dT[\d:.]+Z\)$/);
    const s = await ended(seat);
    expect(s.state).toBe("stopped");
    const m = /^stopped after waiting 4 s for the seats channel to be narrowed · its commits are kept on this machine: (\S+result\.bundle)$/.exec(s.reason ?? "");
    expect(m).not.toBeNull();
    expect(s.commits).toBe(1);
    const file = (m?.[1] ?? "").replace(/^~(?=\/)/, homedir());
    const heads = Bun.spawnSync(["git", "bundle", "list-heads", file], { stdout: "pipe", stderr: "pipe" });
    expect(heads.exitCode).toBe(0);
    expect(heads.stdout.toString()).toMatch(/^[0-9a-f]{40} /);
  } finally { restore(); await settle(seat); }
}, 60_000);

test("a held seat whose channel is narrowed while its person is busy again: released, shown paused for the busy person, never stopped by the bound", async () => {
  const seat = await startedStopped("recheck-held-busy");
  const restore = widen("alex");
  let restored = false;
  try {
    await person(arvid).seatsResume();
    expect(hostSeats().held.has(seat)).toBe(true);
    await person(arvid).seatsBusy({ max: 0 }); // the person is busy again before the narrowing lands
    restore();
    restored = true;
    await alex.client().setRole("carol", "observer"); // a roster event: the channel is fine, the seat stays paused for busy
    // Released by the roster event itself, well before the bound would judge it.
    await waitFor(() => !hostSeats().held.has(seat) ? true : null, { timeoutMs: HOLD_MS / 2, what: "the seat released from the hold" });
    expect(await seatOnHost(seat)).toMatchObject({ state: "paused", reason: "the host's person is using the machine" });
    await Bun.sleep(HOLD_MS + 1_500); // past the bound: nothing stops it
    expect(hostSeats().seats.get(seat)).toMatchObject({ paused: true, stop: null });
    await person(arvid).seatsResume();
    expect((await ended(seat)).state).toBe("done");
  } finally {
    if (!restored) restore();
    await alex.client().setRole("carol", "member");
    await settle(seat);
  }
}, 60_000);

test("a held seat whose channel became fine with no roster event, its person busy again: at the bound it is judged again, released, not stopped", async () => {
  const seat = await startedStopped("recheck-held-bound");
  const restore = widen("alex");
  let restored = false;
  try {
    await person(arvid).seatsResume();
    expect(hostSeats().held.has(seat)).toBe(true);
    await person(arvid).seatsBusy({ max: 0 });
    restore(); // the channel is fine again, and no roster event says so: only the bound's own re-check sees it
    restored = true;
    await Bun.sleep(HOLD_MS + 1_500);
    expect(hostSeats().held.has(seat)).toBe(false);
    expect(hostSeats().seats.get(seat)).toMatchObject({ paused: true, stop: null });
    expect(await seatOnHost(seat)).toMatchObject({ state: "paused", reason: "the host's person is using the machine" });
    await person(arvid).seatsResume();
    expect((await ended(seat)).state).toBe("done");
  } finally {
    if (!restored) restore();
    await settle(seat);
  }
}, 60_000);
