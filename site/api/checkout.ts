// GET /api/checkout?plan=team|business&interval=month|year&seats=N[&lic_id=sub_…] → 303 to a Stripe
// Checkout subscription with quantity = seats (docs/BUSINESS.md "Billing" step 1). `lic_id` is the hint a
// daemon adds when its team already holds a license (FINAL Codex 1): a subscription that still bills
// (or will, once payment is fixed) answers 409 `already_subscribed` with the portal link instead of a
// second subscription; seat changes for a subscriber happen in the portal.
import { PRICE_ENV, requireEnv } from "./_lib/env.js";
import { fail, html, logError, redirect, siteOrigin, wantsHtml } from "./_lib/http.js";
import { defaultDeps, type Deps } from "./_lib/issue.js";
import type { LicenseInterval, LicensePlan } from "./_lib/license.js";
import { LIVE_STATUSES } from "./_lib/stripe.js";

export const MAX_SEATS: Readonly<Record<LicensePlan, number>> = { team: 50, business: 10_000 };
/** A license id as the daemon knows it: a Stripe subscription id, or a comp license id (never looked up). */
const LIC_ID = /^[A-Za-z0-9_]{1,200}$/;

export interface CheckoutQuery { plan: LicensePlan; interval: LicenseInterval; seats: number; licId?: string }

export function parseCheckoutQuery(url: URL): CheckoutQuery | { error: string } {
  const plan = url.searchParams.get("plan") ?? "team";
  const interval = url.searchParams.get("interval") ?? "month";
  const seatsText = url.searchParams.get("seats") ?? "1";
  const licId = url.searchParams.get("lic_id");
  if (plan !== "team" && plan !== "business") return { error: "invalid_plan" };
  if (interval !== "month" && interval !== "year") return { error: "invalid_interval" };
  if (!/^[0-9]{1,6}$/.test(seatsText)) return { error: "invalid_seats" };
  const seats = Number(seatsText);
  if (seats < 1 || seats > MAX_SEATS[plan]) return { error: "invalid_seats" };
  if (licId !== null && !LIC_ID.test(licId)) return { error: "invalid_lic_id" };
  return { plan, interval, seats, ...(licId ? { licId } : {}) };
}

/** Shown to a person who clicked "Buy" before billing is switched on. */
export function notConfiguredPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Billing isn't live yet</title><meta name="color-scheme" content="dark light">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:17px/1.6 ui-sans-serif,system-ui,sans-serif;background:#16171a;color:#eef0f3}
@media (prefers-color-scheme: light){body{background:#fafafb;color:#25262b}}main{max-width:34rem;padding:24px}h1{font-size:1.6rem;line-height:1.2;margin:0 0 12px}
a{color:inherit}.btn{display:inline-block;margin-top:20px;padding:10px 18px;border-radius:999px;background:#57d68d;color:#0f2a1a;font-weight:600;text-decoration:none}</style></head>
<body><main><h1>Billing isn't live yet.</h1><p>Paid plans aren't on sale yet, but every new team starts with a 14-day Team trial that needs no card. Install it now and buy when checkout opens.</p>
<a class="btn" href="/#install">Start the free trial</a> <p><a href="/#pricing">Back to pricing</a></p></main></body></html>`;
}

/**
 * `createSession: false` is the crawler gate's lic_id path: the subscription lookup still runs (a live one goes to the
 * portal), but where a person's request would create a Checkout session, this one gets the continue page instead.
 */
export function makeCheckout(deps: Deps, createSession = true): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    const q = parseCheckoutQuery(url);
    if ("error" in q) return fail(400, q.error);
    const env = requireEnv(deps.env, ["STRIPE_SECRET_KEY", PRICE_ENV[q.plan][q.interval]]);
    if (!env.ok) return wantsHtml(req) ? html(notConfiguredPage(), 503) : env.response;
    // A visitor on the public domain comes back to the public domain, whatever SITE_URL says.
    const origin = new URL(req.url).hostname === "sqwakie.si" ? "https://sqwakie.si" : siteOrigin(req, deps.env.SITE_URL?.trim() || undefined);
    try {
      if (q.licId?.startsWith("sub_")) {
        // Fails closed: a Stripe outage here is a 502, never a subscription created twice by accident.
        const sub = await deps.stripe().getSubscription(q.licId);
        if (sub && LIVE_STATUSES.has(sub.status)) {
          // A person who clicked "Upgrade" lands in the portal (where seats are changed); an API caller gets the 409.
          if (wantsHtml(req)) return redirect(`${origin}/api/portal`);
          return fail(409, "already_subscribed", { portal: `${origin}/api/portal`, lic_id: sub.id, status: sub.status });
        }
      }
      if (!createSession) return continueResponse(url);
      const session = await deps.stripe().createCheckoutSession({
        price: env.values[PRICE_ENV[q.plan][q.interval]] as string, quantity: q.seats, plan: q.plan, interval: q.interval,
        successUrl: `${origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}/?checkout=cancelled#pricing`,
      });
      if (!session.url) return fail(502, "checkout_unavailable");
      return redirect(session.url);
    } catch (err) {
      logError("checkout", err);
      return fail(502, "checkout_unavailable");
    }
  };
}

