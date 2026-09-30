import { test, expect } from 'bun:test';
import { makeCredit } from '../api/compute/credit.ts';
import { fixtureTeam, createAccount, world } from './compute-helpers.ts';
test('disabled compute refuses credit without calling payment provider', async () => {
  const w = world();
  const a = await createAccount(w.d, fixtureTeam);
  let calls = 0;
  const handler = makeCredit({ env: {}, compute: () => w.d, stripe: () => ({ createCreditCheckout: async () => { calls++; return { url: 'https://example.test' }; } }) });
  const response = await handler(new Request('https://site.test/api/compute/credit', { method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ block: 50 }) }));
  expect(response.status).toBe(503);
  expect(calls).toBe(0);
});
test('stale monitoring disables both advertised availability and credit checkout', async () => {
  const { makeQuotes } = await import('../api/compute/quotes.ts');
  const w = world(); const a = await createAccount(w.d, fixtureTeam);
  w.advance(180_001);
  let calls = 0;
  const deps = { env: { COMPUTE_ENABLED: '1' }, compute: () => w.d, stripe: () => ({ createCreditCheckout: async () => { calls++; return { url: 'https://example.test' }; } }) };
  const q = await (await makeQuotes(deps)(new Request('https://site.test'))).json() as { available: boolean };
  expect(q.available).toBe(false);
  const response = await makeCredit(deps)(new Request('https://site.test/api/compute/credit', { method: 'POST', headers: { authorization: `Bearer ${a.token}` }, body: JSON.stringify({ block: 50 }) }));
  expect(response.status).toBe(503);
  expect(calls).toBe(0);
});
