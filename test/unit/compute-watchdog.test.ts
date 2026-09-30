import { test, expect } from 'bun:test';
import { sweep, sendWatchdogReport, deliverWatchdogReport, type WatchdogApi } from '../../scripts/compute-watchdog.ts';
import { makeWatchdogHeartbeat } from '../../site/api/compute/watchdog-heartbeat.ts';
import { MemoryStore } from '../../site/api/_lib/compute/memory-store.ts';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const now = 1_790_000_000;
const created = new Date((now - 3600) * 1000).toISOString();
const ids: number[] = [];
const api: WatchdogApi = { list: async () => ({ next: false, droplets: [
  { id: 1, tags: ['walkie-managed', `wk-paid-until-${now - 1201}`], created_at: created },
  { id: 2, tags: ['walkie-managed', `wk-paid-until-${now - 1200}`], created_at: created },
  { id: 3, tags: ['walkie-managed', 'wk-paid-until-bad'], created_at: created },
  { id: 4, tags: ['walkie-managed'], created_at: new Date((now - 1799) * 1000).toISOString() },
  { id: 5, tags: [`wk-paid-until-${now - 9000}`], created_at: created },
  { id: 6, tags: ['walkie-managed', `wk-paid-until-${now - 9000}`, `wk-paid-until-${now + 300}`], created_at: created },
] }), delete: async id => { ids.push(id); } };

test('provider watchdog dry-runs by default and deletes only exact expired managed ids', async () => {
  expect(await sweep(api, now)).toEqual([1]);
  expect(ids).toEqual([]);
  expect(await sweep(api, now, true)).toEqual([1]);
  expect(ids).toEqual([1]);
});

test('a 1000-machine sweep reaches the site in signed acknowledged parts', async () => {
  const droplets = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1,
    tags: ['walkie-managed', `wk-paid-until-${now - 5000}`], created_at: created }));
  const deleted: { id: number; at: number }[] = [];
  const expired = await sweep({ list: async () => ({ droplets, next: false }), delete: async () => {} }, now, true,
    { deleted: (id, at) => deleted.push({ id, at }) });
  expect(expired).toHaveLength(1000);
  const store = new MemoryStore(), secret = 'fixture-watchdog-secret';
  const handler = makeWatchdogHeartbeat({ env: { COMPUTE_WATCHDOG_HMAC_SECRET: secret, COMPUTE_ENABLED: '1' }, compute: () => null,
    alertStore: () => store, stripe: () => null });
  const responses: number[] = [];
  await sendWatchdogReport({ ts: Date.now(), failed_delete_ids: [], invalid_tag_ids: [], deleted }, secret,
    async req => { const response = await handler(req); responses.push(response.status); return response; });
  expect(responses.length).toBeGreaterThan(1);
  expect(responses.every(status => status === 200)).toBe(true);
  expect(Object.keys((await store.tx(t => t.control('watchdog_deletions'))) as object)).toHaveLength(1000);
  await sendWatchdogReport({ ts: Date.now() + 100, failed_delete_ids: expired, invalid_tag_ids: [], deleted: [] }, secret,
    handler);
  expect(((await store.tx(t => t.control('last_watchdog_status'))) as { failed_delete_ids: number[] }).failed_delete_ids).toHaveLength(1000);
  const largeIds = Array.from({ length: 1000 }, (_, i) => Number.MAX_SAFE_INTEGER - 1000 + i);
  await sendWatchdogReport({ ts: Date.now() + 200, failed_delete_ids: largeIds, invalid_tag_ids: largeIds,
    deleted: largeIds.map(id => ({ id, at: Date.now() })) }, secret, handler);
  expect(((await store.tx(t => t.control('last_watchdog_status'))) as { invalid_tag_ids: number[] }).invalid_tag_ids).toHaveLength(1000);
});

