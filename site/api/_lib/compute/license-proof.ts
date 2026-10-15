import type { StripeLike } from '../stripe.js';
import { AUTHORITY_META, legacyRenewal, RENEW_HASH_META, TEAM_META, renewTokenMatches } from '../metadata.js';

/** A subscription in one of these states is over: it no longer binds or admits anyone. */
export const ENDED_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);
/** Upper bound on each licence read during account creation, with no SDK retries (10 s function limit). */
export const LICENCE_READ_MS = 3_000;

/**
 * A bound subscription proves team ownership; paid compute credit remains a separate admission gate.
 * A licence bound without any authority (the released compute-locked binds) counts for its team: the claim only
 * labels the enrollment, and the signed roster proof still decides who owns the team (lane C, O P1-3).
 * Any status but an ended one counts (lane C round 10): a licence whose card is retrying still proves its holder.
 */
export function licenseVerifier(stripe: Pick<StripeLike, 'getSubscription'>) {
  return async (team: string, license: string, token: string, authority?: string): Promise<boolean> => {
    const sub = await stripe.getSubscription(license, { timeout: LICENCE_READ_MS, maxNetworkRetries: 0 });
    return !!sub && !ENDED_STATUSES.has(sub.status) && sub.metadata[TEAM_META] === team &&
      (sub.metadata[AUTHORITY_META] === authority || legacyRenewal(sub.metadata)) &&
      renewTokenMatches(token, sub.metadata[RENEW_HASH_META]);
  };
}
