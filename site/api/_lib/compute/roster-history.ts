import type { Tx } from './store.js';

export const REMOVED_OWNER_MS = 30 * 24 * 60 * 60_000;
export interface OwnerHistory { readonly admitted_at: number; readonly removed_at?: number }
export type RosterHistory = Readonly<Record<string, OwnerHistory>>;
const key = (team: string) => `enrollment-owner-history:${team}`;

/** Site observation time, never a timestamp supplied by a roster event. */
export async function observeOwners(t: Tx, team: string, owners: readonly string[], now: number): Promise<RosterHistory> {
  const prior = await t.control(key(team)) as RosterHistory | undefined;
  const current = new Set(owners);
  const next: Record<string, OwnerHistory> = { ...(prior ?? {}) };
  for (const owner of current) {
    const old = next[owner];
    next[owner] = old && old.removed_at === undefined ? old : { admitted_at: now };
  }
  for (const [owner, old] of Object.entries(next)) {
    if (!current.has(owner) && old.removed_at === undefined) next[owner] = { ...old, removed_at: now };
  }
  await t.setControl(key(team), next);
  return next;
}

export async function ownerHistory(t: Tx, team: string): Promise<RosterHistory> {
  return (await t.control(key(team)) as RosterHistory | undefined) ?? {};
}

export async function noteFirstFunded(t: Tx, team: string, now: number): Promise<void> {
  const key = `compute-first-funded:${team}`;
  if (typeof await t.control(key) !== 'number') await t.setControl(key, now);
}

export async function firstFunded(t: Tx, team: string): Promise<number | undefined> {
  const value = await t.control(`compute-first-funded:${team}`);
  return typeof value === 'number' ? value : undefined;
}
