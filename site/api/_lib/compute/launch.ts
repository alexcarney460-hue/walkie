import { LEASE_MS, TAG_HORIZON_MS } from './lease.js';
import { bounded, CALL_MS } from './budget.js';
import { tierOffered } from './catalog.js';
import type { ComputeDeps } from './deps.js';
import type { Rental, Tx, TxOptions } from './store.js';
import { newTickPass, onAccount, type TickPass } from './tick-pass.js';
import { assertFresh, firstHourFunds, launchEligible, launchFrozen, realRental } from './safety.js';
import { bill } from './billing.js';
import { userData } from './cloud-init.js';
import { CapacityError, rentalTags, TAG_PAID_UNTIL } from './driver.js';
import { bindInvite } from './ownership.js';
import { terminate } from './service.js';

/**
 * A provider capacity refusal (CapacityError: no machine exists) is retried with the same claim key and join code
 * after 1, 2, 4, 8 and 16 minutes: at most CAPACITY_MAX_ATTEMPTS creates. No create starts later than
 * CAPACITY_DEADLINE_MS after the first refusal, so the 1-hour join code still has time for the box to boot and join.
 * Past either bound the rental ends unbilled (failed / launch_failed) and its first-hour reservation is released.
 * While it waits it stays `starting` (it keeps its quota slot: the provider is full, so nothing behind it could start).
 */
export const CAPACITY_BACKOFF_MS = 60_000;
export const CAPACITY_MAX_ATTEMPTS = 6;
export const CAPACITY_DEADLINE_MS = 40 * 60_000;

/** States before a create was ever claimed that an off-sale tier closes outright (`starting` is the launch recheck's). */
const UNLAUNCHED = new Set<Rental['state']>(['queued', 'needs_code']);

/** Ends a rental that never had a machine: no charge (billing needs an instance) and, no longer active, no reservation. */
async function closeUnlaunched(t: Tx, r: Rental, now: number): Promise<void> {
  await t.updateRental(r.id, { state: 'failed', ended_at: now, end_reason: 'launch_failed', heartbeat_hash: null, needs_code_at: null,
    ...(r.safety ? { safety: { ...r.safety, claim: 'cancelled' as const, code: undefined, heartbeat_token: undefined, capacity_retry_at: undefined } } : {}) });
}

/**
 * Claim is committed before create; competing ticks cannot submit the same rental. `bounds` (the tick's): each of its
 * account-row waits is bounded, and a busy refusal is thrown to the tick, which leaves the launch for the next pass. A
 * machine created but not recorded because the row turned busy is adopted by the next reconcile (its tags name it).
 */
