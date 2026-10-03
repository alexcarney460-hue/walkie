// Hermes hook observations live in the daemon, so hook processes never coordinate through files.
import { z } from "zod";
import type { Store } from "./store.ts";
import type { BodyOf, Event } from "../protocol/schemas.ts";
import type { StatusProvenance } from "../protocol/status-projection.ts";
import type { StatusCoalescer } from "./status-coalesce.ts";

const PROFILE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const HermesStatusReq = z.object({
  profile: z.string().regex(PROFILE), session: z.string().regex(/^[a-f0-9]{64}$/),
  at: z.number().int().positive().safe(), sequence: z.number().int().nonnegative().safe(),
  pid: z.number().int().positive().safe().optional(),
  state: z.enum(["working", "idle", "offline"]), fallback: z.enum(["working", "idle", "offline"]),
  activity: z.string().max(200).optional(), source: z.enum(["tool", "phrase", "notification", "reply"]).optional(),
});
export type HermesStatus = z.infer<typeof HermesStatusReq>;
type Row = Pick<HermesStatus, "state" | "fallback" | "activity" | "source" | "at"> & { seq: number };
/**
 * Ten minutes from a hook's receipt: how long a quiet working session still counts as live with no pid to tell its process
 * (liveByCensus), and how long an ended row is kept before the sweep may purge it (purgeEndedHermesSessions).
 */
const SESSION_TTL_MS = 10 * 60_000;
/**
 * What the census writes into a row's `source` (no hook sends it: the column is the provenance of the activity text, and a
 * retired row has none left) to mark that its session was retired. Such a row is a guess that its session ended, not an
 * ending a hook reported, so it decides nothing about the profile's card (selectRows).
 */
const RETIRED = "retired";
export const HERMES_PROFILE_CAP = 32;
export const HERMES_TOTAL_CAP = 512;

/**
 * How old a census may be and still count as running, and how long a working row must have been silent for a hook to retire it
 * where none does (applyHermesStatus): twice the TTL, so that the hook only steps in long after the sweep would have.
 */
const CENSUS_STALE_MS = 2 * SESSION_TTL_MS;

/** When the census sweep last ran on a store, as the capture time of the census it used (noteHermesCensus). */
const censusAt = new WeakMap<Store, number>();

/**
 * Records that the census sweep (offlineExitedHermesSessions, purgeEndedHermesSessions) ran on a census captured at `capturedAt`:
 * discovery says so after each sweep. While it keeps doing so, ending rows is the sweep's alone; a hook steps in only where the
 * sweep has not run on a census captured within twice the TTL (discovery turned off, a platform with no process provider, scans that fail).
 */
export function noteHermesCensus(store: Store, capturedAt: number): void {
  censusAt.set(store, capturedAt);
}

/** Whether the census sweep has run on a census captured within twice the TTL before `now`. */
function censusRunning(store: Store, now: number): boolean {
  const capturedAt = censusAt.get(store);
  return capturedAt !== undefined && now - capturedAt <= CENSUS_STALE_MS;
}

/** Both counts are bounded after admission. Prefer retaining working sessions when making room. */
export function pruneHermesSessions(store: Store, profile: string, perProfile = HERMES_PROFILE_CAP, total = HERMES_TOTAL_CAP): void {
  const count = (where: string, args: string[]) => store.db.query<{ n: number }, string[]>(
    `SELECT COUNT(*) AS n FROM hermes_sessions ${where}`,
  ).get(...args)?.n ?? 0;
  const discard = (where: string, args: string[], excess: number) => {
    if (excess <= 0) return;
    store.db.query(`DELETE FROM hermes_sessions WHERE rowid IN (SELECT rowid FROM hermes_sessions ${where}
      ORDER BY CASE WHEN state IN ('idle', 'offline') THEN 0 ELSE 1 END, at, seq, rowid LIMIT ?)`)
      .run(...args, excess);
  };
  discard("WHERE profile = ?", [profile], count("WHERE profile = ?", [profile]) - perProfile);
  discard("", [], count("", []) - total);
}

export interface HermesProcess { pid: number; profile: string | null; startedAt?: number }
interface WorkingRow { profile: string; session: string; pid: number | null; received_at: number }

