import { bounded, CALL_MS, TICK_MS } from './budget.js';
import { enqueueCleanup, drainCleanup, hasCleanup } from './cleanup.js';
import { expireLeases, renewLease, TAG_HORIZON_MS, TAG_RENEW_MS } from './lease.js';
import { checkProviderSpend } from "./spend.js";
// The minute tick (Vercel cron → /api/compute/tick; docs/plans/RENT-1.md §5.3, §6.4). Idempotent: running it twice,
// late, or after a crash neither loses nor double-charges a minute, and every decision is re-derived from stored
// state. One pass:
//   1. per account: bill every burning machine to now; stop everything when the account is frozen or its balance is
//      at or below $0; stop single machines on boot timeout, lost heartbeat, idle, the mining heuristic or the egress
//      cap; send a needs_code rental whose code never came back to the queue;
//   2. terminate every rental left `stopping` (this tick's and earlier failures);
//   3. start queued machines, oldest first, as quota frees (→ needs_code: the owner's daemon sends a fresh code);
//   4. reconcile: terminate any instance a driver holds that no live rental owns (an orphan).
import { available, eligible, launchEligible, launchFrozen, realRental } from "./safety.js";
import { launchPending } from "./launch.js";
import { MIN_HOURS_COVERED } from "./catalog.js";
import { bill, capacity, reconcileDeletion } from "./billing.js";
import type { ComputeDeps } from "./deps.js";
import { TAG_RENTAL, TAG_ACCOUNT, TAG_TEAM } from "./driver.js";
import { MINUTE_MS } from "./money.js";
import { markStopped } from "./service.js";
import { finishHandover, remindHandover } from './handover.js';
import type { Rental } from "./store.js";
import type { StopReason } from "./types.js";

export const BOOT_TIMEOUT_MS = 15 * MINUTE_MS;
export const HEARTBEAT_LOST_MS = 15 * MINUTE_MS;
export const MINING_MS = 10 * MINUTE_MS;
/** A rental in needs_code this long without a code goes back to the queue (its quota is released). */
export const CODE_WAIT_MS = 15 * MINUTE_MS;
/** A `starting` rental with no instance this long after the decision was never sent to the provider. */
export const STUCK_LAUNCH_MS = 2 * MINUTE_MS;
const GB = 1_000_000_000;

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

async function tickAccount(d: ComputeDeps, accountId: string, stopped: Map<string, number>): Promise<void> {
  const now = d.now();
  await d.store.tx(async (t) => {
    const a = await t.lockAccount(accountId);
    if (!a) return;
    const rentals: Rental[] = [];
    for (const r of await t.rentals(a.id, 0)) rentals.push(await bill(t, r, now));
    const balance = await t.balance(a.id);
    const paid = await t.paidBalance(a.id);
    const count = (reason: StopReason, n: number) => { if (n) stopped.set(reason, (stopped.get(reason) ?? 0) + n); };
    const all: StopReason | null = a.status === "frozen" ? "frozen" : balance <= 0 ? "no_credit" : null;
    if (all) {
      const live = rentals.filter((r) => r.state !== "stopping");
      await markStopped(t, live, all, now);
      count(all, live.length);
      if (live.length) d.log("stop_all", { account: a.id, reason: all, rentals: live.length });
      return;
    }
    for (const r of rentals) {
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
  });
}

/** Provider-tag I/O has its own bounded budget. Oldest deadlines lead; failed rows remain due. */
async function syncPaidTags(d: ComputeDeps, deadline: number): Promise<void> {
  const rows = (await d.store.tx(t => t.activeRentals())).filter(r => realRental(r) && r.instance_id &&
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
          Math.min(CALL_MS, deadline - Date.now()));
        await d.store.tx(async t => {
          const current = await t.rental(r.id);
          if (current?.safety && current.instance_id === r.instance_id)
            await t.updateRental(r.id, { safety: { ...current.safety, tag_paid_until: until, tag_retry_at: 0,
              alert: current.safety.alert === 'tag_expiry_risk' ? undefined : current.safety.alert } });
        });
      } catch {
        await d.store.tx(async t => {
          const current = await t.rental(r.id);
          if (current?.safety && current.instance_id === r.instance_id)
            await t.updateRental(r.id, { safety: { ...current.safety, tag_retry_at: d.now() + 5 * MINUTE_MS } });
        });
        d.log('alert_provider_unavailable', { provider: r.safety!.provider, rental: r.id });
      }
    }
  }));
  for (const r of await d.store.tx(t => t.activeRentals())) {
    if (!realRental(r) || !r.instance_id || !['starting', 'running'].includes(r.state) ||
        !r.safety?.tag_paid_until || r.safety.tag_paid_until - d.now() > 15 * MINUTE_MS ||
        r.safety.alert === 'tag_expiry_risk') continue;
    await d.store.tx(async t => {
      const current = await t.rental(r.id);
      if (current?.safety && current.instance_id === r.instance_id && current.safety.tag_paid_until === r.safety?.tag_paid_until)
        await t.updateRental(r.id, { safety: { ...current.safety, alert: 'tag_expiry_risk' } });
    });
    d.log('alert_tag_expiry_risk', { rental: r.id, provider: r.safety.provider });
  }
}

