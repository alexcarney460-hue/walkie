import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { liftExpiredHandover, rejectedHandover, rejectedHandoverDigest } from '../api/_lib/compute/handover.ts';

test('lifting expired descendant does not lift an explicitly rejected ancestor digest', async () => {
  const w = C.world(), team = '0123456789abcdef', key = C.generateKeys().pubkey;
  const root = 'a'.repeat(64), rejected = 'b'.repeat(64), expired = 'c'.repeat(64);
  const old = { depth: 0, chainId: root, chain: [root] };
  const proposed = { depth: 2, chainId: expired, chain: [root, rejected, expired] };
  await w.store.tx(async t => {
    await t.setControl(`compute-handover-expired:${team}`, [`${expired}:${key}`]);
    await t.setControl(`compute-handover-rejected:${team}`, [root, rejected, expired, `${root}:${key}`]);
    await t.setControl(`compute-handover-rejected-digests:${team}`, [rejected, expired]);
    await t.setControl(`compute-handover-explicit-rejected:${team}`, [`${rejected}:${C.generateKeys().pubkey}`]);
  });
  expect(await w.store.tx(t => liftExpiredHandover(w.d, t, team, expired, key))).toBe(true);
  expect(await w.store.tx(t => rejectedHandoverDigest(t, team, proposed, 1, key))).toBe(rejected);
  expect(await w.store.tx(t => rejectedHandover(t, team, old, proposed, key))).toBe(true);
});
