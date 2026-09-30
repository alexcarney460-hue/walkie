import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { makeQuotes } from '../api/compute/quotes.ts';

test('quotes trims COMPUTE_ENABLED before checking live availability', async () => {
  const w = C.world();
  const response = await makeQuotes({ env: { COMPUTE_ENABLED: '1\n' }, compute: () => w.d,
    stripe: () => null })(new Request('https://site.test/api/compute/quotes'));
  expect(response.status).toBe(200);
  expect((await response.json() as { available: boolean }).available).toBe(true);
});
