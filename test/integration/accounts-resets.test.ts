// WALKIE-ACCOUNTS-RESET-1/2 through the real daemon: the Codex reset count reaches the pooled view (and the peer), a
// person at the dashboard (a dashboard session) prepares an attempt and uses it, and everything else is refused before
// anything runs: a request marked as an agent's (X-Walkie-Agent, valid or not, or X-Walkie-Under-Agent), the durable
// token the CLI and MCP server use, an id the daemon did not mint, and an account held on another machine.
// The Codex app-server is a FAKE here: no test ever uses a real reset.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { ProcessProvider, ProcRow } from "../../src/daemon/procs.ts";
import { USAGE_URLS } from "../../src/accounts/http.ts";
import type { AppServerLauncher } from "../../src/accounts/resets.ts";
import { fakeFetch, fixture, makeFakeHome } from "../helpers/accounts.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const UID = 4344;
const REQ = "7a3e1c55-0b2d-4f8e-9c1a-2b3c4d5e6f70";

class Procs implements ProcessProvider {
  constructor(public procs: ProcRow[]) {}
  async list(): Promise<ProcRow[]> { return this.procs; }
  async envVars(pids: readonly number[]) { return new Map(pids.map((p) => [p, {}])); }
  async cwd(): Promise<string | undefined> { return undefined; }
  async openFiles(): Promise<string[]> { return []; }
  async claudeSession() { return undefined; }
}

let c: Cluster;
let alex: TestNode, kira: TestNode;
let available = 2;
const consumes: unknown[] = [];
const fake: AppServerLauncher = async () => ({
  async request(method, params) {
    if (method === "initialize") return {};
    if (method === "account/rateLimits/read") return { accountId: "00000000-1111-4222-8333-444444444444", rateLimitResetCredits: { availableCount: available, credits: null } };
    if (method === "account/rateLimitResetCredit/consume") { consumes.push(params); available -= 1; return { outcome: "reset" }; }
    throw new Error(`TEST FAILURE: ${method}`);
  },
  notify() {},
  close() {},
});

beforeAll(async () => {
  c = new Cluster();
  const home = makeFakeHome(join(c.root, "user-home"));
  const f = fakeFetch();
  f.respond.set(USAGE_URLS.codex, () => new Response(JSON.stringify({ ...(fixture("codex-usage.json") as object), rate_limit_reset_credits: { available_count: available, applicable_available_count: available } }), { status: 200 }));
  alex = await c.add({
    name: "alex", login: "alex@example.com", hostname: "alex-mbp",
    discovery: { provider: new Procs([
      { pid: 100, ppid: 1, uid: UID, startedAt: 1_790_000_000_000, command: "claude" },
      { pid: 200, ppid: 1, uid: UID, startedAt: 1_790_000_000_000, command: "codex" },
    ]), uid: UID, intervalMs: 50 },
    accounts: { home, fetch: f.fetch, keychain: async () => { throw new Error("TEST FAILURE: keychain"); }, tickMs: 50, codexAppServer: fake },
  });
  kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp" });
  await alex.client().init("acme", "alex");
  await alex.client().invite("kira@example.com", "kira", "member");
  const j = await kira.client().join(alex.peerAddr);
  if (!j.admitted) throw new Error(`join failed: ${j.reason}`);
});
afterAll(async () => { await c.close(); });

const port = (n: TestNode) => n.d.localPort as number;
const url = (n: TestNode, p: string) => `http://127.0.0.1:${port(n)}${p}`;

/** A dashboard session on node `n` (the `walkie dashboard` login). */
async function session(n: TestNode): Promise<Record<string, string>> {
  const { nonce } = await n.client().authNonce();
  const res = await fetch(url(n, `/auth?nonce=${nonce}`), { redirect: "manual" });
  const value = /#s=([0-9a-f]{64})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
  return { "X-Walkie-Session": value, Origin: `http://127.0.0.1:${port(n)}`, "Content-Type": "application/json" };
}

const codexId = async (n: TestNode) => (await waitFor(async () => {
  const a = (await n.client().accounts()).accounts.find((x) => x.provider === "codex");
  return a?.usage?.resets ? a : null;
}, { what: "codex account with resets" })).id;

test("the count is pooled and replicated: alex's view and kira's view both say 2", async () => {
  const id = await codexId(alex);
  expect((await alex.client().accounts()).accounts.find((a) => a.id === id)?.usage?.resets).toEqual({ available: 2, applicable: 2 });
  const onKira = await waitFor(async () => (await kira.client().accounts()).accounts.find((a) => a.id === id && a.usage?.resets), { what: "resets on kira" });
  expect(onKira.usage?.resets?.available).toBe(2);
  expect(onKira.machines[0]?.self).toBe(false);
});

const post = (n: TestNode, path: string, headers: Record<string, string>, body: unknown) =>
  fetch(url(n, path), { method: "POST", headers, body: JSON.stringify(body) });
const message = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

