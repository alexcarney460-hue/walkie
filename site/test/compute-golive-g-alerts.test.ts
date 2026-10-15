// Go-live builder G (REVIEW-merged-opus.md 2 and 6, REVIEW-merged-codex.md 2, lane C round 8):
// - a one-shot money alert whose Telegram send failed is delivered later by the minute tick, without Stripe redelivering
//   anything, and is still sent once per 30 minutes per key;
// - a held paid checkout whose alert never went out (the webhook's process stopped first) is raised again by the tick;
// - a COMPUTE_PRIVATE_CONFIG that is set but does not parse fails the tick (500) and pages the operator without a store;
// - the licence bind's authority alerts reach Telegram with no store (drain), once per 30 minutes, and a failed send is
//   sent again by the next raise.
import { describe, expect, test } from 'bun:test';
import Stripe from 'stripe';
import { randomBytes } from 'node:crypto';
import { sendAlert } from '../api/_lib/compute/alerts.ts';
import { applyCreditEvent, type StripeEvent } from '../api/_lib/compute/credit.ts';
import { computeFromEnv, type HandlerDeps } from '../api/_lib/compute/handler.ts';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';
import { makeComputeWebhook } from '../api/compute/webhook.ts';
import { makeTick } from '../api/compute/tick.ts';
import { configJson, createAccount, fixtureTeam, MIN, world } from './compute-helpers.ts';

const WH = 'whsec_' + 'builder_g_fixture_secret';
const CRON = 'cron-' + 'builder-g-fixture';
const TG = { COMPUTE_ALERT_TELEGRAM_TOKEN: 'fixture-bot', COMPUTE_ALERT_TELEGRAM_CHAT: 'fixture-chat' };
const hex = () => randomBytes(12).toString('hex');
const envelope = (type: string, object: Record<string, unknown>): StripeEvent => ({
  id: `evt_${hex()}`, object: 'event', api_version: '2026-08-26.dahlia', created: 1_790_000_000, livemode: true,
  pending_webhooks: 1, request: { id: null, idempotency_key: null }, type, data: { object },
} as StripeEvent);
/** A paid compute checkout that fails validation (charged in EUR): held for the operator, never credited. */
const eurSession = (account: string) => ({
  id: `cs_live_${hex()}`, object: 'checkout.session', amount_total: 4_600, client_reference_id: account, currency: 'eur',
  livemode: true, mode: 'payment', payment_intent: `pi_${hex()}`, payment_status: 'paid', status: 'complete',
  metadata: { walkie_compute_account: account, walkie_credit_usd: '50' },
});
async function signed(event: unknown): Promise<Request> {
  const payload = JSON.stringify(event);
  const header = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: WH });
  return new Request('https://site.test/api/compute/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': header } });
}
const tickRequest = () => new Request('https://site.test/api/compute/tick', { headers: { authorization: `Bearer ${CRON}` } });

/** Telegram that can be switched down and up; records every attempt and every delivery. */
function telegram() {
  const t = { up: true, attempts: [] as string[], delivered: [] as string[],
    fetch: async (_: string, init?: RequestInit) => {
      const body = String(init?.body);
      t.attempts.push(body);
      if (!t.up) return new Response('bad gateway', { status: 502 });
      t.delivered.push(body);
      return Response.json({ ok: true });
    } };
  return t;
}
/** The request bodies about one event (the message text, JSON-encoded: its newline arrives escaped). */
const about = (bodies: readonly string[], event: string) => bodies.filter(b => b.includes(`Sqwakie compute: ${event}\\n`));

