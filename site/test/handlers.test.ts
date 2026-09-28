// Every billing function against a mocked Stripe client: success, error and not-configured paths.
import { describe, expect, test } from "bun:test";
import Stripe from "stripe";
import { makeVerifier } from "../../src/license/format.ts";
import { makeCheckout } from "../api/checkout.ts";
import { signLicense, signingKeyFromPem, type LicensePayload } from "../api/_lib/license.ts";
import { renewHash } from "../api/_lib/metadata.ts";
import type { SubscriptionLite } from "../api/_lib/stripe.ts";
import { makeBind } from "../api/license/bind.ts";
import { makeLicense } from "../api/license/index.ts";
import { makeRenew } from "../api/license/renew.ts";
import { makePortal } from "../api/portal.ts";
import { makeWebhook } from "../api/webhook.ts";
import { body, deps, fullEnv, MockStripe, NOW, PERIOD_END_S, stripeError, subscription, testKeypair, WEBHOOK_SECRET } from "./helpers.ts";

const kp = testKeypair();
const verify = makeVerifier(kp.publicB64);
const ENV = fullEnv(kp.pem);
const EXPIRES = PERIOD_END_S * 1000 + 5 * 86_400_000;

const get = (path: string, headers: Record<string, string> = {}): Request => new Request(`https://site.test${path}`, { headers });
const post = (path: string, data: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`https://site.test${path}`, { method: "POST", body: typeof data === "string" ? data : JSON.stringify(data), headers });

async function signedWebhook(event: unknown, secret = WEBHOOK_SECRET): Promise<Request> {
  const payload = JSON.stringify(event);
  const header = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
  return post("/api/webhook", payload, { "stripe-signature": header, "content-type": "application/json" });
}

const without = (name: string): Record<string, string | undefined> => ({ ...ENV, [name]: undefined });

// ---- checkout ----------------------------------------------------------------------------------

