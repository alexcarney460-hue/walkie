import { createHash } from 'node:crypto';
import type { Env } from '../env.js';
import { ALERT_CLAIM_PREFIX, type ComputeStore, type Tx } from './store.js';

const EVENTS = ['tick_stale', 'tick_recovered', 'termination_delayed', 'orphan_found', 'orphan_terminated',
  'orphan_termination_failed', 'launch_uncertain', 'mining_stop', 'egress_cap_stop', 'account_frozen',
  'config_invalid', 'provider_spend', 'provider_unavailable', 'duplicate_instance', 'lease_expired', 'bootstrap_failure_ignored',
  'watchdog_stale', 'watchdog_clock_skew', 'watchdog_delete_failed', 'watchdog_delete_persistent',
  'watchdog_invalid_tag', 'tag_expiry_risk', 'authority_fork', 'instance_vanished', 'handover_objection',
  'handover_expired', 'handover_no_independent_owner', 'enrollment_owners_changed',
  'handover_clear', 'handover_rejected_refusal', 'authority_fork_resolved', 'handover_operator_secret_invalid',
  'handover_operator_review', 'handover_acknowledged', 'handover_objection_overridden', 'authority_fork_rejected',
  'compute_state_unavailable', 'handover_expired_lift', 'freeze_unresolved', 'credit_ignored', 'operator_funded',
  'boot_refund_capped', 'enrollment_licence_refused', 'cpu_pegged', 'cpu_pegged_long', 'licence_read_failed',
  'licence_bindings_overflow', 'licence_store_missing', 'account_busy'] as const;
export type AlertEvent = typeof EVENTS[number];
type Fields = Readonly<Record<string, string | number | boolean | null>>;
export interface AlertDeps {
  readonly store: ComputeStore | null;
  readonly env: Env;
  readonly now: () => number;
  readonly log: (event: string, fields: Fields) => void;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** With no store, deduplicate in this instance's memory instead of dropping the alert (a set but unparseable config). */
  readonly memory?: boolean;
}
const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
/** Why a Stripe money event was held (credit.ts): fixed names only. */
const MONEY_REASONS = ['metadata', 'mode', 'currency', 'amount', 'session_id', 'no_payment_intent', 'unknown_account',
  'lookup_failed', 'no_reference'];
const WINDOW_MS = 1_800_000;
/** A confirmed alert being sent is not sent by another raise for this long; also its first retry delay. */
const SENDING_MS = 60_000;
/**
 * One-shot alerts the operator must not miss: each is raised once for its event, so a failed (or impossible) Telegram
 * send must not lose it.
 * - Money and abuse: a Stripe event answered 200 is not delivered again; a rental ends, stops or loses its lease once.
 * - A team left waiting on the operator (REVIEW-fixdiff-opus.md P2-1): a fork pauses every renewal of the team's
 *   licence and its compute until resolved (authority_fork); a handover hold, objection or acknowledgement waits for
 *   an operator decision, an unacknowledged one is refused after 72 hours, and an expired one stays refused until the
 *   operator lifts it (handover_operator_review, handover_objection, handover_acknowledged,
 *   handover_no_independent_owner, handover_expired).
 * - First compute enrollments refused because the licence state could not be read (licence_read_failed, lane C round
 *   10): a missing or failing STRIPE_SECRET_KEY stops every new team. A team with more than 200 live subscriptions
 *   fails closed at first enrollment until the operator acts (licence_bindings_overflow, lane C round 11).
 * Delivery is confirmed: until Telegram accepts it (and while Telegram is not configured at all) the alert stays queued
 * in its own claim row and the tick raises it again, backing off 1, 2, 4 ... 30 minutes. Nothing is ever dropped: the
 * queue is the dedupe claim every alert identity already has. A delivered alert keeps the 30-minute deduplication.
 */
export const CONFIRMED_ALERTS: ReadonlySet<AlertEvent> = new Set<AlertEvent>(['credit_ignored', 'operator_funded',
  'boot_refund_capped', 'account_frozen', 'freeze_unresolved', 'lease_expired', 'mining_stop', 'egress_cap_stop',
  'authority_fork', 'handover_operator_review', 'handover_objection', 'handover_acknowledged',
  'handover_no_independent_owner', 'handover_expired', 'licence_read_failed', 'licence_bindings_overflow']);
