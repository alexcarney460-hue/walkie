// A seat must not be handed an account until the launcher's standing is checked again. prepareV2 used to request
// the lease while it fetched the brief, and the re-check ran only at the end of spawn: a launcher demoted during
// that wait still received a vault hand-out. The hand-out now waits until the re-check passes. A channel that is
// only momentarily unfit waits the same way, and nothing is leased while it waits.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { AccountsSnapshot } from "../../src/protocol/accounts.ts";
import { TERMINAL_STATES, seatsChannel, type SeatView } from "../../src/protocol/seats.ts";
import type { VaultEntry } from "../../src/accounts/vault/vault.ts";
import { readBlob, blobPath } from "../../src/daemon/blobs.ts";
import { memberByHandle } from "../../src/daemon/roster.ts";
import { seatsFor } from "../../src/daemon/seats/host.ts";
import { accountsView } from "../../src/daemon/views.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const BUN_DIR = dirname(process.execPath);
const ACCOUNT = "a".repeat(24);
const TOKEN = "sk-ant-oat01-FAKEHANDOUTTOKEN0123456789abcdefghijk";
const OBSERVER = "re-checked before it started: @bob is now an observer, and observers can't start seats";

let c: Cluster;
let alex: TestNode;
let bob: TestNode;
let carol: TestNode;
let arvid: TestNode;
let gate: string;
let channel: string;
let leaseCalls = 0;
let restoreClient: (() => void) | null = null;

