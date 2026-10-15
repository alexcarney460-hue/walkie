// The minute tick's alert retries (REVIEW-merged-opus.md 2, REVIEW-merged-codex.md 2). Two sources, both raised again
// through d.log, so the tick's request-scoped alert queue (alert-handler.ts) sends them with sendAlert's own claim:
//   1. queued confirmed alerts (alerts.ts: an undelivered alert waits in its own `alert:<digest>` claim row), whose
//      Telegram send failed, was impossible (no token or chat), or whose sender stopped mid-send, once each one's
//      backoff has passed (sendAlert queues and settles them): ALERT_RETRY_MAX per tick, money and abuse first, oldest
//      first, plus up to TEAM_EXTRA more team-waiting alerts on top (round 7), so at most 13 per tick;
//   2. paid checkouts held for the operator (credit.ts, compute-credit-hold:<session>, state "held") that are 30 minutes
//      old and whose credit_ignored alert has no delivery on record: the webhook's process can stop after the hold
//      committed and before its alert queue ran. Once a delivery is on record the hold is marked `alerted_at` and left.
import { alertClaimKey, queuedAlert } from './alerts.js';
import type { ComputeDeps } from './deps.js';

/** Queued alerts raised again per tick (sent in parallel inside the tick's alert budget). */
export const ALERT_RETRY_MAX = 10;
/**
 * Team-waiting alerts (forks, handovers, licence overflow: priority 1) sent per tick IN ADDITION to the ALERT_RETRY_MAX
 * money-first slots, so a sustained 10 or more due money alerts per tick cannot starve them (REVIEW-r11-codex.md P2-2),
 * and money never gives up a slot to them (REVIEW-r12-codex.md P2-2, REVIEW-r12-opus.md P3: round 6's 3-of-10
 * reservation let money lag without bound under 8-10 money alerts per tick plus a fork flood). At most 13 queued retries
 * per tick; Telegram allows a group 20 messages a minute.
 */
export const TEAM_EXTRA = 3;
const TEAM_PRIORITY = 1;
/** In the band TEAM_PRIORITY lists: a numeric priority at least it, or none (alerts.ts queues every alert with one). */
const teamRow = (value: unknown): boolean => {
  const p = (value as { priority?: unknown } | null)?.priority;
  return typeof p !== 'number' || p >= TEAM_PRIORITY;
};
/** Held checkouts checked per tick, oldest first. */
export const HELD_CREDIT_SWEEP_MAX = 5;
/** A held checkout's alert is raised again only after this long (its own raise had every chance first). */
export const HELD_CREDIT_ALERT_GRACE_MS = 30 * 60_000;

interface HeldCredit { readonly state?: unknown; readonly account?: unknown; readonly session?: unknown; readonly reason?: unknown }
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export async function retryAlerts(d: ComputeDeps): Promise<void> {
  try {
    // The 10 money-first slots (team-waiting alerts fill any money leaves free), then up to 3 more team-waiting alerts
    // not already among them: listing past the team rows the first page holds keeps those 3 truly additional.
    const first = await d.store.tx(t => t.queuedAlerts(d.now(), ALERT_RETRY_MAX));
    const taken = new Set(first.map(r => r.key));
    const teamTaken = first.filter(r => teamRow(r.value)).length;
    const extra = (await d.store.tx(t => t.queuedAlerts(d.now(), TEAM_EXTRA + teamTaken, TEAM_PRIORITY)))
      .filter(r => !taken.has(r.key)).slice(0, TEAM_EXTRA);
    const due = [...first, ...extra];
    for (const { value } of due) {
      const queued = queuedAlert(value);
      if (queued) d.log(`alert_${queued.event}`, queued.fields);
    }
    const held = await d.store.tx(t => t.heldCreditHolds(d.now() - HELD_CREDIT_ALERT_GRACE_MS, HELD_CREDIT_SWEEP_MAX));
    for (const { key, value } of held) {
      const v = value as HeldCredit;
      const fields = { account: text(v.account), session: text(v.session), reason: text(v.reason) };
      const delivered = await d.store.tx(t => t.control(alertClaimKey('credit_ignored', fields)));
      if (typeof delivered !== 'number') {
        d.log('alert_credit_ignored', fields);
        continue;
      }
      await d.store.tx(async t => {
        await t.lockControl(key);
        const current = await t.control(key) as HeldCredit | null | undefined;
        if (current && typeof current === 'object' && current.state === 'held') await t.setControl(key, { ...current, alerted_at: delivered });
      });
    }
  } catch {
    // The tick's safety work must not depend on alert bookkeeping; the next tick tries again.
    d.log('alert_retry_failed', {});
  }
}
