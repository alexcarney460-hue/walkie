// The site's own record of which licence subscriptions are bound to which team (lane C round 10). A first compute
// enrollment decides under the team lock from this record, not from Stripe's eventually consistent search: bind writes
// it under the same lock enrollment takes, before its Stripe write, and a one-time operator backfill writes it for the
// licences bound before the lock-ON site. An entry only names a subscription; whether it is live, and which authority
// it names, is read from Stripe at decision time, so a stale or never-completed entry admits nobody.
import type { StripeLike, SubscriptionLite } from '../stripe.js';
import type { ComputeStore, Tx } from './store.js';
import type { ComputeDeps } from './deps.js';
import { TEAM_META } from '../metadata.js';
import { TEAM_ID } from '../license.js';
import { ENDED_STATUSES, LICENCE_READ_MS } from './license-proof.js';
import { alertFromLog, sendAlert, type AlertDeps } from './alerts.js';
import { randomBytes } from 'node:crypto';

export const bindingsKey = (team: string): string => `licence-bindings:${team}`;

/**
 * The deployed first-enrollment licence reads: each Stripe request carries the caller's timeout (the SDK aborts the HTTP
 * request) and no SDK retries. Without the licence key both reject, so a first enrollment fails closed.
 */
export function licenceReads(stripe: Pick<StripeLike, 'listSubscriptionsByTeam' | 'getSubscription'> | null):
  Required<Pick<ComputeDeps, 'teamLicences' | 'licenceById'>> {
  if (!stripe) {
    const unconfigured = async (): Promise<never> => { throw new Error('licence_stripe_unconfigured'); };
    return { teamLicences: unconfigured, licenceById: unconfigured };
  }
  return {
    teamLicences: (team, { timeout }) => stripe.listSubscriptionsByTeam(team, { timeout, maxNetworkRetries: 0 }),
    licenceById: (id, { timeout }) => stripe.getSubscription(id, { timeout, maxNetworkRetries: 0 }),
  };
}
/**
 * {run, lease_at?, cursor, scanned, recorded, overflowed_teams, started_at, rescan?, complete_at?}: the backfill's progress.
 * complete_at is the marker and, once set, is never removed (lane C round 11): the record only gains ids, so a re-scan
 * never closes the gate. lease_at is the running call's lease (round 12).
 */
export const BACKFILL_KEY = 'licence-bindings-backfill';
/** Beyond this many live ids a team is marked overflowed instead (see recordLicenceBindings). */
export const MAX_BINDINGS = 200;
const SUBSCRIPTION = /^sub_[A-Za-z0-9]{1,200}$/;

/** Where pruning a record too large for the first-enrollment reads stands (lane C round 13, ownership.ts). */
export interface PruneState {
  /** The last id the previous batch read: the next batch starts after it, in id order, and wraps. */
  readonly cursor: string;
  /** Ids read and kept (live, not final, or not found) since the last batch that dropped one. */
  readonly kept: number;
}
export interface LicenceRecord { readonly ids: string[]; readonly overflow: boolean; readonly prune?: PruneState }

/** The subscription ids recorded for `team` (empty when none), whether the record overflowed, and its pruning position. */
export async function licenceRecord(t: Tx, team: string): Promise<LicenceRecord> {
  const value = await t.control(bindingsKey(team)) as { subscriptions?: unknown; overflow?: unknown; prune?: unknown } | undefined;
  const ids = Array.isArray(value?.subscriptions) ? value.subscriptions.filter((id): id is string => typeof id === 'string') : [];
  const prune = value?.prune as { cursor?: unknown; kept?: unknown } | undefined;
  return { ids, overflow: value?.overflow === true,
    ...(typeof prune?.cursor === 'string' && typeof prune.kept === 'number' ? { prune: { cursor: prune.cursor, kept: prune.kept } } : {}) };
}
/** The stored form of a record: the ids, and the overflow mark and pruning position when present. */
const stored = (ids: readonly string[], overflow: boolean, prune?: PruneState) =>
  ({ subscriptions: ids, ...(overflow ? { overflow: true } : {}), ...(prune ? { prune } : {}) });