/**
 * Whether a row's session could be running in one of these processes, by the process census alone. A row whose hook named a
 * pid is owned by that process while it runs (a process that started after the hook is a reused pid), unless it names
 * another profile. The installed Hermes sends no pid, so a row usually is matched by profile instead: it could be owned by a
 * Hermes process that names its profile, or by one that names none (a bare `hermes chat` runs the default, the sticky active
 * or the HERMES_HOME profile, which argv cannot tell). A process that names profile A never owns profile B's row.
 */
function ownersOf(processes: readonly HermesProcess[]): (row: WorkingRow) => boolean {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const named = new Set(processes.flatMap((p) => (p.profile === null ? [] : [p.profile])));
  const unresolved = processes.some((p) => p.profile === null);
  return (row) => {
    if (row.pid === null) return named.has(row.profile) || unresolved;
    const proc = byPid.get(row.pid);
    return !!proc && (proc.profile === null || proc.profile === row.profile) &&
      (proc.startedAt === undefined || proc.startedAt <= row.received_at);
  };
}

/**
 * Whether a working row's process is still running: it is owned (ownersOf), and, with no pid to tell its process, only for as
 * long as it keeps hooking, until ten minutes pass since its last hook (a working session hooks every few seconds).
 */
function liveByCensus(processes: readonly HermesProcess[], capturedAt: number): (row: WorkingRow) => boolean {
  const owns = ownersOf(processes);
  return (row) => owns(row) && (row.pid !== null || capturedAt - row.received_at < SESSION_TTL_MS);
}

/**
 * Retires the working rows received before `before` that `ended` says are over. A retired session is taken to have ended: it
 * shows no current activity (its last tool line must not show on a card that stays idle), and its fallback is offline, so no
 * later hook that changes no row can bring a working card back from it. A hook of that session itself revives the row. Returns
 * the profiles that no longer have a working row: their card is to be recomputed (hermesProfileStatus), since a session that has
 * not ended may still keep it idle. Runs inside its caller's transaction.
 */
function retireWorkingRows(store: Store, before: number, ended: (row: WorkingRow) => boolean): string[] {
  const rows = store.db.query<WorkingRow, [number]>(
    "SELECT profile, session, pid, received_at FROM hermes_sessions WHERE state = 'working' AND received_at < ?",
  ).all(before);
  const mark = store.db.query(`UPDATE hermes_sessions SET state = 'offline', fallback = 'offline', activity = NULL, source = '${RETIRED}'
    WHERE profile = ? AND session = ? AND state = 'working' AND received_at < ?`);
  const changed = new Set<string>();
  for (const row of rows) {
    if (!ended(row)) continue;
    mark.run(row.profile, row.session, before);
    changed.add(row.profile);
  }
  return [...changed].filter((profile) => !store.db.query<{ present: number }, [string]>(
    "SELECT 1 AS present FROM hermes_sessions WHERE profile = ? AND state = 'working' LIMIT 1",
  ).get(profile));
}

/**
 * A successful process census retires the working rows whose process is gone (liveByCensus). Rows received after the census
 * was captured are left alone. Returns the profiles that no longer have a working row: their card is to be
 * recomputed (hermesProfileStatus), since a session that has not ended may still keep it idle.
 */
export function offlineExitedHermesSessions(store: Store, processes: readonly HermesProcess[], capturedAt: number): string[] {
  return store.db.transaction(() => {
    const live = liveByCensus(processes, capturedAt);
    return retireWorkingRows(store, capturedAt, (row) => !live(row));
  })();
}

/**
 * The sweep also purges the rows of sessions that are over. An ended row (not working) is a session at its prompt or one that
 * finished, and its card stays idle for as long as it could be alive: a session at its prompt hooks no more, so that is what the
 * census says (ownersOf), and only once ten minutes have passed since the hook was received (the daemon's clock, never the
 * time the hook claims) and no process could own it does the row go. A row whose fallback is offline says its session ended for
 * good (a finalize, or the census's own retirement): no process owns it, so it goes when its ten minutes have passed. Working
 * rows are the retirement's (a hook's, where no census runs: applyHermesStatus). Only the sweep purges by age: a hook knows no
 * processes, so it deletes nobody's rows.
 * Returns the profiles whose card the purge moved (hermesProfileStatus): a retired row decides nothing, and a finished session's
 * row may not be the one that decides, so a purge can leave a card as it is, and then there is nothing to post.
 */
