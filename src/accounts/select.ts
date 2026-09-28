// Which account a session should run on (ACCOUNTS-2 selector). Pure: the caller gathers the candidates (vault accounts
// on this machine, accounts the owner's other machines — or a sharing teammate — may hand out) with their pooled
// readings (phase 1), local marks and lease counts.
//   room      = the least left over the windows that apply (5-hour, weekly, the model's own weekly; a window whose
//               reset has passed counts as unused). With no --model known, every model window applies (conservative).
//   excluded  = only what cannot run now: AT its hard limit (an exhausted reading, a window at 100 %, a limit mark),
//               needs re-login, unreachable, or explicitly excluded. Round 4 (Codex 4 / Opus 2): the switch threshold
//               (95 %) is a RANKING preference only — an account below its hard limit always stays eligible.
//   reserve   = −10 points per active lease on the account (anywhere in the team), so terminals spread out.
//   order     = tier (below the threshold → room unknown → at/over the threshold), then most room; ties → the
//               caller's own account, soonest weekly reset, fewest leases, id.
// A candidate with no known room (a setup-token nobody meters, a stale or unknown reading) ranks after every metered
// account below the threshold; it is excluded only by marks (a limit a session actually hit, until the reset it named)
// or an exhausted reading whose reset is still ahead.
import type { AccountUsage, AccountWindow, ResetClock } from "../protocol/accounts.ts";
import { clockAvailability, usageUntil } from "../protocol/accounts-format.ts";
import { markGuessed } from "./clock.ts";
import { markApplies, markExcludes, markKey, markLifted, type Mark } from "./leases.ts";

export const LEASE_RESERVE_PTS = 10;
export const DEFAULT_THRESHOLD_PCT = 95;
/** A reading older than this is no reading (phase 1's UNKNOWN_MS). */
export const READING_MAX_AGE_MS = 60 * 60_000;

export interface Candidate {
  id: string;
  provider: "claude" | "codex";
  label: string;
  /** The owner's handle (null: this machine's owner, before a team exists). */
  owner: string | null;
  /** The account belongs to the person asking. */
  own: boolean;
  /** local = in this machine's vault; peer = handed out by another machine's vault (`node`). */
  source: "local" | "peer";
  node?: string;
  usage: AccountUsage | null;
  mark?: Mark;
  /** The stored credential's generation (vault entries); a mark about another generation is ignored. */
  gen?: string;
  leases: number;
  /** No usage meter reaches this login (a setup-token nobody meters): room unknown. */
  meterless?: boolean;
  /**
   * An own account this machine cannot reach right now (its vault machine offline, or not lending here): never picked,
   * and — not being affirmatively at its limit — it keeps a teammate's account from being borrowed (round 3, Codex 7).
   */
  unavailable?: boolean;
  /**
   * RESET-CLOCK-1: the account's remembered reset times (this node's clock). An account they say is at its limit is
   * not picked until the remembered reset — without asking the provider.
   */
  clock?: readonly ResetClock[];
}

export interface Ranked extends Candidate {
  /** Least % left over the applicable windows; null = unknown (meterless, stale or unknown reading). */
  room: number | null;
  /** 0 = below the threshold, 1 = room unknown, 2 = at/over the threshold (still below the hard limit). */
  tier: 0 | 1 | 2;
  /** room − the lease reserve (what the ordering uses). */
  score: number;
  weeklyReset: number | null;
}

export interface Excluded {
  id: string; label: string; why: string; until: number | null;
  /** Owner-qualified identity (markKey): the account id for an own account, `owner:id` for a borrowed one. */
  key?: string;
  /** Positively known to be out of room (at its hard limit), as opposed to unusable. */
  outOfRoom: boolean;
  /** Affirmatively AT its limit (a fresh exhausted reading, a window at 100 %, or a limit mark), not merely near it. */
  atLimit?: boolean;
  provider?: "claude" | "codex";
  owner?: string | null;
}

/** RESET-CLOCK-1: the account that frees first when nothing is usable (for an orchestrator to schedule on). */
export interface NextFree { at: number; id: string; key: string; label: string; provider: "claude" | "codex"; owner: string | null }

