import type { Tx } from './store.js';

export const CHECKOUT_MS = 23 * 60 * 60_000;
export interface OpenCheckout {
  readonly id: string;
  readonly expires_at: number;
  readonly owner_key: string | null;
  readonly chain_id: string | null;
}
const indexKey = (account: string) => `compute-open-checkouts:${account}`;
const attemptKey = (id: string) => `compute-checkout-attempt:${id}`;

export async function openCheckout(t: Tx, account: string, attempt: OpenCheckout, now: number): Promise<boolean> {
  const prior = await t.control(indexKey(account)) as OpenCheckout[] | undefined;
  const open = (prior ?? []).filter(item => item.expires_at > now);
  if (open.length >= 100) return false;
  await t.setControl(indexKey(account), [...open, attempt]);
  await t.setControl(attemptKey(attempt.id), { ...attempt, account });
  return true;
}

export async function closeCheckout(t: Tx, account: string, id: string): Promise<void> {
  const prior = await t.control(indexKey(account)) as OpenCheckout[] | undefined;
  await t.setControl(indexKey(account), (prior ?? []).filter(item => item.id !== id));
}

export async function checkoutAttempt(t: Tx, id: string): Promise<(OpenCheckout & { account: string }) | null> {
  return await t.control(attemptKey(id)) as (OpenCheckout & { account: string }) | undefined ?? null;
}