export function purgeEndedHermesSessions(store: Store, processes: readonly HermesProcess[], capturedAt: number): string[] {
  return store.db.transaction(() => {
    const owns = ownersOf(processes);
    const cutoff = capturedAt - SESSION_TTL_MS;
    const over = store.db.query<WorkingRow & { fallback: string }, [number]>(
      "SELECT profile, session, pid, received_at, fallback FROM hermes_sessions WHERE state != 'working' AND received_at <= ?",
    ).all(cutoff).filter((row) => row.fallback === "offline" || !owns(row));
    const profiles = [...new Set(over.map((row) => row.profile))];
    const cards = () => new Map(profiles.map((profile) => [profile, JSON.stringify(hermesProfileStatus(store, profile))]));
    const before = cards();
    const purge = store.db.query("DELETE FROM hermes_sessions WHERE profile = ? AND session = ? AND state != 'working' AND received_at <= ?");
    for (const row of over) purge.run(row.profile, row.session, cutoff);
    const after = cards();
    return profiles.filter((profile) => before.get(profile) !== after.get(profile));
  })();
}

/** Whether the profile still has a working row that the census keeps live (or one received after the census). */
export function hermesProfileLive(store: Store, profile: string, processes: readonly HermesProcess[], capturedAt: number): boolean {
  const live = liveByCensus(processes, capturedAt);
  return store.db.query<WorkingRow, [string]>(
    "SELECT profile, session, pid, received_at FROM hermes_sessions WHERE profile = ? AND state = 'working'",
  ).all(profile).some((row) => row.received_at >= capturedAt || live(row));
}

type Selected = { working: Row | null; active: Row | null; latest: Row | null };

/** A profile's agent card: the status its hooks and the census sweep publish for it. */
export interface HermesCard { body: BodyOf<"agent.status">; provenance: StatusProvenance }
/** What a hook changes: the card of its profile and, when it moved other profiles' rows (a cap, the expiry), theirs. */
export interface HermesUpdate extends HermesCard {
  /** The cards of other profiles whose rows a cap deleted or whose silent working rows the hook retired, recomputed from the rows that remain. */
  recomputed: HermesCard[];
}

/**
 * The rows that decide a profile's card: its newest working row, its newest row that has not ended, and its newest row
 * that ended on its own, whose fallback is where the card rests. A retired row (see RETIRED) is left out of the last: a
 * session whose process is gone says nothing about a sibling that sits at its prompt (a state=offline / fallback=idle
 * row, which is what Hermes' `on_session_end` after every turn leaves), so that sibling keeps the card idle.
 */
function selectRows(store: Store, profile: string): Selected {
  const select = (condition: string) => store.db.query<Row, [string]>(`SELECT at, seq, state, fallback, activity, source
    FROM hermes_sessions WHERE profile = ? ${condition} ORDER BY at DESC, seq DESC LIMIT 1`).get(profile);
  const working = select("AND state = 'working'");
  const active = working ?? select("AND state != 'offline'");
  const latest = select(`AND source IS NOT '${RETIRED}'`);
  return { working, active, latest };
}

/**
 * A profile's card, the one computation hooks and the census sweep share: working while a session works, idle while one
 * has not ended, else what the newest session that ended on its own left (offline when none did).
 */
function cardOf(profile: string, { working, active, latest }: Selected): HermesCard {
  const state = working ? "working" : active ? "idle" : latest?.fallback ?? "offline";
  const source = working ?? latest;
  const activity = state === "offline" ? undefined : source?.activity ?? undefined;
  return { body: { agent: `hermes-${profile}`, state, runtime: "other", runtime_name: "hermes",
    ...(activity ? { activity } : {}) }, provenance: activity && source?.source ? { activity: source.source } : {} };
}

/**
 * The card a profile shows once the census has retired sessions: the computation a hook gets (applyHermesStatus), from
 * the rows that remain. A working row keeps it working, a row that has not ended keeps it idle, and otherwise it rests
 * where the newest session that ended on its own left it (idle after a turn, offline after a finalize), offline when
 * every row was retired or none is left.
 */
export function hermesProfileStatus(store: Store, profile: string): HermesCard {
  return cardOf(profile, selectRows(store, profile));
}

/** How many rows each profile has. */
function rowsPerProfile(store: Store): Map<string, number> {
  return new Map(store.db.query<{ profile: string; n: number }, []>(
    "SELECT profile, COUNT(*) AS n FROM hermes_sessions GROUP BY profile",
  ).all().map((r) => [r.profile, r.n]));
}

