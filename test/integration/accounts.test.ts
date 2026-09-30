// WALKIE-ACCOUNTS-1 phase 1 end to end: alex's daemon discovers a Claude Code and a Codex session (the Codex one with
// its own CODEX_HOME), records their accounts from the CLI files, polls usage through the fake fetch, and shares the
// summary on `vv`; kira's daemon (accounts off, as a v0.1.3 peer) shows the pooled view. No event kind is added, and
// no token appears in either database, log, accounts.json, local API answer, peer answer, SSE stream or MCP output.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProcessProvider, ProcRow } from "../../src/daemon/procs.ts";
import { handleToolCall } from "../../src/mcp/server.ts";
import { isAllowedUsageUrl } from "../../src/accounts/http.ts";
import { fakeFetch, makeFakeHome, TOKENS } from "../helpers/accounts.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { signedPeerFetch } from "../helpers/signed-peer-fetch.ts";

const UID = 4343;

class Procs implements ProcessProvider {
  constructor(public procs: ProcRow[], private readonly env: Map<number, Record<string, string>>) {}
  async list(): Promise<ProcRow[]> { return this.procs; }
  async envVars(pids: readonly number[], names: readonly string[]) {
    return new Map(pids.map((p) => [p, Object.fromEntries(Object.entries(this.env.get(p) ?? {}).filter(([k]) => names.includes(k)))]));
  }
  async cwd(): Promise<string | undefined> { return undefined; }
  async openFiles(): Promise<string[]> { return []; }
  async claudeSession() { return undefined; }
}

let c: Cluster;
let alex: TestNode, kira: TestNode;
let home: string;
const f = fakeFetch();
let procs: Procs;

beforeAll(async () => {
  c = new Cluster();
  home = makeFakeHome(join(c.root, "user-home"));
  // A second Codex login in its own CODEX_HOME (same fixture account → same id, pooled into one tile).
  const altCodex = join(c.root, "alt-codex");
  mkdirSync(altCodex, { recursive: true });
  cpSync(join(home, ".codex", "auth.json"), join(altCodex, "auth.json"));
  procs = new Procs(
    [
      { pid: 100, ppid: 1, uid: UID, startedAt: 1_790_000_000_000, command: "claude" },
      { pid: 200, ppid: 1, uid: UID, startedAt: 1_790_000_000_000, command: "codex" },
      { pid: 300, ppid: 1, uid: UID, startedAt: 1_790_000_000_000, command: "grok" },
    ],
    new Map([[200, { CODEX_HOME: altCodex }]]),
  );
  alex = await c.add({
    name: "alex", login: "alex@example.com", hostname: "alex-mbp",
    discovery: { provider: procs, uid: UID, intervalMs: 50 },
    accounts: { home, fetch: f.fetch, keychain: async () => { throw new Error("TEST FAILURE: keychain"); }, tickMs: 50 },
  });
  kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp" });
  await alex.client().init("acme", "alex");
  await alex.client().invite("kira@example.com", "kira", "member");
  const j = await kira.client().join(alex.peerAddr);
  if (!j.admitted) throw new Error(`join failed: ${j.reason}`);
});
afterAll(async () => { await c.close(); });

