import { test, expect } from 'bun:test';
import { DigitalOceanDriver } from '../api/_lib/compute/digitalocean.ts';
test('accepted DELETE is not confirmation while provider still lists the machine', async () => {
  const calls: string[] = [];
  const driver = new DigitalOceanDriver('x'.repeat(32), async (_url, init) => {
    calls.push(init.method ?? 'GET');
    return init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ droplet: { id: 1 } });
  });
  let rejected = false;
  try { await driver.terminate('1'); } catch { rejected = true; }
  expect(rejected).toBe(true);
  expect(calls).toEqual(['DELETE', 'GET']);
});