export interface Selection {
  pick: Ranked | null;
  ranked: Ranked[];
  excluded: Excluded[];
  /** Nothing usable: when the earliest excluded account should be usable again (null = unknown). */
  waitUntil: number | null;
  /**
   * Nothing usable and at least one account is known to be out of room (round 1, Codex 10): wait / exit 75, even when
   * no reset time is known — never fall through to the CLI's own login as if no account were set up.
   */
  exhausted: boolean;
  /** Nothing usable: the account with the earliest known reset (remembered or reported), else null. */
  nextFree: NextFree | null;
}

export interface SelectOptions {
  provider: "claude" | "codex";
  model?: string | null;
  now: number;
  thresholdPct?: number;
  /**
   * Accounts never to pick (the one being switched away from), by owner-qualified identity (round 7, Codex r6 4:
   * markKey — a borrowed account's exclusion never hides an own account with the same id).
   */
  exclude?: readonly string[];
}

function applies(w: AccountWindow, model: string | null | undefined): boolean {
  if (w.kind !== "weekly_model") return true;
  if (!model || !w.scope) return true;
  return model.toLowerCase().includes(w.scope.toLowerCase().split(" ")[0] as string);
}

/** The applicable windows, a window past its reset counting as unused. */
export function liveWindows(u: AccountUsage, model: string | null | undefined, now: number): AccountWindow[] {
  return u.windows.filter((w) => applies(w, model)).map((w) => (w.resets_at !== null && w.resets_at <= now ? { ...w, used_pct: 0 } : w));
}

/** Least % left over the applicable windows (null when the reading has none). */
export function roomOf(u: AccountUsage, model: string | null | undefined, now: number): number | null {
  const ws = liveWindows(u, model, now);
  if (!ws.length) return null;
  return Math.min(...ws.map((w) => 100 - w.used_pct));
}

/** The highest used % over the applicable windows and which window it is (for the switch line). */
export function hottestWindow(u: AccountUsage | null, model: string | null | undefined, now: number): AccountWindow | null {
  if (!u) return null;
  const ws = liveWindows(u, model, now);
  return ws.reduce<AccountWindow | null>((a, w) => (!a || w.used_pct > a.used_pct ? w : a), null);
}

/** When the binding (fullest) window of a reading resets. */
function recoveryAt(u: AccountUsage | null, model: string | null | undefined, now: number): number | null {
  if (!u) return null;
  if (u.state === "exhausted" && usageUntil(u) !== null) return usageUntil(u);
  const w = hottestWindow(u, model, now);
  return w?.resets_at ?? null;
}

/**
 * Own accounts first, always (round 1, Opus 4 / Codex 7): a teammate's shared account (own = false) is considered
 * only when none of the caller's own accounts can be picked. The caller decides whether borrowed candidates are in
 * the list at all (the borrower's opt-in).
 */
export function selectOwnFirst(cands: readonly Candidate[], o: SelectOptions): Selection {
  const own = cands.filter((c) => c.own && c.provider === o.provider);
  const mine = select(own, o);
  const theirs = cands.filter((c) => !c.own);
  if (mine.pick || !theirs.length) return mine;
  // Round 2 (Codex 9): a teammate's account only when EVERY own account is affirmatively at its limit — never because
  // an own account is unknown, stale, near the threshold, failing its credentials or left out for another reason.
  const atLimit = new Set(mine.excluded.filter((e) => e.atLimit).map((e) => e.key ?? e.id));
  if (!own.every((c) => atLimit.has(markKey(c)))) return mine;
  const b = select(theirs, o);
  const excluded = [...mine.excluded, ...b.excluded];
  if (b.pick) return { ...b, excluded };
  const times = [mine.waitUntil, b.waitUntil].filter((t): t is number => t !== null);
  return {
    pick: null, ranked: [], excluded, waitUntil: times.length ? Math.min(...times) : null, exhausted: mine.exhausted || b.exhausted,
    nextFree: nextFreeOf(excluded, o.now),
  };
}

/** The excluded account whose known reset comes first (ties: the earlier listed, i.e. own before borrowed). */
export function nextFreeOf(excluded: readonly Excluded[], now: number): NextFree | null {
  let best: Excluded | null = null;
  for (const e of excluded) if (e.until !== null && e.until > now && e.provider && (!best || e.until < (best.until as number))) best = e;
  if (!best) return null;
  return { at: best.until as number, id: best.id, key: best.key ?? best.id, label: best.label, provider: best.provider as "claude" | "codex", owner: best.owner ?? null };
}

