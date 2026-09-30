import { createHash } from 'node:crypto';
import type { Env } from '../env.js';
import type { ComputeStore } from './store.js';

const EVENTS = ['tick_stale', 'tick_recovered', 'termination_delayed', 'orphan_found', 'orphan_terminated',
  'orphan_termination_failed', 'launch_uncertain', 'mining_stop', 'egress_cap_stop', 'account_frozen',
  'config_invalid', 'provider_spend', 'provider_unavailable', 'duplicate_instance', 'lease_expired', 'bootstrap_failure_ignored',
  'watchdog_stale', 'watchdog_clock_skew', 'watchdog_delete_failed', 'watchdog_delete_persistent',
  'watchdog_invalid_tag', 'tag_expiry_risk', 'authority_fork', 'instance_vanished', 'handover_objection',
  'handover_expired', 'handover_no_independent_owner', 'enrollment_owners_changed',
  'handover_clear', 'handover_rejected_refusal', 'authority_fork_resolved', 'handover_operator_secret_invalid',
  'handover_operator_review', 'handover_acknowledged', 'handover_objection_overridden', 'authority_fork_rejected',
  'compute_state_unavailable', 'handover_expired_lift'] as const;
export type AlertEvent = typeof EVENTS[number];
type Fields = Readonly<Record<string, string | number | boolean | null>>;
export interface AlertDeps {
  readonly store: ComputeStore | null;
  readonly env: Env;
  readonly now: () => number;
  readonly log: (event: string, fields: Fields) => void;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}
const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
const unavailableAlerts = new Map<string, number>();

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
  for (const key of ['chain', 'old_chain']) {
    const value = fields[key];
    if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) out[key] = value;
  }
  for (const key of ['acknowledged_by', 'objected_by']) {
    const value = fields[key];
    if (typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value)) out[key] = value;
  }
  const owners = fields.eligible_owners;
  if (typeof owners === 'string' && owners.length <= 4_400 &&
      (owners === '' || owners.split(',').every(key => /^[A-Za-z0-9+/]{43}=$/.test(key)))) out.eligible_owners = owners;
  if (fields.provider === 'digitalocean' || fields.provider === 'fake') out.provider = fields.provider;
  for (const key of ['attempts', 'last_tick_at', 'cost_usd', 'threshold_usd', 'day']) {
    const value = fields[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  if (['charge.dispute.created', 'charge.refunded', 'radar.early_fraud_warning.created'].includes(String(fields.event))) out.event = String(fields.event);
  return out;
}

/** Claim BEFORE sending: failures are also suppressed for 30 minutes (at most once, no retry storm). */
export async function sendAlert(d: AlertDeps, event: AlertEvent, fields: Fields): Promise<void> {
  try {
    if (!(EVENTS as readonly string[]).includes(event)) return;
    const safe = sanitized(fields);
    try { d.log(`alert_${event}`, safe); } catch { /* logging cannot affect billing */ }
    const token = d.env.COMPUTE_ALERT_TELEGRAM_TOKEN?.trim(), chat = d.env.COMPUTE_ALERT_TELEGRAM_CHAT?.trim();
    if (!token || !chat) return;
    const identity = [event, safe.team, safe.account, safe.rental, safe.instance_ref, safe.provider, safe.event, safe.day,
      safe.chain, safe.old_chain, safe.acknowledged_by, safe.objected_by];
    const key = `alert:${digest(JSON.stringify(identity))}`;
    let claimed = false;
    if (d.store) {
      claimed = await d.store.tx(async t => {
        await t.lockControl(key);
        const last = await t.control(key), now = d.now();
        if (typeof last === 'number' && now - last < 1_800_000) return false;
        await t.setControl(key, now);
        return true;
      });
    } else if (event === 'compute_state_unavailable') {
      const last = unavailableAlerts.get(key), now = d.now();
      if (last === undefined || now - last >= 1_800_000) {
        if (unavailableAlerts.size >= 256) unavailableAlerts.delete(unavailableAlerts.keys().next().value!);
        unavailableAlerts.set(key, now);
        claimed = true;
      }
    }
    if (!claimed) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('alert_timeout')); }, 3000);
      });
      await Promise.race([timeout, (async () => {
        const response = await (d.fetch ?? fetch)(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
          method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text: `Walkie compute: ${event}\n${JSON.stringify(safe)}` }),
        });
        if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) throw new Error('alert_delivery_failed');
      })()]);
    } finally { clearTimeout(timer); }
  } catch {
    try { d.log('alert_delivery_failed', {}); } catch { /* best effort only; never print the error (URL contains a token) */ }
  }
}
