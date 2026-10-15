// Round 2 (REVIEW-A-opus.md P3-10): the rental's safety record now carries money fields (unpaid_micros, billing_until),
// so every tick write of it happens under the account lock, the lock billing holds. MemoryStore serializes
// transactions, so this checks lock order inside each transaction rather than racing two of them.
import { expect, test } from 'bun:test';
import { codes, configJson, createAccount, fixtureTeam, idem, MIN, T0, world } from './compute-helpers.ts';
import { rent } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import { parsePrivateConfig } from '../api/_lib/compute/private-config.ts';
import type { ComputeDeps } from '../api/_lib/compute/deps.ts';
import type { ComputeStore, RentalPatch, Tx } from '../api/_lib/compute/store.ts';

/** A store whose transactions record every safety write made before that transaction locked an account. */
function lockSpy(base: ComputeStore): { store: ComputeStore; unlocked: string[] } {
  const unlocked: string[] = [];
  const store: ComputeStore = {
    tx: (fn) => base.tx((t) => {
      let locked = false;
      const proxy = new Proxy(t, {
        get(target, prop) {
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          if (prop === 'lockAccount') return async (id: string) => { locked = true; return target.lockAccount(id); };
          if (prop === 'updateRental') return async (id: string, patch: RentalPatch) => {
            if (patch.safety && !locked) unlocked.push(Object.keys(patch.safety).sort().join(','));
            return target.updateRental(id, patch);
          };
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }) as Tx;
      return fn(proxy);
    }),
  };
  return { store, unlocked };
}

test('paid-tag renewal, its retry and its expiry alert write the safety record under the account lock', async () => {
  const w = world();
  const d: ComputeDeps = { ...w.d, config: parsePrivateConfig(configJson({ cpu: 100, gpu: 100 }, {}, 'digitalocean')), driver: () => w.cloud };
  const a = await createAccount(d, fixtureTeam);
  await w.store.tx(t => t.addLedger({ account_id: a.account_id, kind: 'purchase', live: true, amount_micros: 50_000_000, idem_key: idem(), created_at: T0 }));
  const r = await rent(d, a.account_id, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }],
    codes: codes(1, w.d.now()), walkie_version: 'v0.2.0-pre.17', idle_minutes: 1440 });
  await tick(d);
  const id = r.rentals[0]!.id;
  const due = async (inMinutes: number) => w.store.tx(async t => {
    const cur = (await t.rental(id))!;
    await t.updateRental(id, { state: 'running', last_heartbeat_at: w.d.now(), last_busy_at: w.d.now(),
      safety: { ...cur.safety!, tag_paid_until: w.d.now() + inMinutes * MIN, tag_retry_at: 0 } });
  });
  const spy = lockSpy(w.store);
  const watched: ComputeDeps = { ...d, store: spy.store };
  // A successful renewal.
  w.advance(MIN);
  await due(10);
  await tick(watched);
  expect((await w.store.tx(t => t.rental(id)))!.safety!.tag_paid_until).toBe(w.d.now() + 60 * MIN);
  // A failed renewal close to the deadline: the retry time and the expiry-risk alert.
  w.cloud.setPaidUntil = async () => { throw new Error('fixture tag failure'); };
  w.advance(MIN);
  await due(10);
  await tick(watched);
  const after = (await w.store.tx(t => t.rental(id)))!;
  expect(after.safety!.tag_retry_at).toBe(w.d.now() + 5 * MIN);
  expect(after.safety!.alert).toBe('tag_expiry_risk');
  expect(spy.unlocked).toEqual([]);
});
