// Go-live builder G round 7 (REVIEW-r12-codex.md P2-2, REVIEW-r12-opus.md P3: with 8-10 money alerts per tick plus a
// team-alert flood, round 6's reservation let money lag without bound). Money and abuse alerts keep all 10 per-tick
// retry slots; team-waiting alerts get up to 3 more, so at most 13 sends per tick. Exactly once throughout.
import { expect, test } from 'bun:test';
import { sendAlert } from '../api/_lib/compute/alerts.ts';
import type { HandlerDeps } from '../api/_lib/compute/handler.ts';
import { makeTick } from '../api/compute/tick.ts';
import { fixtureTeam, MIN, world } from './compute-helpers.ts';

const CRON = 'cron-' + 'builder-g7-fixture';
const TG = { COMPUTE_ALERT_TELEGRAM_TOKEN: 'fixt' + 'ure-bot', COMPUTE_ALERT_TELEGRAM_CHAT: 'fixture-chat' };
const tickRequest = () => new Request('https://site.test/api/compute/tick', { headers: { authorization: `Bearer ${CRON}` } });
const hex16 = (i: number) => i.toString(16).padStart(16, '0');
const textOf = (body: string) => (JSON.parse(body) as { text: string }).text;

test('10 money and 5 team alerts arrive every tick for 100 ticks: money at most one tick late, team at 3 per tick, all exactly once', async () => {
  const w = world();
  // Telegram refuses each message the first time it sees it and accepts it after: every raise lands in the queue and
  // every retry is delivered. Records the tick of each delivery and the queued retries sent per tick.
  const seen = new Set<string>(), deliveredAt = new Map<string, number[]>();
  let tickNo = -1, retriesThisTick = 0;
  const fetch = async (_: string, init?: RequestInit) => {
    const text = textOf(String(init?.body));
    if (!seen.has(text)) { seen.add(text); return new Response('bad gateway', { status: 502 }); }
    deliveredAt.set(text, [...(deliveredAt.get(text) ?? []), tickNo]);
    if (/operator_funded|authority_fork/.test(text)) retriesThisTick++;
    return Response.json({ ok: true });
  };
  const d = { store: w.store, env: TG, now: w.d.now, log: () => {}, fetch };
  const deps: HandlerDeps = { env: { ...TG, COMPUTE_ENABLED: '1', CRON_SECRET: CRON }, compute: () => w.d, stripe: () => null, alertFetch: fetch };
  const money: { id: string; tick: number }[] = [], team: string[] = [];
  const teamPerTick: number[] = [], sendsPerTick: number[] = [];
  let m = 0, f = 0;
  const at = (needle: string) => [...deliveredAt].filter(([text]) => text.includes(needle)).flatMap(([, ticks]) => ticks);
  const teamDelivered = () => team.filter(id => at(id).length > 0).length;
  const run = async (t: number) => {
    const before = teamDelivered();
    retriesThisTick = 0;
    w.advance(MIN);
    tickNo = t;
    await makeTick(deps)(tickRequest());
    teamPerTick.push(teamDelivered() - before);
    sendsPerTick.push(retriesThisTick);
  };
  for (let t = 0; t < 100; t++) {
    for (let j = 0; j < 10; j++) {
      const id = `r_${hex16(m++)}`;
      await sendAlert(d, 'operator_funded', { team: fixtureTeam, account: 'ca_0123456789abcdef', rental: id });
      money.push({ id, tick: t });
      w.advance(1);
    }
    for (let j = 0; j < 5; j++) {
      const id = hex16(0xf0000 + f++);
      await sendAlert(d, 'authority_fork', { team: id });
      team.push(id);
      w.advance(1);
    }
    await run(t);
  }
  // After the arrivals stop, the team backlog drains through every free slot.
  for (let t = 100; t < 160; t++) await run(t);
  // Exactly once, every alert.
  for (const id of [...money.map(x => x.id), ...team]) expect([id, at(id).length]).toEqual([id, 1]);
  // Money: delivered on the tick after it was raised (its first retry), never later than one tick beyond that.
  for (const x of money) expect([x.id, at(x.id)[0]! <= x.tick + 1]).toEqual([x.id, true]);
  // Team: exactly 3 per tick while money is saturated, oldest first.
  expect(teamPerTick.slice(0, 100).every(n => n === 3)).toBe(true);
  const order = team.slice().sort((a, b) => at(a)[0]! - at(b)[0]!);
  expect(order.slice(0, 300)).toEqual(team.slice(0, 300));
  // The bound: at most 13 queued retries sent per tick (10 money + 3 team).
  expect(Math.max(...sendsPerTick)).toBe(13);
}, 120_000);