describe("GET /api/checkout", () => {
  test("creates a subscription session with quantity = seats and the configured price, 303 to it", async () => {
    const s = new MockStripe();
    const res = await makeCheckout(deps(s, ENV))(get("/api/checkout?plan=business&interval=year&seats=12"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://checkout.stripe.test/c/pay/cs_test_1");
    expect(s.calls.checkout).toEqual([{
      price: "price_biz_y", quantity: 12, plan: "business", interval: "year",
      successUrl: "https://site.test/welcome?session_id={CHECKOUT_SESSION_ID}", cancelUrl: "https://site.test/#pricing",
    }]);
  });

  test("defaults to team monthly, one seat; origin falls back to the request when SITE_URL is unset", async () => {
    const s = new MockStripe();
    const res = await makeCheckout(deps(s, without("SITE_URL")))(new Request("https://preview.test/api/checkout"));
    expect(res.status).toBe(303);
    expect(s.calls.checkout[0]).toMatchObject({ price: "price_team_m", quantity: 1, cancelUrl: "https://preview.test/#pricing" });
  });

  test("bad parameters are 400 and never reach Stripe", async () => {
    const s = new MockStripe();
    const h = makeCheckout(deps(s, ENV));
    for (const [q, code] of [
      ["plan=free", "invalid_plan"], ["interval=week", "invalid_interval"], ["seats=0", "invalid_seats"],
      ["seats=51", "invalid_seats"], ["seats=-3", "invalid_seats"], ["seats=2.5", "invalid_seats"], ["seats=abc", "invalid_seats"],
      ["plan=business&seats=10001", "invalid_seats"],
    ] as const) {
      const res = await h(get(`/api/checkout?${q}`));
      expect({ q, status: res.status, body: await body(res) }).toEqual({ q, status: 400, body: { error: code } });
    }
    expect(s.calls.checkout).toEqual([]);
  });

  test("missing env: 503 billing_not_configured as JSON, or a friendly page for a browser", async () => {
    const s = new MockStripe();
    const h = makeCheckout(deps(s, without("STRIPE_PRICE_TEAM_MONTH")));
    const api = await h(get("/api/checkout?plan=team&interval=month&seats=3"));
    expect(api.status).toBe(503);
    expect(await body(api)).toEqual({ error: "billing_not_configured" });
    const page = await h(get("/api/checkout?plan=team&interval=month&seats=3", { accept: "text/html,*/*" }));
    expect(page.status).toBe(503);
    expect(page.headers.get("content-type")).toContain("text/html");
    const text = await page.text();
    expect(text).toContain("Billing isn't live yet");
    expect(text).toContain('href="/#install"');
    // Other plans still work when only one price is missing.
    expect((await h(get("/api/checkout?plan=team&interval=year&seats=3"))).status).toBe(303);
    expect((await makeCheckout(deps(s, without("STRIPE_SECRET_KEY")))(get("/api/checkout"))).status).toBe(503);
  });

  test("a Stripe failure or a session without a URL is 502, with no secret in the body", async () => {
    const s = new MockStripe();
    s.fail = stripeError(500);
    const res = await makeCheckout(deps(s, ENV))(get("/api/checkout"));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toBe('{"error":"checkout_unavailable"}');
    const t = new MockStripe();
    t.checkoutUrl = null;
    expect((await makeCheckout(deps(t, ENV))(get("/api/checkout"))).status).toBe(502);
  });
});


// ---- webhook -----------------------------------------------------------------------------------

describe("POST /api/webhook", () => {
  const legacyKey = signLicense({ v: 2, kind: "activation", lic_id: "sub_ABC123", plan: "team", seats: 2, email: "a@b.c", interval: "month", issued_at: 1, expires_at: 2 }, signingKeyFromPem(kp.pem));
  const legacy = { walkie_license: legacyKey.slice(0, 500), walkie_license_1: legacyKey.slice(500) || "x" };

  test("issues nothing: a signed checkout.session.completed or invoice.paid writes no license to metadata", async () => {
    const s = new MockStripe();
    s.subs.set("sub_ABC123", subscription());
    const h = makeWebhook(deps(s, ENV));
    const done = await h(await signedWebhook({
      id: "evt_1", object: "event", type: "checkout.session.completed",
      data: { object: { id: "cs_test_1", object: "checkout.session", mode: "subscription", subscription: "sub_ABC123" } },
    }));
    expect([done.status, await body(done)]).toEqual([200, { received: true, cleared: false, refresh: false }]);
    const paid = await h(await signedWebhook({
      id: "evt_2", object: "event", type: "invoice.paid",
      data: { object: { id: "in_1", object: "invoice", parent: { type: "subscription_details", subscription_details: { subscription: "sub_ABC123" } } } },
    }));
    expect(await body(paid)).toEqual({ received: true, cleared: false, refresh: false });
    expect(s.calls.metadata).toEqual([]);
  });

  test("legacy license chunks (email + org in them) are cleared on any subscription event; other metadata stays", async () => {
    const s = new MockStripe();
    s.subs.set("sub_ABC123", subscription({ metadata: { ...legacy, walkie_plan: "team", walkie_team: "0123456789abcdef" } }));
    s.subs.set("sub_D", subscription({ id: "sub_D", status: "canceled", metadata: { ...legacy } }));
    const h = makeWebhook(deps(s, ENV));
    const upd = await h(await signedWebhook({ id: "evt_3", object: "event", type: "customer.subscription.updated", data: { object: { id: "sub_ABC123", object: "subscription" } } }));
    expect(await body(upd)).toEqual({ received: true, cleared: true, refresh: false });
    expect(s.subs.get("sub_ABC123")?.metadata).toEqual({ walkie_plan: "team", walkie_team: "0123456789abcdef" });
    const del = await h(await signedWebhook({ id: "evt_d", object: "event", type: "customer.subscription.deleted", data: { object: { id: "sub_D", object: "subscription" } } }));
    expect(await body(del)).toEqual({ received: true, cleared: true, refresh: false });
    expect(s.subs.get("sub_D")?.metadata).toEqual({});
    // Nothing left to clear: no second write (no loop on our own metadata update).
    expect(await body(await h(await signedWebhook({ id: "evt_4", object: "event", type: "customer.subscription.updated", data: { object: { id: "sub_ABC123", object: "subscription" } } })))).toEqual({ received: true, cleared: false, refresh: false });
    expect(s.calls.metadata.length).toBe(2);
  });

  test("bad or missing signature is 400 and touches nothing", async () => {
    const s = new MockStripe();
    s.subs.set("sub_ABC123", subscription({ metadata: { ...legacy } }));
    const h = makeWebhook(deps(s, ENV));
    const ev = { id: "evt_x", object: "event", type: "customer.subscription.updated", data: { object: { id: "sub_ABC123" } } };
    const wrongSecret = await h(await signedWebhook(ev, ("wh" + "sec_someone_else")));
    expect([wrongSecret.status, await body(wrongSecret)]).toEqual([400, { error: "bad_signature" }]);
    const payload = JSON.stringify(ev);
    const header = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: WEBHOOK_SECRET });
    expect((await h(post("/api/webhook", payload.replace("sub_ABC123", "sub_EVIL99"), { "stripe-signature": header }))).status).toBe(400);
    expect((await h(post("/api/webhook", payload))).status).toBe(400);
    expect(s.calls.metadata).toEqual([]);
  });

  test("unknown event types are acknowledged; a Stripe outage never makes Stripe retry; missing env is 503", async () => {
    const s = new MockStripe();
    const h = makeWebhook(deps(s, ENV));
    expect(await body(await h(await signedWebhook({ id: "evt_o", object: "event", type: "charge.refunded", data: { object: { id: "ch_1" } } })))).toEqual({ received: true });
    s.fail = stripeError(503);
    const res = await h(await signedWebhook({ id: "evt_f", object: "event", type: "invoice.paid", data: { object: { subscription: "sub_ABC123" } } }));
    expect([res.status, await body(res)]).toEqual([200, { received: true, cleared: false, refresh: false }]);
    for (const n of ["STRIPE_WEBHOOK_SECRET", "STRIPE_SECRET_KEY"]) {
      const r = await makeWebhook(deps(new MockStripe(), without(n)))(await signedWebhook({ id: "e", object: "event", type: "invoice.paid", data: { object: {} } }));
      expect([r.status, await body(r)]).toEqual([503, { error: "billing_not_configured" }]);
    }
  });
});