/** Headers a browser adds to a prefetch, prerender or preview: Sec-Purpose, and the older Purpose, X-Purpose and X-Moz. */
const SPECULATIVE_HEADERS = ["sec-purpose", "purpose", "x-purpose", "x-moz"] as const;

/** True for a request that carries any of those headers, whatever its value (an empty one included). */
export function isSpeculative(req: Request): boolean {
  return SPECULATIVE_HEADERS.some(name => req.headers.get(name) !== null);
}

/** True for a GET a person deliberately started (a click or a typed/opened URL), per Fetch Metadata. */
export function isUserNavigation(req: Request): boolean {
  if (isSpeculative(req)) return false;
  return req.headers.get("sec-fetch-user") === "?1" || req.headers.get("sec-fetch-mode") === "navigate" && req.headers.get("sec-fetch-site") === "none";
}

/** Served instead of a Stripe session to crawlers and link previews: one button that POSTs the same query. */
export function continuePage(url: URL): string {
  const action = `/api/checkout?${url.searchParams.toString()}`.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Continue to checkout</title><meta name="color-scheme" content="dark light">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:17px/1.6 ui-sans-serif,system-ui,sans-serif;background:#16171a;color:#eef0f3}
@media (prefers-color-scheme: light){body{background:#fafafb;color:#25262b}}main{max-width:34rem;padding:24px}button{font:inherit;margin-top:12px;padding:10px 18px;border:0;border-radius:999px;background:#57d68d;color:#0f2a1a;font-weight:600;cursor:pointer}a{color:inherit}</style></head>
<body><main><h1>Continue to checkout</h1><form method="post" action="${action}"><button type="submit">Continue to secure checkout</button></form><p><a href="/#pricing">Back to pricing</a></p></main></body></html>`;
}

function continueResponse(url: URL): Response {
  return new Response(continuePage(url), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}

/** True for a POST a page on this same origin sent (the continue page's button), per Origin and Fetch Metadata. */
export function isSameOriginPost(req: Request): boolean {
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  return req.headers.get("origin") === new URL(req.url).origin;
}

// GET: a person's click goes straight to Stripe; anything else (crawlers, link unfurlers, prefetch) gets the
// continue page, so it never creates a Checkout session. A lic_id without a person's click only reaches the portal
// path, when Stripe finds a live subscription for it; one that finds nothing gets the continue page too. A HEAD
// (which a runtime may route here) always gets the continue page and calls Stripe for nothing.
export function makeCheckoutGet(deps: Deps): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    if (req.method === "HEAD") return continueResponse(url);
    if (isUserNavigation(req)) return makeCheckout(deps)(req);
    if (!url.searchParams.has("lic_id")) return continueResponse(url);
    return makeCheckout(deps, false)(req);
  };
}

// POST: the continue page's button (same query string, empty body). Another site's form gets 403, no session.
export function makeCheckoutPost(deps: Deps): (req: Request) => Promise<Response> {
  return async (req) => (isSameOriginPost(req) ? makeCheckout(deps)(req) : fail(403, "cross_origin"));
}

export async function GET(req: Request): Promise<Response> {
  return makeCheckoutGet(defaultDeps())(req);
}

export async function POST(req: Request): Promise<Response> {
  return makeCheckoutPost(defaultDeps())(req);
}