export async function licenceBindings(t: Tx, team: string): Promise<string[]> { return (await licenceRecord(t, team)).ids; }

/**
 * Adds subscription ids to `team`'s record (idempotent). The caller holds `enrollment-chain:<team>`. It never throws for
 * size: a team that would exceed MAX_BINDINGS keeps its ids and is marked overflowed, and its first enrollment then fails
 * closed (licence_bindings_overflow) while every other team, and the backfill, carry on (lane C round 11).
 */
export async function recordLicenceBindings(t: Tx, team: string, ids: readonly string[]): Promise<'recorded' | 'overflow'> {
  const current = await licenceRecord(t, team);
  const next = [...new Set([...current.ids, ...ids.filter(id => SUBSCRIPTION.test(id))])].sort();
  if (next.length > MAX_BINDINGS) {
    if (!current.overflow) await t.setControl(bindingsKey(team), stored(current.ids, true, current.prune));
    return 'overflow';
  }
  if (next.length !== current.ids.length) await t.setControl(bindingsKey(team), stored(next, current.overflow, current.prune));
  return current.overflow ? 'overflow' : 'recorded';
}

/**
 * Drops from `team`'s record the ids a pruning batch read with a final status (lane C round 13). The caller holds
 * `enrollment-chain:<team>`; the record is re-read here, so ids recorded meanwhile stay. `keptReads` (the batch's ids
 * read and kept) adds to the kept count, which restarts at this batch when it dropped anything. The position is
 * compared and set (round 14): when the stored cursor is no longer `from`, the one this batch started at, another attempt
 * has moved on, so the ended ids are still dropped (always safe) but the position and the count are left as stored.
 * Returns how many ids remain, and the kept count.
 */
export async function dropEndedBindings(t: Tx, team: string, ended: readonly string[], from: string | undefined,
  cursor: string | undefined, keptReads: number): Promise<{ remaining: number; kept: number }> {
  const current = await licenceRecord(t, team), gone = new Set(ended);
  const ids = current.ids.filter(id => !gone.has(id));
  const stale = current.prune?.cursor !== from;
  const kept = stale ? current.prune?.kept ?? 0 : ended.length > 0 ? keptReads : (current.prune?.kept ?? 0) + keptReads;
  // (A cursor is undefined only before any position exists and when nothing in this batch's leading run was read.)
  const prune = stale ? current.prune : cursor === undefined ? undefined : { cursor, kept };
  await t.setControl(bindingsKey(team), stored(ids, current.overflow, prune));
  return { remaining: ids.length, kept };
}

/** Whether the one-time backfill has paged through every subscription. */
export async function backfillComplete(t: Tx): Promise<boolean> {
  const state = await t.control(BACKFILL_KEY) as { complete_at?: unknown } | undefined;
  return typeof state?.complete_at === 'number';
}

/**
 * An operator alert from lane C's code without editing alerts.ts: delivered through sendAlert once `kind` is one of its
 * EVENTS, and only logged (as `alert_<kind>`) until then.
 */
export async function raiseLicenceAlert(d: AlertDeps, kind: string, fields: Readonly<Record<string, string>>): Promise<void> {
  const known = alertFromLog(`alert_${kind}`, fields);
  if (known) await sendAlert(d, known, fields);
  else try { d.log(`alert_${kind}`, fields); } catch { /* logging cannot fail the request */ }
}

/**
 * How long a running backfill call's lease lasts after its last progress write (lane C round 12): longer than one page
 * (a 3 s read plus its team writes), so a live call is never taken over; a call that died frees the run after this.
 */
export const BACKFILL_LEASE_MS = 15_000;

