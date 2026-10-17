// Go-live builder G round 6 (REVIEW-r11-codex.md P2-2, REVIEW-r11-opus.md P3-7):
// - team-waiting alerts (forks, handovers, licence overflow) cannot starve behind a sustained 10+ due money alerts per
//   tick: 3 of the 10 per-tick retry slots are reserved for them while any are due (unused ones go back to money), and
//   money alerts are delayed at most one tick beyond the money-first order, exactly once throughout;
// - a handover alert with many owners still fits Telegram's 4,096-character message: the owner list is shortened with
//   "+N more" in the message, and the full list stays in the log line.
import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { sendAlert } from '../api/_lib/compute/alerts.ts';
import type { HandlerDeps } from '../api/_lib/compute/handler.ts';
import { makeTick } from '../api/compute/tick.ts';
import { fixtureTeam, MIN, world } from './compute-helpers.ts';

const CRON = 'cron-' + 'builder-g6-fixture';
const TG = { COMPUTE_ALERT_TELEGRAM_TOKEN: 'fixt' + 'ure-bot', COMPUTE_ALERT_TELEGRAM_CHAT: 'fixture-chat' };
const tickRequest = () => new Request('https://site.test/api/compute/tick', { headers: { authorization: `Bearer ${CRON}` } });
const hex16 = (i: number) => i.toString(16).padStart(16, '0');
const textOf = (body: string) => (JSON.parse(body) as { text: string }).text;

test('Codex P2-2: under 12 due money alerts per tick for 100 ticks, team-waiting alerts still go out; money at most one tick late', async () => {
  const w = world();
  // Telegram refuses each message the first time it sees it and accepts it after: every raise lands in the queue, and
  // every retry is delivered. Records the tick of each delivery.
  const seen = new Set<string>(), deliveredAt = new Map<string, number[]>();
  let tickNo = -1;
  const fetch = async (_: string, init?: RequestInit) => {
    const text = textOf(String(init?.body));
    if (!seen.has(text)) { seen.add(text); return new Response('bad gateway', { status: 502 }); }
    deliveredAt.set(text, [...(deliveredAt.get(text) ?? []), tickNo]);
    return Response.json({ ok: true });
  };
  const d = { store: w.store, env: TG, now: w.d.now, log: () => {}, fetch };
  const deps: HandlerDeps = { env: { ...TG, COMPUTE_ENABLED: '1', CRON_SECRET: CRON }, compute: () => w.d, stripe: () => null, alertFetch: fetch };
  const money: string[] = [], team: string[] = [];
  const raiseMoney = async (k: number) => {
    const fields = { team: fixtureTeam, account: 'ca_0123456789abcdef', rental: `r_${hex16(k)}` };
    await sendAlert(d, 'operator_funded', fields);
    money.push(`r_${hex16(k)}`);
    w.advance(1); // distinct ages, raise order = age order
  };
  let k = 0;
  for (let t = 0; t < 100; t++) {
    for (let j = 0; j < 12; j++) await raiseMoney(k++);
    if (t === 0 || t === 50) for (let i = 0; i < 4; i++) {
      const id = hex16(0xf000 + t * 10 + i);
      await sendAlert(d, i % 2 ? 'licence_bindings_overflow' : 'handover_operator_review', { team: id });
      team.push(id);
      w.advance(1);
    }
    w.advance(MIN);
    tickNo = t;
    await makeTick(deps)(tickRequest());
  }
  // Drain what is left (12 arrive per tick, 10 go out).
  for (let t = 100; t < 260; t++) { w.advance(MIN); tickNo = t; await makeTick(deps)(tickRequest()); }
  const at = (needle: string) => [...deliveredAt].filter(([text]) => text.includes(needle)).flatMap(([, ticks]) => ticks);
  // Exactly once, every alert.
  for (const id of [...money, ...team]) expect([id, at(id).length]).toEqual([id, 1]);
  // Team-waiting alerts go out within two ticks of being queued (3 reserved slots per tick), not after the money drains.
  for (const id of team.slice(0, 4)) expect(at(id)[0]!).toBeLessThanOrEqual(1);
  for (const id of team.slice(4)) expect(at(id)[0]!).toBeLessThanOrEqual(51);
  // Money-first order gives money alert k (oldest first) tick floor(k / 10); the reservation costs it at most one tick.
  money.forEach((id, index) => expect([id, at(id)[0]! <= Math.floor(index / 10) + 1]).toEqual([id, true]));
}, 120_000);

