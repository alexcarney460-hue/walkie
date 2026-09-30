import { test, expect } from 'bun:test';
import { chainRelation } from '../api/_lib/compute/team-proof.ts';

const genesis = 'a'.repeat(64), transfer = 'b'.repeat(64);

test('only complete digest chains can be related', () => {
  const current = { depth: 0, chainId: genesis, chain: [genesis] };
  expect(chainRelation(current, { chain: [genesis] })).toBe('equal');
  expect(chainRelation(current, { chain: [genesis, transfer] })).toBe('extends');
  expect(chainRelation({ depth: 0, chainId: 'node:1' }, { chain: ['node:1'] })).toBe('conflict');
  expect(chainRelation({ depth: 0, chainId: genesis }, { chain: [genesis] })).toBe('conflict');
  expect(chainRelation(current, { chain: ['node:1'] })).toBe('conflict');
  expect(chainRelation({ depth: 1, chainId: transfer, chain: [genesis, 'node:2'] },
    { chain: [genesis, 'node:2'] })).toBe('conflict');
});
