import { createHash } from "node:crypto";
import { canonicalJson } from "../../protocol/canonical.ts";
import {
  fleetPictureKey, fleetSummaryDecision, fleetSummaryText, isLimitingFactor,
  type FleetSummaryRow, type LimitingFactor,
} from "../../protocol/fleet-capacity.ts";
import { redactSecrets } from "../../protocol/safety.ts";
import { SCHEDULE_CHANNEL } from "../../protocol/talkie-schedule.ts";
import type { Core } from "../core.ts";
import { memberByHandle } from "../roster.ts";

export const SUMMARY_COOLDOWN_MS = 60 * 60_000;
/** How far back the one marker query looks. Older than this, and with no local copy, the picture can be posted once more. */
export const SUMMARY_MARKER_WINDOW_MS = 60 * 24 * 3_600_000;
const META = "talkie_capacity_summary_v1";
const PREFIX = "walkie-talkie-capacity-summary:v1:";
/**
 * How many newest marker rows the repair read looks at. The common case is one query for the newest row: when that
 * row parses and its time is within the skew, nothing older is read. When that row is unreadable or past the skew,
 * one more query reads this many and keeps the newest that counts. More unreadable rows than this hides a valid
 * older one. Neither query reads the whole channel.
 */
export const SUMMARY_MARKER_ROWS = 8;
/**
 * How far a marker time may sit ahead of the earlier of this clock and when this daemon stored the post.
 * Ten minutes keeps a reader a few minutes slow from treating an honest marker as future. Past this, the time is a
 * wrong clock's and is ignored. On top of the hour cooldown, trusting a stamp inside this window waits at most this long.
 */
export const SUMMARY_CLOCK_SKEW_MS = 10 * 60_000;
/** The newest few person-signed markers, with when this daemon stored each. The prefix filter is what finds them under ordinary schedule posts. */
const MARKER_SQL = `SELECT json, received_at FROM events WHERE channel = ? AND +kind = 'msg.post' AND redacted = 0 AND status = 'ok' AND author_agent IS NULL
  AND ts > ? AND json_extract(body, '$.text') LIKE ? ORDER BY ts DESC LIMIT ?`;
const SUMMARY_TEXT_MAX = 1_800;
/** Per machine on the marker: node id, the limit, free seats, score. No hostname. Older markers omit the list. */
const MARKER_MACHINES_MAX = 64;
export interface CapacitySnapshot {
  machines: readonly { node: string; online: boolean }[];
  seats: readonly { node: string; free: number | null }[];
  accounts: readonly { key: string; state: string; windows: readonly { kind: string; scope: string | null; used_pct: number }[] }[];
}
export interface PostedMachine { node: string; factor: LimitingFactor; free_slots: number; score: number; seats_hidden?: boolean }
export interface PostedSummary { fingerprint: string; at: number; machines?: PostedMachine[] }
export type SummaryPostResult = "posted" | "unchanged" | "cooldown" | "empty" | "unavailable";

