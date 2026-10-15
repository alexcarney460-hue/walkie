import { bounded, TICK_BUDGET, type TickBudget } from './budget.js';
import { retryAlerts } from './alert-retry.js';
import { enqueueCleanup, drainCleanup, hasCleanup } from './cleanup.js';
import { expireLeases, renewLease, TAG_HORIZON_MS, TAG_RENEW_MS } from './lease.js';
import { checkProviderSpend } from "./spend.js";
// The minute tick (Vercel cron → /api/compute/tick; docs/plans/RENT-1.md §5.3, §6.4). Idempotent: running it twice,
// late, or after a crash neither loses nor double-charges a minute, and every decision is re-derived from stored
// state. One pass:
//   1. per account: bill every burning machine to now; write off credit lots expired by now (lots.ts); stop everything
//      when the account is frozen or its usable credit is at or below $0; stop single machines on boot timeout, lost heartbeat, idle, the mining heuristic or the egress
//      cap; send a needs_code rental whose code never came back to the queue;
//   2. terminate every rental left `stopping` (this tick's and earlier failures);
//   3. start queued machines, oldest first, as quota frees (→ needs_code: the owner's daemon sends a fresh code);
//   4. reconcile: terminate any instance a driver holds that no live rental owns (an orphan).
// After the billing pass (and in an idle drain too) a bounded sweep writes off expired lots of accounts with nothing
// active. Before reconcile (and in an idle drain too) it retries freezes Stripe could not resolve when delivered (credit.ts
// holds), so a fraud warning, dispute or refund is applied after Stripe stops redelivering it, and raises again the
// confirmed alerts not delivered yet (alert-retry.ts). An idle drain also reconciles once any rental was ever made on a
// provider, so a stray machine is found and deleted while compute is drained.
import { eligible, firstHourFunds, launchEligible, launchFrozen, realRental } from "./safety.js";
import { launchPending, settleOffSale } from "./launch.js";
import { MIN_HOURS_COVERED } from "./catalog.js";
import { bill, capacity, capLapsedLease, noteOperatorFunded, reconcileDeletion } from "./billing.js";
import { applyCreditEvent, FreezeUnresolved, type StripeEvent } from "./credit.js";
import type { ComputeDeps } from "./deps.js";
import { TAG_RENTAL, TAG_ACCOUNT, TAG_TEAM } from "./driver.js";
import { MINUTE_MS } from "./money.js";
import { readCredit, settleExpiries, usable } from "./lots.js";
import { endUncovered, sweepExpiries } from "./expiry-tick.js";
import { newTickPass, noteBusy, onAccount, type TickPass } from "./tick-pass.js";
import { markStopped } from "./service.js";
import { finishHandover, remindHandover } from './handover.js';
import { isBusy, type FreezeHoldRow, type Rental, type TxOptions } from "./store.js";
import type { StopReason } from "./types.js";

export const BOOT_TIMEOUT_MS = 15 * MINUTE_MS;
export const HEARTBEAT_LOST_MS = 15 * MINUTE_MS;
export const MINING_MS = 10 * MINUTE_MS;
/** A rental in needs_code this long without a code goes back to the queue (its quota is released). */
export const CODE_WAIT_MS = 15 * MINUTE_MS;
/** A `starting` rental with no instance this long after the decision was never sent to the provider. */
export const STUCK_LAUNCH_MS = 2 * MINUTE_MS;
const GB = 1_000_000_000;
/** Stripe charge reads per tick for held freezes: each is bounded by budget.call, and the whole sweep by one more. */
export const FREEZE_SWEEP_MAX = 5;
const SWEPT_EVENTS: ReadonlySet<string> = new Set(["charge.dispute.created", "charge.refunded", "radar.early_fraud_warning.created"]);

export interface TickReport {
  readonly accounts: number;
  readonly stopped: Readonly<Record<string, number>>;
  readonly terminated: number;
  readonly dequeued: number;
  readonly orphans: number;
}

