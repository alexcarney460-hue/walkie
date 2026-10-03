// WALK-65 / WALK-66: how much work one machine can still take, and what is in the way. Pure: the dashboard and the
// daemon's fleet summary both call it, and neither one starts a seat. The poll's own recommendation (poll-plan.ts)
// does not read this score. An unknown load limits the score and the summary; it does not withhold a recommendation.
//
// The account-room check is copied from accounts/select.ts (freshRoomOf) rather than imported. That module pulls in
// the lease files, which the dashboard bundle cannot load. FLEET_READING_MAX_AGE_MS and FLEET_SEAT_RUNTIMES are
// checked against those sources in the unit test so the two cannot drift quietly.
import { canonicalJson } from "./canonical.ts";
import { PERSONAL_RESERVE_PCT } from "./pool-rules.ts";

export const LIMITING_FACTORS = ["seats", "cpu", "memory", "load_unknown", "accounts", "offline"] as const;
export type LimitingFactor = (typeof LIMITING_FACTORS)[number];

/** Same line the poll holds a machine at (poll-plan.ts CPU_BUSY_MAX_PCT / FREE_MEM_MIN_BYTES). */
export const FLEET_CPU_BUSY_MAX_PCT = 85;
/** Below this, a machine that was limited by CPU is free again. Between the two, the previous limit stays. */
export const FLEET_CPU_RELEASE_PCT = 75;
export const FLEET_FREE_MEM_MIN_BYTES = 2 * 1024 ** 3;
/** Free memory at or above this (and pressure normal) releases a memory limit. The band below it holds. */
export const FLEET_MEM_RELEASE_BYTES = FLEET_FREE_MEM_MIN_BYTES + 512 * 1024 ** 2;
/** Room above the personal reserve plus this releases an accounts limit. The band between them holds. */
export const FLEET_ACCOUNT_RELEASE_ROOM = PERSONAL_RESERVE_PCT + 10;
/**
 * Score cut for the fallback picture key, used only when an older marker has no per-machine counts:
 * 0, under this, and this through 100. It is not a divisor. A marker that lists each machine uses the
 * dead-band below instead, so a one-seat move does not post even when it crosses this cut.
 */
export const FLEET_SCORE_BAND = 50;
/** A free-seat move of this many or fewer, with the same limit and the same online state, is not a new picture. */
export const FLEET_FREE_QUIET = 1;
/** At most one summary per this long, however much the picture changed. The ask cooldown is a separate, longer wait. */
export const FLEET_SUMMARY_COOLDOWN_MS = 60 * 60_000;
/** A usage reading older than this is no reading (accounts/select.ts READING_MAX_AGE_MS). */
export const FLEET_READING_MAX_AGE_MS = 60 * 60_000;
/** Runtimes a plain seat can run (seats.ts SEAT_RUNTIMES_V1). */
export const FLEET_SEAT_RUNTIMES = ["claude", "codex"] as const;

const FACTOR_LABEL: Record<LimitingFactor, string> = {
  seats: "seats", cpu: "CPU", memory: "memory", load_unknown: "load unknown", accounts: "accounts", offline: "offline",
};

export function isLimitingFactor(value: unknown): value is LimitingFactor {
  return typeof value === "string" && (LIMITING_FACTORS as readonly string[]).includes(value);
}

export function factorLabel(factor: LimitingFactor): string {
  return FACTOR_LABEL[factor];
}

export interface FleetCapacityInput {
  online: boolean;
  /** Null when the machine has not said. `active` counts seats running, paused or queued there. */
  seats: { allows: boolean; max: number | null; active: number } | null;
  /** A missing reading is not a hold. Pressure other than normal or absent is. */
  mem?: { pressure: "normal" | "warn" | "critical" | null; free: number | null } | null;
  /** Processor busy percent. Missing, NaN and infinities are not a hold. Above 85 is. */
  cpuBusyPct?: number | null;
  /** Discovery's process census went stale and published no agent counts. */
  loadUnknown: boolean;
  /** Percent of the account window still left (freshRoomOf). No room at or below the 10% reserve. */
  accountRoomPct: number | null;
}

export interface FleetCapacity {
  /** Seat slots not running, paused or queued. Zero when the cap was never said, or the machine is offline. */
  free_slots: number;
  limiting_factor: LimitingFactor;
  /** 0 when anything other than spare seats is the limit. 1–100 for spare seats, as their share of the cap. */
  score: number;
}

