// GET /api/license?session_id=cs_… → {code, plan, seats, interval, expires_at} for the welcome page
// (docs/BUSINESS.md "Billing" step 3). The ACTIVATION CODE is shown at most once and only within 24 h
// of checkout (audit H2): the reveal is recorded in the subscription's metadata
// (walkie_code_revealed_at) before the code is returned; a second call answers 410 once the retry window
// (RETRY_WINDOW_MS, for a response lost on the wire) is over. Two reveals
// racing (Fable F4): each writes its own nonce with the mark and reads it back; only the caller whose
// nonce stuck (Stripe keeps the last write) gets the code, the other answers 410. A code is not
// a license: `walkie license activate <code>` exchanges it, once, for a license bound to one team.
import { randomBytes } from "node:crypto";
import { requireEnv } from "../_lib/env.js";
import { fail, json, logError } from "../_lib/http.js";
import { DEAD_STATUSES, defaultDeps, issueKey, LICENSED_STATUS, payloadFor, type Deps } from "../_lib/issue.js";
import { LicenseError } from "../_lib/license.js";
import { REVEAL_NONCE_META, REVEALED_META, SHOWN_META } from "../_lib/metadata.js";
import { idOf, type StripeLike } from "../_lib/stripe.js";

export const SESSION_ID = /^cs_[A-Za-z0-9_]{1,250}$/;
/** How long after checkout the welcome page may show the activation code. */
export const REVEAL_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * The retry window of a reveal (FINAL Fable 3; FINAL-2 Codex 4). Within it the same checkout session may
 * call again and get the code: after a completed reveal (`walkie_code_shown_at` set) the call is
 * idempotent, so a response lost on the wire is retried without support; after a mark that never
 * completed (the read-back failed) the reveal runs again. Past the window the code is shown for good.
 */
export const RETRY_WINDOW_MS = 10 * 60 * 1000;

const SUPPORT = "activate it with the code you saved, or email support to resend it";

export type RevealState = "unrevealed" | "shown" | "retriable" | "redeliver";

/**
 * What the metadata says (FINAL-2 Fable 4: `shown` is checked FIRST, so a mark cleared after a completed
 * reveal can't read as unrevealed): `redeliver` = shown within the window (answer the same code again,
 * write nothing), `retriable` = marked but not completed within the window, `shown` = 410.
 */
export function revealState(meta: Readonly<Record<string, string>>, now: number): RevealState {
  const shownAt = Number(meta[SHOWN_META] ?? "");
  if (meta[SHOWN_META]) return Number.isFinite(shownAt) && now - shownAt <= RETRY_WINDOW_MS ? "redeliver" : "shown";
  const revealedAt = Number(meta[REVEALED_META] ?? "");
  if (!meta[REVEALED_META]) return "unrevealed";
  return Number.isFinite(revealedAt) && now - revealedAt <= RETRY_WINDOW_MS ? "retriable" : "shown";
}

/**
 * Best effort, after a failed read-back: the mark is cleared so the customer isn't locked out, unless
 * the current state says a reveal COMPLETED meanwhile (a concurrent call of the same session; FINAL-2
 * Fable 4), or can't be read at all: then nothing is written and the retry window covers it.
 */
async function unmark(stripe: StripeLike, subId: string): Promise<void> {
  try {
    const current = await stripe.getSubscription(subId);
    if (!current || current.metadata[SHOWN_META]) return;
    await stripe.setSubscriptionMetadata(subId, { [REVEALED_META]: "", [REVEAL_NONCE_META]: "" });
  } catch (err) {
    logError("license unmark", err); // the retry window covers this case
  }
}

export function makeLicense(deps: Deps): (req: Request) => Promise<Response> {
  return async (req) => {
    const sessionId = new URL(req.url).searchParams.get("session_id") ?? "";
    if (!SESSION_ID.test(sessionId)) return fail(400, "invalid_session_id");
    const env = requireEnv(deps.env, ["STRIPE_SECRET_KEY", "WALKIE_LICENSE_SIGNING_KEY"]);
    if (!env.ok) return env.response;
    const stripe = deps.stripe();
    try {
      const session = await stripe.getCheckoutSession(sessionId);
      if (!session || session.mode !== "subscription") return fail(404, "not_found");
      const subId = idOf(session.subscription);
      if (!subId || (session.status && session.status !== "complete")) return fail(409, "not_ready");
      const sub = await stripe.getSubscription(subId);
      if (!sub) return fail(404, "not_found");
      if (DEAD_STATUSES.has(sub.status)) return fail(402, "subscription_inactive");
      if (sub.status !== LICENSED_STATUS) return fail(409, "not_ready");
      const state = revealState(sub.metadata, deps.now());
      if (state === "shown") return fail(410, "already_revealed", { message: `already shown: ${SUPPORT}` });
      const created = typeof sub.created === "number" ? sub.created * 1000 : null;
      if (created === null || deps.now() - created > REVEAL_WINDOW_MS) {
        return fail(410, "reveal_expired", { message: `this link is more than 24 hours old: ${SUPPORT}` });
      }
      // FINAL-2 Codex 4: a completed reveal whose response may have been lost is answered again within the
      // window with the SAME code (issued at the first delivery), nothing written; the window keeps
      // counting from that first delivery.
      const issuedAt = state === "redeliver" ? Number(sub.metadata[SHOWN_META]) : deps.now();
      const payload = payloadFor(sub, deps.env, issuedAt);
      const code = issueKey(payload, deps.env);
      if (state === "redeliver") return json({ code, plan: payload.plan, seats: payload.seats, interval: payload.interval, expires_at: payload.expires_at });
      // Recorded BEFORE the code leaves: a failed write shows nothing, and the next call can still reveal.
      // The nonce is read back: a concurrent reveal whose write landed later owns the reveal instead.
      const nonce = randomBytes(16).toString("hex");
      await stripe.setSubscriptionMetadata(sub.id, { [REVEALED_META]: String(deps.now()), [REVEAL_NONCE_META]: nonce, [SHOWN_META]: "" });
      let after;
      try {
        after = await stripe.getSubscription(sub.id);
      } catch (err) {
        await unmark(stripe, sub.id); // FINAL Fable 3: a read-back failure must not lock the customer out
        throw err;
      }
      if (after?.metadata[REVEAL_NONCE_META] !== nonce) return fail(410, "already_revealed", { message: `already shown: ${SUPPORT}` });
      // The reveal is complete only now; until this lands the same session may retry within RETRY_WINDOW_MS.
      // Stamped with the code's issued_at so a redelivery within the window re-issues the identical code.
      await stripe.setSubscriptionMetadata(sub.id, { [SHOWN_META]: String(issuedAt) });
      return json({ code, plan: payload.plan, seats: payload.seats, interval: payload.interval, expires_at: payload.expires_at });
    } catch (err) {
      if (err instanceof LicenseError) {
        logError("license", { type: "license", code: err.code });
        return fail(500, "license_unavailable");
      }
      logError("license", err);
      return fail(502, "stripe_unavailable");
    }
  };
}

export async function GET(req: Request): Promise<Response> {
  return makeLicense(defaultDeps())(req);
}
