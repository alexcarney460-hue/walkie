// RESET-CLOCK-1: the reset clock. Every reset time a provider reports for an account's windows is remembered per
// window (with when it was reported), so the countdown keeps running after the reading that carried it goes stale, a
// poll fails, the login moves to another account, or the daemon restarts. Learned only from data that already flows:
// usage-meter reads, Codex session files, a wrapped session's own reading, and the provider's own "limit reached,
// resets …" message (the switcher's marks). Nothing here asks a provider anything, and no token is ever involved.
import { MAX_CLOCK, ResetClock, type AccountUsage, type ClockSource, type WindowKind } from "../protocol/accounts.ts";
import type { Mark } from "./leases.ts";
import { usageUntil } from "../protocol/accounts-format.ts";

/** A remembered time is dropped this long after it passed (or after it was reported, when it had none). */
export const CLOCK_KEEP_MS = 8 * 86_400_000;
/** No real window resets further ahead than this from its report (weekly windows are 7 days). */
export const CLOCK_MAX_AHEAD_MS = 8 * 86_400_000;
/**
 * The reset the switcher writes into a mark when the provider named none (wrapper.ts UNKNOWN_RESET_MS). A mark from
 * before the `guessed` flag with exactly this gap is treated as guessed: a guess is never shown as a reset time.
 */
export const LEGACY_GUESS_MS = 60 * 60_000;

type ReadingLike = Pick<AccountUsage, "at" | "state" | "source" | "windows" | "until" | "until_reported">;

const clockKey = (c: Pick<ResetClock, "kind" | "scope">): string => `${c.kind}|${c.scope ?? ""}`;

function sourceOf(s: AccountUsage["source"]): ClockSource | null {
  return s === "api" || s === "session" || s === "log" ? s : null;
}

/**
 * The reset times a reading reports: one per window. A reading without windows (unknown, re-login, a failed poll)
 * says nothing about reset times and yields none, so it can never erase what was learned. An exhausted reading
 * without windows (a CLI log) that names when it lifts yields one unnamed window.
 */
export function clockFromReading(r: ReadingLike | null | undefined): ResetClock[] {
  if (!r) return [];
  const source = sourceOf(r.source);
  if (!source) return [];
  if (r.windows.length) {
    return r.windows.map((w) => ({
      kind: w.kind, scope: w.scope, window_s: w.window_s, resets_at: w.resets_at, observed_at: r.at, exhausted: w.used_pct >= 100, source,
    }));
  }
  if (r.state === "exhausted") {
    // Grok's CLI log names a reset only sometimes: without one the reading says null (an older peer's placeholder,
    // report + 60 min, GROK_EXHAUSTED_DEFAULT_MS, is treated the same): kept as unknown, never shown as a reset time.
    return [{ kind: "other", scope: null, window_s: null, resets_at: usageUntil(r), observed_at: r.at, exhausted: true, source }];
  }
  return [];
}

/** The window a limit message named ("five_hour", "seven_day_opus", "opus model", "usage"). */
function markWindow(m: Pick<Mark, "reason" | "model">): { kind: WindowKind; scope: string | null } {
  const r = m.reason.toLowerCase();
  const model = m.model ?? (/(opus|sonnet|haiku|fable|mythos)/.exec(r)?.[1] ?? null);
  const scope = model ? model.charAt(0).toUpperCase() + model.slice(1).toLowerCase() : null;
  if (r.includes("five_hour") || r.includes("5-hour") || r.includes("session")) return { kind: "session", scope: null };
  if (scope) return { kind: "weekly_model", scope };
  if (r.includes("seven_day") || r.includes("week")) return { kind: "weekly", scope: null };
  return { kind: "other", scope: null };
}

/** Whether a mark's `until` is the switcher's placeholder rather than a time the provider named. */
export function markGuessed(m: Pick<Mark, "until" | "at" | "guessed">): boolean {
  if (m.guessed !== undefined) return m.guessed;
  return m.until !== null && m.until - m.at === LEGACY_GUESS_MS;
}

/**
 * A limit message a session hit ("You've reached your limit · resets 4:10am"), as the switcher recorded it. A guessed
 * reset is kept as unknown (null), never as a time. A refused-token mark says nothing about resets.
 */
export function clockFromMark(m: Mark | undefined): ResetClock[] {
  if (!m || m.state !== "exhausted") return [];
  const { kind, scope } = markWindow(m);
  return [{ kind, scope, window_s: null, resets_at: markGuessed(m) ? null : m.until, observed_at: m.at, exhausted: true, source: "message" }];
}

/**
 * Merges newly observed reset times into what is remembered: per window, the newer report wins (the same time with
 * different content: the new one). A window the new report does not mention is kept (it is still what was last known). Long-passed entries
 * are dropped, and at most MAX_CLOCK are kept (the most recently reported). Returns `prev` itself when nothing changed.
 */
export function mergeClock(prev: readonly ResetClock[], next: readonly ResetClock[], now: number): readonly ResetClock[] {
  const by = new Map<string, ResetClock>();
  for (const c of prev) by.set(clockKey(c), c);
  for (const c of next) {
    const have = by.get(clockKey(c));
    const newer = !have || c.observed_at > have.observed_at || (c.observed_at === have.observed_at && JSON.stringify(c) !== JSON.stringify(have));
    if (newer) by.set(clockKey(c), c);
  }
  const kept = [...by.values()]
    .filter((c) => now - (c.resets_at ?? c.observed_at) < CLOCK_KEEP_MS)
    .sort((a, b) => b.observed_at - a.observed_at)
    .slice(0, MAX_CLOCK);
  const same = kept.length === prev.length && kept.every((c) => prev.some((p) => p === c));
  return same ? prev : kept;
}

/** Only well-formed entries (a file or a peer is not trusted to send them). */
export function validClock(raw: unknown): ResetClock[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_CLOCK).flatMap((c) => {
    const p = ResetClock.safeParse(c);
    return p.success ? [p.data] : [];
  });
}

/**
 * A peer's remembered times on this node's clock (skew = reporter − ours). An entry reported beyond the allowed skew
 * is dropped; a reset is capped at its report + 8 days (as shiftUsage caps readings).
 */
export function shiftClock(clock: readonly ResetClock[], skewMs: number, now: number, futureSkewMs: number): ResetClock[] {
  return clock.flatMap((c) => {
    const observed = c.observed_at - skewMs;
    if (observed > now + futureSkewMs) return [];
    const at = Math.max(0, Math.min(now, observed));
    const resets = c.resets_at === null ? null : Math.min(Math.max(0, observed) + CLOCK_MAX_AHEAD_MS, Math.max(0, c.resets_at - skewMs));
    return [{ ...c, observed_at: at, resets_at: resets }];
  });
}