test("alex's accounts are recorded, polled and shown pooled on kira's daemon", async () => {
  const mine = await waitFor(async () => {
    const list = (await alex.client().accounts()).accounts;
    return list.length === 3 && list.find((a) => a.provider === "claude")?.usage?.state === "ok" && list.find((a) => a.provider === "codex")?.usage ? list : null;
  }, { what: "alex's accounts with usage" });
  const claude = mine.find((a) => a.provider === "claude")!;
  expect(claude).toMatchObject({ label: "de***@ex***.test", plan: "Max 20x", owners: ["alex"] });
  expect(claude.machines).toEqual([expect.objectContaining({ hostname: "alex-mbp", handle: "alex", online: true, self: true, agents: ["claude-pid100"] })]);
  expect(claude.usage?.windows.map((w) => w.kind)).toEqual(["session", "weekly", "weekly_model"]);
  expect(mine.find((a) => a.provider === "codex")?.machines[0]?.agents).toEqual(["codex-pid200"]);
  // The fixture's access token expired, but it has a refresh token: unknown (no usage API), not re-login.
  expect(mine.find((a) => a.provider === "grok")?.usage).toMatchObject({ state: "unknown", reason: "no_usage_api" });
  // The Codex session's own CODEX_HOME was used (a local path, kept in accounts.json only).
  expect(readFileSync(join(alex.home, "accounts.json"), "utf8")).toContain("alt-codex");
  // Grok sessions are discovered too; on the wire their runtime is "other" (v0.1.3 peers know no "grok").
  const grokAgent = await waitFor(async () => (await kira.client().agents()).agents.find((a) => a.agent === "grok-pid300"), { what: "grok agent on kira" });
  expect(grokAgent.status.runtime).toBe("other");

  const seen = await waitFor(async () => {
    const list = (await kira.client().accounts()).accounts;
    return list.length === 3 && list.every((a) => a.usage) ? list : null;
  }, { what: "alex's accounts on kira" });
  const onKira = seen.find((a) => a.provider === "claude")!;
  expect(onKira.owners).toEqual(["alex"]);
  expect(onKira.machines[0]).toMatchObject({ hostname: "alex-mbp", self: false, online: true });
  expect(onKira.usage?.windows[0]?.used_pct).toBe(56);
  expect(onKira.usage!.at).toBeLessThanOrEqual(Date.now());
});

test("only the usage endpoints were requested (never a token/refresh URL)", () => {
  expect(f.calls.length).toBeGreaterThan(0);
  expect(f.calls.every(isAllowedUsageUrl)).toBe(true);
});

test("no event kind was added; the vv answer carries the accounts field", async () => {
  const kinds = new Set((await kira.client().events({ limit: 500 })).events.map((e) => e.kind));
  expect([...kinds].some((k) => k.startsWith("account"))).toBe(false);
  const res = await signedPeerFetch(kira, alex, "/peer/v1/vv");
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain('"accounts"');
  expect(body).not.toContain(TOKENS.claude);
});

test("no token anywhere: databases, logs, accounts.json, local API, SSE, MCP output", async () => {
  // SSE: a live dashboard client receives the accounts frame.
  const port = alex.d.localPort;
  const ctrl = new AbortController();
  let sse = "";
  const stream = await fetch(`http://127.0.0.1:${port}/v1/stream`, {
    headers: { Authorization: `Bearer ${alex.d.token}`, Host: `127.0.0.1:${port}` }, signal: ctrl.signal,
  }).catch(() => null);
  if (stream?.body) {
    const reader = stream.body.getReader();
    void (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) return; sse += new TextDecoder().decode(value); } } catch { /* aborted */ } })();
  }
  alex.d.core.hub.accountsChanged();
  await Bun.sleep(600);
  ctrl.abort();

  const mcp = await handleToolCall(alex.client("cc-test"), "walkie_who", {});
  const texts: Record<string, string> = {
    sse, mcp: JSON.stringify(mcp),
    alexAccounts: JSON.stringify(await alex.client().accounts()), kiraAccounts: JSON.stringify(await kira.client().accounts()),
    peers: JSON.stringify(await kira.client().peers()), agents: JSON.stringify(await kira.client().agents()),
  };
  for (const node of [alex, kira]) {
    for (const file of readdirSync(node.home)) {
      const p = join(node.home, file);
      if (statSync(p).isFile()) texts[`${node.spec.name}/${file}`] = readFileSync(p, "latin1");
    }
    const logs = join(node.home, "logs");
    if (existsSync(logs)) for (const file of readdirSync(logs)) texts[`${node.spec.name}/logs/${file}`] = readFileSync(join(logs, file), "latin1");
  }
  expect(Object.keys(texts)).toContain("alex/walkie.db");
  expect(Object.keys(texts)).toContain("alex/accounts.json");
  expect(stream?.status).toBe(200);
  expect(sse).toContain("event: accounts");
  expect(sse).toContain("de***@ex***.test");
  for (const [where, text] of Object.entries(texts)) {
    for (const secret of [TOKENS.claude, TOKENS.codexSecret, TOKENS.kimi, "FIXTURE-GROK", "REFRESHNEVERSENT", "dev.claude@example.test"]) {
      if (text.includes(secret)) throw new Error(`${secret.slice(0, 12)}… found in ${where}`);
    }
  }
});
