import { computeReleaseGate } from "../_lib/compute/release-gate.js";
import { createHmac, timingSafeEqual } from 'node:crypto';
import { defaultHandlerDeps, type HandlerDeps } from '../_lib/compute/handler.js';
import { fail, json } from '../_lib/http.js';
import { sendAlert } from '../_lib/compute/alerts.js';
import { bill, reconcileDeletion } from '../_lib/compute/billing.js';
import { optionalEnv } from '../_lib/env.js';

/** Signed, small heartbeat from the independent host watchdog. */
export function makeWatchdogHeartbeat(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return async req => {
    if (optionalEnv(deps.env, 'COMPUTE_ENABLED') !== '1') return fail(503, 'compute_not_configured');
    const secret = deps.env.COMPUTE_WATCHDOG_HMAC_SECRET;
    const compute = await deps.compute();
    const store = compute?.store ?? await deps.alertStore?.();
    if (!secret || !store) return fail(503, 'compute_not_configured');
    if (Number(req.headers.get('content-length') ?? 0) > 4096) return fail(400, 'invalid_heartbeat');
    const reader = req.body?.getReader();
    if (!reader) return fail(400, 'invalid_heartbeat');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) { await reader.cancel(); return fail(400, 'invalid_heartbeat'); }
      chunks.push(value);
    }
    const raw = new TextDecoder().decode(Buffer.concat(chunks));
    const sig = req.headers.get('x-walkie-signature') ?? '';
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(sig) || !timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')))
      return fail(403, 'invalid_heartbeat');
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return fail(400, 'invalid_heartbeat'); }
    const report = data as { ts?: unknown; failed_delete_ids?: unknown; invalid_tag_ids?: unknown; deleted?: unknown;
      sweep_id?: unknown; part?: unknown; total?: unknown; group?: unknown; groups?: unknown } | null;
    const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : [];
    const ts = keys.every(key => ['ts', 'failed_delete_ids', 'invalid_tag_ids', 'deleted', 'sweep_id', 'part', 'total', 'group', 'groups'].includes(key)) ? report?.ts : null;
    const batched = report?.sweep_id !== undefined || report?.part !== undefined || report?.total !== undefined || report?.group !== undefined || report?.groups !== undefined;
    const group = report?.group ?? 0, groups = report?.groups ?? 1;
    if (batched && (typeof report?.sweep_id !== 'string' || !/^[0-9a-f]{32}$/.test(report.sweep_id) ||
      !Number.isSafeInteger(report.part) || !Number.isSafeInteger(report.total) || (report.total as number) < 1 ||
      (report.total as number) > 100 || (report.part as number) < 0 || (report.part as number) >= (report.total as number)))
      return fail(400, 'invalid_heartbeat');
    if (!Number.isSafeInteger(group) || !Number.isSafeInteger(groups) || (group as number) < 0 ||
      (groups as number) < 1 || (group as number) >= (groups as number)) return fail(400, 'invalid_heartbeat');
    const validIds = (ids: unknown): ids is number[] => Array.isArray(ids) && ids.length <= 64 &&
      ids.every(id => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length;
    const failed = report?.failed_delete_ids ?? [], invalid = report?.invalid_tag_ids ?? [];
    if (!validIds(failed) || !validIds(invalid)) return fail(400, 'invalid_heartbeat');
    const deleted = report?.deleted ?? [];
    if (!Array.isArray(deleted) || deleted.length > 64 || !deleted.every(item => item && typeof item === 'object' &&
      Object.keys(item).length === 2 && Number.isSafeInteger(item.id) && item.id > 0 &&
      Number.isSafeInteger(item.at) && item.at > 0 && item.at <= (ts as number) + 300_000) ||
      new Set(deleted.map(item => item.id)).size !== deleted.length) return fail(400, 'invalid_heartbeat');
    const now = Date.now();
    if (!Number.isSafeInteger(ts) || Math.abs(now - (ts as number)) > 300_000) return fail(403, 'invalid_heartbeat');
    const counts = await store.tx(async t => {
      await t.lockControl('last_watchdog_heartbeat');
      const previous = await t.control('last_watchdog_heartbeat');
      const batchKey = `watchdog-report:${report?.sweep_id}:${group}`;
      const partial = batched ? await t.control(batchKey) as { part: number; failed: number[]; invalid: number[] } | undefined : undefined;
      if (batched && partial && partial.part >= (report?.part as number)) return null;
      if (!batched && typeof previous === 'number' && previous >= (ts as number)) return null;
      if (batched && (report?.part === 0 ? partial !== undefined : !partial || partial.part + 1 !== report?.part))
        return 'invalid' as const;
      await t.setControl('last_watchdog_heartbeat', typeof previous === 'number' ? Math.max(previous, ts as number) : ts);
      const allFailed = batched ? [...(partial?.failed ?? []), ...failed] : failed;
      const allInvalid = batched ? [...(partial?.invalid ?? []), ...invalid] : invalid;
      const complete = !batched || report?.part === (report?.total as number) - 1;
      if (batched) await t.setControl(batchKey, { part: report?.part, failed: allFailed, invalid: allInvalid });
      const sweepKey = `watchdog-report:${report?.sweep_id}:summary`;
      const summary = complete && batched ? await t.control(sweepKey) as { groups: number; received: number[]; failed: number[]; invalid: number[] } | undefined : undefined;
      if (summary && summary.groups !== groups) return 'invalid' as const;
      const received = complete ? [...(summary?.received ?? []), group as number] : [];
      const sweepFailed = complete ? [...(summary?.failed ?? []), ...allFailed] : [];
      const sweepInvalid = complete ? [...(summary?.invalid ?? []), ...allInvalid] : [];
      const sweepComplete = complete && (!batched || received.length === groups);
      if (complete && batched) await t.setControl(sweepKey, { groups, received, failed: sweepFailed, invalid: sweepInvalid });
      const priorStatus = sweepComplete ? await t.control('last_watchdog_status') as { failed_delete_ids?: number[] } | undefined : undefined;
      if (sweepComplete) await t.setControl('last_watchdog_status', { ts, failed_delete_ids: sweepFailed, invalid_tag_ids: sweepInvalid });
      const nextCounts = new Map<number, number>();
      if (sweepComplete) {
        for (const id of priorStatus?.failed_delete_ids ?? []) {
          if (!sweepFailed.includes(id)) await t.setControl(`watchdog-delete-fail:${id}`, 0);
        }
        for (const id of sweepFailed) {
          const key = `watchdog-delete-fail:${id}`;
          const count = await t.control(key);
          const next = (typeof count === 'number' ? count : 0) + 1;
          await t.setControl(key, next);
          nextCounts.set(id, next);
        }
      }
      if (deleted.length) {
        await t.lockControl('watchdog_deletions');
        const prior = await t.control('watchdog_deletions');
        const existing = prior && typeof prior === 'object' && !Array.isArray(prior) ? prior as Record<string, unknown> : {};
        const kept = Object.entries(existing).filter(([, at]) => typeof at === 'number' && at > now - 24 * 60 * 60_000);
        const merged = Object.fromEntries([...kept, ...deleted.map(item => [String(item.id), item.at])]);
        await t.setControl('watchdog_deletions', Object.fromEntries(Object.entries(merged).slice(-1024)));
      }
      return { nextCounts, failed: sweepComplete ? sweepFailed : [], invalid: sweepComplete ? sweepInvalid : [] };
    });
    if (counts === 'invalid') return fail(400, 'invalid_heartbeat');
    if (!counts) return json({ ok: true });
    if (deleted.length) {
      const removed = new Map<number, number>(deleted.map(item => [item.id, item.at]));
      for (const rental of await store.tx(t => t.activeRentals())) {
        const id = rental.instance_id ? Number(rental.instance_id) : NaN;
        const at = removed.get(id);
        if (!at || rental.instance_id !== String(id) || (rental.started_at !== null && at < rental.started_at)) continue;
        await store.tx(async t => {
          await t.lockAccount(rental.account_id);
          const current = await t.rental(rental.id);
          if (!current || current.instance_id !== rental.instance_id || !['starting', 'running', 'stopping'].includes(current.state)) return;
          const endedAt = Math.min(now, at);
          const billed = await bill(t, current, endedAt);
          await reconcileDeletion(t, billed, endedAt);
          await t.updateRental(current.id, { state: 'ended', ended_at: endedAt, end_reason: 'watchdog_expired', heartbeat_hash: null });
        });
      }
    }
    const alert = { store, env: deps.env, now: () => now, log: compute?.log ?? (() => {}), fetch: deps.alertFetch };
    if (Math.abs(now - (ts as number)) > 60_000) await sendAlert(alert, 'watchdog_clock_skew', { last_tick_at: ts as number });
    for (const id of counts.invalid) await sendAlert(alert, 'watchdog_invalid_tag', { instance: String(id) });
    for (const id of counts.failed) {
      await sendAlert(alert, 'watchdog_delete_failed', { instance: String(id) });
      const count = counts.nextCounts.get(id) ?? 0;
      if (count >= 3) await sendAlert(alert, 'watchdog_delete_persistent', { instance: String(id), attempts: count });
    }
    return json({ ok: true });
  };
}

export async function POST(req: Request): Promise<Response> {
  return computeReleaseGate(process.env) ?? makeWatchdogHeartbeat(defaultHandlerDeps())(req);
}
