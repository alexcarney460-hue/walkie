// FINAL release audits (docs/audits/2026-09-26-*): the billing functions' side of Codex 1 (no second
// subscription for an existing subscriber), Codex 4 (seat changes reach the daemon) and Fable 3 (a failed
// reveal read-back doesn't lock the customer out).
import { describe, expect, test } from "bun:test";
import Stripe from "stripe";
import { makeCheckout } from "../api/checkout.ts";
import { REFRESH_META, renewHash, REVEALED_META, SHOWN_META } from "../api/_lib/metadata.ts";
import { makeLicense, RETRY_WINDOW_MS } from "../api/license/index.ts";
import { makeStatus } from "../api/license/status.ts";
import { makeWebhook } from "../api/webhook.ts";
import { body, deps, fullEnv, MockStripe, NOW, PERIOD_END_S, stripeError, subscription, testKeypair, WEBHOOK_SECRET } from "./helpers.ts";

const kp = testKeypair();
const ENV = fullEnv(kp.pem);
const get = (path: string): Request => new Request(`https://site.test${path}`);
const post = (path: string, data: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`https://site.test${path}`, { method: "POST", body: typeof data === "string" ? data : JSON.stringify(data), headers });

async function signedWebhook(event: unknown): Promise<Request> {
  const payload = JSON.stringify(event);
  const header = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: WEBHOOK_SECRET });
  return post("/api/webhook", payload, { "stripe-signature": header, "content-type": "application/json" });
}

describe("Codex 1: GET /api/checkout refuses a second subscription for a team that has one", () => {
  test("lic_id of a live subscription (active, past_due, trialing, paused) → 409 already_subscribed with the portal link; nothing is created", async () => {
    for (const status of ["active", "past_due", "trialing", "paused"]) {
      const s = new MockStripe();
      s.subs.set("sub_LIVE", subscription({ id: "sub_LIVE", status }));
      const res = await makeCheckout(deps(s, ENV))(get("/api/checkout?plan=team&interval=month&seats=3&lic_id=sub_LIVE"));
      expect([status, res.status]).toEqual([status, 409]);
      expect(await body(res)).toEqual({ error: "already_subscribed", portal: "https://site.test/api/portal", lic_id: "sub_LIVE", status });
      expect(s.calls.checkout).toEqual([]);
    }
  });

  test("a browser (Accept: text/html) with a live lic_id is sent to the portal instead of a JSON 409", async () => {
    const s = new MockStripe();
    s.subs.set("sub_LIVE", subscription({ id: "sub_LIVE" }));
    const res = await makeCheckout(deps(s, ENV))(new Request("https://site.test/api/checkout?lic_id=sub_LIVE", { headers: { accept: "text/html,*/*" } }));
    expect([res.status, res.headers.get("location")]).toEqual([303, "https://site.test/api/portal"]);
    expect(s.calls.checkout).toEqual([]);
  });

  test("a dead or unknown lic_id (canceled, unpaid, incomplete_expired, a comp license id) still checks out; a malformed one is 400", async () => {
    for (const status of ["canceled", "unpaid", "incomplete_expired"]) {
      const s = new MockStripe();
      s.subs.set("sub_DEAD", subscription({ id: "sub_DEAD", status }));
      const res = await makeCheckout(deps(s, ENV))(get("/api/checkout?plan=team&interval=month&seats=3&lic_id=sub_DEAD"));
      expect([status, res.status]).toEqual([status, 303]);
      expect(s.calls.checkout.length).toBe(1);
    }
    const s = new MockStripe();
    expect((await makeCheckout(deps(s, ENV))(get("/api/checkout?lic_id=comp_2026_alex"))).status).toBe(303);
    expect((await makeCheckout(deps(s, ENV))(get("/api/checkout?lic_id=sub_unknown"))).status).toBe(303);
    const bad = await makeCheckout(deps(s, ENV))(get("/api/checkout?lic_id=sub%20x"));
    expect([bad.status, (await body(bad)).error]).toEqual([400, "invalid_lic_id"]);
    expect(s.calls.checkout.length).toBe(2);
  });

  test("a Stripe outage on the hint lookup fails closed (502), never a second subscription by accident", async () => {
    const s = new MockStripe();
    s.fail = stripeError(500);
    const res = await makeCheckout(deps(s, ENV))(get("/api/checkout?lic_id=sub_LIVE"));
    expect(res.status).toBe(502);
    expect(s.calls.checkout).toEqual([]);
  });
});

