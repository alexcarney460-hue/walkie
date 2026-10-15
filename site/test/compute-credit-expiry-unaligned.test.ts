// Lane H round 2 (REVIEW-pre17-opus.md P2-4, the reviewer's probe zz-m03 committed): "only lots unexpired at the
// burn's own time pay" on ticks that are NOT aligned to the expiry. The rental starts 5 min 20 s before the old lot
// expires and ticks run 10 s before and 50 s after it, so minute 7 starts 40 s after the expiry and is billed by the
// same tick that settles the old lot: it must be paid from the unexpired lot. Removing the expiry check in
// lots.ts `allocate` fails this test.
import { expect, test } from 'bun:test';
import { CREDIT_LIFETIME_MS } from '../api/_lib/compute/lots.ts';
import { rent, T0 } from './compute-helpers.ts';
import { account, agentReq, alive, buy, DAY, jump, ledger, MIN, tick, world } from './compute-credit-expiry-helpers.ts';

test('a minute started after a lot expired, billed by the tick that settles the lot, is paid from the unexpired lot', async () => {
  const w = world({ quotas: { cpu: 1, gpu: 16 } });
  const a = await account(w);
  const old = await buy(w, a, 50_000_000, { at: T0 });
  const fresh = await buy(w, a, 5_000_000, { at: T0 + DAY });
  const T = T0 + CREDIT_LIFETIME_MS;
  await jump(w, CREDIT_LIFETIME_MS - 5 * MIN - 20_000);
  const id = (await rent(w.d, a, agentReq(w.d.now()))).rentals[0]!.id;
  await alive(w, id);
  w.advance(70_000);
  await tick(w.d);
  for (let i = 0; i < 5; i++) { await alive(w, id); w.advance(MIN); await tick(w.d); }
  const burns = ledger(w, a).filter(e => e.kind === 'burn');
  const late = burns.filter(e => e.created_at >= T);
  expect(late.length).toBeGreaterThan(0);
  expect(late.every(e => e.lot === fresh)).toBe(true);
  expect(burns.filter(e => e.lot === old).every(e => e.created_at < T)).toBe(true);
});