function person(n: TestNode): WalkieClient { return n.client(""); }
const seatOnHost = async (id: string): Promise<SeatView | undefined> => (await person(arvid).seats(id)).seats[0];
const ended = (id: string) =>
  waitFor(async () => { const s = await seatOnHost(id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id} to end` });
const preparing = (id: string) => waitFor(() => seatsFor(arvid.d.core)?.isRunning(id) ? true : null, { what: `seat ${id} preparing on arvid` });

function holdPreparation(): void {
  rmSync(gate, { force: true });
  writeFileSync(join(arvid.d.core.paths.home, "seat-env"), `while [ ! -f '${gate}' ]; do sleep 0.05; done\n`);
}

async function demoteBob(): Promise<void> {
  await alex.client().setRole("bob", "observer");
  await waitFor(() => memberByHandle(arvid.d.core.roster, "bob")?.role === "observer" ? true : null, { timeoutMs: 15_000, what: "arvid sees bob as an observer" });
  await waitFor(() => arvid.d.core.roster.channels.get(channel)?.members?.join(",") === "arvid" ? true : null, { timeoutMs: 15_000, what: "arvid's seats channel narrowed" });
}

async function restoreBob(): Promise<void> {
  await alex.client().setRole("bob", "member");
  await waitFor(() => arvid.d.core.roster.channels.get(channel)?.members?.includes("bob") ? true : null, { timeoutMs: 15_000, what: "bob back in arvid's seats channel" });
}

type HostSeat = { v2: { run: { brief: string } } | null };
const briefOf = (id: string): string => {
  const seat = (seatsFor(arvid.d.core) as unknown as { seats: Map<string, HostSeat> }).seats.get(id);
  const hash = seat?.v2?.run.brief;
  if (!hash) throw new Error("seat has no brief hash");
  return hash;
};

/**
 * The seat-env gate is still closed, so launch has started and prepareV2 has not. Drop the host's copy of the brief
 * and hold the peer fetch: opening the gate then reaches the await inside prepareV2.
 */
function hangBrief(id: string): { entered: Promise<void>; release: () => void } {
  const hash = briefOf(id);
  const bytes = readBlob(arvid.d.core.paths.blobs, hash) ?? readBlob(bob.d.core.paths.blobs, hash);
  if (!bytes) throw new Error("brief blob is not on the host or the launcher");
  rmSync(blobPath(arvid.d.core.paths.blobs, hash), { force: true });
  const client = arvid.d.client;
  const real = client.blob.bind(client);
  let entered!: () => void;
  const enteredP = new Promise<void>((r) => { entered = r; });
  let release!: (bytes: Uint8Array) => void;
  const held = new Promise<Uint8Array>((r) => { release = r; });
  let opened = false;
  client.blob = async (addr, h, ch, max) => {
    if (h !== hash) return real(addr, h, ch, max);
    if (!opened) { opened = true; entered(); }
    return held;
  };
  restoreClient = () => { client.blob = real; };
  return { entered: enteredP, release: () => release(bytes) };
}

function widen(extra: string): () => void {
  const core = arvid.d.core as unknown as { chain: { current: { channels: ReadonlyMap<string, { members?: string[] }> } } };
  const before = core.chain.current;
  const ch = before.channels.get(channel) as { members: string[] };
  core.chain.current = { ...before, channels: new Map(before.channels).set(channel, { ...ch, members: [...ch.members.filter((m) => m !== extra), extra] }) };
  return () => { core.chain.current = before; };
}

beforeAll(async () => {
  c = new Cluster();
  const home = join(c.root, "arvid-home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-access", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference"] } }), { mode: 0o600 });
  gate = join(c.root, "gate");
  const seats = {
    flushMs: 100, keychain: async () => null, holdMaxMs: 4_000, launchesPerMinute: 100,
    env: { PATH: `${join(FIXTURES, "fake-claude")}:${BUN_DIR}:/usr/bin:/bin`, HOME: home, FAKE_CLAUDE_LOG: join(c.root, "claude.jsonl"), FAKE_CLAUDE_STATE: join(c.root, "fake-state") },
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
  const snap = AccountsSnapshot.parse({
    at: Date.now(),
    accounts: [{
      id: ACCOUNT, provider: "claude", label: "Claude account", plan: null, agents: [], usage: null, last_seen: Date.now(),
      vault: { policy: "shared", share_with: ["arvid", "bob"], gen: "ab", home_at: Date.now() },
    }],
  });
  alex.d.core.accounts = snap;
  alex.d.core.vault = {
    list: () => [{ id: ACCOUNT, provider: "claude", label: "Claude account", plan: null, policy: "shared", share_with: ["arvid", "bob"], created_at: 1, expires_at: null, home: null, linked: false, gen: "ab" } as VaultEntry],
    claudeToken: async () => TOKEN,
  };
  alex.d.core.vaultSharing = () => true;
  alex.d.core.vaultRoomLeft = () => 90;
  const real = arvid.d.client.vaultLease.bind(arvid.d.client);
  arvid.d.client.vaultLease = async (addr, body) => { leaseCalls++; return real(addr, body); };
  await waitFor(() => {
    const view = accountsView(arvid.d.core, arvid.d.sync).find((a) => a.key === `alex:${ACCOUNT}`);
    return view?.machines.some((m) => m.node_id === alex.d.nodeId && m.online && m.vault?.policy === "shared") ? true : null;
  }, { timeoutMs: 20_000, what: "arvid sees alex's shared account" });
}, 90_000);

afterAll(async () => { writeFileSync(gate, ""); restoreClient?.(); await c.close(); });

async function launch(brief: string): Promise<string> {
  leaseCalls = 0;
  holdPreparation();
  const { seat } = await person(bob).seatRun({ machine: "arvid-mac", runtime: "claude", brief, account: `alex:${ACCOUNT}` });
  await preparing(seat);
  return seat;
}

test("control: a launcher still allowed is handed the account and the seat runs", async () => {
  const seat = await launch("lease-recheck-control");
  writeFileSync(gate, "");
  const s = await ended(seat);
  expect(s.state).toBe("done");
  expect(leaseCalls).toBe(1);
}, 60_000);

test("a launcher demoted during the brief fetch is refused and no lease is requested", async () => {
  const seat = await launch("lease-recheck-demoted");
  const hang = hangBrief(seat);
  try {
    writeFileSync(gate, "");
    await hang.entered;
    await demoteBob();
    hang.release();
    const s = await ended(seat);
    expect(leaseCalls).toBe(0);
    expect(s.state).toBe("refused");
    expect(s.reason).toBe(OBSERVER);
  } finally {
    restoreClient?.();
    restoreClient = null;
    writeFileSync(gate, "");
    await restoreBob();
  }
}, 60_000);

test("a channel that is too wide at start waits without leasing, then leases once it narrows", async () => {
  const seat = await launch("lease-recheck-held");
  const hang = hangBrief(seat);
  const narrow = widen("carol");
  try {
    writeFileSync(gate, "");
    await hang.entered;
    hang.release();
    await Bun.sleep(500);
    expect(leaseCalls).toBe(0);
    expect(TERMINAL_STATES.has((await seatOnHost(seat))?.state ?? "")).toBe(false);
    narrow();
    const s = await ended(seat);
    expect(s.state).toBe("done");
    expect(leaseCalls).toBe(1);
  } finally {
    narrow();
    restoreClient?.();
    restoreClient = null;
    writeFileSync(gate, "");
  }
}, 60_000);
