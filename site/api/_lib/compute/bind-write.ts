import { AUTHORITY_CHAIN_META, AUTHORITY_META, RENEW_HASH_META, TEAM_META } from '../metadata.js';
import type { StripeLike } from '../stripe.js';
import type { BindClaim } from './store.js';
import { ComputeError } from './service.js';

type BindStripe = Pick<StripeLike, 'setSubscriptionMetadata' | 'getSubscription'>;

/** Resolve the original write before trusting any read or deleting its recovery claim. */
export async function replayBindWrite(stripe: BindStripe, id: string, claim: BindClaim) {
  const write = claim.write;
  if (!write || !/^walkie-db-bind-v2-[0-9a-f]{32}$/.test(write.key) ||
      !write.metadata || typeof write.metadata !== 'object' || Array.isArray(write.metadata) ||
      write.metadata[TEAM_META] !== claim.team || write.metadata[RENEW_HASH_META] !== claim.hash ||
      write.metadata[AUTHORITY_META] !== claim.authority ||
      write.metadata[AUTHORITY_CHAIN_META] !== claim.chain ||
      Object.values(write.metadata).some(value => typeof value !== 'string'))
    throw new ComputeError(503, 'bind_claim_unavailable');
  await stripe.setSubscriptionMetadata(id, { ...write.metadata },
    { idempotencyKey: write.key, timeout: 3_000, maxNetworkRetries: 0 });
  return stripe.getSubscription(id);
}