export interface FleetSummaryRow {
  node: string;
  hostname: string;
  free_slots: number;
  limiting_factor: LimitingFactor;
  score: number;
  /** The lead's person is not on this host's seats channel, so the free-seat count is not a reading. */
  seats_hidden?: boolean;
}

/** An account as the score reads it: no key is required, and none is returned. */
export interface FleetAccountReading {
  provider: string;
  usage: { at: number; state: string; windows: readonly { used_pct: number; resets_at: number | null }[] } | null;
  machines: readonly { node_id: string; online: boolean }[];
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Cap the seat host actually stated, or unknown. A cap above 10_000 is not a reading this score will repeat. */
function seatHead(seats: FleetCapacityInput["seats"]): { known: boolean; free: number; max: number } {
  const max = seats?.max;
  if (!seats || seats.allows !== true || typeof max !== "number" || !Number.isSafeInteger(max) || max < 0 || max > 10_000) {
    return { known: false, free: 0, max: 0 };
  }
  const active = Number.isSafeInteger(seats.active) && seats.active >= 0 ? seats.active : 0;
  return { known: true, free: Math.max(0, max - active), max };
}

function memoryBlocked(input: FleetCapacityInput): boolean {
  const mem = input.mem;
  if (!mem) return false;
  if (mem.pressure != null && mem.pressure !== "normal") return true;
  const free = finite(mem.free);
  return free !== null && free < FLEET_FREE_MEM_MIN_BYTES;
}

function cpuBlocked(input: FleetCapacityInput): boolean {
  const cpu = finite(input.cpuBusyPct);
  return cpu !== null && cpu > FLEET_CPU_BUSY_MAX_PCT;
}

function accountsBlocked(input: FleetCapacityInput): boolean {
  const room = finite(input.accountRoomPct);
  return room === null || room <= PERSONAL_RESERVE_PCT;
}

function rawCapacity(input: FleetCapacityInput): FleetCapacity {
  const head = seatHead(input.seats);
  if (input.online !== true) return { free_slots: 0, limiting_factor: "offline", score: 0 };
  if (memoryBlocked(input)) return { free_slots: head.free, limiting_factor: "memory", score: 0 };
  if (cpuBlocked(input)) return { free_slots: head.free, limiting_factor: "cpu", score: 0 };
  if (input.loadUnknown === true) return { free_slots: head.free, limiting_factor: "load_unknown", score: 0 };
  if (!head.known || head.free <= 0) return { free_slots: 0, limiting_factor: "seats", score: 0 };
  if (accountsBlocked(input)) return { free_slots: head.free, limiting_factor: "accounts", score: 0 };
  const share = Math.round((100 * head.free) / head.max);
  return { free_slots: head.free, limiting_factor: "seats", score: Math.min(100, Math.max(1, share)) };
}

/**
 * `previousFactor` is the limit the last summary posted for this machine. It is kept only when the raw reading would
 * now look free (spare seats) and the number is still inside that limit's release band. A different blocker, offline,
 * or an unknown load replaces it at once. The dashboard calls this without a previous factor.
 */
export function fleetCapacity(input: FleetCapacityInput, previousFactor?: LimitingFactor | null): FleetCapacity {
  const reading = rawCapacity(input);
  if (!previousFactor || !isLimitingFactor(previousFactor) || reading.limiting_factor !== "seats") return reading;
  if (!inReleaseBand(previousFactor, input)) return reading;
  return { free_slots: reading.free_slots, limiting_factor: previousFactor, score: 0 };
}

function inReleaseBand(factor: LimitingFactor, input: FleetCapacityInput): boolean {
  if (factor === "cpu") {
    const cpu = finite(input.cpuBusyPct);
    return cpu !== null && cpu > FLEET_CPU_RELEASE_PCT && cpu <= FLEET_CPU_BUSY_MAX_PCT;
  }
  if (factor === "memory") {
    const mem = input.mem;
    if (!mem || (mem.pressure != null && mem.pressure !== "normal")) return false;
    const free = finite(mem.free);
    return free !== null && free >= FLEET_FREE_MEM_MIN_BYTES && free < FLEET_MEM_RELEASE_BYTES;
  }
  if (factor === "accounts") {
    const room = finite(input.accountRoomPct);
    return room !== null && room > PERSONAL_RESERVE_PCT && room <= FLEET_ACCOUNT_RELEASE_ROOM;
  }
  return false;
}

/** The roomiest fresh Claude or Codex reading on `node`, in percent left, or null when none is fresh. */
export function bestAccountRoom(accounts: readonly FleetAccountReading[], node: string, now: number): number | null {
  if (!Number.isFinite(now)) return null;
  let best: number | null = null;
  for (const account of accounts) {
    if (!(FLEET_SEAT_RUNTIMES as readonly string[]).includes(account.provider)) continue;
    if (!account.machines.some((m) => m.node_id === node && m.online === true)) continue;
    const room = roomLeft(account.usage, now);
    if (room === null) continue;
    best = best === null ? room : Math.max(best, room);
  }
  return best;
}

function roomLeft(usage: FleetAccountReading["usage"], now: number): number | null {
  if (!usage || !Number.isFinite(usage.at) || usage.at > now || now - usage.at > FLEET_READING_MAX_AGE_MS) return null;
  if (usage.state === "exhausted") return 0;
  if (usage.state !== "ok" || usage.windows.length === 0) return null;
  let least = Infinity;
  for (const w of usage.windows) {
    const used = w.resets_at !== null && w.resets_at <= now ? 0 : w.used_pct;
    if (!Number.isFinite(used)) continue;
    least = Math.min(least, 100 - used);
  }
  return Number.isFinite(least) ? least : null;
}

export interface FleetPictureRow {
  node: string;
  limiting_factor: LimitingFactor;
  free_slots: number;
  score: number;
}

/** None, 1–3, or 4 or more. Exact free seats stay in the summary text and in the marker. */
function fleetFreeBand(free: number): number {
  if (free <= 0) return 0;
  if (free <= 3) return 1;
  return 2;
}

/** 0, under FLEET_SCORE_BAND, or FLEET_SCORE_BAND through 100. */
function fleetScoreBand(score: number): number {
  if (score <= 0) return 0;
  if (score < FLEET_SCORE_BAND) return 1;
  return 2;
}

/**
 * Fallback text of the picture, for a marker that has no per-machine counts. The same limit, the same
 * free-seat band and the same score band match. A marker that lists machines uses fleetMaterialChange.
 */
export function fleetPictureKey(rows: readonly FleetPictureRow[]): string {
  const stable: { node: string; factor: LimitingFactor; free_band: number; score_band: number }[] = [];
  for (const row of rows) {
    if (typeof row.node !== "string" || row.node.length < 1 || row.node.length > 64) continue;
    if (!isLimitingFactor(row.limiting_factor)) continue;
    if (!Number.isSafeInteger(row.free_slots) || row.free_slots < 0 || row.free_slots > 10_000) continue;
    if (!Number.isSafeInteger(row.score) || row.score < 0 || row.score > 100) continue;
    stable.push({
      node: row.node, factor: row.limiting_factor,
      free_band: fleetFreeBand(row.free_slots), score_band: fleetScoreBand(row.score),
    });
  }
  stable.sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
  return canonicalJson(stable);
}

function hostLabel(raw: string): string {
  const cleaned = String(raw ?? "").replace(/[\u0000-\u001F\u007F]/g, "").replace(/@/g, "").trim().slice(0, 64);
  if (!cleaned || isAddress(cleaned)) return "machine";
  return cleaned;
}

function isAddress(value: string): boolean {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return value.split(".").every((part) => Number(part) <= 255);
  return value.includes(":") && value.length > 2 && /^[0-9a-fA-F:]+$/.test(value);
}

/**
 * The owner-only schedule-channel text. Free seats in the first line count only machines whose score is above zero, so a blocked
 * machine's idle seats are not offered as fleet capacity. Hostnames are the roster's, with addresses, @ and
 * control characters taken out. At most 40 machines are listed.
 */
export function fleetSummaryText(rows: readonly FleetSummaryRow[]): string {
  const usable = rows.filter((row) => isLimitingFactor(row.limiting_factor) && Number.isSafeInteger(row.free_slots) && Number.isSafeInteger(row.score));
  const open = usable.filter((row) => row.score > 0);
  const free = open.reduce((sum, row) => sum + Math.max(0, row.free_slots), 0);
  const machines = usable.length;
  const headline = `WalkieTalkie fleet capacity: ${free} free seat${free === 1 ? "" : "s"} on ${open.length} of ${machines} machine${machines === 1 ? "" : "s"}.`;
  const sorted = [...usable].sort((a, b) => {
    const ah = hostLabel(a.hostname);
    const bh = hostLabel(b.hostname);
    return ah < bh ? -1 : ah > bh ? 1 : a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
  });
  const shown = sorted.slice(0, 40).map((row) => summaryLine(row));
  const more = sorted.length - shown.length;
  const tail = more > 0 ? [`and ${more} more machine${more === 1 ? "" : "s"}`] : [];
  return [headline, ...shown, ...tail].join("\n");
}

function summaryLine(row: FleetSummaryRow): string {
  const name = hostLabel(row.hostname);
  // The free-seat count is not a reading, so it is not printed and neither is a score. Seats stays the short line.
  // Any other limit still names the factor, with no count and no score.
  if (row.seats_hidden !== true) return `${name}: ${row.free_slots} free, limited by ${factorLabel(row.limiting_factor)}, score ${row.score}`;
  if (row.limiting_factor === "seats") return `${name}: seats hidden`;
  return `${name}: seats hidden, limited by ${factorLabel(row.limiting_factor)}`;
}

export interface FleetMarkerMachine {
  node: string;
  factor: LimitingFactor;
  free_slots: number;
  seats_hidden?: boolean;
}

/**
 * Whether the picture moved enough to post, compared with the exact free-seat counts in the last marker.
 * One free seat of chatter stays quiet. A new limit, going offline or coming back, a machine appearing or
 * leaving, or seats becoming visible or hidden, does not.
 */
export function fleetMaterialChange(rows: readonly (FleetPictureRow & { seats_hidden?: boolean })[], previous: readonly FleetMarkerMachine[]): boolean {
  const now = new Map<string, { factor: LimitingFactor; free: number; hidden: boolean }>();
  for (const row of rows) {
    if (typeof row.node !== "string" || row.node.length < 1 || row.node.length > 64) continue;
    if (!isLimitingFactor(row.limiting_factor)) continue;
    if (!Number.isSafeInteger(row.free_slots) || row.free_slots < 0 || row.free_slots > 10_000) continue;
    now.set(row.node, { factor: row.limiting_factor, free: row.free_slots, hidden: row.seats_hidden === true });
  }
  const prev = new Map<string, { factor: LimitingFactor; free: number; hidden: boolean }>();
  for (const row of previous) {
    if (typeof row.node !== "string" || row.node.length < 1 || row.node.length > 64) continue;
    if (!isLimitingFactor(row.factor)) continue;
    if (!Number.isSafeInteger(row.free_slots) || row.free_slots < 0 || row.free_slots > 10_000) continue;
    prev.set(row.node, { factor: row.factor, free: row.free_slots, hidden: row.seats_hidden === true });
  }
  if (now.size !== prev.size) return true;
  for (const [node, row] of now) {
    const was = prev.get(node);
    if (!was) return true;
    if (was.factor !== row.factor || was.hidden !== row.hidden) return true;
    if (Math.abs(was.free - row.free) > FLEET_FREE_QUIET) return true;
  }
  return false;
}

function pictureChanged(
  fingerprint: string,
  previous: { fingerprint: string; machines?: readonly FleetMarkerMachine[] },
  rows: readonly (FleetPictureRow & { seats_hidden?: boolean })[] | undefined,
): boolean {
  if (rows && previous.machines && previous.machines.length > 0) return fleetMaterialChange(rows, previous.machines);
  return previous.fingerprint !== fingerprint;
}

export type FleetSummaryDecision = "post" | "unchanged" | "cooldown" | "empty";

/**
 * Whether to post. This does not know who was asked, or the two-hour ask cooldown. An empty fleet that has never
 * been posted is skipped (a poll of an empty team stays quiet). A bad clock does not post. When the last marker
 * lists each machine, one free seat of chatter is unchanged even if the fallback fingerprint differs. A marker
 * with only a fingerprint still compares that fingerprint.
 */
export function fleetSummaryDecision(
  fingerprint: string,
  previous: { fingerprint: string; at: number; machines?: readonly FleetMarkerMachine[] } | null,
  now: number,
  machineCount: number,
  rows?: readonly (FleetPictureRow & { seats_hidden?: boolean })[],
): FleetSummaryDecision {
  if (!Number.isSafeInteger(now) || now < 0) return "cooldown";
  if (previous && !pictureChanged(fingerprint, previous, rows)) return "unchanged";
  const count = Number.isSafeInteger(machineCount) && machineCount > 0 ? machineCount : 0;
  if (count === 0 && !previous) return "empty";
  if (previous && (now < previous.at || now - previous.at < FLEET_SUMMARY_COOLDOWN_MS)) return "cooldown";
  return "post";
}