/** Why one running machine should stop now, if it should. */
export function stopReason(r: Rental, now: number, egressCapGb: number): StopReason | null {
  if (r.state === "starting" && r.started_at !== null && r.last_heartbeat_at === null && now - r.started_at >= BOOT_TIMEOUT_MS) return "boot_timeout";
  if (r.state !== "running") return null;
  if (r.gpu_hot_since !== null && now - r.gpu_hot_since >= MINING_MS) return "mining";
  if (r.egress_bytes >= egressCapGb * GB) return "egress_cap";
  if (r.last_heartbeat_at !== null && now - r.last_heartbeat_at >= HEARTBEAT_LOST_MS) return "heartbeat_lost";
  const busyAt = r.last_busy_at ?? r.last_heartbeat_at ?? r.started_at ?? now;
  if (now - busyAt >= r.idle_minutes * MINUTE_MS) return "idle";
  return null;
}

async function tickAccount(d: ComputeDeps, accountId: string, stopped: Map<string, number>, bounds: TxOptions): Promise<void> {
  const now = d.now();
  await d.store.tx(async (t) => {
    const a = await t.lockAccount(accountId);
    if (!a) return;
    const rentals: Rental[] = [];
    for (const r of await t.rentals(a.id, 0)) rentals.push(await bill(t, r, now));
    // Credit lots expired by now are written off after every machine was billed up to their expiry (lots.ts).
    const expired = await settleExpiries(t, a.id, now);
    if (expired) d.log('credit_expired', { account: a.id, micros: expired });
    const credit = await readCredit(t, a.id);
    const paid = usable(credit.paid, now), balance = paid + usable(credit.other, now);
    const count = (reason: StopReason, n: number) => { if (n) stopped.set(reason, (stopped.get(reason) ?? 0) + n); };
    const all: StopReason | null = a.status === "frozen" ? "frozen" : balance <= 0 ? "no_credit" : null;
    if (all) {
      const live = rentals.filter((r) => r.state !== "stopping");
      await markStopped(t, live, all, now);
      count(all, live.length);
      if (live.length) d.log("stop_all", { account: a.id, reason: all, rentals: live.length });
      return;
    }
    // Every pass, whatever wrote the expiry off: no waiting rental keeps a first hour no lasting credit backs.
    const ended = await endUncovered(t, rentals, credit, now);
    count('no_credit', ended.size);
    for (const r of rentals) {
      if (ended.has(r.id)) continue;
      if (realRental(r) && (paid <= 0 || a.classification !== "customer" || !(await eligible(d, t, a)))) {
        await markStopped(t, [r], 'no_credit', now);
        count('no_credit', 1);
        continue;
      }
      if (!(await renewLease(t, r, now))) {
        await markStopped(t, [r], 'no_credit', now);
        count('no_credit', 1);
        continue;
      }
      const reason = stopReason(r, now, d.config.egress_cap_gb);
      if (reason) {
        await markStopped(t, [r], reason, now);
        count(reason, 1);
        d.log("stop", { account: a.id, rental: r.id, reason });
        if (reason === "mining") await t.setAccount(a.id, { review: "mining" });
      } else if (r.state === "needs_code" && r.needs_code_at !== null && now - r.needs_code_at >= CODE_WAIT_MS) {
        await t.updateRental(r.id, { state: "queued", needs_code_at: null });
      }
    }
  }, bounds);
}

