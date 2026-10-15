// One minute tick's account-row discipline (lane H rounds 2-4, pre.17 reviews): every pass that locks an account row
// waits at most a bound for it, and an account found busy (its row held past the bound) waits alone: every later pass
// of the same tick skips it without waiting again, while the other accounts' work and the tick's health record go on.
// A run of busy billing passes is counted per account and raises account_busy.
import type { ComputeDeps } from './deps.js';
import { isBusy, type TxOptions } from './store.js';

/** A tick transaction waits at most this long (or one call budget, if shorter) for a lock: then the account is busy. */
export const TICK_LOCK_MS = 2_000;
/** Consecutive busy billing passes after which an account raises account_busy (then every 60 passes while it lasts). */
export const BUSY_ALERT_PASSES = 3;
const BUSY_KEY = 'compute-busy-accounts';

/** The bounds of the tick's account-row transactions: lock waits as above, no statement longer than one call budget. */
export function tickBounds(callMs: number): TxOptions {
  return { lockTimeoutMs: Math.min(TICK_LOCK_MS, callMs), statementTimeoutMs: callMs };
}

/** The accounts found busy so far in this tick, and the bounds every account-row transaction of the tick runs under. */
export interface TickPass {
  readonly busy: Set<string>;
  readonly bounds: TxOptions;
}
export function newTickPass(callMs: number): TickPass {
  return { busy: new Set(), bounds: tickBounds(callMs) };
}

/**
 * Runs one account-row step under the tick's bounds. An account already found busy in this tick is skipped without
 * waiting (unless `evenIfBusy`: a step that must still try, such as a provider deletion whose record may wait); one
 * found busy now is remembered and logged once (`compute_account_busy`). Anything but a busy refusal is thrown.
 * Returns undefined when the step did not run to completion because of the account's row.
 */
export async function onAccount<T>(d: ComputeDeps, pass: TickPass, account: string, step: (bounds: TxOptions) => Promise<T>,
    opts: { readonly evenIfBusy?: boolean } = {}): Promise<T | undefined> {
  if (pass.busy.has(account) && !opts.evenIfBusy) return undefined;
  try { return await step(pass.bounds); }
  catch (err) {
    if (!isBusy(err)) throw err;
    if (!pass.busy.has(account)) d.log('compute_account_busy', { account });
    pass.busy.add(account);
    return undefined;
  }
}

/**
 * Keeps a busy account's backlog visible: counts each active account's consecutive busy billing passes in one control
 * row and raises account_busy at BUSY_ALERT_PASSES and every 60 passes after. A billed account starts again at 0; an
 * account no longer active is dropped (its next busy run counts from 1); an active account the deadline left unvisited
 * keeps its count. A tick with nothing busy, now or before, reads the row and writes nothing.
 */
export async function noteBusy(d: ComputeDeps, pass: TickPass, active: readonly string[], billed: ReadonlySet<string>): Promise<void> {
  const busyActive = active.filter(id => pass.busy.has(id));
  const counts = (stored: unknown): Readonly<Record<string, number>> =>
    stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, number> : {};
  let raised: (readonly [string, number])[] = [];
  try {
    raised = await d.store.tx(async t => {
      if (!busyActive.length && !Object.keys(counts(await t.control(BUSY_KEY))).length) return [];
      await t.lockControl(BUSY_KEY);
      const prior = counts(await t.control(BUSY_KEY));
      const next: Record<string, number> = {};
      for (const id of active) {
        if (pass.busy.has(id)) next[id] = (typeof prior[id] === 'number' ? prior[id] : 0) + 1;
        else if (!billed.has(id) && typeof prior[id] === 'number') next[id] = prior[id];
      }
      if (JSON.stringify(next) !== JSON.stringify(prior)) await t.setControl(BUSY_KEY, Object.keys(next).length ? next : null);
      return busyActive.map(id => [id, next[id]!] as const);
    }, pass.bounds);
  } catch (err) {
    if (!isBusy(err)) throw err;
    d.log('compute_busy_count_busy', {}); // the counter row itself is held: it counts on the next tick
  }
  for (const [account, passes] of raised)
    if (passes === BUSY_ALERT_PASSES || (passes > BUSY_ALERT_PASSES && passes % 60 === 0))
      d.log('alert_account_busy', { account, attempts: passes });
}