test("anything marked as an agent's, and the durable token, is refused on every reset route; nothing is used", async () => {
  const id = await codexId(alex);
  const s = await session(alex);
  for (const path of ["/v1/accounts/reset/prepare", "/v1/accounts/reset", "/v1/accounts/reset/resolve", "/v1/accounts/refresh"]) {
    const body = path === "/v1/accounts/reset" ? { account: id, request_id: REQ } : { account: id };
    const markers: Array<Record<string, string>> = [{ "X-Walkie-Agent": "cc-1" }, { "X-Walkie-Under-Agent": "1" }, { "X-Walkie-Under-Agent": "0" }];
    for (const marker of markers) {
      const res = await post(alex, path, { ...s, ...marker }, body);
      expect(res.status).toBe(403);
      expect((await message(res)).message).toContain("not an agent");
    }
    // A malformed agent name is refused before any route runs (400 from the header check).
    expect((await post(alex, path, { ...s, "X-Walkie-Agent": "NOT A VALID NAME!" }, body)).status).toBe(400);
    const asToken = await post(alex, path, { Authorization: `Bearer ${alex.d.token}`, "Content-Type": "application/json" }, body);
    expect(asToken.status).toBe(403);
    expect((await message(asToken)).message).toContain("dashboard");
  }
  expect(consumes).toHaveLength(0);
});

// ADD-MACHINE-2's gate (merged from v0.2.0-pre.3): /v1/auth/nonce refuses X-Walkie-Agent / X-Walkie-Under-Agent, so an
// agent that identifies itself gets no dashboard session to spend a reset with. (An unmarked same-user process is the
// accepted limit, SECURITY "Limit resets".)
test("an agent cannot mint a dashboard session to spend a reset (the ADD-MACHINE-2 nonce gate)", async () => {
  const res = await fetch("http://walkie/v1/auth/nonce", {
    method: "POST", unix: alex.d.socket, headers: { "X-Walkie-Under-Agent": "1", "Content-Type": "application/json" }, body: "{}",
  } as RequestInit);
  expect(res.status).toBe(403);
  const named = await fetch("http://walkie/v1/auth/nonce", {
    method: "POST", unix: alex.d.socket, headers: { "X-Walkie-Agent": "cc-1", "Content-Type": "application/json" }, body: "{}",
  } as RequestInit);
  expect(named.status).toBe(403);
  expect(consumes).toHaveLength(0);
});

test("ids the daemon did not mint are refused", async () => {
  const id = await codexId(alex);
  const res = await post(alex, "/v1/accounts/reset", await session(alex), { account: id, request_id: REQ });
  expect(res.status).toBe(409);
  expect((await message(res)).code).toBe("unknown_attempt");
  expect(consumes).toHaveLength(0);
});

test("a person prepares and confirms; a double request is one use; the meter follows", async () => {
  const id = await codexId(alex);
  const s = await session(alex);
  const prep = await post(alex, "/v1/accounts/reset/prepare", s, { account: id });
  expect(prep.status).toBe(200);
  const { attempt } = (await prep.json()) as { attempt: { id: string; account: string; earlier: unknown } };
  expect(attempt).toMatchObject({ account: id, earlier: null });
  const [r1, r2] = await Promise.all([
    post(alex, "/v1/accounts/reset", s, { account: id, request_id: attempt.id }),
    post(alex, "/v1/accounts/reset", s, { account: id, request_id: attempt.id }),
  ]);
  expect(r1.status).toBe(200);
  expect(r2.status).toBe(200);
  const a1 = (await r1.json()) as { result: { outcome: string; left: number } };
  const a2 = (await r2.json()) as { result: { outcome: string; left: number } };
  expect(a1.result).toEqual({ outcome: "reset", left: 1 });
  expect(a2.result).toEqual(a1.result);
  expect(consumes).toEqual([{ idempotencyKey: attempt.id }]);
  const after = await waitFor(async () => (await alex.client().accounts()).accounts.find((a) => a.id === id && a.usage?.resets?.available === 1), { what: "meter after the reset" });
  expect(after.usage?.resets?.available).toBe(1);
});

test("kira's dashboard cannot act on alex's account (v1 is local-only); bad bodies are refused", async () => {
  const id = await codexId(alex);
  const res = await post(kira, "/v1/accounts/reset/prepare", await session(kira), { account: id });
  expect(res.status).toBe(404);
  const bad = await post(alex, "/v1/accounts/reset", await session(alex), { account: id, request_id: "x" });
  expect(bad.status).toBe(400);
  expect(consumes).toHaveLength(1);
});

test("Claude is used on claude.ai: prepare refused as not_supported, refresh accepted", async () => {
  const claude = await waitFor(async () => (await alex.client().accounts()).accounts.find((a) => a.provider === "claude"), { what: "claude account" });
  const s = await session(alex);
  const res = await post(alex, "/v1/accounts/reset/prepare", s, { account: claude.id });
  expect(res.status).toBe(409);
  const refresh = await post(alex, "/v1/accounts/refresh", s, { account: claude.id });
  expect(refresh.status).toBe(200);
  expect((await refresh.json()) as { scheduled: boolean; held: boolean }).toEqual({ scheduled: true, held: false });
});