/** Provider-tag I/O has its own bounded budget. Oldest deadlines lead; failed rows remain due. */
async function syncPaidTags(d: ComputeDeps, deadline: number, callMs: number, pass: TickPass): Promise<void> {
  // A busy account's tags wait for the next pass (tick-pass.ts): a tag lasts TAG_HORIZON_MS, renewed from TAG_RENEW_MS.
  const rows = (await d.store.tx(t => t.activeRentals())).filter(r => !pass.busy.has(r.account_id) && realRental(r) && r.instance_id &&
    r.safety?.lease_until && ['starting', 'running'].includes(r.state) &&
    (r.safety.tag_paid_until ?? 0) - d.now() < TAG_RENEW_MS && (r.safety.tag_retry_at ?? 0) <= d.now())
    .sort((a, b) => (a.safety?.tag_paid_until ?? 0) - (b.safety?.tag_paid_until ?? 0));
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < rows.length && Date.now() < deadline) {
      const r = rows[cursor++]!;
      try {
        const driver = d.driver(r.safety!.provider);
        if (!driver) throw new Error('provider unavailable');
        const until = d.now() + TAG_HORIZON_MS;
        await bounded(signal => driver.setPaidUntil(r.instance_id!, until, signal),
          Math.min(callMs, deadline - Date.now()));
        // The safety record carries money fields (unpaid_micros): write it under the account lock billing holds. A busy
        // row leaves the new deadline unrecorded: the next pass sets the tag again (idempotent).
        await onAccount(d, pass, r.account_id, bounds => d.store.tx(async t => {
          await t.lockAccount(r.account_id);
          const current = await t.rental(r.id);
          if (current?.safety && current.instance_id === r.instance_id)
            await t.updateRental(r.id, { safety: { ...current.safety, tag_paid_until: until, tag_retry_at: 0,
              alert: current.safety.alert === 'tag_expiry_risk' ? undefined : current.safety.alert } });
        }, bounds));
      } catch {
        await onAccount(d, pass, r.account_id, bounds => d.store.tx(async t => {
          await t.lockAccount(r.account_id);
          const current = await t.rental(r.id);
          if (current?.safety && current.instance_id === r.instance_id)
            await t.updateRental(r.id, { safety: { ...current.safety, tag_retry_at: d.now() + 5 * MINUTE_MS } });
        }, bounds));
        d.log('alert_provider_unavailable', { provider: r.safety!.provider, rental: r.id });
      }
    }
  }));
  for (const r of await d.store.tx(t => t.activeRentals())) {
    if (!realRental(r) || !r.instance_id || !['starting', 'running'].includes(r.state) ||
        !r.safety?.tag_paid_until || r.safety.tag_paid_until - d.now() > 15 * MINUTE_MS ||
        r.safety.alert === 'tag_expiry_risk') continue;
    await onAccount(d, pass, r.account_id, bounds => d.store.tx(async t => {
      await t.lockAccount(r.account_id);
      const current = await t.rental(r.id);
      if (current?.safety && current.instance_id === r.instance_id && current.safety.tag_paid_until === r.safety?.tag_paid_until)
        await t.updateRental(r.id, { safety: { ...current.safety, alert: 'tag_expiry_risk' } });
    }, bounds));
    d.log('alert_tag_expiry_risk', { rental: r.id, provider: r.safety.provider });
  }
}

/**
 * Queued → needs_code, oldest first, for each account whose credit still covers the machine's first hour. A busy
 * account (tick-pass.ts) waits for the next pass, and its queued machines neither take nor hold a slot in the others'
 * passes meanwhile: a held row cannot stall the queue of its quota group (pre.17c review).
 */
async function dequeue(d: ComputeDeps, pass: TickPass): Promise<number> {
  const accounts = await d.store.tx(async (t) => [...new Set((await t.activeRentals()).filter((r) => r.state === "queued").map((r) => r.account_id))]);
  let moved = 0;
  for (const accountId of accounts) {
    moved += await onAccount(d, pass, accountId, bounds => d.store.tx(async (t) => {
      const a = await t.lockAccount(accountId);
      if (!a || a.status !== "active" || a.review || await launchFrozen(t, a.team_id)) return 0;
      await t.lockCapacity();
      const active = await t.activeRentals();
      const cap = capacity(active, d.config);
      // Anything older in the same quota group (any account) goes first: FIFO per group.
      const blocked = new Set<string>();
      // Each candidate excludes its own persisted reservation, but includes every other rental.
      let n = 0;
      for (const r of active) {
        if (r.state !== "queued") continue;
        const group = d.config.tiers[r.tier].quota_group;
        if (blocked.has(group) || pass.busy.has(r.account_id)) continue;
        if (r.account_id !== a.id) { if (!cap.take(r.tier)) blocked.add(group); continue; }
        const first = r.price_per_hour_micros * MIN_HOURS_COVERED;
        const real = realRental(r);
        const { total: balance, paid } = await firstHourFunds(t, a.id, d.now(), r.id);
        if ((real && (a.classification !== "customer" || !(await launchEligible(d, t, a)))) || balance < first || (real && paid < first) || !cap.take(r.tier)) { blocked.add(group); continue; }

        await t.updateRental(r.id, { state: "needs_code", needs_code_at: d.now() });
        n++;
      }
      return n;
    }, bounds)) ?? 0;
  }
  return moved;
}