test('with no team-waiting alert due money gets its 10 slots; with light money team-waiting alerts fill the free slots plus 3 more', async () => {
  const w = world();
  const tg = { up: false, delivered: [] as string[] };
  const fetch = async (_: string, init?: RequestInit) => {
    if (!tg.up) return new Response('bad gateway', { status: 502 });
    tg.delivered.push(textOf(String(init?.body)));
    return Response.json({ ok: true });
  };
  const d = { store: w.store, env: TG, now: w.d.now, log: () => {}, fetch };
  const deps: HandlerDeps = { env: { ...TG, COMPUTE_ENABLED: '1', CRON_SECRET: CRON }, compute: () => w.d, stripe: () => null, alertFetch: fetch };
  for (let i = 0; i < 15; i++) { await sendAlert(d, 'operator_funded', { team: fixtureTeam, account: 'ca_0123456789abcdef', rental: `r_${hex16(i)}` }); w.advance(1); }
  tg.up = true;
  w.advance(2 * MIN);
  await makeTick(deps)(tickRequest());
  expect(tg.delivered.filter(t => t.includes('operator_funded'))).toHaveLength(10);
  // Two money alerts and twenty team-waiting alerts due: the ten money-first slots are filled (2 money, 8 team) and,
  // since round 7, up to 3 more team-waiting alerts go on top: 13 in all.
  tg.up = false;
  const w2 = world();
  const d2 = { ...d, store: w2.store, now: w2.d.now };
  for (let i = 0; i < 2; i++) await sendAlert(d2, 'operator_funded', { team: fixtureTeam, account: 'ca_0123456789abcdef', rental: `r_${hex16(i)}` });
  for (let i = 0; i < 20; i++) await sendAlert(d2, 'authority_fork', { team: hex16(0xa00 + i) });
  tg.up = true;
  tg.delivered.length = 0;
  w2.advance(2 * MIN);
  await makeTick({ ...deps, compute: () => w2.d })(tickRequest());
  expect(tg.delivered.filter(t => t.includes('operator_funded'))).toHaveLength(2);
  expect(tg.delivered.filter(t => t.includes('authority_fork'))).toHaveLength(11);
});

test('Opus P3-7: a handover alert with 200 owners fits Telegram (4,096 characters, "+N more"); the log line keeps all 200', async () => {
  const owners = Array.from({ length: 200 }, () => randomBytes(32).toString('base64'));
  const sent: string[] = [], logs: { event: string; fields: Record<string, unknown> }[] = [];
  const d = { store: null, env: TG, now: () => 1_795_000_000_000, log: (event: string, fields: Record<string, unknown>) => { logs.push({ event, fields }); },
    fetch: async (_: string, init?: RequestInit) => { sent.push(textOf(String(init?.body))); return Response.json({ ok: true }); } };
  await sendAlert(d, 'handover_operator_review', { team: randomBytes(8).toString('hex'), chain: 'c'.repeat(64), old_chain: 'd'.repeat(64),
    eligible_owners: owners.join(','), acknowledged_by: '', objected_by: '' });
  expect(sent).toHaveLength(1);
  const text = sent[0]!;
  expect(text.length).toBeLessThanOrEqual(4096);
  expect(text).toMatch(/"eligible_owners":"/);
  const shown = /"eligible_owners":"([^"]*)"/.exec(text)![1]!.split(',');
  const more = /^\+(\d+) more$/.exec(shown[shown.length - 1]!);
  expect(more).not.toBeNull();
  const listed = shown.slice(0, -1);
  expect(listed).toEqual(owners.slice(0, listed.length));
  expect(listed.length + Number(more![1])).toBe(200);
  expect(listed.length).toBeGreaterThan(50);
  expect(logs.find(l => l.event === 'alert_handover_operator_review')!.fields.eligible_owners).toBe(owners.join(','));
});

test('a handover alert that already fits is sent unchanged', async () => {
  const owners = Array.from({ length: 5 }, () => randomBytes(32).toString('base64'));
  const sent: string[] = [];
  const d = { store: null, env: TG, now: () => 1_796_000_000_000, log: () => {},
    fetch: async (_: string, init?: RequestInit) => { sent.push(textOf(String(init?.body))); return Response.json({ ok: true }); } };
  await sendAlert(d, 'handover_operator_review', { team: randomBytes(8).toString('hex'), chain: 'e'.repeat(64), eligible_owners: owners.join(',') });
  expect(sent[0]).toContain(`"eligible_owners":"${owners.join(',')}"`);
  expect(sent[0]).not.toContain('more');
});
