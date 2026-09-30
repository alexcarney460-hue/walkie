import type { StripeLike } from '../stripe.js';
import { AUTHORITY_META, RENEW_HASH_META, TEAM_META, renewTokenMatches } from '../metadata.js';

/** A bound subscription proves team ownership; paid compute credit remains a separate admission gate. */
export function licenseVerifier(stripe: Pick<StripeLike, 'getSubscription'>) {
  return async (team: string, license: string, token: string, authority?: string): Promise<boolean> => {
    const sub = await stripe.getSubscription(license);
    return !!sub && sub.status === 'active' && sub.metadata[TEAM_META] === team &&
      sub.metadata[AUTHORITY_META] === authority && renewTokenMatches(token, sub.metadata[RENEW_HASH_META]);
  };
}