// ---- license (welcome page): the activation code, once, within 24 h (H2) ---------------------------------

describe("GET /api/license", () => {
  function paid(over: Parameters<typeof subscription>[0] = {}) {
    const s = new MockStripe();
    s.subs.set("sub_ABC123", subscription(over));
    s.sessions.set("cs_test_1", { id: "cs_test_1", mode: "subscription", status: "complete", subscription: "sub_ABC123", customer: "cus_XYZ" });
    return s;
  }

  test("returns an activation code (no team, no org) for a paid session, and records the reveal before answering", async () => {
    const s = paid();
    const res = await makeLicense(deps(s, ENV))(get("/api/license?session_id=cs_test_1"));
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(Object.keys(b).sort()).toEqual(["code", "expires_at", "interval", "plan", "seats"]);
    expect(b).toMatchObject({ plan: "team", seats: 7, interval: "month", expires_at: EXPIRES });
    const c = verify(b.code as string);
    expect(c.ok && c.payload).toEqual({
      v: 2, kind: "activation", lic_id: "sub_ABC123", plan: "team", seats: 7, email: "lead@kestrel.test",
      interval: "month", issued_at: NOW, expires_at: EXPIRES,
    });
    expect(s.subs.get("sub_ABC123")?.metadata).toEqual({
      walkie_code_revealed_at: String(NOW), walkie_code_reveal_nonce: expect.stringMatching(/^[0-9a-f]{32}$/), walkie_code_shown_at: String(NOW),
    });
  });

  test("F4: two concurrent reveals whose writes race (last write wins) show the code to exactly one caller; the other gets 410", async () => {
    const s = paid();
    const orig = s.setSubscriptionMetadata.bind(s);
    // Both handlers read the subscription unrevealed and both write; the writes land in call order once
    // both are in (a barrier), so the second one overwrites the first: Stripe's last-write-wins.
    const pending: { id: string; m: Record<string, string>; go: () => void }[] = [];
    let released = false; // after the barrier, later writes (the winner's `shown` mark) land directly
    s.setSubscriptionMetadata = (id, m) => new Promise<void>((resolve) => {
      if (released) { void orig(id, m).then(resolve); return; }
      pending.push({ id, m, go: resolve });
      if (pending.length === 2) { released = true; void (async () => { for (const w of pending) { await orig(w.id, w.m); w.go(); } })(); }
    });
    const h = makeLicense(deps(s, ENV));
    const [a, b] = await Promise.all([h(get("/api/license?session_id=cs_test_1")), h(get("/api/license?session_id=cs_test_1"))]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 410]);
    const bodies = await Promise.all([body(a), body(b)]);
    const shown = bodies.filter((x) => typeof x.code === "string");
    expect(shown.length).toBe(1);
    const refused = bodies.find((x) => x.error === "already_revealed");
    expect(refused).toBeDefined();
    expect(JSON.stringify(refused)).not.toContain(".");
    // The metadata holds the winner's nonce; within the retry window a third call redelivers the winner's
    // code (FINAL-2 Codex 4: a lost response), after it the call is refused.
    expect(s.subs.get("sub_ABC123")?.metadata.walkie_code_revealed_at).toBe(String(NOW));
    const third = await h(get("/api/license?session_id=cs_test_1"));
    expect([third.status, (await body(third)).code]).toEqual([200, shown[0]?.code]);
    const late = makeLicense({ env: ENV, stripe: () => s, now: () => NOW + 10 * 60_000 + 1 }); // RETRY_WINDOW_MS + 1
    expect((await late(get("/api/license?session_id=cs_test_1"))).status).toBe(410);
  });

  test("H2: the second call within the window redelivers the same code; after it, 410 already_revealed with no code", async () => {
    const s = paid();
    const h = makeLicense(deps(s, ENV));
    const first = await h(get("/api/license?session_id=cs_test_1"));
    expect(first.status).toBe(200);
    const same = await h(get("/api/license?session_id=cs_test_1"));
    expect([same.status, (await body(same)).code]).toEqual([200, (await body(first)).code]);
    const late = makeLicense({ env: ENV, stripe: () => s, now: () => NOW + 10 * 60_000 + 1 }); // RETRY_WINDOW_MS + 1
    const again = await late(get("/api/license?session_id=cs_test_1"));
    const b = await body(again);
    expect([again.status, b.error]).toEqual([410, "already_revealed"]);
    expect(String(b.message)).toContain("already shown");
    expect(String(b.message)).toContain("email support to resend");
    expect(JSON.stringify(b)).not.toContain(".");
  });

  test("H2: more than 24 h after checkout the link reveals nothing (410 reveal_expired)", async () => {
    const s = paid({ created: Math.floor(NOW / 1000) - 24 * 3600 - 1 });
    const r = await makeLicense(deps(s, ENV))(get("/api/license?session_id=cs_test_1"));
    expect([r.status, (await body(r)).error]).toEqual([410, "reveal_expired"]);
    expect(s.calls.metadata).toEqual([]);
    const noCreated = paid({ created: null });
    expect((await makeLicense(deps(noCreated, ENV))(get("/api/license?session_id=cs_test_1"))).status).toBe(410);
  });

  test("a failed reveal write shows no code, and a retry can still reveal it", async () => {
    const s = paid();
    const orig = s.setSubscriptionMetadata.bind(s);
    let fails = 1;
    s.setSubscriptionMetadata = async (id, m) => { if (fails-- > 0) throw stripeError(500); return orig(id, m); };
    const h = makeLicense(deps(s, ENV));
    const first = await h(get("/api/license?session_id=cs_test_1"));
    expect([first.status, await body(first)]).toEqual([502, { error: "stripe_unavailable" }]);
    expect((await h(get("/api/license?session_id=cs_test_1"))).status).toBe(200);
  });

  test("400 bad id, 404 unknown or non-subscription session, 409 not ready (open session, incomplete, trialing), 402 dead, 503, 502", async () => {
    const s = new MockStripe();
    s.sessions.set("cs_pay", { id: "cs_pay", mode: "payment" });
    s.sessions.set("cs_open", { id: "cs_open", mode: "subscription", subscription: null });
    s.sessions.set("cs_unpaid", { id: "cs_unpaid", mode: "subscription", status: "open", subscription: "sub_ABC123" });
    s.sessions.set("cs_inc", { id: "cs_inc", mode: "subscription", subscription: "sub_I" });
    s.sessions.set("cs_trial", { id: "cs_trial", mode: "subscription", subscription: "sub_T" });
    s.sessions.set("cs_dead", { id: "cs_dead", mode: "subscription", subscription: "sub_D" });
    s.subs.set("sub_ABC123", subscription());
    s.subs.set("sub_I", subscription({ id: "sub_I", status: "incomplete" }));
    s.subs.set("sub_T", subscription({ id: "sub_T", status: "trialing" }));
    s.subs.set("sub_D", subscription({ id: "sub_D", status: "canceled" }));
    const h = makeLicense(deps(s, ENV));
    const cases: [string, number, string][] = [
      ["/api/license", 400, "invalid_session_id"], ["/api/license?session_id=cs_<script>", 400, "invalid_session_id"],
      ["/api/license?session_id=cs_missing", 404, "not_found"], ["/api/license?session_id=cs_pay", 404, "not_found"],
      ["/api/license?session_id=cs_open", 409, "not_ready"], ["/api/license?session_id=cs_unpaid", 409, "not_ready"],
      ["/api/license?session_id=cs_inc", 409, "not_ready"], ["/api/license?session_id=cs_trial", 409, "not_ready"],
      ["/api/license?session_id=cs_dead", 402, "subscription_inactive"],
    ];
    for (const [path, status, error] of cases) {
      const r = await h(get(path));
      expect({ path, status: r.status, body: await body(r) }).toEqual({ path, status, body: { error } });
    }
    expect(s.calls.metadata).toEqual([]);
    const nc = await makeLicense(deps(s, without("WALKIE_LICENSE_SIGNING_KEY")))(get("/api/license?session_id=cs_inc"));
    expect([nc.status, await body(nc)]).toEqual([503, { error: "billing_not_configured" }]);
    s.fail = stripeError(500);
    const down = await h(get("/api/license?session_id=cs_inc"));
    expect([down.status, await body(down)]).toEqual([502, { error: "stripe_unavailable" }]);
  });
});