/**
 * Records a hook's observation and returns the card of its profile. While a census runs (noteHermesCensus), a hook deletes and
 * retires no row by age: whether a session is over is the census's to say, and a hook knows no processes, so ending rows
 * (retirement, expiry) is the sweep's (offlineExitedHermesSessions, purgeEndedHermesSessions). A session at its prompt hooks no
 * more, and another profile's hook must not take its row. Where no census has run on one captured within twice the TTL (discovery
 * turned off, a platform with no process provider, a scan that keeps failing), nothing else would ever end a session that died while
 * it worked, and its working row would decide its profile's card for good: the hook then retires the working rows silent for more
 * than twice the TTL, as the sweep would, and hands back the cards it moved. Besides that only the caps delete here, and the cards
 * of the profiles they cost rows are handed back too.
 */
export function applyHermesStatus(store: Store, input: HermesStatus, now = Date.now()): HermesUpdate {
  const event = HermesStatusReq.parse(input);
  const { rows, recomputed } = store.db.transaction(() => {
    const before = rowsPerProfile(store);
    store.db.query(`INSERT INTO hermes_sessions(profile, session, at, seq, state, fallback, activity, source, received_at, pid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(profile, session) DO UPDATE SET
      at=excluded.at, seq=excluded.seq, state=excluded.state, fallback=excluded.fallback,
      activity=excluded.activity, source=excluded.source, received_at=excluded.received_at,
      pid=COALESCE(excluded.pid, hermes_sessions.pid)
      WHERE excluded.at > hermes_sessions.at OR
        (excluded.at = hermes_sessions.at AND excluded.seq > hermes_sessions.seq)`)
      .run(event.profile, event.session, event.at, event.sequence, event.state, event.fallback,
        event.activity ?? null, event.source ?? null, now, event.pid ?? null);
    pruneHermesSessions(store, event.profile);
    const retired = censusRunning(store, now) ? [] : retireWorkingRows(store, now - CENSUS_STALE_MS, () => true);
    // A profile that lost rows to a cap, or its silent working rows to the expiry, no longer matches the card it last published:
    // it is recomputed here (this hook's own profile is, below), so that nothing is left showing a state that no row holds.
    const after = rowsPerProfile(store);
    const lost = [...before].filter(([profile, n]) => (after.get(profile) ?? 0) < n).map(([profile]) => profile);
    const moved = [...new Set([...lost, ...retired])].filter((profile) => profile !== event.profile);
    return { rows: selectRows(store, event.profile), recomputed: moved.map((profile) => hermesProfileStatus(store, profile)) };
  })();
  return { ...cardOf(event.profile, rows), recomputed };
}

/** Whether a status is a Hermes session's: runtime "other", runtime_name "hermes" (what hooks and discovery post; the dashboard shows it view only). */
export function isHermesStatus(status: Pick<BodyOf<"agent.status">, "runtime" | "runtime_name">): boolean {
  return status.runtime === "other" && status.runtime_name === "hermes";
}

/**
 * A card as it may be posted: its activity line, and where that came from, only for a profile that `activityProfiles` (config.json
 * hermes_activity_profiles) lists. Every other profile shows its state only. This is applied where cards are posted, not where rows are
 * written: a row may hold an activity line stored while its profile was listed, and a card computed from it must not show it
 * once the profile is not.
 */
export function shownCard(card: HermesCard, activityProfiles: readonly string[]): HermesCard {
  if (card.body.activity === undefined && card.provenance.activity === undefined) return card;
  if (activityProfiles.includes(card.body.agent.slice("hermes-".length))) return card;
  const { activity: _line, ...body } = card.body;
  return { body, provenance: {} };
}

/**
 * Posts what a hook changed: the cards of other profiles whose rows a cap deleted, then its own (whose event it returns). Each card
 * shows an activity line only if its profile is in `activityProfiles` (shownCard).
 */
export function submitHermesUpdate(statuses: Pick<StatusCoalescer, "submit">, update: HermesUpdate, activityProfiles: readonly string[]): Event | null {
  for (const card of update.recomputed) {
    const shown = shownCard(card, activityProfiles);
    statuses.submit(shown.body.agent, shown.body, shown.provenance);
  }
  const own = shownCard(update, activityProfiles);
  return statuses.submit(own.body.agent, own.body, own.provenance);
}
