import type { ComputeDeps } from './deps.js';
import type { Tx } from './store.js';
import { terminate } from './service.js';
import { bounded, CALL_MS, CONCURRENCY } from './budget.js';

interface Job { readonly key: string; readonly provider: string; readonly instance: string; readonly rental?: string; readonly after: number; readonly attempts: number }
const KEY = 'cleanup_jobs';
const jobs = async (t: Tx): Promise<Job[]> => (await t.control(KEY) as Job[] | undefined) ?? [];
/** The caller has already established ownership. No billing association for surplus or terminal instances. */
export async function enqueueCleanup(t: Tx, provider: string, instance: string, rental?: string): Promise<void> {
  await t.lockControl(KEY);
  const all = await jobs(t), key = rental ? `rental:${rental}` : `${provider}:${instance}`;
  if (!all.some(j => j.key === key)) await t.setControl(KEY, [...all, { key, provider, instance, rental, after: 0, attempts: 0 }]);
}
export async function hasCleanup(d: ComputeDeps): Promise<boolean> { return d.store.tx(async t => (await jobs(t)).length > 0); }

/** Claim moves a job to the tail before I/O. A killed invocation releases its claim by time, fairly across ticks. */
export async function drainCleanup(d: ComputeDeps, deadline: number): Promise<number> {
  const active = await d.store.tx(t => t.activeRentals());
  await d.store.tx(async t => {
    for (const r of active.filter(r => r.state === 'stopping'))
      await enqueueCleanup(t, r.safety?.provider ?? d.config.tiers[r.tier].provider, r.instance_id ?? '', r.id);
  });
  let done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (Date.now() < deadline) {
      const job = await d.store.tx(async t => {
        await t.lockControl(KEY);
        const all = await jobs(t), next = all.find(j => j.after <= d.now());
        if (!next) return null;
        const claimed = { ...next, attempts: next.attempts + 1, after: d.now() + 60_000 };
        await t.setControl(KEY, [...all.filter(j => j.key !== next.key), claimed]);
        return claimed;
      });
      if (!job) return;
      let ok = false;
      try {
        const ms = Math.min(CALL_MS, deadline - Date.now());
        if (job.rental) {
          const r = await d.store.tx(t => t.rental(job.rental!));
          ok = !r || r.state !== 'stopping' || await terminate(d, r, ms);
        } else {
          const driver = d.driver(job.provider);
          if (!driver) throw new Error('provider_unavailable');
          await bounded(signal => driver.terminate(job.instance, signal), ms);
          ok = true;
          d.log('orphan_terminated', { instance: job.instance });
        }
      } catch { d.log('alert_orphan_termination_failed', { instance: job.instance }); }
      if (ok) {
        await d.store.tx(async t => {
          await t.lockControl(KEY);
          await t.setControl(KEY, (await jobs(t)).filter(j => j.key !== job.key));
        });
        done++;
      }
    }
  }));
  return done;
}
