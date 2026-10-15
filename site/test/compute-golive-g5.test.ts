// Go-live builder G round 5 (REVIEW-final-opus.md P3-5, PROBE P3): the queue of undelivered confirmed alerts has a
// priority. Money and abuse alerts are retried first, then the alerts that leave a team waiting on the operator (forks,
// handovers), oldest first within each class. The per-tick bound (10) and exactly-once delivery are unchanged.
import { expect, test } from 'bun:test';
import { sendAlert } from '../api/_lib/compute/alerts.ts';
import type { HandlerDeps } from '../api/_lib/compute/handler.ts';
import { makeTick } from '../api/compute/tick.ts';
import { fixtureTeam, MIN, world } from './compute-helpers.ts';

const CRON = 'cron-' + 'builder-g5-fixture';
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
const about = (bodies: readonly string[], event: string) => bodies.filter(b => b.includes(`Sqwakie compute: ${event}\\n`));
const hex16 = (i: number) => i.toString(16).padStart(16, '0');
const teamOf = (body: string) => /\\"team\\":\\"([0-9a-f]{16})\\"/.exec(body)![1]!;
/** A money alert's rental id, else the team of a team-waiting alert. */
const labelOf = (body: string) => /r_[0-9a-f]{16}/.exec(body)?.[0] ?? `team:${teamOf(body)}`;

function setup() {
  const w = world();
  const tg = telegram();
  const d = { store: w.store, env: TG, now: w.d.now, log: () => {}, fetch: tg.fetch };
  const deps: HandlerDeps = { env: { ...TG, COMPUTE_ENABLED: '1', CRON_SECRET: CRON }, compute: () => w.d, stripe: () => null,
    alertFetch: tg.fetch };
  return { w, tg, d, tick: () => makeTick(deps)(tickRequest()) };
}

test('PROBE P3: 600 queued fork alerts and 1 money alert: the money alert goes out on the first tick; all 601 exactly once', async () => {
  const { w, tg, d, tick } = setup();
  tg.up = false;
  for (let i = 0; i < 600; i++) await sendAlert(d, 'authority_fork', { team: hex16(i) });
  w.advance(MIN);
  // Raised last, so it is the newest entry and the last one due.
  await sendAlert(d, 'operator_funded', { team: fixtureTeam, account: 'ca_0123456789abcdef', rental: 'r_00000000000f00d1' });
  expect(tg.attempts).toHaveLength(601);
  tg.up = true;
  w.advance(2 * MIN);
  await tick();
  expect(about(tg.delivered, 'operator_funded')).toHaveLength(1);
  let maxPerTick = 0;
  for (let i = 0; i < 80; i++) {
    const before = tg.attempts.length;
    w.advance(MIN);
    await tick();
    maxPerTick = Math.max(maxPerTick, about(tg.attempts.slice(before), 'authority_fork').length +
      about(tg.attempts.slice(before), 'operator_funded').length);
  }
  // Round 7: 10 money-first slots plus up to 3 team-waiting ones.
  expect(maxPerTick).toBeLessThanOrEqual(13);
  const forks = about(tg.delivered, 'authority_fork');
  expect(forks).toHaveLength(600);
  expect(new Set(forks.map(teamOf)).size).toBe(600);
  expect(about(tg.delivered, 'operator_funded')).toHaveLength(1);
  // Exactly once: every queued alert failed once and was delivered once, nothing more.
  expect(about(tg.attempts, 'authority_fork')).toHaveLength(1200);
  expect(about(tg.attempts, 'operator_funded')).toHaveLength(2);
}, 60_000);

test('money and abuse first (10 slots), then team-waiting alerts (3 more), oldest first within each class', async () => {
  const { w, tg, d, tick } = setup();
  tg.up = false;
  // Forks raised first (the oldest entries overall), then 12 money alerts one minute apart.
  for (let i = 0; i < 5; i++) {
    await sendAlert(d, 'handover_operator_review', { team: hex16(0xf00 + i) });
    w.advance(1_000); // distinct ages: oldest first, not key order
  }
  for (let i = 0; i < 12; i++) {
    w.advance(MIN);
    await sendAlert(d, i % 2 ? 'lease_expired' : 'operator_funded', { team: fixtureTeam, account: 'ca_0123456789abcdef', rental: `r_${hex16(i)}` });
  }
  tg.up = true;
  w.advance(5 * MIN);
  await tick();
  // Round 7: money keeps all 10 slots and team-waiting alerts get up to 3 more (REVIEW-r12-codex.md P2-2), so tick 1
  // sends the 10 oldest money alerts and the 3 oldest handovers; tick 2 the last 2 money alerts and 2 handovers.
  const first = tg.delivered.filter(b => /lease_expired|operator_funded|handover_operator_review/.test(b));
  expect(first.map(labelOf)).toEqual([...Array.from({ length: 10 }, (_, i) => `r_${hex16(i)}`),
    ...Array.from({ length: 3 }, (_, i) => `team:${hex16(0xf00 + i)}`)]);
  const before = tg.delivered.length;
  w.advance(MIN);
  await tick();
  const second = tg.delivered.slice(before).filter(b => /lease_expired|operator_funded|handover_operator_review/.test(b));
  expect(second.map(labelOf)).toEqual([`r_${hex16(10)}`, `r_${hex16(11)}`, `team:${hex16(0xf03)}`, `team:${hex16(0xf04)}`]);
});