// ---- bind (H3) ----------------------------------------------------------------------------------------

const TEAM_A = "aaaaaaaaaaaaaaaa";
const TEAM_B = "bbbbbbbbbbbbbbbb";

function codeFor(over: Partial<LicensePayload> = {}): string {
  return signLicense({
    v: 2, kind: "activation", lic_id: "sub_ABC123", plan: "team", seats: 7, email: "lead@kestrel.test",
    interval: "month", issued_at: NOW, expires_at: EXPIRES, ...over,
  }, signingKeyFromPem(kp.pem));
}

describe("POST /api/license/bind", () => {
  test("first bind: a team-bound key + a 32-byte renewal token; only the token's sha256 is stored", async () => {
    const s = new MockStripe();
    s.subs.set("sub_ABC123", subscription());
    const res = await makeBind(deps(s, ENV))(post("/api/license/bind", { code: codeFor(), team_id: TEAM_A }));
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(Object.keys(b).sort()).toEqual(["key", "renewal_token"]);
    const token = b.renewal_token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url").length).toBe(32);
    const k = verify(b.key as string);
    expect(k.ok && k.payload).toEqual({
      v: 2, kind: "license", lic_id: "sub_ABC123", plan: "team", seats: 7, email: "lead@kestrel.test",
      interval: "month", issued_at: NOW, expires_at: EXPIRES, team: TEAM_A,
    });
    const meta = s.subs.get("sub_ABC123")?.metadata ?? {};
    expect(meta).toEqual({ walkie_team: TEAM_A, walkie_renew_hash: renewHash(token) });
    expect(JSON.stringify(meta)).not.toContain(token);
  });

  test("the same team again: a fresh key, no token (idempotent); another team: 409 license_bound_elsewhere", async () => {
    const s = new MockStripe();
    s.subs.set("sub_ABC123", subscription());
    const h = makeBind(deps(s, ENV));
    await h(post("/api/license/bind", { code: codeFor(), team_id: TEAM_A }));
    const hash = s.subs.get("sub_ABC123")?.metadata.walkie_renew_hash;
    const again = await h(post("/api/license/bind", { code: codeFor(), team_id: TEAM_A }));
    const b = await body(again);
    expect([again.status, Object.keys(b)]).toEqual([200, ["key"]]);
    const k = verify(b.key as string);
    expect(k.ok && k.payload.team).toBe(TEAM_A);
    const other = await h(post("/api/license/bind", { code: codeFor(), team_id: TEAM_B }));
    expect([other.status, await body(other)]).toEqual([409, { error: "license_bound_elsewhere" }]);
    expect(s.subs.get("sub_ABC123")?.metadata).toEqual({ walkie_team: TEAM_A, walkie_renew_hash: hash as string });
    expect(s.calls.metadata.length).toBe(1);
  });

  test("a concurrent first bind whose write was overwritten gets 409 and no token", async () => {
    const s = new MockStripe();
    s.subs.set("sub_ABC123", subscription());
    const orig = s.setSubscriptionMetadata.bind(s);
    // Team B's write lands right after team A's.
    s.setSubscriptionMetadata = async (id, m) => { await orig(id, m); if (m.walkie_team === TEAM_A) await orig(id, { walkie_team: TEAM_B, walkie_renew_hash: "f".repeat(64) }); };
    const res = await makeBind(deps(s, ENV))(post("/api/license/bind", { code: codeFor(), team_id: TEAM_A }));
    expect([res.status, await body(res)]).toEqual([409, { error: "license_bound_elsewhere" }]);
  });

  test("L8: only an active subscription binds (trialing, past_due, canceled → 402)", async () => {
    for (const status of ["trialing", "past_due", "canceled", "incomplete"]) {
      const s = new MockStripe();
      s.subs.set("sub_ABC123", subscription({ status }));
      const r = await makeBind(deps(s, ENV))(post("/api/license/bind", { code: codeFor(), team_id: TEAM_A }));
      expect({ status, got: r.status, body: await body(r) }).toEqual({ status, got: 402, body: { error: "subscription_inactive" } });
      expect(s.calls.metadata).toEqual([]);
    }
  });

  test("refuses anything that isn't our activation code: a license key, a forged code, junk; bad team ids; 404; 413; 503; 502", async () => {
    const s = new MockStripe();
    s.subs.set("sub_ABC123", subscription());
    const h = makeBind(deps(s, ENV));
    const licenseKey = signLicense({ ...(verify(codeFor()) as { payload: LicensePayload }).payload, kind: "license", team: TEAM_A }, signingKeyFromPem(kp.pem));
    const forged = signLicense({ v: 2, kind: "activation", lic_id: "sub_ABC123", plan: "business", seats: 900, email: "x@y.z", interval: "year", issued_at: NOW, expires_at: EXPIRES },
      signingKeyFromPem(testKeypair().pem));
    const cases: [unknown, number, string][] = [
      [{ code: licenseKey, team_id: TEAM_A }, 400, "invalid_code"], [{ code: forged, team_id: TEAM_A }, 400, "invalid_code"],
      [{ code: "abc.def", team_id: TEAM_A }, 400, "invalid_code"], [{ code: 7, team_id: TEAM_A }, 400, "invalid_code"],
      [{ code: codeFor(), team_id: "ACME" }, 400, "invalid_team_id"], [{ code: codeFor() }, 400, "invalid_team_id"],
      [{ code: codeFor({ lic_id: "sub_NOPE" }), team_id: TEAM_A }, 404, "not_found"],
      ["{not json", 400, "invalid_json"], ["[1]", 400, "invalid_json"],
    ];
    for (const [data, status, error] of cases) {
      const r = await h(post("/api/license/bind", data));
      expect({ data, status: r.status, body: await body(r) }).toEqual({ data, status, body: { error } });
    }
    expect((await h(post("/api/license/bind", "x".repeat(9000)))).status).toBe(413);
    expect(s.calls.metadata).toEqual([]);
    expect((await makeBind(deps(s, without("WALKIE_LICENSE_SIGNING_KEY")))(post("/api/license/bind", { code: codeFor(), team_id: TEAM_A }))).status).toBe(503);
    s.fail = stripeError(500);
    expect((await h(post("/api/license/bind", { code: codeFor(), team_id: TEAM_A }))).status).toBe(502);
  });
});

