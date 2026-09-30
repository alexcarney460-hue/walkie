import { expect, test } from 'bun:test';
import { authorityPathMetadata, readAuthorityPath } from '../api/_lib/metadata.ts';

test('the full 100-entry authority chain fits Stripe metadata and round trips', () => {
  const chain = Array.from({ length: 100 }, (_, i) => i.toString(16).padStart(64, '0'));
  const metadata = authorityPathMetadata(chain);
  expect(Object.keys(metadata)).toHaveLength(17);
  expect(Object.values(metadata).every(chunk => chunk.length <= 400)).toBe(true);
  expect(readAuthorityPath(metadata)).toEqual(chain);
  expect(readAuthorityPath(authorityPathMetadata(chain.slice(0, 1)))).toEqual(chain.slice(0, 1));
  expect(() => authorityPathMetadata([...chain, ...chain])).toThrow('authority_chain_metadata_limit');
});
