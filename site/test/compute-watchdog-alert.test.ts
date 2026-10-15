// Go-live fix round, lane A (REVIEW-opus.md P2-5): the independent watchdog is not installed yet, and every tick used
// to raise alert_watchdog_stale (Telegram every 30 minutes, all day). It now alerts once per UTC day for one stale
// episode, and at once when a new episode starts (the watchdog came back, then went quiet again).
import { expect, test } from 'bun:test';
import { MIN, world } from './compute-helpers.ts';
import { tick } from '../api/_lib/compute/tick.ts';

test('a missing watchdog alerts once per UTC day, and again at once when a new stale episode starts', async () => {
  const w = world();
  const stale = () => w.logs.filter(x => x.event === 'alert_watchdog_stale').length;
  await tick(w.d);
  expect(stale()).toBe(1);
  for (let i = 0; i < 90; i++) { w.advance(MIN); await tick(w.d); }
  expect(stale()).toBe(1);
  // The next UTC day reminds once.
  const nextDay = (Math.floor(w.d.now() / 86_400_000) + 1) * 86_400_000;
  w.advance(nextDay - w.d.now() + MIN);
  await tick(w.d);
  await tick(w.d);
  expect(stale()).toBe(2);
  // The watchdog comes back, then goes quiet again: a new episode alerts once, without waiting a day.
  await w.store.tx(t => t.setControl('last_watchdog_heartbeat', w.d.now()));
  w.advance(10 * MIN);
  await tick(w.d);
  expect(stale()).toBe(2);
  w.advance(11 * MIN);
  await tick(w.d);
  await tick(w.d);
  expect(stale()).toBe(3);
});
