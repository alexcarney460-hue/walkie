// WALKIE-ACCOUNTS-RESET-3 through the real daemon: a provider's 429 Retry-After hold survives the discovery passes
// that re-record the account every few milliseconds here (every 15 s in production), so neither the poller nor a
// person's refresh polls through it. The Codex app-server is never started.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { ProcessProvider, ProcRow } from "../../src/daemon/procs.ts";
import { USAGE_URLS } from "../../src/accounts/http.ts";
import type { AppServerLauncher } from "../../src/accounts/resets.ts";
import { fakeFetch, makeFakeHome } from "../helpers/accounts.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const UID = 4345;

class Procs implements ProcessProvider {
  scans = 0;
  constructor(public procs: ProcRow[]) {}
  async list(): Promise<ProcRow[]> { this.scans++; return this.procs; }
  async envVars(pids: readonly number[]) { return new Map(pids.map((p) => [p, {}])); }
  async cwd(): Promise<string | undefined> { return undefined; }
  async openFiles(): Promise<string[]> { return []; }
  async claudeSession() { return undefined; }
}

let c: Cluster;
let alex: TestNode;
const f = fakeFetch();
const procs = new Procs([{ pid: 200, ppid: 1, uid: UID, startedAt: 1_790_000_000_000, command: "codex" }]);
const never: AppServerLauncher = async () => { throw new Error("TEST FAILURE: the app-server must not start"); };

beforeAll(async () => {
  c = new Cluster();
  const home = makeFakeHome(join(c.root, "user-home"));
  f.respond.set(USAGE_URLS.codex, () => new Response("{}", { status: 429, headers: { "Retry-After": "3600" } }));
  alex = await c.add({
    name: "alex", login: "alex@example.com", hostname: "alex-mbp",
    discovery: { provider: procs, uid: UID, intervalMs: 30 },
    accounts: { home, fetch: f.fetch, keychain: async () => { throw new Error("TEST FAILURE: keychain"); }, tickMs: 20, codexAppServer: never },
  });
  await alex.client().init("acme", "alex");
});
afterAll(async () => { await c.close(); });

test("a 429 Retry-After hold holds through many discovery passes and a person's refresh", async () => {
  const codexCalls = () => f.calls.filter((u) => u === USAGE_URLS.codex).length;
  const acct = await waitFor(async () => {
    const a = (await alex.client().accounts()).accounts.find((x) => x.provider === "codex");
    return a?.usage?.reason === "rate_limited" ? a : null;
  }, { what: "codex account held by a 429" });
  const calls = codexCalls();
  const scans = procs.scans;
  await waitFor(async () => (procs.scans >= scans + 10 ? true : null), { what: "ten more discovery passes" });
  expect(codexCalls()).toBe(calls); // the poller (ticking every 20 ms) did not poll through the hold
  expect(calls).toBe(1);

  const port = alex.d.localPort as number;
  const { nonce } = await alex.client().authNonce();
  const login = await fetch(`http://127.0.0.1:${port}/auth?nonce=${nonce}`, { redirect: "manual" });
  const session = /#s=([0-9a-f]{64})$/.exec(login.headers.get("location") ?? "")?.[1] ?? "";
  const res = await fetch(`http://127.0.0.1:${port}/v1/accounts/refresh`, {
    method: "POST", body: JSON.stringify({ account: acct.id }),
    headers: { "X-Walkie-Session": session, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
  });
  expect(await res.json()).toEqual({ scheduled: false, held: true });
  await Bun.sleep(100);
  expect(codexCalls()).toBe(calls);
});
