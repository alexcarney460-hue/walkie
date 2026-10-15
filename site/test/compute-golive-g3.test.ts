// Go-live builder G round 3 (REVIEW-fixdiff-opus.md P2-1 and P3-5, REVIEW-fixdiff-codex.md P2-2 and P2-3):
// - authority_fork (a fork pauses every renewal of the team's licence) and the handover alerts that leave a team waiting
//   on the operator are confirmed: a failed send is delivered later by the tick;
// - a confirmed alert raised while Telegram is not configured is queued, and delivered once configuration returns;
// - undelivered confirmed alerts are never dropped: 260 of them (the old cap was 200) are all delivered exactly once,
//   at most 10 per tick;
// - an account under mining review cannot open a credit checkout.
import { describe, expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { sendAlert } from '../api/_lib/compute/alerts.ts';
import { BACKFILL_KEY } from '../api/_lib/compute/licence-records.ts';
import type { HandlerDeps } from '../api/_lib/compute/handler.ts';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';
import { makeAccount } from '../api/compute/account.ts';
import { makeCredit } from '../api/compute/credit.ts';
import { makeTick } from '../api/compute/tick.ts';
import { createAccount, fixtureTeam, MIN, world } from './compute-helpers.ts';

const CRON = 'cron-' + 'builder-g3-fixture';
const TG = { COMPUTE_ALERT_TELEGRAM_TOKEN: 'fixture-bot', COMPUTE_ALERT_TELEGRAM_CHAT: 'fixture-chat' };
const tickRequest = () => new Request('https://site.test/api/compute/tick', { headers: { authorization: `Bearer ${CRON}` } });
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

type Keys = ReturnType<typeof C.generateKeys>;
type Move = { transfer: { key: string; event: unknown }; events: unknown[] };
/** compute-licence-first-enrollment.test.ts's licence world (MockStripe licence, lock-era bind), reduced to what is used. */
function licenceWorld(name: string) {
  const w = C.world(), t = C.mkTeam(name), stripe = new C.LH.MockStripe();
  const id = `sub_${name.replace(/[^A-Za-z0-9]/g, '')}`;
  stripe.subs.set(id, C.LH.subscription({ id }));
  w.d.verifyLicense = C.licenseVerifier(stripe);
  w.d.teamLicences = async (team: string) => stripe.listSubscriptionsByTeam(team);
  // Lane C round 10: first enrollment waits for the one-time licence backfill; this world has run it (integration).
  void w.store.tx(x => x.setControl(BACKFILL_KEY, { complete_at: C.T0 }));
  let seq = 1;
  const move = (by: Keys, to: Keys): Move => {
    const at = (seq += 3);
    const ev = (n: number, kind: string, body: object) => C.signEvent(by, { v: C.PROTOCOL_VERSION, team: t.team,
      id: `${by.nodeId}:${n}`, origin: by.nodeId, seq: n, ts: C.T0 + n, author: { handle: 'alex', node: by.nodeId }, kind, body });
    const transfer = C.transfer(by, t.team, at + 2, to);
    return { transfer, events: [ev(at, 'team.member', { login: `direct:${to.nodeId}`, handle: `h${at}`, role: 'owner' }),
      ev(at + 1, 'team.node', { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: `m${at}`, pubkey: to.pubkey,
        ip: '127.0.0.1' }), transfer.event] };
  };
  /** A licence bound while the site was locked (no compute store, no proof): walkie_team + walkie_renew_hash only.
   *  Set directly (lane C round 11: the lock-ON bind now refuses without its store). */
  const bind = async () => C.LH.releasedBind(stripe, id, t.team);
  const account = (keys: Keys, moves: Move[] = [], extra: object = {}) => C.createAccount(w.d, t.team,
    C.proof(keys, t.team, w.clock.now, t.genesis, moves.map(m => m.transfer), { roster_events: moves.flatMap(m => m.events), ...extra }));
  return { w, t, id, move, bind, account };
}

describe('Opus P2-1: alerts that leave a team waiting on the operator are confirmed', () => {
  test('PROBE F: a failed authority_fork send is delivered by the tick once Telegram is back, exactly once', async () => {
    const s = licenceWorld('g3fork'), f = s.t.f, n = C.generateKeys(), x = C.generateKeys();
    const fToN = s.move(f, n);
    const bound = await s.bind();
    expect(bound.status).toBe(200);
    await s.account(n, [fToN], { lic_id: s.id, renewal_token: bound.body.renewal_token });
    await s.w.store.tx(t => t.setControl('last_tick', s.w.clock.now));
    const tg = telegram();
    tg.up = false;
    const deps: HandlerDeps = { env: { ...TG, COMPUTE_ENABLED: '1', CRON_SECRET: CRON }, compute: () => s.w.d, stripe: () => null,
      alertFetch: tg.fetch };
    const fToX = s.move(f, x);
    const res = await makeAccount(deps)(new Request('https://site.test/api/compute/account', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ team_id: s.t.team,
        proof: C.proof(x, s.t.team, s.w.clock.now, s.t.genesis, [fToX.transfer], { roster_events: fToX.events }) }) }));
    expect(res.status).toBe(403);
    expect(typeof await s.w.store.tx(t => t.control(`enrollment-fork:${s.t.team}`))).toBe('number');
    expect(about(tg.attempts, 'authority_fork')).toHaveLength(1);
    tg.up = true;
    for (let i = 0; i < 5; i++) { s.w.clock.now += MIN; await makeTick(deps)(tickRequest()); }
    const delivered = about(tg.delivered, 'authority_fork');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(s.t.team);
    for (let i = 0; i < 60; i++) { s.w.clock.now += MIN; await makeTick(deps)(tickRequest()); }
    expect(about(tg.attempts, 'authority_fork')).toHaveLength(2);
  });

  const fields = { team: '0123456789abcdef', chain: 'a'.repeat(64), old_chain: 'b'.repeat(64) };
  for (const event of ['authority_fork', 'handover_operator_review', 'handover_objection', 'handover_acknowledged',
    'handover_no_independent_owner', 'handover_expired'] as const) {
    test(`${event}: a failed send is retried and delivered`, async () => {
      const store = new MemoryStore(), tg = telegram();
      let now = 1_790_000_000_000;
      const d = { store, env: TG, now: () => now, log: () => {}, fetch: tg.fetch };
      tg.up = false;
      await sendAlert(d, event, fields);
      tg.up = true;
      now += 2 * MIN;
      await sendAlert(d, event, fields);
      expect(tg.delivered).toHaveLength(1);
    });
  }

  test('an alert that blocks nobody (a rejected chain refused again) keeps the repeating rule: a failure waits 30 minutes', async () => {
    const store = new MemoryStore(), tg = telegram();
    let now = 1_790_000_000_000;
    const d = { store, env: TG, now: () => now, log: () => {}, fetch: tg.fetch };
    tg.up = false;
    await sendAlert(d, 'handover_rejected_refusal', fields);
    tg.up = true;
    now += 2 * MIN;
    await sendAlert(d, 'handover_rejected_refusal', fields);
    expect(tg.attempts).toHaveLength(1);
  });
});