test('failed watchdog delivery keeps the report for a later run', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.watchdog-pending-'));
  const path = join(dir, 'pending.json');
  const report = { ts: Date.now(), failed_delete_ids: [], invalid_tag_ids: [], deleted: [{ id: 7, at: Date.now() - 25 * 60 * 60_000 }] };
  try {
    await expect(deliverWatchdogReport(report, path, 'fixture-secret', async () => new Response('', { status: 503 }))).rejects.toThrow();
    expect(existsSync(path)).toBe(true);
    const store = new MemoryStore();
    const handler = makeWatchdogHeartbeat({ env: { COMPUTE_WATCHDOG_HMAC_SECRET: 'fixture-secret', COMPUTE_ENABLED: '1' }, compute: () => null,
      alertStore: () => store, stripe: () => null });
    await deliverWatchdogReport(null, path, 'fixture-secret', handler);
    expect(existsSync(path)).toBe(false);
    expect((await store.tx(t => t.control('watchdog_deletions')) as Record<string, number>)['7']).toBe(report.deleted[0]!.at);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('3201 failed deletions survive one rejected group and retry without duplicate alerts', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.watchdog-pending-'));
  const path = join(dir, 'pending.json');
  const ids = Array.from({ length: 3201 }, (_, i) => i + 1);
  const store = new MemoryStore(), secret = 'fixture-secret';
  const alerts: string[] = [];
  const handler = makeWatchdogHeartbeat({ env: { COMPUTE_WATCHDOG_HMAC_SECRET: secret, COMPUTE_ENABLED: '1' },
    compute: () => ({ store, log: (event: string, fields: { instance_ref?: string }) => {
      if (event === 'alert_watchdog_delete_failed' && fields.instance_ref) alerts.push(fields.instance_ref);
    } }) as any, stripe: () => null });
  let rejected = false;
  const send = async (req: Request) => {
    const body = await req.clone().json() as { group: number; part: number };
    if (!rejected && body.group === 0 && body.part === 0) { rejected = true; return new Response('', { status: 400 }); }
    return handler(req);
  };
  try {
    await expect(deliverWatchdogReport({ ts: Date.now(), failed_delete_ids: ids, invalid_tag_ids: [], deleted: [] },
      path, secret, send)).rejects.toThrow();
    expect(existsSync(path)).toBe(true);
    const pending = JSON.parse(readFileSync(path, 'utf8')) as { sweep_id: string };
    expect((await store.tx(t => t.control(`watchdog-report:${pending.sweep_id}:1`)) as { part: number }).part).toBe(0);
    await deliverWatchdogReport(null, path, secret, send);
    expect(existsSync(path)).toBe(false);
    expect((await store.tx(t => t.control('last_watchdog_status')) as { failed_delete_ids: number[] }).failed_delete_ids.sort((a, b) => a - b)).toEqual(ids);
    expect(new Set(alerts).size).toBe(3201);
    expect(alerts).toHaveLength(3201);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('far future paid tags are bounded by creation and failed deletes do not stop the sweep', async () => {
  const deleted: number[] = [];
  const invalid: number[] = [], failed: number[] = [];
  const droplets = [
    { id: 11, tags: ['walkie-managed', 'wk-paid-until-999999999999'], created_at: new Date((now - 7200) * 1000).toISOString() },
    { id: 12, tags: ['walkie-managed', `wk-paid-until-${now - 5000}`], created_at: created },
    { id: 13, tags: ['walkie-managed', `wk-paid-until-${now - 5000}`], created_at: created },
    { id: 14, tags: [`wk-paid-until-${now - 5000}`], created_at: created },
  ];
  const expired = await sweep({ list: async () => ({ droplets, next: false }), delete: async id => {
    if (id === 11) throw new Error('provider status 422');
    deleted.push(id);
  } }, now, true, { invalidTag: id => invalid.push(id), deleteFailed: id => failed.push(id) });
  expect(expired).toEqual([11, 12, 13]);
  expect(deleted).toEqual([12, 13]);
  expect(invalid).toEqual([11]);
  expect(failed).toEqual([11]);
});