describe('O2 / C2: one-shot money alerts are delivered once Telegram recovers', () => {
  test('a held checkout alert that failed on the webhook is delivered by the tick, with no Stripe redelivery', async () => {
    const w = world();
    const a = await createAccount(w.d, fixtureTeam);
    const tg = telegram();
    const deps: HandlerDeps = { env: { ...TG, COMPUTE_ENABLED: '1', COMPUTE_STRIPE_WEBHOOK_SECRET: WH, CRON_SECRET: CRON },
      compute: () => w.d, stripe: () => null, alertFetch: tg.fetch };
    const s = eurSession(a.account_id);
    tg.up = false;
    const res = await makeComputeWebhook(deps)(await signed(envelope('checkout.session.completed', s)));
    expect(await res.json()).toEqual({ received: true, outcome: 'ignored' });
    expect(about(tg.attempts, 'credit_ignored')).toHaveLength(1);
    // Telegram stays down for ten minutes: the tick keeps retrying, backing off, never more than once a minute.
    for (let i = 0; i < 10; i++) { w.advance(MIN); expect((await makeTick(deps)(tickRequest())).status).toBe(200); }
    const whileDown = about(tg.attempts, 'credit_ignored').length;
    expect(whileDown).toBeGreaterThan(1);
    expect(whileDown).toBeLessThanOrEqual(11);
    expect(about(tg.delivered, 'credit_ignored')).toHaveLength(0);
    // Telegram recovers: delivered within the retry backoff, exactly once, with the session the operator needs.
    tg.up = true;
    for (let i = 0; i < 20; i++) { w.advance(MIN); await makeTick(deps)(tickRequest()); }
    const delivered = about(tg.delivered, 'credit_ignored');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(s.id);
    expect(delivered[0]).toContain('currency');
    // Delivered: no more retries, and a repeat inside 30 minutes is still deduplicated.
    const attempts = about(tg.attempts, 'credit_ignored').length;
    for (let i = 0; i < 5; i++) { w.advance(MIN); await makeTick(deps)(tickRequest()); }
    await sendAlert({ store: w.store, env: TG, now: w.d.now, log: () => {}, fetch: tg.fetch }, 'credit_ignored',
      { account: a.account_id, session: s.id, reason: 'currency' });
    expect(about(tg.attempts, 'credit_ignored')).toHaveLength(attempts);
    // Nothing left queued, even counting entries not yet due.
    expect(await w.store.tx(t => t.queuedAlerts(w.d.now() + 86_400_000, 10))).toEqual([]);
  });

  test('a failed send then a successful one (PROBE J inverted): delivered, then deduplicated for 30 minutes', async () => {
    const store = new MemoryStore();
    const tg = telegram();
    let now = 1_790_000_000_000;
    const d = { store, env: TG, now: () => now, log: () => {}, fetch: tg.fetch };
    const fields = { account: 'ca_0123456789abcdef', session: 'cs_live_builderGj', reason: 'currency' };
    tg.up = false;
    await sendAlert(d, 'credit_ignored', fields);
    tg.up = true;
    now += 10 * MIN;
    await sendAlert(d, 'credit_ignored', fields);
    expect(tg.attempts).toHaveLength(2);
    expect(tg.delivered).toHaveLength(1);
    now += 29 * MIN;
    await sendAlert(d, 'credit_ignored', fields);
    expect(tg.attempts).toHaveLength(2);
    now += 2 * MIN;
    await sendAlert(d, 'credit_ignored', fields);
    expect(tg.delivered).toHaveLength(2);
  });

  test('every one-shot money event is retried after a failed send; a repeating alert keeps its 30-minute suppression', async () => {
    const fields = { team: '0123456789abcdef', account: 'ca_0123456789abcdef', rental: 'r_0123456789abcdef', provider: 'digitalocean',
      event: 'charge.refunded', charge: 'ch_builderG', reason: 'lookup_failed' };
    for (const event of ['credit_ignored', 'operator_funded', 'boot_refund_capped', 'account_frozen', 'freeze_unresolved',
      'lease_expired', 'mining_stop', 'egress_cap_stop'] as const) {
      const store = new MemoryStore(), tg = telegram();
      let now = 1_790_000_000_000;
      const d = { store, env: TG, now: () => now, log: () => {}, fetch: tg.fetch };
      tg.up = false;
      await sendAlert(d, event, fields);
      tg.up = true;
      now += 2 * MIN;
      await sendAlert(d, event, fields);
      expect([event, tg.delivered.length]).toEqual([event, 1]);
    }
    const store = new MemoryStore(), tg = telegram();
    let now = 1_790_000_000_000;
    const d = { store, env: TG, now: () => now, log: () => {}, fetch: tg.fetch };
    tg.up = false;
    await sendAlert(d, 'tick_stale', {});
    tg.up = true;
    now += 2 * MIN;
    await sendAlert(d, 'tick_stale', {});
    expect(tg.attempts).toHaveLength(1);
  });

  test('concurrent raises of one money alert send it once', async () => {
    const store = new MemoryStore(), tg = telegram();
    const d = { store, env: TG, now: () => 1_790_000_000_000, log: () => {}, fetch: tg.fetch };
    await Promise.all(Array.from({ length: 8 }, () =>
      sendAlert(d, 'operator_funded', { team: '0123456789abcdef', account: 'ca_0123456789abcdef', rental: 'r_0123456789abcdef' })));
    expect(tg.attempts).toHaveLength(1);
  });

  test('a held checkout whose alert never went out is raised again by the tick after 30 minutes, then left alone', async () => {
    const w = world();
    const a = await createAccount(w.d, fixtureTeam);
    const s = eurSession(a.account_id);
    // Held and logged, but the request ended before any Telegram send (no alert queue around this call).
    expect(await applyCreditEvent(w.d, envelope('checkout.session.completed', s))).toBe('ignored');
    const tg = telegram();
    const deps: HandlerDeps = { env: { ...TG, COMPUTE_ENABLED: '1', CRON_SECRET: CRON }, compute: () => w.d, stripe: () => null,
      alertFetch: tg.fetch };
    for (let i = 0; i < 29; i++) { w.advance(MIN); await makeTick(deps)(tickRequest()); }
    expect(about(tg.attempts, 'credit_ignored')).toHaveLength(0);
    for (let i = 0; i < 2; i++) { w.advance(MIN); await makeTick(deps)(tickRequest()); }
    const delivered = about(tg.delivered, 'credit_ignored');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(s.id);
    for (let i = 0; i < 40; i++) { w.advance(MIN); await makeTick(deps)(tickRequest()); }
    expect(about(tg.attempts, 'credit_ignored')).toHaveLength(1);
    const hold = await w.store.tx(t => t.control(`compute-credit-hold:${s.id}`)) as { state?: string; alerted_at?: number };
    expect(hold.state).toBe('held');
    expect(typeof hold.alerted_at).toBe('number');
  });
});