describe('Codex P2-2: a confirmed alert raised without Telegram configured is not lost', () => {
  test('queued while unconfigured, delivered by the tick once the token and chat are set; a repeating alert is not queued', async () => {
    const w = world();
    const tg = telegram();
    const unconfigured = { store: w.store, env: {}, now: w.d.now, log: () => {}, fetch: tg.fetch };
    const funded = { team: fixtureTeam, account: 'ca_0123456789abcdef', rental: 'r_0123456789abcdef', provider: 'digitalocean' };
    await sendAlert(unconfigured, 'operator_funded', funded);
    await sendAlert(unconfigured, 'account_frozen', { account: 'ca_0123456789abcdef' });
    await sendAlert(unconfigured, 'tick_stale', { last_tick_at: 5 });
    expect(tg.attempts).toHaveLength(0);
    const plain: HandlerDeps = { env: { COMPUTE_ENABLED: '1', CRON_SECRET: CRON }, compute: () => w.d, stripe: () => null, alertFetch: tg.fetch };
    for (let i = 0; i < 5; i++) { w.advance(MIN); await makeTick(plain)(tickRequest()); }
    expect(tg.attempts).toHaveLength(0);
    const configured: HandlerDeps = { ...plain, env: { ...plain.env, ...TG } };
    for (let i = 0; i < 31; i++) { w.advance(MIN); await makeTick(configured)(tickRequest()); }
    expect(about(tg.delivered, 'operator_funded')).toHaveLength(1);
    expect(about(tg.delivered, 'operator_funded')[0]).toContain('r_0123456789abcdef');
    expect(about(tg.delivered, 'account_frozen')).toHaveLength(1);
    expect(about(tg.attempts, 'tick_stale')).toHaveLength(0);
  });
});

describe('Codex P2-3 / Opus P3-3: undelivered confirmed alerts are never dropped', () => {
  test('260 distinct failed money alerts (the old cap was 200): all delivered exactly once, at most 10 per tick', async () => {
    const w = world();
    const tg = telegram();
    tg.up = false;
    const d = { store: w.store, env: TG, now: w.d.now, log: () => {}, fetch: tg.fetch };
    const rentals = Array.from({ length: 260 }, (_, i) => `r_${i.toString(16).padStart(16, '0')}`);
    for (const rental of rentals) await sendAlert(d, 'operator_funded', { team: fixtureTeam, account: 'ca_0123456789abcdef', rental });
    expect(tg.attempts).toHaveLength(260);
    tg.up = true;
    const deps: HandlerDeps = { env: { ...TG, COMPUTE_ENABLED: '1', CRON_SECRET: CRON }, compute: () => w.d, stripe: () => null,
      alertFetch: tg.fetch };
    let maxPerTick = 0;
    for (let i = 0; i < 40; i++) {
      const before = about(tg.attempts, 'operator_funded').length;
      w.advance(MIN);
      await makeTick(deps)(tickRequest());
      maxPerTick = Math.max(maxPerTick, about(tg.attempts, 'operator_funded').length - before);
    }
    expect(maxPerTick).toBe(10);
    const delivered = about(tg.delivered, 'operator_funded');
    expect(delivered).toHaveLength(260);
    expect(new Set(delivered.map(b => /r_[0-9a-f]{16}/.exec(b)![0])).size).toBe(260);
    for (let i = 0; i < 40; i++) { w.advance(MIN); await makeTick(deps)(tickRequest()); }
    expect(about(tg.attempts, 'operator_funded')).toHaveLength(260 + 260);
  });
});

describe('Opus P3-5: an account under review cannot buy credit', () => {
  test('the credit route refuses 403 account_under_review before any Stripe call (PROBE C2)', async () => {
    const w = world();
    const a = await createAccount(w.d, fixtureTeam);
    await w.store.tx(t => t.setAccount(a.account_id, { review: 'mining' }));
    const created: unknown[] = [];
    const handler = makeCredit({ env: { COMPUTE_ENABLED: '1' }, compute: () => w.d,
      stripe: () => ({ createCreditCheckout: async (p) => { created.push(p); return { url: 'https://checkout.stripe.test/x' }; } }) });
    const res = await handler(new Request('https://site.test/api/compute/credit', { method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ block: 50 }) }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_under_review' });
    expect(created).toHaveLength(0);
  });
});