/** Terminates every instance a configured driver holds whose rental isn't live or doesn't own it. */
async function reconcile(d: ComputeDeps, deadline: number, callMs: number, pass: TickPass): Promise<number> {
  const recorded = await d.store.tx(t => t.control('providers')) as string[] | undefined;
  const providers = new Set([...Object.values(d.config.tiers).map(x => x.provider), ...(recorded ?? [])]);
  let n = 0;
  for (const p of providers) {
    if (Date.now() >= deadline) break;
    const driver = d.driver(p);
    if (!driver) { d.log('alert_provider_unavailable', { provider: p }); continue; }
    // Provider snapshot FIRST; re-read each claim after listing to avoid racing admission.
    let instances;
    try { instances = await bounded(signal => driver.list(signal), Math.min(callMs, deadline - Date.now())); }
    catch { d.log('alert_provider_unavailable', { provider: p }); continue; }
    for (const inst of instances) {
      if (Date.now() >= deadline) break;
      const rid = inst.tags[TAG_RENTAL] ?? '';
      const r = await d.store.tx(t => t.rental(rid));
      if (r?.safety?.provider === p && (r.instance_id === inst.instance_id ||
          (inst.tags[TAG_ACCOUNT] === r.account_id && inst.tags[TAG_TEAM] === r.team_id &&
           inst.tags['walkie:claim'] === r.safety.key && inst.tags['walkie:provider'] === p))) {
        if (r.safety.claim === 'pending') continue;
        if (r.instance_id && r.instance_id !== inst.instance_id) {
          d.log('alert_duplicate_instance', { rental: r.id });
          await d.store.tx(t => enqueueCleanup(t, p, inst.instance_id));
          continue;
        }
        // A busy account is skipped (tick-pass.ts): its instance is looked at again on the next pass.
        const adopted = await onAccount(d, pass, r.account_id, bounds => d.store.tx(async t => {
          await t.lockAccount(r.account_id);
          const cur = await t.rental(r.id);
          if (!cur?.safety) return null;
          if (cur.state === 'ended' || cur.state === 'failed' || (cur.instance_id && cur.instance_id !== inst.instance_id)) {
            await enqueueCleanup(t, p, inst.instance_id);
            return null;
          }
          const cancelled = cur.safety.claim === 'cancelled';
          const next: Rental = { ...cur, instance_id: inst.instance_id, state: cancelled ? 'stopping' : cur.state,
            safety: { ...cur.safety, claim: cancelled ? 'cancelled' : 'confirmed', code: undefined, heartbeat_token: undefined } };
          await t.updateRental(cur.id, { instance_id: inst.instance_id, state: next.state, safety: next.safety });
          return next;
        }, bounds));
        if (adopted?.state === 'stopping') await d.store.tx(t => enqueueCleanup(t, p, inst.instance_id, adopted.id));
        continue;
      }
      d.log('orphan_found', { instance: inst.instance_id, provider: p });
      const old = await d.store.tx(async t => {
        const key = `orphan:${p}:${inst.instance_id}`;
        await t.lockControl(key);
        const first = await t.control(key);
        if (typeof first !== 'number') { await t.setControl(key, d.now()); return false; }
        return d.now() - first >= STUCK_LAUNCH_MS;
      });
      if (!old) continue;
      await d.store.tx(t => enqueueCleanup(t, p, inst.instance_id));
      n++;
    }
    // No resource observed after the grace window: close uncertain claims, never create again.
    const outstanding = await d.store.tx(t => t.activeRentals());
    for (const r of outstanding) {
      if (r.safety?.provider === p && r.instance_id && r.safety.claim === 'confirmed' &&
          r.started_at !== null && d.now() - r.started_at >= STUCK_LAUNCH_MS &&
          !instances.some(i => i.instance_id === r.instance_id)) {
        // A listing can omit a live droplet; only the provider's definite "not found" for that id ends the rental.
        if (Date.now() >= deadline) break;
        let gone = false;
        try { gone = await bounded(signal => driver.instanceGone(r.instance_id!, signal), Math.min(callMs, deadline - Date.now())); }
        catch { gone = false; }
        if (!gone) {
          d.log('alert_provider_unavailable', { provider: p, rental: r.id });
          continue;
        }
        const closed = await onAccount(d, pass, r.account_id, bounds => d.store.tx(async t => {
          await t.lockAccount(r.account_id);
          const current = await t.rental(r.id);
          if (current && ['starting', 'running'].includes(current.state) && current.instance_id === r.instance_id)
            await t.updateRental(r.id, { state: 'ended', ended_at: d.now(), end_reason: 'launch_failed', heartbeat_hash: null });
          return true;
        }, bounds));
        if (closed) d.log('alert_instance_vanished', { rental: r.id, provider: p });
        continue;
      }
      if (r.safety?.provider !== p || !r.safety.claimed_at || r.instance_id ||
          d.now() - r.safety.claimed_at < STUCK_LAUNCH_MS || instances.some(i => i.tags[TAG_RENTAL] === r.id)) continue;
      await onAccount(d, pass, r.account_id, bounds => d.store.tx(async t => {
        await t.lockAccount(r.account_id);
        const cur = await t.rental(r.id);
        if (!cur?.safety || cur.instance_id) return;
        await t.updateRental(cur.id, { state: 'failed', ended_at: d.now(), end_reason: 'launch_failed', heartbeat_hash: null,
          safety: { ...cur.safety, claim: 'cancelled', code: undefined, heartbeat_token: undefined } });
      }, bounds));
    }
  }
  return n;
}