export interface BackfillResult {
  readonly complete: boolean; readonly pages: number; readonly scanned: number; readonly recorded: number;
  readonly cursor: string | null;
  /** The teams this scan found over MAX_BINDINGS, each counted once (lane C round 12). */
  readonly overflowed: number; readonly overflowed_teams: readonly string[];
  /** Another call holds the lease: this one read nothing and wrote nothing. Stop and wait for it. */
  readonly busy?: boolean;
  /** This call's lease expired and another call took the run over: it stopped without writing. */
  readonly superseded?: boolean;
}
type BackfillState = { run?: string; lease_at?: number; cursor?: string | null; scanned?: number; recorded?: number;
  overflowed_teams?: string[]; started_at?: number; rescan?: boolean; complete_at?: number };
type BackfillOptions = { now: () => number; budgetMs: number; restart?: boolean;
  log?: (event: string, fields: Record<string, string>) => void };

/** Complete means the marker is set and no re-scan is under way. */
const finished = (state: BackfillState | null | undefined): boolean => state?.complete_at !== undefined && !state.rescan;
const summary = (state: BackfillState | null | undefined, extra: Partial<BackfillResult> = {}): BackfillResult => ({
  complete: finished(state), pages: 0, scanned: state?.scanned ?? 0, recorded: state?.recorded ?? 0, cursor: state?.cursor ?? null,
  overflowed: state?.overflowed_teams?.length ?? 0, overflowed_teams: state?.overflowed_teams ?? [], ...extra });

const leaseLive = (state: BackfillState | undefined, now: number): boolean =>
  state?.lease_at !== undefined && now - state.lease_at < BACKFILL_LEASE_MS;
/**
 * Whether a backfill call holds a live lease right now: the route answers busy before charging the operator's quota
 * (lane C round 13). A call that takes the lease just after this check still gets its busy answer from the backfill.
 */
export async function backfillBusy(store: ComputeStore, now: number): Promise<boolean> {
  return leaseLive((await store.tx(t => t.control(BACKFILL_KEY)) ?? undefined) as BackfillState | undefined, now);
}

/** Takes the lease, unless the backfill is complete (and no restart was asked) or another call holds a live lease. */
async function beginBackfill(store: ComputeStore, run: string, opts: BackfillOptions):
  Promise<{ kind: 'done' | 'busy' | 'run'; state: BackfillState | undefined }> {
  return store.tx(async t => {
    await t.lockControl(BACKFILL_KEY);
    const state = (await t.control(BACKFILL_KEY) ?? undefined) as BackfillState | undefined;
    if (finished(state) && !opts.restart) return { kind: 'done' as const, state };
    if (leaseLive(state, opts.now())) return { kind: 'busy' as const, state };
    const fresh = !state || opts.restart === true;
    const begun: BackfillState = { run, lease_at: opts.now(), cursor: fresh ? null : state.cursor ?? null,
      scanned: fresh ? 0 : state.scanned ?? 0, recorded: fresh ? 0 : state.recorded ?? 0,
      overflowed_teams: fresh ? [] : state.overflowed_teams ?? [], started_at: fresh ? opts.now() : state.started_at ?? opts.now(),
      ...(opts.restart || state?.rescan ? { rescan: true } : {}),
      ...(state?.complete_at !== undefined ? { complete_at: state.complete_at } : {}) };
    await t.setControl(BACKFILL_KEY, begun);
    return { kind: 'run' as const, state: begun };
  });
}

/** After a failed call: frees the lease at once if this call still holds it. */
async function releaseLease(store: ComputeStore, run: string): Promise<void> {
  await store.tx(async t => {
    await t.lockControl(BACKFILL_KEY);
    const { lease_at: _held, ...rest } = (await t.control(BACKFILL_KEY) ?? {}) as BackfillState;
    if (rest.run === run && _held !== undefined) await t.setControl(BACKFILL_KEY, rest);
  });
}