describe("Codex 4: seat or price changes are marked for the daemon's daily check-in", () => {
  test("customer.subscription.updated with changed items/quantity/plan sets walkie_refresh_at; a metadata-only update (our own writes) does not", async () => {
    const s = new MockStripe();
    s.subs.set("sub_ABC123", subscription({ metadata: { walkie_team: "0123456789abcdef" } }));
    const h = makeWebhook(deps(s, ENV));
    const seats = await h(await signedWebhook({
      id: "evt_q", object: "event", type: "customer.subscription.updated", created: Math.floor(NOW / 1000),
      data: { object: { id: "sub_ABC123", object: "subscription" }, previous_attributes: { items: { data: [{ quantity: 2 }] } } },
    }));
    expect(await body(seats)).toEqual({ received: true, cleared: false, refresh: true });
    expect(s.subs.get("sub_ABC123")?.metadata).toEqual({ walkie_team: "0123456789abcdef", [REFRESH_META]: String(NOW) });
    const meta = await h(await signedWebhook({
      id: "evt_m", object: "event", type: "customer.subscription.updated", created: Math.floor(NOW / 1000) + 5,
      data: { object: { id: "sub_ABC123", object: "subscription" }, previous_attributes: { metadata: { walkie_refresh_at: "" } } },
    }));
    expect(await body(meta)).toEqual({ received: true, cleared: false, refresh: false });
    expect(s.calls.metadata.length).toBe(1);
    const plan = await h(await signedWebhook({
      id: "evt_p", object: "event", type: "customer.subscription.updated", created: Math.floor(NOW / 1000) + 9,
      data: { object: { id: "sub_ABC123", object: "subscription" }, previous_attributes: { plan: { id: "price_team_m" } } },
    }));
    expect(await body(plan)).toEqual({ received: true, cleared: false, refresh: true });
    expect(s.subs.get("sub_ABC123")?.metadata[REFRESH_META]).toBe(String(NOW + 9_000));
  });

  test("POST /api/license/status: the token gets {seats, plan, expires_at, newer}; newer compares walkie_refresh_at with the daemon's issued_at", async () => {
    const s = new MockStripe();
    const token = "t".repeat(43);
    s.subs.set("sub_ABC123", subscription({ quantity: 9, metadata: { walkie_team: "0123456789abcdef", walkie_renew_hash: renewHash(token) } }));
    const h = makeStatus(deps(s, ENV));
    const call = (b: unknown) => h(post("/api/license/status", b));
    const plain = await call({ lic_id: "sub_ABC123", renewal_token: token, issued_at: NOW - 60_000 });
    expect([plain.status, await body(plain)]).toEqual([200, { seats: 9, plan: "team", interval: "month", expires_at: PERIOD_END_S * 1000 + 5 * 86_400_000, status: "active", newer: false }]);
    await s.setSubscriptionMetadata("sub_ABC123", { [REFRESH_META]: String(NOW) });
    expect((await body(await call({ lic_id: "sub_ABC123", renewal_token: token, issued_at: NOW - 60_000 }))).newer).toBe(true);
    expect((await body(await call({ lic_id: "sub_ABC123", renewal_token: token, issued_at: NOW + 1 }))).newer).toBe(false);
    expect((await body(await call({ lic_id: "sub_ABC123", renewal_token: token }))).newer).toBe(true);
    const wrong = await call({ lic_id: "sub_ABC123", renewal_token: "A".repeat(43) });
    expect([wrong.status, await body(wrong)]).toEqual([403, { error: "invalid_renewal" }]);
    expect((await call({ lic_id: "sub_ABC123" })).status).toBe(400);
    expect((await call({ lic_id: "sub_nope", renewal_token: token })).status).toBe(403);
    const unbound = new MockStripe();
    unbound.subs.set("sub_U", subscription({ id: "sub_U", metadata: { walkie_renew_hash: renewHash(token) } }));
    expect((await makeStatus(deps(unbound, ENV))(post("/api/license/status", { lic_id: "sub_U", renewal_token: token }))).status).toBe(403);
  });
});

