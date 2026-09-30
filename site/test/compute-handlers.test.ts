// The /api/compute/* functions over HTTP (Request in, Response out): auth, switches, rate limits, the Stripe TEST-mode
// credit checkout, and the compute webhook with signed Stripe test fixtures (credited once across 3 deliveries; a
// dispute freezes the account and the next tick stops its machines).
import { describe, expect, test } from "bun:test";
import Stripe from "stripe";
import { makeAccount } from "../api/compute/account.ts";
import { makeCredit } from "../api/compute/credit.ts";
import { makeHeartbeat } from "../api/compute/heartbeat.ts";
import { makeQuotes } from "../api/compute/quotes.ts";
import { makeRent } from "../api/compute/rent.ts";
import { makeStart } from "../api/compute/start.ts";
import { makeState } from "../api/compute/state.ts";
import { makeStop } from "../api/compute/stop.ts";
import { makeTick } from "../api/compute/tick.ts";
import { makeComputeWebhook } from "../api/compute/webhook.ts";
import { computeKeyAllowed, type CreditCheckoutReq, type CreditStripe } from "../api/_lib/compute/credit.ts";
import { computeFromEnv, type HandlerDeps } from "../api/_lib/compute/handler.ts";
import { MemoryStore } from "../api/_lib/compute/memory-store.ts";
import { fixtureTeam, proof, codes, configJson, idem, world, type World } from "./compute-helpers.ts";

const WH = "whsec_" + "compute_test_secret";
const CRON = "cron-" + "test-secret-value";
const TEAM = fixtureTeam;

class MockCreditStripe implements CreditStripe {
  readonly calls: CreditCheckoutReq[] = [];
  async createCreditCheckout(p: CreditCheckoutReq) {
    this.calls.push(p);
    return { url: "https://checkout.stripe.test/c/pay/cs_test_credit" };
  }
}

function setup(envOver: Record<string, string | undefined> = {}) {
  const w = world();
  const stripe = new MockCreditStripe();
  const env = { COMPUTE_ENABLED: "1", COMPUTE_STRIPE_WEBHOOK_SECRET: WH, CRON_SECRET: CRON, SITE_URL: "https://site.test", ...envOver };
  const deps: HandlerDeps = { env, compute: () => w.d, stripe: () => stripe };
  return { w, stripe, deps };
}