function tieBreak(a: Ranked, b: Ranked): number {
  if (a.own !== b.own) return a.own ? -1 : 1;
  const ar = a.weeklyReset ?? Number.MAX_SAFE_INTEGER;
  const br = b.weeklyReset ?? Number.MAX_SAFE_INTEGER;
  if (ar !== br) return ar - br;
  if (a.leases !== b.leases) return a.leases - b.leases;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function select(cands: readonly Candidate[], o: SelectOptions): Selection {
  const threshold = o.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const minRoom = 100 - threshold;
  const ranked: Ranked[] = [];
  const excluded: Excluded[] = [];
  const skip = new Set(o.exclude ?? []);
  const out = (c: Candidate, why: string, until: number | null, outOfRoom = false, atLimit = false) =>
    excluded.push({ id: c.id, key: markKey(c), label: c.label, why, until, outOfRoom, atLimit, provider: c.provider, owner: c.owner });
  for (const c of cands) {
    if (c.provider !== o.provider || skip.has(markKey(c))) continue;
    if (c.unavailable) { out(c, "unreachable right now", null); continue; }
    // A limit mark yields only to a reading taken well after it with its relevant windows below 100 % (round 5,
    // hysteresis); a model-scoped limit only for that model; a refused-token mark only once confirmed (two refusals),
    // and only a new credential (another generation) lifts it.
    if (markApplies(c.mark, c.gen) && (c.mark.until === null || c.mark.until > o.now) && markExcludes(c.mark, o.model) && (c.mark.state === "relogin" || !markLifted(c.mark, c.usage))) {
      // A guessed reset (the provider named none) holds the account out, but is never reported as when it frees.
      const markUntil = c.mark.state === "exhausted" && markGuessed(c.mark) ? null : c.mark.until;
      out(c, c.mark.state === "relogin" ? "needs re-login" : `limit reached (${c.mark.reason})`, markUntil, c.mark.state === "exhausted", c.mark.state === "exhausted");
      continue;
    }
    // An exhausted reading whose reset is still ahead holds however old it is; anything else must be fresh.
    const readUntil = usageUntil(c.usage);
    if (c.usage?.state === "exhausted" && readUntil !== null && readUntil > o.now) { out(c, "limit reached", readUntil, true, true); continue; }
    // RESET-CLOCK-1: a limit remembered from any report (an older reading, a teammate's machine, a limit message)
    // holds until its remembered reset, unless a later reading shows room. After it the account is eligible again
    // (room unknown until a reading) — nothing is asked of the provider to find out.
    const remembered = clockAvailability(c.clock, c.usage, o.now);
    if (remembered.kind === "exhausted" && remembered.until !== null && remembered.until > o.now) {
      out(c, "limit reached (remembered)", remembered.until, true, true);
      continue;
    }
    const u = c.usage && o.now - c.usage.at <= READING_MAX_AGE_MS ? c.usage : null;
    if (u?.state === "relogin") { out(c, "needs re-login", null); continue; }
    if (u?.state === "exhausted" && usageUntil(u) === null) { out(c, "limit reached", null, true, true); continue; }
    const weekly = u?.windows.find((w) => w.kind === "weekly")?.resets_at ?? null;
    const room = u && u.state !== "unknown" ? roomOf(u, o.model, o.now) : null;
    if (room !== null && room <= 0) { out(c, "100% used", recoveryAt(u, o.model, o.now), true, true); continue; }
    const tier = room === null ? 1 : room <= minRoom ? 2 : 0;
    const score = (room ?? 0) - LEASE_RESERVE_PTS * c.leases;
    ranked.push({ ...c, room, tier, score, weeklyReset: weekly });
  }
  ranked.sort((a, b) => {
    // Below the threshold first, then accounts whose room is unknown, then those at/over the threshold.
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.room !== null && b.room !== null && Math.abs(a.score - b.score) >= 0.05) return b.score - a.score;
    if (a.room === null && a.leases !== b.leases) return a.leases - b.leases;
    return tieBreak(a, b);
  });
  const pick = ranked[0] ?? null;
  const times = excluded.map((e) => e.until).filter((t): t is number => t !== null && t > o.now);
  return {
    pick, ranked, excluded, waitUntil: pick ? null : times.length ? Math.min(...times) : null, exhausted: !pick && excluded.some((e) => e.atLimit === true),
    nextFree: pick ? null : nextFreeOf(excluded, o.now),
  };
}
