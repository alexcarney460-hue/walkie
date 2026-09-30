import { LEASE_MS, TAG_HORIZON_MS } from './lease.js';
import { bounded, CALL_MS } from './budget.js';
import type { ComputeDeps } from './deps.js';
import type { Rental } from './store.js';
import { available, assertFresh, launchEligible, launchFrozen, realRental } from './safety.js';
import { bill } from './billing.js';
import { userData } from './cloud-init.js';
import { rentalTags, TAG_PAID_UNTIL } from './driver.js';
import { bindInvite } from './ownership.js';
import { terminate } from './service.js';

/** Claim is committed before create; competing ticks cannot submit the same rental. */
export async function launchPending(d: ComputeDeps, id: string, timeoutMs = CALL_MS): Promise<void> {
  if (d.enabled === false) return;
  const claimed = await d.store.tx(async t => {
    const initial = await t.rental(id);
    if (!initial) return null;
    const a = await t.lockAccount(initial.account_id);
    const r = await t.rental(id);
    if (!r?.safety || r.state !== 'starting' || r.safety.claim !== 'pending') return null;
    if (a && await launchFrozen(t, a.team_id)) return null;
    await assertFresh(d, t);
    const funds = await available(t, r.account_id, r.id);
    if (!a || a.status !== 'active' || a.review || (realRental(r) && (a.classification !== "customer" || !(await launchEligible(d, t, a)))) ||
        r.safety.reserved < r.price_per_hour_micros || funds.total < r.safety.reserved ||
        (realRental(r) && funds.paid < r.safety.reserved)) {
      await t.updateRental(r.id, { state: 'ended', ended_at: d.now(), end_reason: 'no_credit', heartbeat_hash: null,
        safety: { ...r.safety, claim: 'cancelled', code: undefined, heartbeat_token: undefined } });
      return null;
    }
    try { await bindInvite(t, a, r.safety.code ?? '', r.id, d.now()); }
    catch {
      await t.updateRental(r.id, { state: 'failed', ended_at: d.now(), end_reason: 'launch_failed', heartbeat_hash: null,
        safety: { ...r.safety, claim: 'cancelled', code: undefined, heartbeat_token: undefined } });
      return null;
    }
    const next: Rental = { ...r, started_at: d.now(), launch_attempts: r.launch_attempts + 1,
      safety: { ...r.safety, claim: 'claimed', claimed_at: d.now(), lease_until: d.now() + LEASE_MS } };
    await t.updateRental(r.id, { started_at: next.started_at, launch_attempts: next.launch_attempts, safety: next.safety });
    return next;
  });
  if (!claimed?.safety) return;
  const r = claimed, claim = claimed.safety;
  const driver = d.driver(claim.provider);
  const config = d.config.tiers[r.tier];
  let instance: string;
  try {
    if (!driver || config.provider !== claim.provider || !claim.code || !claim.heartbeat_token) throw new Error('launch_unavailable');
    const result = await bounded(signal => driver.provision({
      idempotency_key: claim.key, instance_type: config.instance_type, region: config.region, image: config.image,
      name: r.name, tags: { ...rentalTags(r.id, r.team_id, r.account_id), 'walkie:provider': claim.provider,
        'walkie:claim': claim.key, [TAG_PAID_UNTIL]: String(Math.floor((d.now() + TAG_HORIZON_MS) / 1000)) },
      user_data: userData({ rentalId: r.id, joinCode: claim.code!, heartbeatToken: claim.heartbeat_token!,
        walkieVersion: r.walkie_version, siteOrigin: d.siteOrigin, hostname: r.name, egressRateMbit: 1000, leaseUntil: claim.lease_until }),
    }, signal), timeoutMs);
    instance = result.instance_id;
  } catch {
    // A timed-out create may have succeeded. Never issue a second create for this claim.
    await d.store.tx(async t => {
      await t.lockAccount(r.account_id);
      const cur = await t.rental(r.id);
      if (cur?.safety) await t.updateRental(r.id, { safety: { ...cur.safety,
        claim: cur.safety.claim === 'cancelled' ? 'cancelled' : 'uncertain', code: undefined, heartbeat_token: undefined } });
    });
    d.log('launch_uncertain', { rental: r.id });
    return;
  }
  const cancelled = await d.store.tx(async t => {
    const a = await t.lockAccount(r.account_id);
    const cur = await t.rental(r.id);
    if (!cur?.safety) throw new Error('missing launch claim');
    const cancel = cur.state !== 'starting' || cur.safety.claim === 'cancelled' || a?.status !== 'active' || a.review ||
      (realRental(cur) && (a?.classification !== "customer" || !(await launchEligible(d, t, a))));
    const next: Rental = { ...cur, instance_id: instance, state: cancel ? 'stopping' : 'starting',
      safety: { ...cur.safety, tag_paid_until: d.now() + TAG_HORIZON_MS, claim: cancel ? 'cancelled' : 'confirmed', code: undefined, heartbeat_token: undefined } };
    await t.updateRental(r.id, { instance_id: instance, state: next.state, safety: next.safety });
    await bill(t, next, d.now());
    return cancel ? next : null;
  });
  if (cancelled) await terminate(d, cancelled);
}