/** Queued → needs_code, oldest first, for each account whose credit still covers the machine's first hour. */
async function dequeue(d: ComputeDeps): Promise<number> {
  const accounts = await d.store.tx(async (t) => [...new Set((await t.activeRentals()).filter((r) => r.state === "queued").map((r) => r.account_id))]);
  let moved = 0;
  for (const accountId of accounts) {
    moved += await d.store.tx(async (t) => {
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
        if (blocked.has(group)) continue;
        if (r.account_id !== a.id) { if (!cap.take(r.tier)) blocked.add(group); continue; }
        const first = r.price_per_hour_micros * MIN_HOURS_COVERED;
        const real = realRental(r);
        const { total: balance, paid } = await available(t, a.id, r.id);
        if ((real && (a.classification !== "customer" || !(await launchEligible(d, t, a)))) || balance < first || (real && paid < first) || !cap.take(r.tier)) { blocked.add(group); continue; }

        await t.updateRental(r.id, { state: "needs_code", needs_code_at: d.now() });
        n++;
      }
      return n;
    });
  }
  return moved;
}

/** Terminates every instance a configured driver holds whose rental isn't live or doesn't own it. */
async function reconcile(d: ComputeDeps, deadline: number): Promise<number> {
  const recorded = await d.store.tx(t => t.control('providers')) as string[] | undefined;
  const providers = new Set([...Object.values(d.config.tiers).map(x => x.provider), ...(recorded ?? [])]);
  let n = 0;
  for (const p of providers) {
    if (Date.now() >= deadline) break;
    const driver = d.driver(p);
    if (!driver) { d.log('alert_provider_unavailable', { provider: p }); continue; }
    // Provider snapshot FIRST; re-read each claim after listing to avoid racing admission.
    let instances;
    try { instances = await bounded(signal => driver.list(signal), Math.min(CALL_MS, deadline - Date.now())); }
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
        const adopted = await d.store.tx(async t => {
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
        });
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
        await d.store.tx(async t => {
          await t.lockAccount(r.account_id);
          const current = await t.rental(r.id);
          if (current && ['starting', 'running'].includes(current.state) && current.instance_id === r.instance_id)
            await t.updateRental(r.id, { state: 'ended', ended_at: d.now(), end_reason: 'launch_failed', heartbeat_hash: null });
        });
        d.log('alert_instance_vanished', { rental: r.id, provider: p });
        continue;
      }
      if (r.safety?.provider !== p || !r.safety.claimed_at || r.instance_id ||
          d.now() - r.safety.claimed_at < STUCK_LAUNCH_MS || instances.some(i => i.tags[TAG_RENTAL] === r.id)) continue;
      await d.store.tx(async t => {
        await t.lockAccount(r.account_id);
        const cur = await t.rental(r.id);
        if (!cur?.safety || cur.instance_id) return;
        await t.updateRental(cur.id, { state: 'failed', ended_at: d.now(), end_reason: 'launch_failed', heartbeat_hash: null,
          safety: { ...cur.safety, claim: 'cancelled', code: undefined, heartbeat_token: undefined } });
      });
    }
  }
  return n;
}