const req = (path: string, opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) =>
  new Request(`https://site.test${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    ...(opts.body !== undefined ? { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) } : {}),
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
  });

async function account(deps: HandlerDeps): Promise<{ account_id: string; token: string }> {
  const res = await makeAccount(deps)(req("/api/compute/account", { body: { team_id: TEAM, proof: proof() } }));
  expect(res.status).toBe(201);
  return (await res.json()) as { account_id: string; token: string };
}

async function signed(event: unknown): Promise<Request> {
  const payload = JSON.stringify(event);
  const header = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: WH });
  return new Request("https://site.test/api/compute/webhook", { method: "POST", body: payload, headers: { "stripe-signature": header } });
}

function paidSession(accountId: string, block: number, id = "cs_test_1", pi = "pi_test_1") {
  return {
    id: `evt_${idem()}`, type: "checkout.session.completed",
    data: { object: { id, mode: "payment", payment_status: "paid", currency: "usd", amount_total: block * 100, payment_intent: pi, metadata: { walkie_compute_account: accountId, walkie_credit_usd: String(block) } } },
  };
}

async function buy(w: World, deps: HandlerDeps, accountId: string, block: number, session = `cs_test_${idem()}`) {
  const res = await makeComputeWebhook(deps)(await signed(paidSession(accountId, block, session, `pi_${session}`)));
  expect(res.status).toBe(200);
  return (await res.json()) as { outcome: string };
}

describe("quotes", () => {
  test("public, prices only", async () => {
    const res = await makeQuotes()(req("/api/compute/quotes"));
    const q = (await res.json()) as { tiers: { id: string }[] };
    expect(q.tiers.map((t) => t.id)).toEqual(["agent", "agent-xl", "gpu-20", "gpu-48", "gpu-80"]);
  });
});

describe("account + auth", () => {
  test("account creation returns a token once; bad bodies are 400; per-IP limit", async () => {
    const { deps } = setup();
    const a = await account(deps);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await makeAccount(deps)(req("/api/compute/account", { body: { team_id: "XYZ" } }))).status).toBe(400);
    for (let i = 0; i < 9; i++) await makeAccount(deps)(req("/api/compute/account", { body: { team_id: TEAM, proof: proof() } }));
    const limited = await makeAccount(deps)(req("/api/compute/account", { body: { team_id: TEAM, proof: proof() } }));
    expect(limited.status).toBe(429);
  });

  test("state needs the bearer token", async () => {
    const { deps } = setup();
    const a = await account(deps);
    expect((await makeState(deps)(req("/api/compute/state"))).status).toBe(401);
    expect((await makeState(deps)(req("/api/compute/state", { token: "x".repeat(43) }))).status).toBe(401);
    const ok = await makeState(deps)(req("/api/compute/state", { token: a.token }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ account_id: a.account_id, balance_micros: 0, rentals: [] });
  });

  test("not configured → 503 everywhere it matters", async () => {
    const deps: HandlerDeps = { env: {}, compute: () => null, stripe: () => null };
    for (const h of [makeAccount(deps), makeState(deps), makeRent(deps), makeHeartbeat(deps)]) {
      const res = await h(req("/x", { body: {}, token: "a".repeat(43) }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "compute_not_configured" });
    }
    expect(await computeFromEnv({ COMPUTE_PRIVATE_CONFIG: configJson() })).toBeNull(); // no DATABASE_URL
    expect(await computeFromEnv({ DATABASE_URL: "postgres://x" })).toBeNull(); // no private config
    expect(await computeFromEnv({ COMPUTE_PRIVATE_CONFIG: configJson(), DATABASE_URL: 'postgres://x' }, new MemoryStore())).toBeNull();
    expect(await computeFromEnv({ COMPUTE_PRIVATE_CONFIG: configJson(), COMPUTE_ENABLED: '1',
      COMPUTE_HANDOVER_TOKEN_KEY: 'rent-fixture-handover-key-32-bytes' }, new MemoryStore())).not.toBeNull();
    await expect(computeFromEnv({ COMPUTE_PRIVATE_CONFIG: configJson(), COMPUTE_ENABLED: '1' },
      new MemoryStore())).rejects.toMatchObject({ status: 503, code: 'handover_token_key_unavailable' });
  });
});

describe("credit", () => {
  test("checkout for a valid block (test-mode key guard)", async () => {
    const { deps, stripe } = setup();
    const a = await account(deps);
    const res = await makeCredit(deps)(req("/api/compute/credit", { body: { block: 200 }, token: a.token }));
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.test/c/pay/cs_test_credit" });
    expect(stripe.calls).toEqual([{ accountId: a.account_id, block: 200, successUrl: "https://site.test/?compute=credit-added",
      cancelUrl: "https://site.test/", attemptId: expect.stringMatching(/^[0-9a-f]{32}$/), expiresAt: expect.any(Number) }]);
    expect((await makeCredit(deps)(req("/api/compute/credit", { body: { block: 75 }, token: a.token }))).status).toBe(400);
    expect(computeKeyAllowed("sk_test_abc", undefined)).toBe(true);
    expect(computeKeyAllowed("sk_live_abc", undefined)).toBe(false);
    expect(computeKeyAllowed("sk_live_abc", "1")).toBe(true);
  });

  test("webhook credits a $50 block exactly once across three deliveries", async () => {
    const { w, deps } = setup();
    const a = await account(deps);
    const ev = paidSession(a.account_id, 50, "cs_test_triple", "pi_triple");
    const outcomes = [];
    for (let i = 0; i < 3; i++) outcomes.push(((await (await makeComputeWebhook(deps)(await signed(ev))).json()) as { outcome: string }).outcome);
    expect(outcomes).toEqual(["credited", "duplicate", "duplicate"]);
    expect(await w.store.tx((t) => t.balance(a.account_id))).toBe(50_000_000);
  });

  test("webhook refuses a bad signature and ignores mismatched amounts or unknown accounts", async () => {
    const { deps } = setup();
    const a = await account(deps);
    const bad = new Request("https://site.test/api/compute/webhook", { method: "POST", body: "{}", headers: { "stripe-signature": "t=1,v1=00" } });
    expect((await makeComputeWebhook(deps)(bad)).status).toBe(400);
    const wrong = paidSession(a.account_id, 50);
    (wrong.data.object as Record<string, unknown>).amount_total = 100;
    expect(await (await makeComputeWebhook(deps)(await signed(wrong))).json()).toMatchObject({ outcome: "ignored" });
    expect(await (await makeComputeWebhook(deps)(await signed(paidSession("ca_ffffffffffffffff", 50)))).json()).toMatchObject({ outcome: "ignored" });
  });

  test("a dispute freezes the account: rent refused, machines stopped on the next tick", async () => {
    const { w, deps } = setup();
    const a = await account(deps);
    await buy(w, deps, a.account_id, 200, "cs_test_disputed");
    const rent = await makeRent(deps)(req("/api/compute/rent", { token: a.token, body: { idempotency_key: idem(), machines: [{ tier: "agent", count: 1 }], codes: codes(1), walkie_version: "v0.2.0-pre.7" } }));
    expect(rent.status).toBe(200);
    const dispute = { id: "evt_d", type: "charge.dispute.created", data: { object: { id: "dp_1", payment_intent: "pi_cs_test_disputed" } } };
    expect(await (await makeComputeWebhook(deps)(await signed(dispute))).json()).toMatchObject({ outcome: "frozen" });
    const again = await makeRent(deps)(req("/api/compute/rent", { token: a.token, body: { idempotency_key: idem(), machines: [{ tier: "agent", count: 1 }], codes: codes(1), walkie_version: "v0.2.0-pre.7" } }));
    expect(again.status).toBe(403);
    expect(await again.json()).toEqual({ error: "account_frozen" });
    const tick = await makeTick(deps)(req("/api/compute/tick", { headers: { authorization: `Bearer ${CRON}` } }));
    expect(await tick.json()).toMatchObject({ stopped: { frozen: 1 }, terminated: 1 });
  });
});

describe("rent / start / stop", () => {
  test("COMPUTE_ENABLED gates launching but never stopping", async () => {
    const { w, deps } = setup({ COMPUTE_ENABLED: undefined });
    const a = await account(deps);
    await buy(w, deps, a.account_id, 50);
    const res = await makeRent(deps)(req("/api/compute/rent", { token: a.token, body: { idempotency_key: idem(), machines: [{ tier: "agent", count: 1 }], codes: codes(1), walkie_version: "v0.2.0-pre.7" } }));
    expect(res.status).toBe(503);
    expect((await makeStop(deps)(req("/api/compute/stop", { token: a.token, body: { all: true } }))).status).toBe(200);
  });

  test("402 with the numbers when credit is short; 400 for a bad body; start refuses a rental not waiting", async () => {
    const { w, deps } = setup();
    const a = await account(deps);
    const body = { idempotency_key: idem(), machines: [{ tier: "gpu-80", count: 1 }], codes: codes(1), walkie_version: "v0.2.0-pre.7" };
    const res = await makeRent(deps)(req("/api/compute/rent", { token: a.token, body }));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "insufficient_credit", needed_micros: 8_820_000, balance_micros: 0 });
    expect((await makeRent(deps)(req("/api/compute/rent", { token: a.token, body: { ...body, codes: [] } }))).status).toBe(400);
    await buy(w, deps, a.account_id, 50);
    const ok = (await (await makeRent(deps)(req("/api/compute/rent", { token: a.token, body }))).json()) as { rentals: { id: string }[] };
    const st = await makeStart(deps)(req("/api/compute/start", { token: a.token, body: { rental_id: ok.rentals[0]!.id, code: codes(1)[0], walkie_version: "v0.2.0-pre.7" } }));
    expect(st.status).toBe(409);
  });

  test("heartbeat needs the rental's own token; tick needs the cron secret", async () => {
    const { deps } = setup();
    const hb = await makeHeartbeat(deps)(req("/api/compute/heartbeat", { body: { rental_id: "r_0123456789abcdef", token: "a".repeat(43), busy_seats: 0, pool_jobs: 0, cpu_pct: 1, egress_bytes: 0 } }));
    expect(hb.status).toBe(403);
    expect((await makeTick(deps)(req("/api/compute/tick"))).status).toBe(401);
    expect((await makeTick(deps)(req("/api/compute/tick", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    expect((await makeTick(deps)(req("/api/compute/tick", { headers: { authorization: `Bearer ${CRON}` } }))).status).toBe(200);
  });
});
