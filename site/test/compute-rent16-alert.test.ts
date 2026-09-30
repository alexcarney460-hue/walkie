import { expect, test } from 'bun:test';
import { sendAlert } from '../api/_lib/compute/alerts.ts';
import type { Env } from '../api/_lib/env.ts';

test('store-unavailable alert uses mock delivery and suppresses immediate repeats', async () => {
  const events: string[] = [], messages: string[] = [];
  const deps = { store: null, env: { COMPUTE_ALERT_TELEGRAM_TOKEN: 'fixture-token',
    COMPUTE_ALERT_TELEGRAM_CHAT: 'fixture-chat' } as Env, now: () => 1790000000000,
    log: (event: string) => { events.push(event); },
    fetch: async (_url: string, init?: RequestInit) => {
      messages.push(String(init?.body));
      return Response.json({ ok: true });
    } };
  await sendAlert(deps, 'compute_state_unavailable', { team: '0123456789abcdef' });
  await sendAlert(deps, 'compute_state_unavailable', { team: '0123456789abcdef' });
  expect(events).toEqual(['alert_compute_state_unavailable', 'alert_compute_state_unavailable']);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('compute_state_unavailable');
});
