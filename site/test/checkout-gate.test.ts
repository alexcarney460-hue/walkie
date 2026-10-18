import { describe, expect, test } from "bun:test";
import { continuePage, GET, isSameOriginPost, isUserNavigation, makeCheckoutGet, makeCheckoutPost } from "../api/checkout.ts";
import { deps, fullEnv, MockStripe, subscription, testKeypair } from "./helpers.ts";

const q = "/api/checkout?plan=team&interval=month&seats=5";
describe("checkout GET gate", () => {
  test("a crawler GET gets the continue page, not a Stripe session", async () => {
    const res = await GET(new Request(`https://sqwakie.si${q}`, { headers: { "user-agent": "Googlebot", accept: "text/html" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const body = await res.text();
    expect(body).toContain('method="post"');
    expect(body).toContain('action="/api/checkout?plan=team&amp;interval=month&amp;seats=5"');
  });
  test("user navigations are recognised by Fetch Metadata", () => {
    expect(isUserNavigation(new Request(`https://x${q}`, { headers: { "sec-fetch-user": "?1" } }))).toBe(true);
    expect(isUserNavigation(new Request(`https://x${q}`, { headers: { "sec-fetch-mode": "navigate", "sec-fetch-site": "none" } }))).toBe(true);
    expect(isUserNavigation(new Request(`https://x${q}`, { headers: { "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" } }))).toBe(false);
    expect(isUserNavigation(new Request(`https://x${q}`))).toBe(false);
  });
  test("continue page escapes the query", () => {
    expect(continuePage(new URL('https://x/api/checkout?plan="><x'))).not.toContain('"><x');
  });
});

// The same handlers against a mocked Stripe: which requests create a Checkout session, and which never do.
const ENV = fullEnv(testKeypair().pem);
const SITE = "https://site.test";
const PERSON = { "sec-fetch-user": "?1", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", accept: "text/html" };
const CRAWLER = { "user-agent": "Slackbot-LinkExpanding 1.0", accept: "text/html" };
const get = (path: string, headers: Record<string, string>): Request => new Request(`${SITE}${path}`, { headers });
const post = (path: string, headers: Record<string, string>): Request => new Request(`${SITE}${path}`, { method: "POST", headers });
// What a browser sends when the continue page's own form is submitted.
const BUTTON = { origin: SITE, "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-user": "?1", accept: "text/html" };

function withLiveSub(): MockStripe {
  const s = new MockStripe();
  s.subs.set("sub_ABC123", subscription());
  return s;
}

describe("checkout gate with a mocked Stripe", () => {
  test("a person's GET creates one session", async () => {
    const s = new MockStripe();
    const res = await makeCheckoutGet(deps(s, ENV))(get(q, PERSON));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://checkout.stripe.test/c/pay/cs_test_1");
    expect(s.calls.checkout).toHaveLength(1);
  });
  test("a crawler GET gets the continue page and creates nothing", async () => {
    const s = new MockStripe();
    const res = await makeCheckoutGet(deps(s, ENV))(get(q, CRAWLER));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Continue to secure checkout");
    expect(s.calls.checkout).toEqual([]);
  });
  test("a lic_id with a live subscription goes to the portal path, even without a person's click", async () => {
    for (const headers of [CRAWLER, PERSON]) {
      const s = withLiveSub();
      const res = await makeCheckoutGet(deps(s, ENV))(get(`${q}&lic_id=sub_ABC123`, headers));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${SITE}/api/portal`);
      expect(s.calls.checkout).toEqual([]);
    }
    const s = withLiveSub();
    const api = await makeCheckoutGet(deps(s, ENV))(get(`${q}&lic_id=sub_ABC123`, {}));
    expect(api.status).toBe(409);
    expect(await api.json()).toMatchObject({ error: "already_subscribed", portal: `${SITE}/api/portal` });
    expect(s.calls.checkout).toEqual([]);
  });
  test("a lic_id Stripe does not find, without a person's click, gets the continue page and creates nothing", async () => {
    for (const lic of ["sub_unknown", "comp_123", "x"]) {
      for (const headers of [CRAWLER, {}]) {
        const s = withLiveSub();
        const res = await makeCheckoutGet(deps(s, ENV))(get(`${q}&lic_id=${lic}`, headers));
        expect(res.status).toBe(200);
        expect(res.headers.get("x-robots-tag")).toContain("noindex");
        const body = await res.text();
        expect(body).toContain('method="post"');
        expect(body).toContain(`lic_id=${lic}`);
        expect(s.calls.checkout).toEqual([]);
      }
    }
  });
  test("a lic_id whose subscription is canceled, without a person's click, creates nothing", async () => {
    const s = new MockStripe();
    s.subs.set("sub_ABC123", subscription({ status: "canceled" }));
    const res = await makeCheckoutGet(deps(s, ENV))(get(`${q}&lic_id=sub_ABC123`, CRAWLER));
    expect(res.status).toBe(200);
    expect(s.calls.checkout).toEqual([]);
  });
  test("a person's click with a lic_id Stripe does not find still reaches checkout", async () => {
    const s = withLiveSub();
    const res = await makeCheckoutGet(deps(s, ENV))(get(`${q}&lic_id=sub_unknown`, PERSON));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://checkout.stripe.test/c/pay/cs_test_1");
    expect(s.calls.checkout).toHaveLength(1);
  });
  // A browser prefetch or prerender of a typed or opened URL is navigate + none, but no person asked for it.
  test("a prefetch or prerender GET gets the continue page and creates nothing", async () => {
    const SPECULATIVE = { "sec-fetch-mode": "navigate", "sec-fetch-site": "none", accept: "text/html" };
    const marks: Record<string, string>[] = [
      { "sec-purpose": "prefetch" },
      { "sec-purpose": "prefetch;prerender" },
      { purpose: "prefetch" },
      { "sec-purpose": "prefetch", "sec-fetch-user": "?1" },
    ];
    for (const mark of marks) {
      for (const path of [q, `${q}&lic_id=sub_unknown`]) {
        const s = withLiveSub();
        const res = await makeCheckoutGet(deps(s, ENV))(get(path, { ...SPECULATIVE, ...mark }));
        expect(res.status).toBe(200);
        expect(res.headers.get("x-robots-tag")).toContain("noindex");
        expect(await res.text()).toContain("Continue to secure checkout");
        expect(s.calls.checkout).toEqual([]);
      }
    }
  });
  test("a HEAD request never creates a session, even with a person's navigation headers", async () => {
    for (const path of [q, `${q}&lic_id=sub_unknown`, `${q}&lic_id=sub_ABC123`]) {
      const s = withLiveSub();
      const res = await makeCheckoutGet(deps(s, ENV))(new Request(`${SITE}${path}`, { method: "HEAD", headers: PERSON }));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-robots-tag")).toContain("noindex");
      expect(s.calls.checkout).toEqual([]);
    }
  });
  test("speculative requests are not user navigations", () => {
    expect(isUserNavigation(new Request(`https://x${q}`, { headers: { "sec-purpose": "prefetch", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" } }))).toBe(false);
    expect(isUserNavigation(new Request(`https://x${q}`, { headers: { "sec-purpose": "prefetch;prerender", "sec-fetch-user": "?1" } }))).toBe(false);
    expect(isUserNavigation(new Request(`https://x${q}`, { headers: { purpose: "prefetch", "sec-fetch-user": "?1" } }))).toBe(false);
  });
  test("a Stripe outage during the gate's lookup is a 502, never a session", async () => {
    const s = new MockStripe();
    s.fail = new Error("stripe down");
    const res = await makeCheckoutGet(deps(s, ENV))(get(`${q}&lic_id=sub_ABC123`, CRAWLER));
    expect(res.status).toBe(502);
    expect(s.calls.checkout).toEqual([]);
  });
});

describe("checkout POST origin check with a mocked Stripe", () => {
  test("a cross-site POST gets 403 and creates nothing", async () => {
    const cases: Record<string, string>[] = [
      { origin: "https://evil.test", "sec-fetch-site": "cross-site" },
      { origin: "https://evil.test" },
      { origin: SITE, "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "cross-site" },
      { origin: "null" },
      { origin: "http://site.test" },
      {},
    ];
    for (const headers of cases) {
      const s = new MockStripe();
      const res = await makeCheckoutPost(deps(s, ENV))(post(q, { ...headers, accept: "text/html" }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "cross_origin" });
      expect(s.calls.checkout).toEqual([]);
    }
  });
  test("the continue page's own button (same-origin POST) creates exactly one session", async () => {
    const s = new MockStripe();
    const page = await makeCheckoutGet(deps(s, ENV))(get(q, CRAWLER));
    const action = /action="([^"]+)"/.exec(await page.text())?.[1]?.replace(/&amp;/g, "&");
    expect(action).toBe(q);
    const res = await makeCheckoutPost(deps(s, ENV))(post(action as string, BUTTON));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://checkout.stripe.test/c/pay/cs_test_1");
    expect(s.calls.checkout).toHaveLength(1);
  });
  test("a same-origin POST without Fetch Metadata (older browser) still works", async () => {
    const s = new MockStripe();
    const res = await makeCheckoutPost(deps(s, ENV))(post(q, { origin: SITE }));
    expect(res.status).toBe(303);
    expect(s.calls.checkout).toHaveLength(1);
  });
  test("isSameOriginPost compares Origin with the request's own origin", () => {
    expect(isSameOriginPost(new Request(`https://sqwakie.si${q}`, { method: "POST", headers: { origin: "https://sqwakie.si", "sec-fetch-site": "same-origin" } }))).toBe(true);
    expect(isSameOriginPost(new Request(`https://sqwakie.si${q}`, { method: "POST", headers: { origin: "https://www.sqwakie.si", "sec-fetch-site": "same-site" } }))).toBe(false);
  });
});
