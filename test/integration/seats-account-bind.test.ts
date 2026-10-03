// A v2 seat that borrows an account must run its child on that account's login, not the host's. The login is
// requested only after the launcher is re-checked, and the child environment is built from the credentials that
// request wrote. A host with no Claude login of its own can still run one. The fake runtimes log credential
// variable names and CODEX_HOME, never values.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { AccountsSnapshot } from "../../src/protocol/accounts.ts";
import { TERMINAL_STATES, seatsChannel, type SeatView } from "../../src/protocol/seats.ts";
import type { VaultEntry } from "../../src/accounts/vault/vault.ts";
import { codexLeaseCopy } from "../../src/accounts/vault/codex-access.ts";
import { accountsView } from "../../src/daemon/views.ts";
import { seatsFor } from "../../src/daemon/seats/host.ts";
import { codexAccessToken } from "../helpers/accounts.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const BUN_DIR = dirname(process.execPath);
const CLAUDE_ACCOUNT = "a".repeat(24);
const CODEX_ACCOUNT = "c".repeat(24);
// Assembled at runtime so the source has no token-shaped literal.
const TOKEN = ["sk", "ant", "oat01"].join("-") + "-" + "bea".repeat(16);

let c: Cluster;
let bea: TestNode;
let noor: TestNode;
let olive: TestNode;
let home: string;
let logFile: string;
let codexLog: string;
let credFile: string;
let hostCodex: string;
let leaseCalls = 0;