/**
 * Retries freezes Stripe could not resolve when they were delivered (credit.ts: compute-freeze-hold:<charge>, state
 * pending), oldest attempt first, through credit.ts's own freeze path. The event is rebuilt without payment_intent, so
 * freeze() reads the charge again: once Stripe answers, the account is frozen (the next tick stops its machines) and the
 * hold ends `resolved` exactly as a redelivery leaves it; while it cannot, the hold stays pending with attempts and
 * updated_at bumped (and credit.ts's own alert, deduplicated per charge). Without a compute Stripe key there is nothing
 * to ask: no store read and no log.
 */
async function sweepFreezeHolds(d: ComputeDeps, deadline: number, callMs: number): Promise<void> {
  const charges = d.charges;
  if (!charges?.paymentIntentOfCharge || Date.now() >= deadline) return;
  let holds: readonly FreezeHoldRow[];
  // A failure here must not cost the rest of the tick (reconcile, launches): logged, and Stripe's redelivery still retries.
  try { holds = await d.store.tx(t => t.pendingFreezeHolds(FREEZE_SWEEP_MAX)); }
  catch { d.log("freeze_retry_failed", { reason: "error" }); return; }
  for (const { key, value } of holds) {
    if (Date.now() >= deadline) break;
    const { charge, event, event_id: eventId, livemode } = value as { charge?: unknown; event?: unknown; event_id?: unknown; livemode?: unknown };
    if (typeof charge !== "string" || typeof event !== "string" || !SWEPT_EVENTS.has(event)) continue;
    const ev: StripeEvent = { id: typeof eventId === "string" ? eventId : `sweep_${charge}`, type: event, livemode: livemode === true,
      data: { object: event === "charge.refunded" ? { id: charge } : { charge } } };
    try {
      // A Stripe redelivery may have resolved it since the listing: a freeze that is no longer pending is not applied again.
      const current = await d.store.tx(t => t.control(key)) as { state?: unknown } | null | undefined;
      if (current?.state !== "pending") continue;
      await bounded(() => applyCreditEvent(d, ev, charges), Math.min(callMs, deadline - Date.now()));
    } catch (err) {
      // FreezeUnresolved: credit.ts bumped the hold and alerted. Otherwise the hold is unchanged and first in line next tick.
      if (!(err instanceof FreezeUnresolved))
        d.log("freeze_retry_failed", { charge, reason: err instanceof Error && err.message === "compute_deadline" ? "deadline" : "error" });
    }
  }
}