// ---- renew (H1, L8) -----------------------------------------------------------------------------------

describe("POST /api/license/renew", () => {
  async function bound(status = "active") {
    const s = new MockStripe();
    s.subs.set("sub_ABC123", subscription());
    const b = await body(await makeBind(deps(s, ENV))(post("/api/license/bind", { code: codeFor(), team_id: TEAM_A })));
    const cur = s.subs.get("sub_ABC123") as SubscriptionLite;
    s.subs.set("sub_ABC123", { ...cur, status });
    return { s, token: b.renewal_token as string };
  }

  test("the right token → a fresh key for the bound team; nothing else is read from the body", async () => {
    const { s, token } = await bound();
    const res = await makeRenew(deps(s, ENV))(post("/api/license/renew", { lic_id: "sub_ABC123", renewal_token: token, team_id: TEAM_B, ignored: "x" }));
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(Object.keys(b)).toEqual(["key"]);
    const c = verify(b.key as string);
    expect(c.ok && c.payload).toMatchObject({ kind: "license", team: TEAM_A, lic_id: "sub_ABC123", seats: 7, expires_at: EXPIRES, issued_at: NOW });
  });

  test("H1: a subscription id alone, a wrong token, or an unknown subscription → the same 403; nothing about the customer leaks", async () => {
    const { s } = await bound();
    const h = makeRenew(deps(s, ENV));
    for (const data of [{ lic_id: "sub_ABC123", renewal_token: "A".repeat(43) }, { lic_id: "sub_NOPE", renewal_token: "A".repeat(43) }]) {
      const r = await h(post("/api/license/renew", data));
      expect([r.status, await body(r)]).toEqual([403, { error: "invalid_renewal" }]);
    }
    const bare = await h(post("/api/license/renew", { lic_id: "sub_ABC123" }));
    expect([bare.status, await body(bare)]).toEqual([400, { error: "invalid_renewal_token" }]);
    // An unbound subscription has no hash: every token is wrong.
    const u = new MockStripe();
    u.subs.set("sub_U", subscription({ id: "sub_U" }));
    expect((await makeRenew(deps(u, ENV))(post("/api/license/renew", { lic_id: "sub_U", renewal_token: "A".repeat(43) }))).status).toBe(403);
  });

  test("L8: with the right token, only `active` renews (trialing, past_due, canceled → 402)", async () => {
    for (const status of ["trialing", "past_due", "canceled"]) {
      const { s, token } = await bound(status);
      const r = await makeRenew(deps(s, ENV))(post("/api/license/renew", { lic_id: "sub_ABC123", renewal_token: token }));
      expect({ status, got: r.status, body: await body(r) }).toEqual({ status, got: 402, body: { error: "subscription_inactive" } });
    }
  });

  test("bad input → 400, oversized → 413, unconfigured → 503, Stripe down → 502", async () => {
    const { s, token } = await bound();
    const h = makeRenew(deps(s, ENV));
    const cases: [unknown, number, string][] = [
      [{ lic_id: "cus_1", renewal_token: token }, 400, "invalid_lic_id"], [{ renewal_token: token }, 400, "invalid_lic_id"],
      [{ lic_id: "sub_../../x", renewal_token: token }, 400, "invalid_lic_id"], [{ lic_id: "sub_ABC123", renewal_token: `${token}x` }, 400, "invalid_renewal_token"],
      ["{not json", 400, "invalid_json"],
    ];
    for (const [data, status, error] of cases) {
      const r = await h(post("/api/license/renew", data));
      expect({ data, status: r.status, body: await body(r) }).toEqual({ data, status, body: { error } });
    }
    expect((await h(post("/api/license/renew", "x".repeat(9000)))).status).toBe(413);
    const nc = await makeRenew(deps(s, without("STRIPE_SECRET_KEY")))(post("/api/license/renew", { lic_id: "sub_ABC123", renewal_token: token }));
    expect([nc.status, await body(nc)]).toEqual([503, { error: "billing_not_configured" }]);
    s.fail = stripeError(500);
    expect((await h(post("/api/license/renew", { lic_id: "sub_ABC123", renewal_token: token }))).status).toBe(502);
  });
});

