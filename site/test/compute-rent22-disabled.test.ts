import { expect, test } from 'bun:test';
import { configJson } from './compute-helpers.ts';
import { computeFromEnv, type HandlerDeps } from '../api/_lib/compute/handler.ts';
import type { ComputeStore } from '../api/_lib/compute/store.ts';
import { makeAccount } from '../api/compute/account.ts';
import { makeCredit } from '../api/compute/credit.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { makeHeartbeat } from '../api/compute/heartbeat.ts';
import { makeLease } from '../api/compute/lease.ts';
import { makeQuotes } from '../api/compute/quotes.ts';
import { makeRent } from '../api/compute/rent.ts';
import { makeStart } from '../api/compute/start.ts';
import { makeState } from '../api/compute/state.ts';
import { makeStop } from '../api/compute/stop.ts';
import { makeTick } from '../api/compute/tick.ts';
import { makeWatchdogHeartbeat } from '../api/compute/watchdog-heartbeat.ts';
import { makeComputeWebhook } from '../api/compute/webhook.ts';

// Compute is fully off only without its private config (or without a store). With COMPUTE_ENABLED unset but the
// config and store present it drains instead (compute-drain.test.ts): state, stop and the tick keep working.
test('DATABASE_URL without the private config permits zero compute store transactions on every route', async () => {
  let transactions = 0;
  const store = { tx: async () => { transactions++; throw Error('disabled compute touched store'); } } as unknown as ComputeStore;
  const env = { DATABASE_URL: 'postgres://127.0.0.1:1/unused',
    COMPUTE_STRIPE_WEBHOOK_SECRET: 'fixture', COMPUTE_WATCHDOG_HMAC_SECRET: 'fixture', CRON_SECRET: 'fixture' };
  const deps: HandlerDeps = { env, compute: () => computeFromEnv(env, store), alertStore: () => store,
    stripe: () => null, licenseStripe: () => null, alertFetch: async () => { throw Error('network'); } };
  const routes = [makeAccount, makeCredit, makeHandover, makeHeartbeat, makeLease, makeQuotes,
    makeRent, makeStart, makeState, makeStop, makeTick, makeWatchdogHeartbeat, makeComputeWebhook];
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('network'); }) as unknown as typeof fetch;
  try {
    for (const route of routes) {
      const response = await route(deps)(new Request('https://site.test/api/compute/test', {
        method: 'POST', headers: { authorization: 'Bearer fixture', 'stripe-signature': 'fixture' }, body: '{}',
      }));
      expect(response.status).toBeGreaterThanOrEqual(200);
    }
    expect(transactions).toBe(0);
  } finally { globalThis.fetch = previous; }
});

test('with the private config and COMPUTE_ENABLED unset, quotes still make no store transaction', async () => {
  let transactions = 0;
  const store = { tx: async () => { transactions++; throw Error('quotes touched store'); } } as unknown as ComputeStore;
  const env = { DATABASE_URL: 'postgres://127.0.0.1:1/unused', COMPUTE_PRIVATE_CONFIG: configJson(),
    COMPUTE_HANDOVER_TOKEN_KEY: 'rent-fixture-handover-key-32-bytes' };
  expect((await computeFromEnv(env, store))?.enabled).toBe(false);
  const deps: HandlerDeps = { env, compute: () => computeFromEnv(env, store), alertStore: () => store, stripe: () => null };
  const response = await makeQuotes(deps)(new Request('https://site.test/api/compute/quotes'));
  expect(((await response.json()) as { available: boolean }).available).toBe(false);
  expect(transactions).toBe(0);
});