export const EMPTY_REPORT: TickReport = { accounts: 0, stopped: {}, terminated: 0, dequeued: 0, orphans: 0 };
async function applyWatchdogDeletions(d: ComputeDeps, pass: TickPass): Promise<void> {
  const stored = await d.store.tx(t => t.control('watchdog_deletions'));
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
  const deleted = stored as Record<string, unknown>;
  for (const r of await d.store.tx(t => t.activeRentals())) {
    const at = r.instance_id ? deleted[r.instance_id] : undefined;
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || (r.started_at !== null && at < r.started_at) ||
        !['starting', 'running', 'stopping'].includes(r.state)) continue;
    // A busy account's deletions are applied on the next pass that gets its row (tick-pass.ts).
    await onAccount(d, pass, r.account_id, bounds => d.store.tx(async t => {
      await t.lockAccount(r.account_id);
      const current = await t.rental(r.id);
      if (!current || current.instance_id !== r.instance_id || !['starting', 'running', 'stopping'].includes(current.state)) return;
      const endedAt = Math.min(d.now(), at);
      const billed = await bill(t, capLapsedLease(current, endedAt), endedAt);
      const settled = await reconcileDeletion(t, billed, endedAt, d.now());
      await t.updateRental(r.id, { state: 'ended', ended_at: endedAt, end_reason: 'watchdog_expired', heartbeat_hash: null });
      noteOperatorFunded(d.log, settled, d.config.tiers[settled.tier]?.cost_per_hour_micros);
    }, bounds));
  }
}