export const EMPTY_REPORT: TickReport = { accounts: 0, stopped: {}, terminated: 0, dequeued: 0, orphans: 0 };
async function applyWatchdogDeletions(d: ComputeDeps): Promise<void> {
  const stored = await d.store.tx(t => t.control('watchdog_deletions'));
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
  const deleted = stored as Record<string, unknown>;
  for (const r of await d.store.tx(t => t.activeRentals())) {
    const at = r.instance_id ? deleted[r.instance_id] : undefined;
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || (r.started_at !== null && at < r.started_at) ||
        !['starting', 'running', 'stopping'].includes(r.state)) continue;
    await d.store.tx(async t => {
      await t.lockAccount(r.account_id);
      const current = await t.rental(r.id);
      if (!current || current.instance_id !== r.instance_id || !['starting', 'running', 'stopping'].includes(current.state)) return;
      const endedAt = Math.min(d.now(), at);
      const billed = await bill(t, current, endedAt);
      await reconcileDeletion(t, billed, endedAt);
      await t.updateRental(r.id, { state: 'ended', ended_at: endedAt, end_reason: 'watchdog_expired', heartbeat_hash: null });
    });
  }
}
export async function tick(d: ComputeDeps): Promise<TickReport> {
  const deadline = Date.now() + TICK_MS;
  const handovers = await d.store.tx(t => t.control('compute-handover-teams')) as string[] | undefined;
  for (const team of handovers ?? []) {
    if (Date.now() >= deadline) break;
    await d.store.tx(async t => {
      await finishHandover(d, t, team);
      await remindHandover(d, t, team);
    });
  }
  const active = await d.store.tx(t => t.activeRentals());
  if (d.enabled === false && active.length === 0 && !(await hasCleanup(d))) return EMPTY_REPORT;
  const heartbeat = await d.store.tx(t => t.control('last_watchdog_heartbeat'));
  if (typeof heartbeat !== 'number' || d.now() - heartbeat > 20 * MINUTE_MS)
    d.log('alert_watchdog_stale', { last_tick_at: typeof heartbeat === 'number' ? heartbeat : null });
  await applyWatchdogDeletions(d);
  await expireLeases(d);
  // Requested/expired stops get the first provider slots, before metering or launches.
  let terminated = await drainCleanup(d, Math.min(deadline, Date.now() + 16_000));
  const previousTick = await d.store.tx(t => t.control('last_tick'));
  const fresh = typeof previousTick === 'number' && d.now() - previousTick <= 180_000;
  if (!fresh) d.log('alert_tick_stale', { last_tick_at: typeof previousTick === 'number' ? previousTick : null });
  const accounts = [...new Set(active.map(r => r.account_id))];
  const stopped = new Map<string, number>();
  const cursor = await d.store.tx(t => t.control('billing_cursor'));
  const split = typeof cursor === 'string' ? accounts.indexOf(cursor) + 1 : 0;
  const ordered = [...accounts.slice(split), ...accounts.slice(0, split)];
  let billed = 0;
  for (const id of ordered) {
    if (Date.now() >= deadline - CALL_MS) break;
    await tickAccount(d, id, stopped);
    await d.store.tx(t => t.setControl('billing_cursor', id));
    billed++;
  }
  if (Date.now() < deadline) await syncPaidTags(d, Math.min(deadline, Date.now() + CALL_MS));
  terminated += await drainCleanup(d, Math.min(deadline, Date.now() + 16_000));
  // Record health after the safety pass even if optional reconciliation consumes the remaining budget.
  if (billed === accounts.length) await d.store.tx(t => t.setControl('last_tick', d.now()));
  const orphans = await reconcile(d, deadline);
  terminated += await drainCleanup(d, deadline);
  const backlog = billed !== accounts.length;
  const dequeued = !backlog && d.enabled !== false && Date.now() < deadline ? await dequeue(d) : 0;
  const pending = await d.store.tx(t => t.activeRentals());
  for (const r of pending) {
    if (Date.now() >= deadline || backlog) break;
    if (fresh && d.enabled !== false && r.state === 'starting' && r.safety?.claim === 'pending' &&
        !(await d.store.tx(t => launchFrozen(t, r.team_id))))
      await launchPending(d, r.id, Math.min(CALL_MS, deadline - Date.now()));
  }
  if (Date.now() < deadline) {
    try { await checkProviderSpend(d); } catch { d.log('config_invalid', {}); }
  }
  if (!fresh && billed === accounts.length) d.log('alert_tick_recovered', {});
  return { accounts: accounts.length, stopped: Object.fromEntries(stopped), terminated, dequeued, orphans };
}