// ---- portal (H2, L9) ----------------------------------------------------------------------------------

describe("GET /api/portal", () => {
  const LOGIN = "https://billing.stripe.com/p/login/test_123";
  test("always 303 to Stripe's email-verified login; a session id or customer id never opens a portal session", async () => {
    const s = new MockStripe();
    s.sessions.set("cs_test_1", { id: "cs_test_1", mode: "subscription", customer: "cus_XYZ" });
    const h = makePortal(deps(s, fullEnv(kp.pem, { STRIPE_PORTAL_LOGIN_URL: LOGIN })));
    for (const q of ["", "?session_id=cs_test_1", "?customer=cus_XYZ"]) {
      const r = await h(get(`/api/portal${q}`));
      expect([q, r.status, r.headers.get("location")]).toEqual([q, 303, LOGIN]);
    }
    expect(s.calls).toEqual({ checkout: [], metadata: [] });
  });

  test("L9: unset or non-https login URL → 503 billing_not_configured", async () => {
    const s = new MockStripe();
    const none = await makePortal(deps(s, ENV))(get("/api/portal?session_id=cs_test_1"));
    expect([none.status, await body(none)]).toEqual([503, { error: "billing_not_configured" }]);
    const insecure = await makePortal(deps(s, fullEnv(kp.pem, { STRIPE_PORTAL_LOGIN_URL: "javascript:alert(1)" })))(get("/api/portal"));
    expect(insecure.status).toBe(503);
  });
});
