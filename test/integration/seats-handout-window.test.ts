// A borrowed login must not be written, or handed to any child (including `claude --help`), until the launcher is
// checked again after the hand-out returns. A hold after that drops the login and asks again once it clears.
// The fake claude wrapper records whether CLAUDE_CODE_OAUTH_TOKEN was set, including on --help. Values are never logged.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
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
const TOKEN = ["sk", "ant", "oat01"].join("-") + "-" + "bea".repeat(16);

let c: Cluster;
let bea: TestNode;
let noor: TestNode;
let olive: TestNode;
let channel: string;
let helpLog: string;
let slowHelp: string;
let codexLog: string;
let leaseCalls = 0;
let afterLease: (() => Promise<void>) | null = null;

const person = (n: TestNode): WalkieClient => n.client("");
const seatOnHost = async (id: string): Promise<SeatView | undefined> => (await person(olive).seats(id)).seats[0];
const ended = (id: string) =>
  waitFor(async () => { const s = await seatOnHost(id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id} to end` });
const helpRows = (): Array<Record<string, unknown>> => !existsSync(helpLog) ? [] :
  readFileSync(helpLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const codexRows = (): Array<Record<string, unknown>> => !existsSync(codexLog) ? [] :
  readFileSync(codexLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const leaseHomes = () => {
  const d = join(olive.home, "vault", "codex");
  return existsSync(d) ? readdirSync(d).filter((n) => n.startsWith("lease-")) : [];
};
const reset = () => { rmSync(helpLog, { force: true }); rmSync(codexLog, { force: true }); rmSync(slowHelp, { force: true }); leaseCalls = 0; afterLease = null; };
const run = async (runtime: "claude" | "codex", brief: string, account: string) =>
  (await person(noor).seatRun({ machine: "olive-mac", runtime, brief, account })).seat;
const configure = (launchers: string[]) => person(olive).seatsConfig({
  allow: true, same_user: true, launchers, env: ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_STATE", "FAKE_CODEX_LOG"],
});
/** The host remembers the first `claude --help`. A later seat would skip it, so a demotion would not show the token. */
const forgetHelpProbe = () => {
  const host = seatsFor(olive.d.core) as unknown as { permissionPrompts: boolean | null } | undefined;
  if (host) host.permissionPrompts = null;
};

function lenderCodex(now: number): string {
  return JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { access_token: codexAccessToken(now + 5 * 86_400_000), refresh_token: "stays-on-the-lender", account_id: "lease-account" } });
}

/** Puts `extra` in the host's seats channel so the channel is too wide (a hold, not a lost launcher). */
function widen(extra: string): () => void {
  const core = olive.d.core as unknown as { chain: { current: { channels: ReadonlyMap<string, { members?: string[] }> } } };
  const before = core.chain.current;
  const ch = before.channels.get(channel) as { members: string[] };
  core.chain.current = { ...before, channels: new Map(before.channels).set(channel, { ...ch, members: [...ch.members.filter((m) => m !== extra), extra] }) };
  return () => { core.chain.current = before; };
}

beforeAll(async () => {
  c = new Cluster();
  const home = join(c.root, "olive-home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "host-own-access", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference"] } }), { mode: 0o600 });
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { access_token: "host-codex-access", refresh_token: "", account_id: "host-not-the-lease" } }), { mode: 0o600 });
  helpLog = join(c.root, "help.jsonl");
  slowHelp = join(c.root, "slow-help");
  codexLog = join(c.root, "codex.jsonl");
  const wrapDir = join(c.root, "wrap");
  mkdirSync(wrapDir, { recursive: true });
  const fakeClaude = join(FIXTURES, "fake-claude", "claude");
  writeFileSync(join(wrapDir, "claude"), [
    "#!/bin/sh",
    "borrowed=0",
    'if [ -n "${CLAUDE_CODE_OAUTH_TOKEN+x}" ]; then borrowed=1; fi',
    'for a in "$@"; do',
    '  if [ "$a" = "--help" ]; then',
    `    echo "{\\"help\\":true,\\"phase\\":\\"start\\",\\"borrowed\\":$borrowed}" >> ${JSON.stringify(helpLog)}`,
    `    if [ -f ${JSON.stringify(slowHelp)} ]; then sleep 1; fi`,
    `    echo "{\\"help\\":true,\\"phase\\":\\"end\\",\\"borrowed\\":$borrowed}" >> ${JSON.stringify(helpLog)}`,
    `    exec ${JSON.stringify(fakeClaude)} "$@"`,
    "  fi",
    "done",
    `echo "{\\"help\\":false,\\"borrowed\\":$borrowed}" >> ${JSON.stringify(helpLog)}`,
    `exec ${JSON.stringify(fakeClaude)} "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  const seats = {
    flushMs: 100, keychain: async () => null, holdMaxMs: 4_000, launchesPerMinute: 100,
    env: {
      PATH: `${wrapDir}:${join(FIXTURES, "fake-claude")}:${join(FIXTURES, "fake-codex")}:${BUN_DIR}:/usr/bin:/bin`,
      HOME: home, FAKE_CLAUDE_LOG: join(c.root, "claude.jsonl"), FAKE_CLAUDE_STATE: join(c.root, "fake-state"), FAKE_CODEX_LOG: codexLog,
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
  channel = seatsChannel(olive.d.nodeId);
  await configure(["@noor"]);
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
  olive.d.client.vaultLease = async (addr, body) => {
    leaseCalls++;
    const res = await real(addr, body);
    if (afterLease) await afterLease();
    return res;
  };
  await waitFor(() => {
    const view = accountsView(olive.d.core, olive.d.sync);
    const online = (k: string) => view.find((a) => a.key === k)?.machines.some((m) => m.node_id === bea.d.nodeId && m.online && m.vault?.policy === "shared");
    return online(`bea:${CLAUDE_ACCOUNT}`) && online(`bea:${CODEX_ACCOUNT}`) ? true : null;
  }, { timeoutMs: 20_000, what: "olive sees bea's shared accounts" });
}, 90_000);

afterAll(async () => { await c.close(); });

test("a hold that appears after the hand-out, before the process starts, drops the login and asks again", async () => {
  reset();
  writeFileSync(slowHelp, "1");
  let undo: () => void = () => undefined;
  let started!: () => void;
  const helpStarted = new Promise<void>((r) => { started = r; });
  const watchHelp = setInterval(() => { if (helpRows().some((r) => r.phase === "start")) { clearInterval(watchHelp); started(); } }, 20);
  const seatP = run("claude", "hold-before-start", `bea:${CLAUDE_ACCOUNT}`);
  try {
    await helpStarted;
    undo = widen("bea");
    await waitFor(() => helpRows().some((r) => r.phase === "end") ? true : null, { timeoutMs: 10_000, what: "help probe to finish" });
    await Bun.sleep(200);
    expect(leaseCalls).toBe(1);
    expect(helpRows().filter((r) => r.help === false)).toEqual([]);
    expect(helpRows().every((r) => r.borrowed === 0)).toBe(true);
    const live = await seatOnHost(await seatP);
    expect(live && TERMINAL_STATES.has(live.state)).toBe(false);
    undo();
    undo = () => undefined;
    const s = await ended(await seatP);
    expect(s.state).toBe("done");
    expect(leaseCalls).toBe(2);
    expect(helpRows().filter((r) => r.help === true).every((r) => r.borrowed === 0)).toBe(true);
    expect(helpRows().some((r) => r.help === false && r.borrowed === 1)).toBe(true);
  } finally {
    clearInterval(watchHelp);
    undo();
    rmSync(slowHelp, { force: true });
  }
}, 60_000);

test("a launcher removed while the hand-out is in flight never gives the borrowed token to a child, including --help", async () => {
  reset();
  forgetHelpProbe();
  afterLease = async () => { afterLease = null; await configure(["@bea"]); };
  try {
    const s = await ended(await run("claude", "demote-claude", `bea:${CLAUDE_ACCOUNT}`));
    expect(leaseCalls).toBe(1);
    expect(s.state).toBe("refused");
    expect(helpRows().some((r) => r.borrowed === 1)).toBe(false);
    expect(helpRows().some((r) => r.help === false)).toBe(false);
  } finally {
    await configure(["@noor"]);
    await waitFor(() => olive.d.core.roster.channels.get(channel)?.members?.includes("noor") ? true : null, { timeoutMs: 15_000, what: "noor back on olive" });
  }
}, 60_000);

test("a launcher removed while the hand-out is in flight writes no Codex lease home", async () => {
  reset();
  const seen: string[] = [];
  const watcher = watch(olive.home, { recursive: true }, (_ev, name) => {
    if (name && String(name).includes("lease-")) seen.push(String(name));
  });
  await Bun.sleep(50);
  afterLease = async () => { afterLease = null; await configure(["@bea"]); };
  try {
    const s = await ended(await run("codex", "demote-codex", `bea:${CODEX_ACCOUNT}`));
    await Bun.sleep(200);
    expect(leaseCalls).toBe(1);
    expect(s.state).toBe("refused");
    expect(seen).toEqual([]);
    expect(leaseHomes()).toEqual([]);
    expect(codexRows()).toEqual([]);
  } finally {
    watcher?.close();
    await configure(["@noor"]);
    await waitFor(() => olive.d.core.roster.channels.get(channel)?.members?.includes("noor") ? true : null, { timeoutMs: 15_000, what: "noor back on olive" });
  }
}, 60_000);

test("a hold during the hand-out writes no lease home, then a cleared hold asks again", async () => {
  reset();
  let undo: () => void = () => undefined;
  let returned!: () => void;
  const handout = new Promise<void>((r) => { returned = r; });
  afterLease = async () => { afterLease = null; undo = widen("bea"); returned(); };
  try {
    const idP = run("codex", "hold-clears", `bea:${CODEX_ACCOUNT}`);
    await handout;
    let saw = false;
    for (let i = 0; i < 8; i++) {
      if (leaseHomes().length) saw = true;
      await Bun.sleep(30);
    }
    expect(saw).toBe(false);
    expect(leaseHomes()).toEqual([]);
    expect(leaseCalls).toBe(1);
    undo();
    undo = () => undefined;
    const s = await ended(await idP);
    expect(s.state).toBe("done");
    expect(leaseCalls).toBe(2);
    expect(leaseHomes()).toEqual([]);
    expect(codexRows().some((r) => String(r.codex_home ?? "").includes("/vault/codex/lease-"))).toBe(true);
  } finally { undo(); }
}, 60_000);

test("a hold during the hand-out that times out writes no lease home and does not ask again", async () => {
  reset();
  let undo: () => void = () => undefined;
  let returned!: () => void;
  const handout = new Promise<void>((r) => { returned = r; });
  afterLease = async () => { afterLease = null; undo = widen("bea"); returned(); };
  try {
    const idP = run("codex", "hold-timeout", `bea:${CODEX_ACCOUNT}`);
    await handout;
    let saw = false;
    for (let i = 0; i < 8; i++) {
      if (leaseHomes().length) saw = true;
      await Bun.sleep(30);
    }
    expect(saw).toBe(false);
    expect(leaseCalls).toBe(1);
    const s = await ended(await idP);
    expect(s.state).toBe("refused");
    expect(leaseCalls).toBe(1);
    expect(leaseHomes()).toEqual([]);
    expect(codexRows()).toEqual([]);
    expect(String(s.reason)).toContain("seats channel");
  } finally { undo(); }
}, 60_000);