describe('O6: an unparseable COMPUTE_PRIVATE_CONFIG fails the tick and pages the operator', () => {
  const base = { DATABASE_URL: 'postgres://unused.invalid/db', CRON_SECRET: CRON, COMPUTE_HANDOVER_TOKEN_KEY: 'k'.repeat(40), ...TG };

  test('present but invalid: the tick answers 500 and Telegram hears config_invalid once per 30 minutes, with no store', async () => {
    for (const enabled of ['1', undefined]) {
      const env: Record<string, string | undefined> = { ...base, COMPUTE_PRIVATE_CONFIG: configJson().slice(0, -1), COMPUTE_ENABLED: enabled };
      const tg = telegram();
      const tick = makeTick({ env, compute: () => computeFromEnv(env, new MemoryStore()), alertStore: () => null, stripe: () => null,
        alertFetch: tg.fetch });
      const first = await tick(tickRequest());
      expect(first.status).toBe(500);
      expect(await first.json()).toEqual({ error: 'config_invalid' });
      const second = await tick(tickRequest());
      expect(second.status).toBe(500);
      // One page per 30 minutes per instance (the first loop iteration's claim also covers the second).
      expect(about(tg.delivered, 'config_invalid').length).toBe(enabled === '1' ? 1 : 0);
    }
  });

  test('absent: compute is fully off, the tick answers 200 and nothing is sent', async () => {
    const env: Record<string, string | undefined> = { ...base, COMPUTE_ENABLED: '1' };
    const tg = telegram();
    const tick = makeTick({ env, compute: () => computeFromEnv(env), alertStore: () => null, stripe: () => null, alertFetch: tg.fetch });
    const res = await tick(tickRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: 0, stopped: {}, terminated: 0, dequeued: 0, orphans: 0 });
    expect(tg.attempts).toHaveLength(0);
  });
});

describe('lane C round 8: the bind authority alerts reach Telegram with no store (drain)', () => {
  for (const event of ['authority_fork', 'handover_rejected_refusal', 'handover_operator_review'] as const) {
    test(`${event}: one delivery per 30 minutes per key, and a failed send is sent again by the next raise`, async () => {
      const tg = telegram();
      let now = 1_795_000_000_000 + ['authority_fork', 'handover_rejected_refusal', 'handover_operator_review'].indexOf(event) * 86_400_000;
      const team = randomBytes(8).toString('hex'), chain = randomBytes(32).toString('hex');
      const d = { store: null, env: TG, now: () => now, log: () => {}, fetch: tg.fetch };
      await sendAlert(d, event, { team, chain });
      await sendAlert(d, event, { team, chain });
      expect(tg.delivered).toHaveLength(1);
      expect(tg.delivered[0]).toContain(team);
      await sendAlert(d, event, { team: randomBytes(8).toString('hex'), chain });
      expect(tg.delivered).toHaveLength(2);
      now += 29 * MIN;
      await sendAlert(d, event, { team, chain });
      expect(tg.delivered).toHaveLength(2);
      now += 2 * MIN;
      tg.up = false;
      await sendAlert(d, event, { team, chain });
      expect(tg.attempts).toHaveLength(3);
      tg.up = true;
      now += 2 * MIN;
      await sendAlert(d, event, { team, chain });
      expect(tg.attempts).toHaveLength(4);
      expect(tg.delivered).toHaveLength(3);
    });
  }
});
