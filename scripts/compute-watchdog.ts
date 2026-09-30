/** Independent DigitalOcean rental expiry. */
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
const API = 'https://api.digitalocean.com/v2';
const PAID = /^wk-paid-until-([0-9]{1,12})$/;
export const GRACE_SECONDS = 20 * 60;
export const MAX_HORIZON_SECONDS = 60 * 60;
export const CLOCK_SKEW_SECONDS = 10 * 60;

export interface Droplet { id: number; tags?: unknown; created_at?: unknown }
export interface WatchdogApi {
  list(page: number): Promise<{ droplets: Droplet[]; next: boolean }>;
  delete(id: number): Promise<void>;
}
export interface SweepHooks { invalidTag?: (id: number) => void; deleteFailed?: (id: number) => void; deleted?: (id: number, at: number) => void }
export interface WatchdogReport { ts: number; failed_delete_ids: number[]; invalid_tag_ids: number[]; deleted: { id: number; at: number }[]; sweep_id?: string }

/** Every part is independently signed and awaited before the next part is sent. */
export async function sendWatchdogReport(report: WatchdogReport, secret: string, send: (req: Request) => Promise<Response>): Promise<number> {
  const chunk = 32;
  const parts = Math.max(1, Math.ceil(Math.max(report.failed_delete_ids.length, report.invalid_tag_ids.length, report.deleted.length) / chunk));
  const groups = Math.ceil(parts / 100);
  const sweep_id = report.sweep_id ?? randomBytes(16).toString('hex');
  let latest = report.ts;
  let failed = false;
  for (let group = 0; group < groups; group++) {
    const total = Math.min(100, parts - group * 100);
    for (let part = 0; part < total; part++) {
    const offset = (group * 100 + part) * chunk;
    const ts = Math.max(Date.now(), latest + 1);
    const body = JSON.stringify({ ts, sweep_id, group, groups, part, total,
      failed_delete_ids: report.failed_delete_ids.slice(offset, offset + chunk),
      invalid_tag_ids: report.invalid_tag_ids.slice(offset, offset + chunk),
      deleted: report.deleted.slice(offset, offset + chunk) });
    if (Buffer.byteLength(body) > 4096) throw new Error('watchdog report part too large');
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    const response = await send(new Request('https://site.test/api/compute/watchdog-heartbeat', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-walkie-signature': signature }, body }));
    if (!response.ok) { failed = true; break; }
    latest = ts;
    }
  }
  if (failed) throw new Error('watchdog heartbeat delivery failed');
  return latest;
}

/** Keep a deleted-machine report until every signed part has been acknowledged. */
export async function deliverWatchdogReport(report: WatchdogReport | null, pendingPath: string, secret: string,
  send: (req: Request) => Promise<Response>): Promise<number> {
  let latest = 0;
  if (existsSync(pendingPath)) {
    const prior = JSON.parse(readFileSync(pendingPath, 'utf8')) as WatchdogReport;
    latest = await sendWatchdogReport({ ...prior, ts: Math.max(Date.now(), prior.ts + 100) }, secret, send);
    unlinkSync(pendingPath);
  }
  if (!report) return latest;
  report = { ...report, ts: Math.max(report.ts, latest + 1), sweep_id: report.sweep_id ?? randomBytes(16).toString('hex') };
  const temp = `${pendingPath}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(report), { mode: 0o600 });
  renameSync(temp, pendingPath);
  latest = await sendWatchdogReport(report, secret, send);
  unlinkSync(pendingPath);
  return latest;
}

export async function sweep(api: WatchdogApi, nowSeconds: number, apply = false, hooks: SweepHooks = {}): Promise<number[]> {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) throw new Error('invalid time');
  const expired: number[] = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await api.list(page);
    for (const droplet of batch.droplets) {
      if (!droplet || typeof droplet !== 'object' || !Number.isSafeInteger(droplet.id) || droplet.id <= 0 || !Array.isArray(droplet.tags) ||
          !droplet.tags.includes('walkie-managed')) continue;
      const paidTags = droplet.tags.filter((t): t is string => typeof t === 'string' && t.startsWith('wk-paid-until-'));
      // Renewal attaches the new tag before removing the old one. Honor the newest deadline.
      const deadlines = paidTags.map(tag => PAID.exec(tag)).filter((m): m is RegExpExecArray => m !== null)
        .map(m => Number(m[1])).filter(n => Number.isSafeInteger(n) && n > 0);
      const valid = deadlines.filter(n => n <= nowSeconds + MAX_HORIZON_SECONDS + CLOCK_SKEW_SECONDS);
      if (deadlines.length !== valid.length || (paidTags.length && !deadlines.length)) hooks.invalidTag?.(droplet.id);
      const created = typeof droplet.created_at === 'string' ? Date.parse(droplet.created_at) / 1000 : NaN;
      const paidUntil = valid.length ? Math.max(...valid) : Number.isFinite(created) ? created + MAX_HORIZON_SECONDS : NaN;
      const stale = Number.isFinite(paidUntil) && nowSeconds > paidUntil + GRACE_SECONDS;
      if (!stale) continue;
      expired.push(droplet.id);
    }
    if (!batch.next) {
      const ids = [...new Set(expired)];
      if (apply) for (const id of ids) {
        try { await api.delete(id); hooks.deleted?.(id, Date.now()); } catch { hooks.deleteFailed?.(id); }
      }
      return ids;
    }
  }
  throw new Error('pagination limit reached');
}

export function digitalOceanApi(token: string, fetchFn: typeof fetch = fetch): WatchdogApi {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new Error('invalid provider token');
  const call = async (path: string, method = 'GET') => {
    const response = await fetchFn(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!response.ok && !(method === 'DELETE' && response.status === 404)) throw new Error(`provider status ${response.status}`);
    return response;
  };
  return {
    async list(page) {
      const response = await call(`/droplets?tag_name=walkie-managed&per_page=200&page=${page}`);
      const body = await response.json() as { droplets?: unknown; links?: { pages?: { next?: unknown } } };
      if (!Array.isArray(body.droplets)) throw new Error('invalid provider listing');
      return { droplets: body.droplets as Droplet[], next: !!body.links?.pages?.next };
    },
    async delete(id) {
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('invalid droplet id');
      await call(`/droplets/${id}`, 'DELETE');
    },
  };
}

if (import.meta.main) {
  const path = process.env.COMPUTE_WATCHDOG_TOKEN_FILE;
  if (!path) throw new Error('COMPUTE_WATCHDOG_TOKEN_FILE missing');
  const token = readFileSync(path, 'utf8').trim();
  const apply = process.argv.includes('--apply');
  const secret = process.env.COMPUTE_WATCHDOG_HMAC_SECRET;
  const origin = process.env.COMPUTE_SITE_ORIGIN;
  if (!secret || !origin) throw new Error('watchdog heartbeat configuration missing');
  const send = (req: Request) => fetch(new URL('/api/compute/watchdog-heartbeat', origin), { method: 'POST', headers: req.headers,
    body: req.body, signal: AbortSignal.timeout(10_000) });
  const pendingPath = `${path}.pending-report`;
  const lastReportTs = await deliverWatchdogReport(null, pendingPath, secret, send);
  const invalid_tag_ids: number[] = [], failed_delete_ids: number[] = [];
  const deleted: { id: number; at: number }[] = [];
  const ids = await sweep(digitalOceanApi(token), Math.floor(Date.now() / 1000), apply, {
    invalidTag: id => { invalid_tag_ids.push(id); console.error(JSON.stringify({ event: 'invalid_paid_tag', id })); },
    deleteFailed: id => { failed_delete_ids.push(id); console.error(JSON.stringify({ event: 'watchdog_delete_failed', id })); },
    deleted: (id, at) => { deleted.push({ id, at }); },
  });
  const ts = Math.max(Date.now(), lastReportTs + 1);
  await deliverWatchdogReport({ ts, failed_delete_ids, invalid_tag_ids, deleted }, pendingPath, secret, send);
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', expired_ids: ids }));
}