/**
 * Raised where no store may be used (the licence bind while compute drains, a store that cannot be reached):
 * deduplicated in this instance's memory, 30 minutes once delivered, and sent again by a raise a minute after a failure.
 */
const MEMORY_ALERTS: ReadonlySet<AlertEvent> = new Set<AlertEvent>(['compute_state_unavailable', 'authority_fork',
  'handover_rejected_refusal', 'handover_operator_review', 'licence_store_missing']);
const memoryClaims = new Map<string, { readonly at: number; readonly delivered: boolean }>();
/** A confirmed alert's claim row while it is not delivered (a delivered one holds its delivery time, a number). */
export interface QueuedAlert {
  readonly pending: number; readonly event: AlertEvent; readonly fields: Readonly<Record<string, string | number>>;
  readonly first_at: number; readonly attempts: number; readonly next_at: number;
  /** Retry class (alertPriority): Tx.queuedAlerts lists due alerts by it, then oldest first_at. */
  readonly priority: number;
}
/**
 * The retry queue's classes (REVIEW-final-opus.md P3-5: 600 queued forks held a money alert back 58 ticks). Money and
 * abuse alerts first, so self-minted fork alerts can never delay one; then the alerts that leave a team waiting on the
 * operator (forks, handovers). Oldest first within a class. The per-tick bound is unchanged.
 */
const MONEY_ALERTS: ReadonlySet<AlertEvent> = new Set<AlertEvent>(['credit_ignored', 'operator_funded', 'boot_refund_capped',
  'account_frozen', 'freeze_unresolved', 'lease_expired', 'mining_stop', 'egress_cap_stop', 'licence_read_failed']);
export const alertPriority = (event: AlertEvent): number => (MONEY_ALERTS.has(event) ? 0 : 1);

export function alertFromLog(event: string, fields: Fields): AlertEvent | null {
  if (event === 'stop') return fields.reason === 'mining' ? 'mining_stop' : fields.reason === 'egress_cap' ? 'egress_cap_stop' : null;
  const name = event.replace(/^alert_/, '');
  return (EVENTS as readonly string[]).includes(name) ? name as AlertEvent : null;
}
/** Never forward arbitrary log text, provider responses, credentials or caller-supplied strings. */
function sanitized(fields: Fields): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, pattern] of Object.entries({ team: /^[0-9a-f]{16}$/, account: /^ca_[0-9a-f]{16}$/, rental: /^r_[0-9a-f]{16}$/ })) {
    const value = fields[key];
    if (typeof value === 'string' && pattern.test(value)) out[key] = value;
  }
  if (typeof fields.instance === 'string') out.instance_ref = digest(fields.instance);
  // Already sanitized (an outbox entry raised again): kept, so its deduplication key does not change.
  else if (typeof fields.instance_ref === 'string' && /^[0-9a-f]{16}$/.test(fields.instance_ref)) out.instance_ref = fields.instance_ref;
  for (const key of ['chain', 'old_chain']) {
    const value = fields[key];
    if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) out[key] = value;
  }
  for (const key of ['acknowledged_by', 'objected_by']) {
    const value = fields[key];
    if (typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value)) out[key] = value;
  }
  const owners = fields.eligible_owners;
  // The full list is logged and queued; deliver() shortens it to fit one Telegram message.
  if (typeof owners === 'string' && owners.length <= MAX_OWNERS * 45 &&
      (owners === '' || owners.split(',').every(key => /^[A-Za-z0-9+/]{43}=$/.test(key)))) out.eligible_owners = owners;
  if (fields.provider === 'digitalocean' || fields.provider === 'fake') out.provider = fields.provider;
  for (const key of ['attempts', 'last_tick_at', 'cost_usd', 'threshold_usd', 'day']) {
    const value = fields[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  if (['charge.dispute.created', 'charge.refunded', 'radar.early_fraud_warning.created'].includes(String(fields.event))) out.event = String(fields.event);
  // Stripe object ids from a signature-verified event, so the operator can find the payment in the dashboard.
  if (typeof fields.charge === 'string' && /^(ch|py)_[A-Za-z0-9]{1,250}$/.test(fields.charge)) out.charge = fields.charge;
  if (typeof fields.session === 'string' && /^cs_(test|live)_[A-Za-z0-9]{1,250}$/.test(fields.session)) out.session = fields.session;
  if (typeof fields.event_id === 'string' && /^evt_[A-Za-z0-9]{1,250}$/.test(fields.event_id)) out.event_id = fields.event_id;
  if (MONEY_REASONS.includes(String(fields.reason))) out.reason = String(fields.reason);
  return out;
}

/** Owner keys an alert may carry (each 44 characters plus a comma); more drops the field. */
const MAX_OWNERS = 1_000;
/** Telegram's sendMessage text limit, in characters (all alert text is ASCII). */
const TELEGRAM_TEXT_MAX = 4_096;

/**
 * The Telegram text for an alert, at most TELEGRAM_TEXT_MAX characters (REVIEW-r11-opus.md P3-7: about 91 owners made a
 * handover alert undeliverable). A long owner list keeps as many keys as fit and ends "+N more"; the log line has all.
 */
function alertText(event: AlertEvent, safe: Readonly<Record<string, string | number>>): string {
  const render = (fields: Readonly<Record<string, string | number>>) => `Sqwakie compute: ${event}\n${JSON.stringify(fields)}`;
  const full = render(safe);
  const owners = typeof safe.eligible_owners === 'string' && safe.eligible_owners ? safe.eligible_owners.split(',') : [];
  if (full.length <= TELEGRAM_TEXT_MAX || !owners.length) return full.slice(0, TELEGRAM_TEXT_MAX);
  const shortened = (n: number) => render({ ...safe, eligible_owners: [...owners.slice(0, n), `+${owners.length - n} more`].join(',') });
  let lo = 0, hi = owners.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (shortened(mid).length <= TELEGRAM_TEXT_MAX) lo = mid; else hi = mid - 1;
  }
  return shortened(lo).slice(0, TELEGRAM_TEXT_MAX);
}