export async function launchPending(d: ComputeDeps, id: string, timeoutMs = CALL_MS, bounds?: TxOptions): Promise<void> {
  if (d.enabled === false) return;
  const claimed = await d.store.tx(async t => {
    const initial = await t.rental(id);
    if (!initial) return null;
    const a = await t.lockAccount(initial.account_id);
    const r = await t.rental(id);
    if (!r?.safety || r.state !== 'starting' || r.safety.claim !== 'pending') return null;
    // Rechecked immediately before the create (and on every tick while backing off): a tier taken off sale (quota 0)
    // or a capacity wait past its deadline ends the rental instead of creating a machine.
    if (!tierOffered(d.config, r.tier)) {
      await closeUnlaunched(t, r, d.now());
      d.log('launch_off_sale', { rental: r.id });
      return null;
    }
    if (r.safety.capacity_since !== undefined && d.now() - r.safety.capacity_since >= CAPACITY_DEADLINE_MS) {
      await closeUnlaunched(t, r, d.now());
      d.log('launch_capacity_exhausted', { rental: r.id, attempts: r.launch_attempts });
      return null;
    }
    if (r.safety.capacity_retry_at !== undefined && d.now() < r.safety.capacity_retry_at) return null; // backing off
    if (a && await launchFrozen(t, a.team_id)) return null;
    await assertFresh(d, t);
    // The first-hour rule holds at the create too (pre.17 review P3-1): a capacity retry up to CAPACITY_DEADLINE_MS later
    // must not start a machine on credit that expires within its first hour.
    const funds = await firstHourFunds(t, r.account_id, d.now(), r.id);
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
      safety: { ...r.safety, claim: 'claimed', claimed_at: d.now(), lease_until: d.now() + LEASE_MS, capacity_retry_at: undefined } };
    await t.updateRental(r.id, { started_at: next.started_at, launch_attempts: next.launch_attempts, safety: next.safety });
    return next;
  }, bounds);
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
  } catch (err) {
    const outcome = await d.store.tx(async t => {
      await t.lockAccount(r.account_id);
      const cur = await t.rental(r.id);
      if (!cur?.safety) return 'uncertain' as const;
      if (err instanceof CapacityError && cur.state === 'starting' && cur.safety.claim === 'claimed' && !cur.instance_id)
        return capacityRefused(d, t, cur);
      // A timed-out create may have succeeded. Never issue a second create for this claim.
      await t.updateRental(r.id, { safety: { ...cur.safety,
        claim: cur.safety.claim === 'cancelled' ? 'cancelled' : 'uncertain', code: undefined, heartbeat_token: undefined } });
      return 'uncertain' as const;
    }, bounds);
    if (outcome === 'uncertain') d.log('launch_uncertain', { rental: r.id });
    else {
      // One operator alert per rental: the private quota is above what the provider grants.
      if (outcome.first) d.log('alert_provider_unavailable', { provider: claim.provider, rental: r.id });
      d.log(outcome.ended ? 'launch_capacity_exhausted' : 'launch_capacity_retry', { rental: r.id, attempts: outcome.attempts });
    }
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
  }, bounds);
  if (cancelled) await terminate(d, cancelled);
}

/**
 * Inside the account lock, for a claimed create the provider refused for capacity: schedule the next try (the claim
 * goes back to pending with its code, started_at cleared so nothing bills or times out), or end the rental unbilled
 * once CAPACITY_MAX_ATTEMPTS creates or CAPACITY_DEADLINE_MS are used up.
 */
async function capacityRefused(d: ComputeDeps, t: Tx, cur: Rental): Promise<{ first: boolean; ended: boolean; attempts: number }> {
  const now = d.now();
  const first = cur.safety!.capacity_since === undefined;
  const since = cur.safety!.capacity_since ?? now;
  const attempts = cur.launch_attempts;
  if (attempts >= CAPACITY_MAX_ATTEMPTS || now - since >= CAPACITY_DEADLINE_MS) {
    await closeUnlaunched(t, cur, now);
    return { first, ended: true, attempts };
  }
  await t.updateRental(cur.id, { started_at: null, safety: { ...cur.safety!, claim: 'pending', claimed_at: undefined, lease_until: undefined,
    capacity_since: since, capacity_retry_at: now + CAPACITY_BACKOFF_MS * 2 ** Math.max(0, attempts - 1) } });
  return { first, ended: false, attempts };
}

/**
 * Ends every queued or needs_code rental whose tier is off sale (its quota group was set to 0 after it was accepted):
 * unbilled, reservation released. Rentals already `starting` are closed by launchPending's recheck instead. The minute
 * tick must call this once per pass (lanes/D-FINAL.md, needs from lane A); returns how many it closed.
 */
export async function settleOffSale(d: ComputeDeps, pass: TickPass = newTickPass(CALL_MS)): Promise<number> {
  const due = (await d.store.tx(t => t.activeRentals())).filter(r => UNLAUNCHED.has(r.state) && !tierOffered(d.config, r.tier));
  let closed = 0;
  for (const r of due) {
    closed += await onAccount(d, pass, r.account_id, bounds => d.store.tx(async t => {
      await t.lockAccount(r.account_id);
      const cur = await t.rental(r.id);
      if (!cur || !UNLAUNCHED.has(cur.state) || tierOffered(d.config, cur.tier)) return 0;
      await closeUnlaunched(t, cur, d.now());
      d.log('launch_off_sale', { rental: cur.id });
      return 1;
    }, bounds)) ?? 0;
  }
  return closed;
}
