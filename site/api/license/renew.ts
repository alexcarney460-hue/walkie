// POST /api/license/renew {lic_id, renewal_token} → {key} (docs/BUSINESS.md "Renewal", audit H1/L8).
// The roster authority calls this once a day when its key is close to expiry. A subscription id alone
// authorizes nothing: the token's sha256 must match the one stored at the first bind (constant-time),
// and an unknown subscription answers the same 403 as a wrong token. Then the subscription must be
// `active` (not trialing) and bound to a team; the fresh key is bound to that team.
import { requireEnv } from "../_lib/env.js";
import { fail, json, logError } from "../_lib/http.js";
import { defaultDeps, issueKey, LICENSED_STATUS, payloadFor, type Deps } from "../_lib/issue.js";
import { LicenseError, TEAM_ID } from "../_lib/license.js";
import { AUTHORITY_CHAIN_META, AUTHORITY_META, RENEW_AUTHORITY_META, RENEW_CHAIN_META,
  RENEW_HASH_META, renewTokenMatches, TEAM_META } from "../_lib/metadata.js";
import { readJsonObject } from "../_lib/body.js";
import type { ComputeStore } from '../_lib/compute/store.js';
import type { SubscriptionLite } from '../_lib/stripe.js';
import { COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION } from '../_lib/compute/release-gate.js';

export const LIC_ID = /^sub_[A-Za-z0-9]{1,200}$/;
export const RENEWAL_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const pools = new Map<string, Promise<ComputeStore>>();
function renewalStore(url: string): Promise<ComputeStore> {
  let pool = pools.get(url);
  if (!pool) {
    pool = import('../_lib/compute/pg-store.js').then(({ PgStore }) => PgStore.connect(url));
    pools.set(url, pool);
    void pool.catch(() => pools.delete(url));
  }
  return pool;
}

export function makeRenew(deps: Deps & { computeStore?: () => ComputeStore | null; previewCompute?: boolean }): (req: Request) => Promise<Response> {
  return async (req) => {
    const env = requireEnv(deps.env, ["STRIPE_SECRET_KEY", "WALKIE_LICENSE_SIGNING_KEY"]);
    if (!env.ok) return env.response;
    const body = await readJsonObject(req);
    if ("response" in body) return body.response;
    const { lic_id: licId, renewal_token: token } = body.value;
    if (typeof licId !== "string" || !LIC_ID.test(licId)) return fail(400, "invalid_lic_id");
    if (typeof token !== "string" || !RENEWAL_TOKEN.test(token)) return fail(400, "invalid_renewal_token");
    const stripe = deps.stripe();
    try {
      const computeAvailable = COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION || deps.previewCompute === true;
      const store = computeAvailable ? deps.computeStore?.() ?? (deps.env.DATABASE_URL?.trim()
        ? await renewalStore(deps.env.DATABASE_URL.trim()) : null) : null;
      const check = async (sub: SubscriptionLite | null) => {
        if (!sub || !renewTokenMatches(token, sub.metadata[RENEW_HASH_META])) return fail(403, "invalid_renewal");
        const team = sub.metadata[TEAM_META];
        if (!team || !TEAM_ID.test(team)) return fail(403, "invalid_renewal");
        if (sub.status !== LICENSED_STATUS) return fail(402, "subscription_inactive");
        return json({ key: issueKey(payloadFor(sub, deps.env, deps.now(), team), deps.env) });
      };
      if (!store) return await check(await stripe.getSubscription(licId));
      return await store.tx(async t => {
        const initial = await stripe.getSubscription(licId);
        const team = initial?.metadata[TEAM_META];
        if (!team || !TEAM_ID.test(team)) return fail(403, 'invalid_renewal');
        await t.lockControl(`enrollment-chain:${team}`);
        const sub = await stripe.getSubscription(licId);
        if (sub?.metadata[TEAM_META] !== team) return fail(403, 'invalid_renewal');
        const enrollment = await t.enrollment(team);
        const latest = await t.control(`enrollment-chain:${team}`) as { chainId?: string } | undefined;
        const authority = sub.metadata[AUTHORITY_META];
        const chain = sub.metadata[AUTHORITY_CHAIN_META];
        if ((enrollment && enrollment.key !== authority) || (latest && latest.chainId !== chain) ||
            (authority && !enrollment && !latest) || (!authority && (enrollment || latest)) ||
            sub.metadata[RENEW_AUTHORITY_META] !== (authority ?? 'legacy') ||
            sub.metadata[RENEW_CHAIN_META] !== (chain ?? 'legacy'))
          return fail(403, 'invalid_renewal');
        return check(sub);
      });
    } catch (err) {
      if (err instanceof LicenseError) {
        logError("renew", { type: "license", code: err.code });
        return fail(500, "license_unavailable");
      }
      logError("renew", err);
      return fail(502, "stripe_unavailable");
    }
  };
}

export async function POST(req: Request): Promise<Response> {
  return makeRenew(defaultDeps())(req);
}