export function capacityFingerprint(snapshot: CapacitySnapshot): string {
  const state = {
    machines: snapshot.machines.map((m) => [m.node, m.online]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    seats: snapshot.seats.map((s) => [s.node, s.free]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    accounts: snapshot.accounts.map((a) => [a.key, a.state,
      a.windows.map((w) => [w.kind, w.scope, Math.floor(w.used_pct / 10)]).sort((x, y) => canonicalJson(x).localeCompare(canonicalJson(y)))])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };
  return createHash("sha256").update(canonicalJson(state)).digest("hex");
}

/**
 * The picture last posted, from this daemon's copy and the newest valid person-signed marker in the schedule channel.
 * A time more than ten minutes ahead of this clock (the local copy), or ahead of the earlier of this clock and when
 * this daemon stored the post (a marker), is a wrong clock's and is left out. Receipt alone is not enough: the machine
 * that wrote the marker stored it on the same clock, so after that clock is corrected the stamp is still future-dated.
 * Of the copies that remain, the later time wins, so a lead who returns after another lead posted does not post that picture again.
 * A marker this daemon signed itself with a later time than its own copy is skipped, and the read goes on to the next
 * valid one: the copy is written with every marker this daemon posts, so such a marker is from before its clock was
 * corrected (WALK-65/66 review SHOULD-H). A lead other than the one that signed a once-fast marker cannot tell it apart
 * and takes it once real time reaches its stamp, until the picture changes (RV5 7, documented).
 * The channel read is a query filtered on the marker prefix. A valid newest row is the only one it fetches. An
 * unreadable or future-dated newest row is followed by one read of the newest few, not a scan of the channel.
 * A marker older than SUMMARY_MARKER_WINDOW_MS is outside that query. This does not write the copy it reads.
 */
export function lastPostedSummary(core: Core): PostedSummary | null {
  const raw = core.store.getMeta(META);
  const parsed = raw ? parsePosted(raw) : null;
  const local = parsed && parsed.at <= core.clock() + SUMMARY_CLOCK_SKEW_MS ? parsed : null;
  // Skipped, not compared: a later marker of another lead behind it still counts (RV5 2 without repeating INT-B).
  const ownStale = (found: FoundMarker) => local !== null && found.origin === core.nodeId && found.posted.at > local.at;
  const remote = readNewestMarker(core, ownStale)?.posted ?? null;
  if (local && remote) return remote.at > local.at ? remote : local;
  return local ?? remote;
}

type FoundMarker = { posted: PostedSummary; origin: string | null };

function readNewestMarker(core: Core, skip: (found: FoundMarker) => boolean): FoundMarker | null {
  try {
    const now = core.clock();
    const since = now - SUMMARY_MARKER_WINDOW_MS;
    const statement = core.store.db.query<{ json: string; received_at: number }, [string, number, string, number]>(MARKER_SQL);
    const prefix = `${PREFIX}%`;
    // Stop at the newest row when it counts. Asking for more would keep walking every newer non-marker.
    const newest = statement.all(SCHEDULE_CHANNEL, since, prefix, 1);
    const picked = acceptMarker(newest, now, skip);
    if (picked || newest.length === 0) return picked;
    return acceptMarker(statement.all(SCHEDULE_CHANNEL, since, prefix, SUMMARY_MARKER_ROWS), now, skip);
  } catch {
    return null;
  }
}

/**
 * Newest first. Skip a row that does not parse, whose time is past the earlier of this clock and its receipt by more than
 * the skew, or that `skip` rules out.
 */
function acceptMarker(rows: readonly { json: string; received_at: number }[], now: number, skip: (found: FoundMarker) => boolean): FoundMarker | null {
  for (const row of rows) {
    const found = postedFromEvent(row.json);
    if (!found || skip(found)) continue;
    // received_at is when this daemon stored the post. The writer stamped that with the same clock as `at`, so a corrected clock counts too.
    if (typeof row.received_at !== "number" || found.posted.at > Math.min(row.received_at, now) + SUMMARY_CLOCK_SKEW_MS) continue;
    return found;
  }
  return null;
}

/** The marker's picture and the node that signed it. */
function postedFromEvent(json: string): FoundMarker | null {
  try {
    const event = JSON.parse(json) as { body?: { text?: unknown }; author?: { agent?: string }; origin?: unknown };
    const text = event.body?.text;
    if (event.author?.agent || typeof text !== "string" || !text.startsWith(PREFIX)) return null;
    const posted = parsePosted(text.slice(PREFIX.length));
    return posted ? { posted, origin: typeof event.origin === "string" ? event.origin : null } : null;
  } catch { return null; }
}

function parsePosted(raw: string): PostedSummary | null {
  try {
    const value = JSON.parse(raw) as { fingerprint?: unknown; at?: unknown; machines?: unknown };
    if (typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)) return null;
    if (typeof value.at !== "number" || !Number.isSafeInteger(value.at) || value.at < 0) return null;
    const machines = parseMachines(value.machines);
    return machines ? { fingerprint: value.fingerprint, at: value.at, machines } : { fingerprint: value.fingerprint, at: value.at };
  } catch { return null; }
}

function parseMachines(raw: unknown): PostedMachine[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const machines: PostedMachine[] = [];
  for (const item of raw) {
    if (machines.length >= MARKER_MACHINES_MAX) break;
    if (!item || typeof item !== "object") continue;
    const row = item as { node?: unknown; factor?: unknown; free_slots?: unknown; score?: unknown; seats_hidden?: unknown };
    if (typeof row.node !== "string" || row.node.length < 1 || row.node.length > 64) continue;
    if (!isLimitingFactor(row.factor)) continue;
    if (!Number.isSafeInteger(row.free_slots) || (row.free_slots as number) < 0 || (row.free_slots as number) > 10_000) continue;
    if (!Number.isSafeInteger(row.score) || (row.score as number) < 0 || (row.score as number) > 100) continue;
    machines.push({
      node: row.node, factor: row.factor, free_slots: row.free_slots as number, score: row.score as number,
      ...(row.seats_hidden === true ? { seats_hidden: true } : {}),
    });
  }
  return machines.length ? machines : undefined;
}

export function summaryDue(fingerprint: string, previous: PostedSummary | null, now: number): boolean {
  return (!previous || previous.fingerprint !== fingerprint) && (!previous || now - previous.at >= SUMMARY_COOLDOWN_MS);
}

export function recordPostedSummary(core: Core, fingerprint: string, at: number, machines?: readonly PostedMachine[]): void {
  const kept = markerMachines(machines ?? []);
  const body = kept.length ? { fingerprint, at, machines: kept } : { fingerprint, at };
  const json = JSON.stringify(body);
  core.emit("msg.post", { text: PREFIX + json }, { channel: SCHEDULE_CHANNEL });
  core.store.setMeta(META, json);
}

/**
 * Post the fleet summary to the owner-only schedule channel when the picture changed and the hour has passed.
 * Person-signed: it is not an orchestrator ask and it does not launch a seat. The same channel carries the marker
 * (fingerprint, time, each machine's limit, no hostname) so the next lead does not repeat it. A marker an older
 * peer stored, with only the fingerprint and the time, still counts. `previous` omitted looks the picture up;
 * `null` means this daemon has never seen one. No schedule channel posts nothing and stores nothing.
 */
export function postFleetCapacitySummary(core: Core, rows: readonly FleetSummaryRow[], now: number, previous?: PostedSummary | null): SummaryPostResult {
  const list = Array.isArray(rows) ? rows : [];
  const fingerprint = createHash("sha256").update(fleetPictureKey(list)).digest("hex");
  const prior = previous === undefined ? lastPostedSummary(core) : previous;
  const decision = fleetSummaryDecision(fingerprint, prior, now, list.length, list);
  if (decision !== "post") return decision;
  // Only while everyone who can read the schedule channel is an owner now: a member demoted from owner stays listed until
  // the channel's membership is repaired (which can wait on the roster authority), and must not get fresh figures meanwhile
  // (Codex pre.13 audit SHOULD).
  const members = core.roster.channels.get(SCHEDULE_CHANNEL)?.members;
  if (!members || !members.length || members.some((handle) => memberByHandle(core.roster, handle)?.role !== "owner")) return "unavailable";
  const clipped = fleetSummaryText(list);
  const text = redactSecrets(clipped.length > SUMMARY_TEXT_MAX ? clipped.slice(0, SUMMARY_TEXT_MAX) : clipped).text.slice(0, 1_900);
  if (!text.trim()) return "unavailable";
  const machines = markerMachines(list);
  core.store.transaction(() => {
    core.emit("msg.post", { text }, { channel: SCHEDULE_CHANNEL });
    recordPostedSummary(core, fingerprint, now, machines);
  }, { durable: true });
  core.log.info("fleet_capacity_summary", { machines: list.length, open: list.filter((row) => row.score > 0).length });
  return "posted";
}

function markerMachines(rows: readonly { node: string; limiting_factor?: LimitingFactor; factor?: LimitingFactor; free_slots: number; score: number; seats_hidden?: boolean }[]): PostedMachine[] {
  const out: PostedMachine[] = [];
  const sorted = [...rows].sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
  for (const row of sorted) {
    if (out.length >= MARKER_MACHINES_MAX) break;
    const factor = row.factor ?? row.limiting_factor;
    if (typeof row.node !== "string" || row.node.length < 1 || row.node.length > 64) continue;
    if (!isLimitingFactor(factor)) continue;
    if (!Number.isSafeInteger(row.free_slots) || row.free_slots < 0 || row.free_slots > 10_000) continue;
    if (!Number.isSafeInteger(row.score) || row.score < 0 || row.score > 100) continue;
    out.push({ node: row.node, factor, free_slots: row.free_slots, score: row.score, ...(row.seats_hidden === true ? { seats_hidden: true } : {}) });
  }
  return out;
}