function claimKey(event: AlertEvent, safe: Readonly<Record<string, string | number>>): string {
  const identity = [event, safe.team, safe.account, safe.rental, safe.instance_ref, safe.provider, safe.event, safe.day,
    safe.chain, safe.old_chain, safe.acknowledged_by, safe.objected_by,
    ...(safe.charge ? [safe.charge] : []), ...(safe.session ? [safe.session] : []), ...(safe.event_id ? [safe.event_id] : [])];
  return `${ALERT_CLAIM_PREFIX}${digest(JSON.stringify(identity))}`;
}
/** The control key whose number value records the last delivery of this alert (a confirmed alert's delivery proof). */
export function alertClaimKey(event: AlertEvent, fields: Fields): string {
  return claimKey(event, sanitized(fields));
}

/** A queued (undelivered) confirmed alert, or null for anything else (a delivery time, a repeating claim, a bad row). */
export function queuedAlert(value: unknown): QueuedAlert | null {
  const x = value as QueuedAlert | null;
  return typeof x === 'object' && x !== null && !Array.isArray(x) && (EVENTS as readonly string[]).includes(x.event) &&
    typeof x.fields === 'object' && x.fields !== null && [x.pending, x.first_at, x.attempts, x.next_at].every(Number.isSafeInteger)
    ? x : null;
}

/** Repeating alerts: claim BEFORE sending, so a failure is also suppressed for 30 minutes (at most once, no retry storm). */
async function claimOnce(t: Tx, key: string, now: number): Promise<boolean> {
  await t.lockControl(key);
  const last = await t.control(key);
  if (typeof last === 'number' && now - last < WINDOW_MS) return false;
  await t.setControl(key, now);
  return true;
}

/**
 * Confirmed alerts: queued in the claim row BEFORE sending (next_at a minute ahead), so a sender that dies mid-send
 * still leaves the tick something to raise again. Suppressed while delivered within 30 minutes, or while queued and
 * not due (another sender has it, or it is backing off after a failure).
 */