/** Day-and-episode claim: a watchdog that never reported, or one stale since the same heartbeat, alerts once per UTC day. */
async function alertWatchdogStale(d: ComputeDeps, last: number | null): Promise<void> {
  const day = Math.floor(d.now() / 86_400_000) * 86_400_000;
  const due = await d.store.tx(async t => {
    await t.lockControl('watchdog_stale_alert');
    const previous = await t.control('watchdog_stale_alert') as { day?: unknown; last?: unknown } | undefined;
    if (previous?.day === day && previous.last === last) return false;
    await t.setControl('watchdog_stale_alert', { day, last });
    return true;
  });
  if (due) d.log('alert_watchdog_stale', { last_tick_at: last, day });
}
export async function tick(d: ComputeDeps, budget: TickBudget = TICK_BUDGET): Promise<TickReport> {
  const deadline = Date.now() + budget.total;
  // Every account-row pass below runs bounded, and an account found busy waits alone (tick-pass.ts): one held account
  // row costs the tick at most one bounded wait, not its deadline, and never another team's work or the health record.
  const pass = newTickPass(budget.call);
  const handovers = await d.store.tx(t => t.control('compute-handover-teams')) as string[] | undefined;
  for (const team of handovers ?? []) {
    if (Date.now() >= deadline) break;
    try {
      await d.store.tx(async t => {
        await finishHandover(d, t, team);
        await remindHandover(d, t, team);
      }, pass.bounds);
    } catch (err) {
      // A team whose accounts are busy finishes its handover on a later pass (the 24-72 h window allows it).
      if (!isBusy(err)) throw err;
      d.log('compute_handover_busy', { team });
    }
  }
  const active = await d.store.tx(t => t.activeRentals());
  if (d.enabled === false && active.length === 0 && !(await hasCleanup(d))) {
    // Idle drain: nothing to meter or delete, but the tick ran, so record its health (no false tick_stale).
    await d.store.tx(t => t.setControl('last_tick', d.now()));
    // Credit expiry is money bookkeeping, not a launch: it runs while drained too.
    await sweepExpiries(d, Math.min(deadline, Date.now() + budget.call), pass);
    // Freezes are a safety path: retried while drained too, so a later credit or a re-enable finds the account frozen.
    await sweepFreezeHolds(d, Math.min(deadline, Date.now() + budget.call), budget.call);
    await retryAlerts(d);
    // A provider we rented on may still hold a stray machine (an uncertain create that surfaced late): find it and
    // delete it. Never before the first rental, so a drained site that never rented makes no provider call.
    const recorded = await d.store.tx(t => t.control('providers')) as string[] | undefined;
    if (!recorded?.length) return EMPTY_REPORT;
    const orphans = await reconcile(d, deadline, budget.call, pass);
    const terminated = await drainCleanup(d, deadline, pass);
    return { ...EMPTY_REPORT, orphans, terminated };
  }
  const heartbeat = await d.store.tx(t => t.control('last_watchdog_heartbeat'));
  if (typeof heartbeat !== 'number' || d.now() - heartbeat > 20 * MINUTE_MS)
    await alertWatchdogStale(d, typeof heartbeat === 'number' ? heartbeat : null);
  await applyWatchdogDeletions(d, pass);
  await expireLeases(d, pass);
  // Requested/expired stops get the first provider slots, before metering or launches.
  let terminated = await drainCleanup(d, Math.min(deadline, Date.now() + budget.cleanup), pass);
  const previousTick = await d.store.tx(t => t.control('last_tick'));
  const fresh = typeof previousTick === 'number' && d.now() - previousTick <= 180_000;
  if (!fresh) d.log('alert_tick_stale', { last_tick_at: typeof previousTick === 'number' ? previousTick : null });
  const accounts = [...new Set(active.map(r => r.account_id))];
  const stopped = new Map<string, number>();
  const cursor = await d.store.tx(t => t.control('billing_cursor'));
  const split = typeof cursor === 'string' ? accounts.indexOf(cursor) + 1 : 0;
  const ordered = [...accounts.slice(split), ...accounts.slice(0, split)];
  const billed = new Set<string>();
  let visited = 0;
  for (const id of ordered) {
    if (Date.now() >= deadline - budget.call) break;
    // A busy account (its row held past the bound, here or in an earlier pass of this tick) waits alone (pre.17 review
    // P2-1): it is not billed this pass and its own dequeue and launches wait, while the tick's health and every other
    // account's work go on. Its minutes are metered from their count on the next pass, and a run of busy passes raises
    // account_busy (noteBusy).
    if (await onAccount(d, pass, id, async bounds => { await tickAccount(d, id, stopped, bounds); return true; })) billed.add(id);
    await d.store.tx(t => t.setControl('billing_cursor', id));
    visited++;
  }
  await noteBusy(d, pass, accounts, billed);
  // Every account was visited: billed, or busy and left to wait alone. Otherwise the deadline cut the pass short.
  const complete = visited === accounts.length;
  // Two or more active accounts and every one of them busy: only a site-wide lock does that (one customer's traffic
  // holds only its own rows), so the tick is not healthy and tick_stale follows. One active account that is busy waits
  // alone like any other, or its own traffic could stall every team's rents (pre.17c review P3-1).
  const allBusy = accounts.length >= 2 && billed.size === 0 && accounts.every(id => pass.busy.has(id));
  const healthy = complete && !allBusy;
  // Expired lots the billing pass did not settle (accounts with nothing active, or an expiry reached after an account's
  // billing pass), within one call budget.
  await sweepExpiries(d, Math.min(deadline - budget.call, Date.now() + budget.call), pass);
  if (Date.now() < deadline) await syncPaidTags(d, Math.min(deadline, Date.now() + budget.call), budget.call, pass);
  terminated += await drainCleanup(d, Math.min(deadline, Date.now() + budget.cleanup), pass);
  // Record health after the safety pass even if optional reconciliation consumes the remaining budget.
  if (healthy) await d.store.tx(t => t.setControl('last_tick', d.now()));
  // Held freezes get one call budget after the safety pass and the health record, ahead of the optional reconcile.
  await sweepFreezeHolds(d, Math.min(deadline, Date.now() + budget.call), budget.call);
  await retryAlerts(d);
  const orphans = await reconcile(d, deadline, budget.call, pass);
  terminated += await drainCleanup(d, deadline, pass);
  // Queued work of a tier taken off sale ends unbilled and frees its first hour (in drain too) before anything is dequeued.
  if (Date.now() < deadline) await settleOffSale(d, pass);
  const backlog = !complete;
  const dequeued = !backlog && d.enabled !== false && Date.now() < deadline ? await dequeue(d, pass) : 0;
  const pending = await d.store.tx(t => t.activeRentals());
  for (const r of pending) {
    if (Date.now() >= deadline || backlog) break;
    if (pass.busy.has(r.account_id)) continue; // its row is held: this launch waits for the next pass
    if (fresh && d.enabled !== false && r.state === 'starting' && r.safety?.claim === 'pending' &&
        !(await d.store.tx(t => launchFrozen(t, r.team_id))))
      await onAccount(d, pass, r.account_id, bounds => launchPending(d, r.id, Math.min(budget.call, deadline - Date.now()), bounds));
  }
  if (Date.now() < deadline) {
    try { await checkProviderSpend(d); } catch { d.log('config_invalid', {}); }
  }
  if (!fresh && healthy) d.log('alert_tick_recovered', {});
  return { accounts: accounts.length, stopped: Object.fromEntries(stopped), terminated, dequeued, orphans };
}