describe("Fable 3: a failed reveal read-back does not lock the customer out", () => {
  function paid(): MockStripe {
    const s = new MockStripe();
    s.subs.set("sub_ABC123", subscription());
    s.sessions.set("cs_test_1", { id: "cs_test_1", mode: "subscription", status: "complete", subscription: "sub_ABC123", customer: "cus_XYZ" });
    return s;
  }

  test("read-back fails → 502 and the mark is cleared (best effort); the same session reveals on retry", async () => {
    const s = paid();
    const orig = s.getSubscription.bind(s);
    let reads = 0;
    s.getSubscription = async (id) => { reads++; if (reads === 2) throw stripeError(500); return orig(id); }; // 1: the lookup, 2: the read-back
    const h = makeLicense(deps(s, ENV));
    const first = await h(get("/api/license?session_id=cs_test_1"));
    expect([first.status, await body(first)]).toEqual([502, { error: "stripe_unavailable" }]);
    expect(s.subs.get("sub_ABC123")?.metadata[REVEALED_META]).toBeUndefined();
    const again = await h(get("/api/license?session_id=cs_test_1"));
    expect(again.status).toBe(200);
    expect(typeof (await body(again)).code).toBe("string");
    expect(s.subs.get("sub_ABC123")?.metadata[SHOWN_META]).toBe(String(NOW));
    expect((await h(get("/api/license?session_id=cs_test_1"))).status).toBe(200); // within the window: redelivered (FINAL-2 Codex 4)
    expect((await makeLicense({ env: ENV, stripe: () => s, now: () => NOW + RETRY_WINDOW_MS + 1 })(get("/api/license?session_id=cs_test_1"))).status).toBe(410);
  });

  test("read-back fails and the clear fails too: the same session may still retry within 10 min, not after; a shown code repeats only within the window", async () => {
    const s = paid();
    const origGet = s.getSubscription.bind(s);
    const origSet = s.setSubscriptionMetadata.bind(s);
    let reads = 0, writes = 0;
    s.getSubscription = async (id) => { reads++; if (reads === 2) throw stripeError(500); return origGet(id); };
    s.setSubscriptionMetadata = async (id, m) => { writes++; if (writes === 2) throw stripeError(500); return origSet(id, m); }; // 2: the clear
    const h = makeLicense(deps(s, ENV));
    expect((await h(get("/api/license?session_id=cs_test_1"))).status).toBe(502);
    expect(s.subs.get("sub_ABC123")?.metadata[REVEALED_META]).toBe(String(NOW));
    expect(s.subs.get("sub_ABC123")?.metadata[SHOWN_META]).toBeUndefined();
    // Within the window: the mark is stale (no shown_at), so the reveal is retried.
    const retry = await h(get("/api/license?session_id=cs_test_1"));
    expect(retry.status).toBe(200);
    expect((await h(get("/api/license?session_id=cs_test_1"))).status).toBe(200); // within the window: redelivered (FINAL-2 Codex 4)
    expect((await makeLicense({ env: ENV, stripe: () => s, now: () => NOW + RETRY_WINDOW_MS + 1 })(get("/api/license?session_id=cs_test_1"))).status).toBe(410);
    // Past the window without a completed reveal: support only.
    const late = paid();
    late.subs.set("sub_ABC123", subscription({ metadata: { [REVEALED_META]: String(NOW - RETRY_WINDOW_MS - 1) } }));
    const r = await makeLicense(deps(late, ENV))(get("/api/license?session_id=cs_test_1"));
    expect([r.status, (await body(r)).error]).toEqual([410, "already_revealed"]);
  });
});