const person = (n: TestNode): WalkieClient => n.client("");
const seatOnHost = async (id: string): Promise<SeatView | undefined> => (await person(olive).seats(id)).seats[0];
const ended = (id: string) =>
  waitFor(async () => { const s = await seatOnHost(id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id} to end` });

type Launch = { argv?: string[]; env?: string[]; access_file?: boolean; codex_home?: string | null };
const launches = (file: string): Launch[] => !existsSync(file) ? [] :
  readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Launch).filter((l) => Array.isArray(l.argv));

function lenderCodex(now: number): string {
  const access = codexAccessToken(now + 5 * 86_400_000);
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { access_token: access, refresh_token: "stays-on-the-lender", account_id: "lease-account" },
  });
}

beforeAll(async () => {
  c = new Cluster();
  home = join(c.root, "olive-home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  credFile = join(home, ".claude", ".credentials.json");
  hostCodex = join(home, ".codex");
  writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: "host-own-access", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference"] } }), { mode: 0o600 });
  writeFileSync(join(hostCodex, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { access_token: "host-codex-access", refresh_token: "", account_id: "host-not-the-lease" },
  }), { mode: 0o600 });
  logFile = join(c.root, "claude.jsonl");
  codexLog = join(c.root, "codex.jsonl");
  const seats = {
    flushMs: 100, keychain: async () => null, holdMaxMs: 4_000, launchesPerMinute: 100,
    env: {
      PATH: `${join(FIXTURES, "fake-claude")}:${join(FIXTURES, "fake-codex")}:${BUN_DIR}:/usr/bin:/bin`,
      HOME: home, FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_STATE: join(c.root, "fake-state"), FAKE_CODEX_LOG: codexLog,
    },
  };
  bea = await c.add({ name: "bea", login: "bea@example.com", hostname: "bea-mbp" });
  noor = await c.add({ name: "noor", login: "noor@example.com", hostname: "noor-mbp" });
  olive = await c.add({ name: "olive", login: "olive@example.com", hostname: "olive-mac", seats });
  await bea.client().init("aka", "bea");
  for (const [n, h] of [[noor, "noor"], [olive, "olive"]] as const) {
    await bea.client().invite(`${h}@example.com`, h, "member");
    expect((await n.client().join(bea.peerAddr)).admitted).toBe(true);
  }
  const channel = seatsChannel(olive.d.nodeId);
  await person(olive).seatsConfig({ allow: true, same_user: true, launchers: ["@noor"], env: ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_STATE", "FAKE_CODEX_LOG"] });
  await waitFor(() => noor.d.core.roster.channels.get(channel)?.members?.includes("noor") ? true : null, { timeoutMs: 15_000, what: "noor in olive's seats channel" });
  const vaultOf = (id: string, provider: "claude" | "codex", gen: string): VaultEntry => ({
    id, provider, label: provider === "codex" ? "ChatGPT account" : "Claude account", plan: null, policy: "shared", share_with: ["olive", "noor"], created_at: 1, expires_at: null, home: null, linked: false, gen,
  }) as VaultEntry;
  bea.d.core.accounts = AccountsSnapshot.parse({
    at: Date.now(),
    accounts: [
      { id: CLAUDE_ACCOUNT, provider: "claude", label: "Claude account", plan: null, agents: [], usage: null, last_seen: Date.now(), vault: { policy: "shared", share_with: ["olive", "noor"], gen: "c1", home_at: Date.now() } },
      { id: CODEX_ACCOUNT, provider: "codex", label: "ChatGPT account", plan: null, agents: [], usage: null, last_seen: Date.now(), vault: { policy: "shared", share_with: ["olive", "noor"], gen: "d1", home_at: Date.now() } },
    ],
  });
  bea.d.core.vault = {
    list: () => [vaultOf(CLAUDE_ACCOUNT, "claude", "c1"), vaultOf(CODEX_ACCOUNT, "codex", "d1")],
    claudeToken: async () => TOKEN,
    codexAccess: (_id: string, now: number) => codexLeaseCopy(lenderCodex(now), now),
  };
  bea.d.core.vaultSharing = () => true;
  bea.d.core.vaultRoomLeft = () => 90;
  const real = olive.d.client.vaultLease.bind(olive.d.client);
  olive.d.client.vaultLease = async (addr, body) => { leaseCalls++; return real(addr, body); };
  await waitFor(() => {
    const view = accountsView(olive.d.core, olive.d.sync);
    const claude = view.find((a) => a.key === `bea:${CLAUDE_ACCOUNT}`);
    const codex = view.find((a) => a.key === `bea:${CODEX_ACCOUNT}`);
    const online = (a: typeof claude) => a?.machines.some((m) => m.node_id === bea.d.nodeId && m.online && m.vault?.policy === "shared");
    return online(claude) && online(codex) ? true : null;
  }, { timeoutMs: 20_000, what: "olive sees bea's shared accounts" });
}, 90_000);

afterAll(async () => { await c.close(); });

test("a borrowed Claude seat's child gets the account token, not the host's login", async () => {
  rmSync(logFile, { force: true });
  leaseCalls = 0;
  const { seat } = await person(noor).seatRun({ machine: "olive-mac", runtime: "claude", brief: "account-claude", account: `bea:${CLAUDE_ACCOUNT}` });
  const s = await ended(seat);
  const l = launches(logFile);
  expect(s.state).toBe("done");
  expect(leaseCalls).toBe(1);
  expect(l.length).toBe(1);
  expect(l[0]?.env).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  expect(l[0]?.access_file).toBe(false);
}, 60_000);

test("a borrowed Codex seat's child uses the leased home, not the host's Codex home", async () => {
  rmSync(codexLog, { force: true });
  leaseCalls = 0;
  const { seat } = await person(noor).seatRun({ machine: "olive-mac", runtime: "codex", brief: "account-codex", account: `bea:${CODEX_ACCOUNT}` });
  const s = await ended(seat);
  const l = launches(codexLog);
  expect(s.state).toBe("done");
  expect(leaseCalls).toBe(1);
  expect(l.length).toBe(1);
  expect(l[0]?.env).toContain("CODEX_HOME");
  expect(l[0]?.codex_home ?? "").toMatch(/\/vault\/codex\/lease-[0-9a-f]{16}$/);
  expect(l[0]?.codex_home).not.toBe(hostCodex);
  expect(String(l[0]?.codex_home)).not.toContain(".walkie-workers");
}, 60_000);

test("a host with no Claude login of its own still runs a seat on a borrowed account", async () => {
  rmSync(logFile, { force: true });
  rmSync(credFile, { force: true });
  leaseCalls = 0;
  const { seat } = await person(noor).seatRun({ machine: "olive-mac", runtime: "claude", brief: "account-claude-no-host", account: `bea:${CLAUDE_ACCOUNT}` });
  const s = await ended(seat);
  const l = launches(logFile);
  expect(s.state).toBe("done");
  expect(l[0]?.env).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  expect(l[0]?.access_file).toBe(false);
}, 60_000);

test("a borrowed seat is bound to the lending machine and the credential generation it handed out (Codex pre.12 audit r3)", async () => {
  const h = seatsFor(olive.d.core) as unknown as Record<string, (...a: unknown[]) => unknown>;
  const orig = (h.watchAccount as (...a: unknown[]) => unknown).bind(h);
  const bound: unknown[] = [];
  h.watchAccount = (seat: unknown, plan: unknown) => { bound.push(plan); return orig(seat, plan); };
  try {
    const { seat } = await person(noor).seatRun({ machine: "olive-mac", runtime: "claude", brief: "account-claude-gen", account: `bea:${CLAUDE_ACCOUNT}` });
    expect((await ended(seat)).state).toBe("done");
    expect(bound).toEqual([expect.objectContaining({ kind: "peer", node: bea.d.nodeId, gen: "c1" })]);
  } finally { h.watchAccount = orig; }
}, 60_000);

test("a borrowed seat whose account is now lent by another machine is refused at the final check (Opus review of 9ffe1f81, S2)", async () => {
  const h = seatsFor(olive.d.core) as unknown as Record<string, (...a: unknown[]) => unknown>;
  const orig = (h.bindAccount as (...a: unknown[]) => Promise<void>).bind(h);
  // Bound to another lending machine than the one the account names now (as if it switched while the seat prepared).
  h.bindAccount = async (seat: unknown) => {
    await orig(seat);
    const v = (seat as { v2: { bound?: Record<string, unknown> } }).v2;
    if (v.bound) v.bound = { ...v.bound, node: "f".repeat(16) };
  };
  try {
    const { seat } = await person(noor).seatRun({ machine: "olive-mac", runtime: "claude", brief: "account-claude-switched", account: `bea:${CLAUDE_ACCOUNT}` });
    const s = await ended(seat);
    expect(s.state).toBe("refused");
    expect(s.reason ?? "").toContain("the account changed while the seat was being prepared");
  } finally { h.bindAccount = orig; }
}, 60_000);