/**
 * One operator backfill call: pages through every subscription with the list API (never the search), from the stored
 * cursor, and records each live one (not ended) that names a team, under that team's lock. Stops at the end of the
 * list (and then sets the marker) or when `budgetMs` is spent, keeping the cursor for the next call.
 * One call runs at a time (lane C round 12): the running call holds a lease, renewed on every page write and released
 * when it returns or fails; meanwhile another call answers `busy` without reading or writing. Only a call whose lease
 * expired (it died, or stalled past BACKFILL_LEASE_MS) can be taken over, and it then stops without writing (`superseded`).
 * The marker, once set, is carried on every write. Idempotent: entries are a set, a call after completion does nothing,
 * and `restart` re-scans from the first subscription (later calls continue it until it completes). Reads Stripe only.
 * A team over MAX_BINDINGS is marked overflowed, counted and alerted once per scan, and the backfill carries on.
 */
export async function backfillLicenceBindings(store: ComputeStore, stripe: Pick<StripeLike, 'listSubscriptionsPage'>,
  opts: BackfillOptions): Promise<BackfillResult> {
  const deadline = Date.now() + opts.budgetMs, run = randomBytes(8).toString('hex');
  const start = await beginBackfill(store, run, opts);
  if (start.kind === 'done') return summary(start.state);
  if (start.kind === 'busy') return summary(start.state, { busy: true });
  const begun = start.state!;
  let cursor = begun.cursor ?? null, scanned = begun.scanned ?? 0, recorded = begun.recorded ?? 0, pages = 0;
  const overflowedTeams = new Set(begun.overflowed_teams);
  const counts = () => ({ pages, scanned, recorded, cursor, overflowed: overflowedTeams.size, overflowed_teams: [...overflowedTeams] });
  try {
    for (;;) {
      const page = await stripe.listSubscriptionsPage(cursor ?? undefined, { timeout: LICENCE_READ_MS, maxNetworkRetries: 0 });
      pages++;
      const byTeam = new Map<string, string[]>();
      for (const sub of page.data as readonly SubscriptionLite[]) {
        const team = sub.metadata?.[TEAM_META];
        if (team && TEAM_ID.test(team) && !ENDED_STATUSES.has(sub.status)) byTeam.set(team, [...(byTeam.get(team) ?? []), sub.id]);
      }
      for (const [team, ids] of byTeam) {
        const outcome = await store.tx(async t => {
          await t.lockControl(`enrollment-chain:${team}`);
          return recordLicenceBindings(t, team, ids);
        });
        if (outcome === 'overflow' && !overflowedTeams.has(team)) {
          overflowedTeams.add(team);
          opts.log?.('licence_bindings_overflow', { team });
        }
        recorded += ids.length;
      }
      scanned += page.data.length;
      cursor = page.data.at(-1)?.id ?? cursor;
      const complete = !page.hasMore, last = complete || Date.now() >= deadline;
      const taken = await store.tx(async t => {
        await t.lockControl(BACKFILL_KEY);
        const current = (await t.control(BACKFILL_KEY) ?? undefined) as BackfillState | undefined;
        if (current?.run !== run) return { state: current }; // taken over: never overwrite another call's progress or marker
        const marker = current.complete_at ?? (complete ? opts.now() : undefined);
        await t.setControl(BACKFILL_KEY, { run, ...(last ? {} : { lease_at: opts.now() }), cursor, scanned, recorded,
          overflowed_teams: [...overflowedTeams], started_at: begun.started_at, ...(!complete && current.rescan ? { rescan: true } : {}),
          ...(marker !== undefined ? { complete_at: marker } : {}) } satisfies BackfillState);
        return null;
      });
      if (taken) return { ...counts(), complete: finished(taken.state), superseded: true };
      if (complete) return { ...counts(), complete: true, cursor: null };
      if (last) return { ...counts(), complete: false };
    }
  } catch (err) {
    await releaseLease(store, run).catch(() => undefined);
    throw err;
  }
}