async function claimConfirmed(t: Tx, key: string, event: AlertEvent, safe: QueuedAlert['fields'], now: number): Promise<boolean> {
  await t.lockControl(key);
  const last = await t.control(key);
  if (typeof last === 'number' && now - last < WINDOW_MS) return false;
  const queued = queuedAlert(last);
  if (queued && now < queued.next_at) return false;
  await t.setControl(key, { pending: now, event, fields: safe, first_at: queued?.first_at ?? now, attempts: queued?.attempts ?? 0,
    next_at: now + SENDING_MS, priority: alertPriority(event) } satisfies QueuedAlert);
  return true;
}

async function settleConfirmed(t: Tx, key: string, event: AlertEvent, safe: QueuedAlert['fields'], delivered: boolean,
    now: number): Promise<void> {
  await t.lockControl(key);
  if (delivered) {
    await t.setControl(key, now);
    return;
  }
  const queued = queuedAlert(await t.control(key));
  const attempts = (queued?.attempts ?? 0) + 1;
  await t.setControl(key, { pending: now, event, fields: safe, first_at: queued?.first_at ?? now, attempts,
    next_at: now + Math.min(SENDING_MS * 2 ** (attempts - 1), WINDOW_MS), priority: alertPriority(event) } satisfies QueuedAlert);
}

function remember(key: string, value: { at: number; delivered: boolean }): void {
  memoryClaims.delete(key);
  if (memoryClaims.size >= 256) memoryClaims.delete(memoryClaims.keys().next().value!);
  memoryClaims.set(key, value);
}
function claimMemory(key: string, now: number): boolean {
  const last = memoryClaims.get(key);
  if (last && now - last.at < (last.delivered ? WINDOW_MS : SENDING_MS)) return false;
  remember(key, { at: now, delivered: false });
  return true;
}

/** Telegram's sendMessage, three seconds at most; throws unless Telegram answered ok. */
async function deliver(d: AlertDeps, token: string, chat: string, event: AlertEvent, safe: QueuedAlert['fields']): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('alert_timeout')); }, 3000);
    });
    await Promise.race([timeout, (async () => {
      const response = await (d.fetch ?? fetch)(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
        method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: alertText(event, safe) }),
      });
      if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) throw new Error('alert_delivery_failed');
    })()]);
  } finally { clearTimeout(timer); }
}

/**
 * Sends one operator alert to Telegram, deduplicated per key for 30 minutes: durably through the store, or in memory
 * for MEMORY_ALERTS (and `memory`) when there is no store. CONFIRMED_ALERTS are queued until delivered (see above),
 * also while the Telegram token or chat is not configured. Never throws and never logs the error (the URL carries the
 * bot token).
 */
export async function sendAlert(d: AlertDeps, event: AlertEvent, fields: Fields): Promise<void> {
  try {
    if (!(EVENTS as readonly string[]).includes(event)) return;
    const safe = sanitized(fields);
    try { d.log(`alert_${event}`, safe); } catch { /* logging cannot affect billing */ }
    const token = d.env.COMPUTE_ALERT_TELEGRAM_TOKEN?.trim(), chat = d.env.COMPUTE_ALERT_TELEGRAM_CHAT?.trim();
    const key = claimKey(event, safe), store = d.store;
    const confirmed = store !== null && CONFIRMED_ALERTS.has(event);
    if ((!token || !chat) && !confirmed) return;
    const claimed = store
      ? await store.tx(t => confirmed ? claimConfirmed(t, key, event, safe, d.now()) : claimOnce(t, key, d.now()))
      : (MEMORY_ALERTS.has(event) || d.memory === true) && claimMemory(key, d.now());
    if (!claimed) return;
    let delivered = false;
    if (token && chat) {
      try {
        await deliver(d, token, chat, event, safe);
        delivered = true;
      } catch {
        try { d.log('alert_delivery_failed', {}); } catch { /* best effort only */ }
      }
    } else {
      try { d.log('alert_not_configured', {}); } catch { /* best effort only */ }
    }
    if (store && confirmed) await store.tx(t => settleConfirmed(t, key, event, safe, delivered, d.now()));
    else if (!store) remember(key, { at: d.now(), delivered });
  } catch {
    try { d.log('alert_delivery_failed', {}); } catch { /* best effort only; never print the error (URL contains a token) */ }
  }
}
