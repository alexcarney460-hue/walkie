// Display rules for accounts shared by the CLI and the dashboard. No zod here: the dashboard bundle imports it.
import type { AccountProvider, AccountUsage, AccountView, AccountWindow, ResetClock, ResetFailure, ResetResult, UsageReason } from "./accounts.ts";

/** A reading older than this is shown as stale; older than UNKNOWN_MS it is no longer shown as a level. */
export const STALE_MS = 15 * 60_000;
export const UNKNOWN_MS = 60 * 60_000;
/** Meter bands on what is LEFT: green ≥ 30 %, amber 10–30 %, red < 10 %. */
export const AMBER_LEFT = 30;
export const RED_LEFT = 10;

export type MeterLevel = "green" | "amber" | "red";
export type DisplayState = "ok" | "stale" | "unknown" | "exhausted" | "relogin";

export const PROVIDER_NAME: Record<AccountProvider, string> = { claude: "Claude", codex: "Codex", kimi: "Kimi", grok: "Grok" };
/** Neutral monograms (no provider logos). */
export const PROVIDER_MONOGRAM: Record<AccountProvider, string> = { claude: "Cl", codex: "Cx", kimi: "Ki", grok: "Gk" };

/** What is left of a window, 0–100, rounded to a whole percent. */
export function leftPct(w: Pick<AccountWindow, "used_pct">): number {
  return Math.max(0, Math.min(100, Math.round(100 - w.used_pct)));
}

export function meterLevel(left: number): MeterLevel {
  return left < RED_LEFT ? "red" : left < AMBER_LEFT ? "amber" : "green";
}

/**
 * RESET-CLOCK-1: the placeholder an older Grok adapter (pre.7 and before) put in `until` when its log named no reset:
 * the failure's time + 60 min. Such a time is not a reset anyone reported.
 */
export const GUESSED_RESET_MS = 60 * 60_000;

/**
 * The reset time a reading really reports (provenance-aware): `until` when the provider named it (`until_reported`),
 * or any `until` from a meter or session; for legacy CLI-log readings without provenance, not the older Grok
 * placeholder (exactly its time + 60 min) — unknown, never shown or scheduled on as a time. Every displayed or routed
 * reading reset goes through here.
 */
export function usageUntil(u: Pick<AccountUsage, "at" | "source" | "until" | "until_reported"> | null | undefined): number | null {
  if (!u || u.until === null) return null;
  if (u.until_reported === true) return u.until;
  return u.source === "log" && u.until - u.at === GUESSED_RESET_MS ? null : u.until;
}

/**
 * The usage state to show, from the reading and its age. An exhausted reading with no reported reset counts only
 * while the adapters hold such a limit (GUESSED_RESET_MS after it was read), like clockAvailability — never for days.
 */
export function displayState(u: AccountUsage | null, now: number): DisplayState {
  if (!u) return "unknown";
  if (u.state === "relogin") return "relogin";
  const until = usageUntil(u);
  if (u.state === "exhausted" && (until === null ? now - u.at < GUESSED_RESET_MS : until > now)) return "exhausted";
  if (u.state === "unknown") return "unknown";
  const age = now - u.at;
  if (age > UNKNOWN_MS) return "unknown";
  if (age > STALE_MS) return "stale";
  if (u.state === "exhausted") return "ok"; // the limit lifted since
  return u.windows.some((w) => leftPct(w) <= 0 && (w.resets_at === null || w.resets_at > now)) ? "exhausted" : "ok";
}

/** The session (5-hour), weekly and model-scoped weekly windows a tile shows, in that order. */
export function mainWindows(u: AccountUsage | null): { session?: AccountWindow; weekly?: AccountWindow; model: AccountWindow[] } {
  const ws = u?.windows ?? [];
  return {
    session: ws.find((w) => w.kind === "session"),
    weekly: ws.find((w) => w.kind === "weekly"),
    model: ws.filter((w) => w.kind === "weekly_model"),
  };
}

export function windowLabel(w: AccountWindow): string {
  if (w.kind === "session") return w.window_s && w.window_s !== 5 * 3600 ? `${Math.round(w.window_s / 3600)}-hour` : "5-hour";
  if (w.kind === "weekly") return "Weekly";
  if (w.kind === "weekly_model") return `Weekly · ${w.scope ?? "model"}`;
  return w.window_s ? durationShort(w.window_s * 1000) : "Window";
}

/** "3d 4h", "2h 05m", "12m", "now". */
export function durationShort(ms: number): string {
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "resets in 2h 05m", or "" when the reset time is unknown. */
export function resetText(resetsAt: number | null, now: number): string {
  return resetsAt === null ? "" : resetsAt <= now ? "reset due" : `resets in ${durationShort(resetsAt - now)}`;
}

/** The exact step to renew a login, on the machine that holds it. */
export function reloginStep(provider: AccountProvider, hostname: string): string {
  const cmd: Record<AccountProvider, string> = {
    claude: "run `claude`, then type /login",
    codex: "run `codex login`",
    kimi: "run `kimi`, then type /login",
    grok: "run `grok login`",
  };
  return `On ${hostname}: ${cmd[provider]}`;
}

const REASON_TEXT: Record<UsageReason, string> = {
  no_usage_api: "no usage API for this provider",
  token_expiring: "login is refreshing; waiting for the CLI",
  no_token: "no login found on the machine",
  keychain_unavailable: "Keychain did not answer without a prompt",
  api_key_login: "API-key login (no plan limits to read)",
  http_error: "usage service error",
  rate_limited: "usage service is rate limiting; backing off",
  login_expired: "login expired",
  limit_reached: "limit reached",
  identity_pending: "identifying the account",
  not_polled: "not read yet",
  token_login: "token login, account unknown",
};

export function reasonText(r: UsageReason | null): string {
  return r ? REASON_TEXT[r] : "no reading yet";
}

/** Two-letter initials for a handle ("maren" → "MA"). */
export function initials(handle: string): string {
  return handle.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

/** One line for the CLI and tooltips: "5-hour 44% left (resets in 2h 45m) · Weekly 65% left (resets in 6d 12h)". */
export function usageLine(a: Pick<AccountView, "usage" | "provider" | "clock">, now: number): string {
  const st = displayState(a.usage, now);
  const ws = mainWindows(a.usage);
  const parts = [ws.session, ws.weekly, ...ws.model].filter((w): w is AccountWindow => !!w)
    .map((w) => {
      const r = resetText(windowResetAt(a.clock, w), now);
      return `${windowLabel(w)} ${leftPct(w)}% left${r ? ` (${r})` : ""}`;
    });
  if (st === "relogin") return "needs re-login";
  const avail = clockAvailability(a.clock, a.usage, now);
  const likely = avail.kind === "available_unconfirmed" ? `${AVAILABLE_UNCONFIRMED} · ` : "";
  if (st === "exhausted") {
    // The limit's own reset: the reading's, else a window that is itself at 100 % (that window IS the limit). Other
    // windows keep their own countdown in `parts`, never presented as the limit's (pre.7 RC delta).
    const full = (a.usage?.windows ?? []).filter((w) => leftPct(w) <= 0 && w.resets_at !== null && w.resets_at > now).map((w) => w.resets_at as number);
    const until = usageUntil(a.usage) ?? (full.length ? Math.max(...full) : null);
    return `exhausted · ${until ? resetText(until, now) : "reset time not reported"}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
  }
  if (st === "unknown") {
    // RESET-CLOCK-1: no current reading, but the remembered reset times still count down.
    const known = clockRows(a.clock, now).filter((r) => r.status !== "unknown").map((r) => `${r.label} ${clockText(r, now)}`);
    const last = avail.kind === "exhausted" ? `limit reached${avail.until !== null ? ` (${resetText(avail.until, now)})` : ""} · ` : likely;
    return `${last}unknown · ${reasonText(a.usage?.reason ?? null)}${known.length && !likely ? ` · ${known.join(" · ")}` : ""}`;
  }
  return `${likely}${parts.join(" · ") || "no windows reported"}${st === "stale" ? " (stale)" : ""}`;
}

// ---- reset clock (RESET-CLOCK-1) ---------------------------------------------------

/** The words for an account whose limit reset passed with no reading since (never "0 % used": nothing says so). */
export const AVAILABLE_UNCONFIRMED = "should be available again (not yet confirmed)";

export type ClockStatus = "counting" | "passed" | "unknown";

export interface ClockRow {
  kind: ResetClock["kind"]; scope: string | null; label: string;
  resetsAt: number | null; observedAt: number; exhausted: boolean; status: ClockStatus;
}

const KIND_ORDER: Record<ResetClock["kind"], number> = { session: 0, weekly: 1, weekly_model: 2, other: 3 };

function clockLabel(c: ResetClock): string {
  if (c.kind === "other" && !c.window_s) return "Limit";
  return windowLabel({ kind: c.kind, scope: c.scope, window_s: c.window_s, used_pct: 0, resets_at: c.resets_at });
}

/** The remembered reset times as rows (5-hour, weekly, model windows, others), each counting down on its own. */
export function clockRows(clock: readonly ResetClock[] | undefined, now: number): ClockRow[] {
  return [...(clock ?? [])]
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.scope ?? "").localeCompare(b.scope ?? ""))
    .map((c) => ({
      kind: c.kind, scope: c.scope, label: clockLabel(c), resetsAt: c.resets_at, observedAt: c.observed_at, exhausted: c.exhausted,
      status: c.resets_at === null ? "unknown" : c.resets_at > now ? "counting" : "passed",
    }));
}

/** "resets in 2h 14m", "reset passed, not yet confirmed", "reset time not reported". */
export function clockText(r: Pick<ClockRow, "status" | "resetsAt">, now: number): string {
  if (r.status === "unknown" || r.resetsAt === null) return "reset time not reported";
  if (r.status === "passed") return "reset passed, not yet confirmed";
  return resetText(r.resetsAt, now);
}

/** The remembered entry for a reading's window (same kind and model), if any. */
export function clockFor(clock: readonly ResetClock[] | undefined, w: Pick<AccountWindow, "kind" | "scope">): ResetClock | undefined {
  return (clock ?? []).find((c) => c.kind === w.kind && (c.scope ?? null) === (w.scope ?? null));
}

/** A window's reset time: the reading's own, else the remembered one (a newer report of the same window wins). */
export function windowResetAt(clock: readonly ResetClock[] | undefined, w: AccountWindow): number | null {
  const c = clockFor(clock, w);
  if (w.resets_at !== null && (!c || c.resets_at === null)) return w.resets_at;
  return c?.resets_at ?? w.resets_at;
}

const WEEK_MS = 7 * 86_400_000;

/**
 * An absolute local time for hovers and the CLI: "3:10 PM" today, "Tue 3:10 PM" within a week, "Oct 4, 3:10 PM"
 * otherwise. `timeZone` for tests; the viewer's own zone by default.
 */
export function absTime(ms: number, now: number, timeZone?: string): string {
  const zone = timeZone ? { timeZone } : {};
  const day = (t: number) => new Intl.DateTimeFormat("en-US", { ...zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  const time = new Intl.DateTimeFormat("en-US", { ...zone, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  if (day(ms) === day(now)) return time;
  if (Math.abs(ms - now) < WEEK_MS) return `${new Intl.DateTimeFormat("en-US", { ...zone, weekday: "short" }).format(new Date(ms))} ${time}`;
  return `${new Intl.DateTimeFormat("en-US", { ...zone, month: "short", day: "numeric" }).format(new Date(ms))}, ${time}`;
}

/** The full date and time for a hover title: "Saturday, September 27, 2026 at 3:10 PM". */
export function fullTime(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { ...(timeZone ? { timeZone } : {}), dateStyle: "full", timeStyle: "short" }).format(new Date(ms));
}

export type Availability =
  | { kind: "none" }
  /** A limit was last reported hit; `until` = when the last of those windows resets (null: not reported). */
  | { kind: "exhausted"; until: number | null }
  /** Every limit that was hit has passed its reset, and no reading since says how much is used. */
  | { kind: "available_unconfirmed"; since: number };

const ACCOUNT_WIDE = new Set<ResetClock["kind"]>(["session", "weekly", "other"]);

/**
 * What the remembered reset times say about using the account (account-wide limits only). A remembered limit counts
 * until a later report says the account has room: a newer report of the same window replaces it (mergeClock), and a
 * later room-left report of any account-wide window, or a later known reading that is not exhausted, supersedes it.
 */
export function clockAvailability(clock: readonly ResetClock[] | undefined, usage: AccountUsage | null | undefined, now: number): Availability {
  const all = clock ?? [];
  const roomAt = Math.max(
    ...all.filter((c) => !c.exhausted && ACCOUNT_WIDE.has(c.kind)).map((c) => c.observed_at),
    usage && usage.state === "ok" && usage.windows.length ? usage.at : 0,
    0,
  );
  // A model's own limit (weekly_model) leaves the account usable for other models: shown on its row, not here.
  // A limit whose reset nobody reported counts only as long as the adapters hold such a limit (GUESSED_RESET_MS after it
  // was seen); after that nothing is known either way — never "limit reached" for days, never a made-up reset.
  const hit = all.filter((c) => c.exhausted && ACCOUNT_WIDE.has(c.kind) && roomAt <= c.observed_at
    && (c.resets_at !== null || now - c.observed_at < GUESSED_RESET_MS));
  if (!hit.length) return { kind: "none" };
  const pending = hit.filter((c) => c.resets_at === null || c.resets_at > now);
  if (pending.length) {
    return { kind: "exhausted", until: pending.some((c) => c.resets_at === null) ? null : Math.max(...pending.map((c) => c.resets_at as number)) };
  }
  return { kind: "available_unconfirmed", since: Math.max(...hit.map((c) => c.resets_at as number)) };
}

// ---- limit resets (ACCOUNTS-RESET-1) ----------------------------------------------

/**
 * How each provider's limit resets are used: "walkie" = Walkie can use one through the provider's own CLI on the
 * machine that holds the login (Codex app-server); "web" = only on the provider's own page (Claude: claude.ai
 * Settings > Usage > "Reset for free"); "none" = the provider has no resets (Kimi, Grok).
 */
export const RESET_REDEEM: Record<AccountProvider, "walkie" | "web" | "none"> = { codex: "walkie", claude: "web", kimi: "none", grok: "none" };

/** The provider's own usage page, when it has one Walkie can link to. */
export const USAGE_PAGE: Record<AccountProvider, string | null> = {
  claude: "https://claude.ai/settings/usage",
  codex: null,
  kimi: "https://www.kimi.com/code",
  grok: null,
};

export type ResetsDisplay =
  | { kind: "available"; n: number; applicable: number | null }
  | { kind: "none" }
  | { kind: "not_reported" };

export function resetsDisplay(u: AccountUsage | null): ResetsDisplay {
  const r = u?.resets;
  if (!r) return { kind: "not_reported" };
  return r.available > 0 ? { kind: "available", n: r.available, applicable: r.applicable } : { kind: "none" };
}

/** "Resets available: 2", "No resets available", "Not reported by Claude". */
export function resetsText(provider: AccountProvider, d: ResetsDisplay): string {
  if (d.kind === "available") return `Resets available: ${d.n}`;
  if (d.kind === "none") return "No resets available";
  return `Not reported by ${PROVIDER_NAME[provider]}`;
}

/** When the soonest current window resets ("5-hour window resets in 2h 05m"), or "" when no reset time is known. */
export function nextWindowReset(u: AccountUsage | null, now: number): string {
  const next = (u?.windows ?? []).filter((w) => w.resets_at !== null && w.resets_at > now).sort((a, b) => (a.resets_at ?? 0) - (b.resets_at ?? 0))[0];
  return next ? `${windowLabel(next)} window ${resetText(next.resets_at, now)}` : "";
}

/** Why a failed attempt failed, in words (nothing was sent in any of these). */
const FAILURE_TEXT: Record<ResetFailure, string> = {
  codex_missing: "The Codex CLI isn't installed where Walkie can find it on this machine.",
  not_signed_in: "Codex isn't signed in to this account on this machine: run `codex login`, then try again.",
  unreachable: "Couldn't reach Codex on this machine (it didn't start or didn't answer).",
  refused: "Codex refused to read this account's limits; if it asks you to sign in, run `codex login`.",
  not_saved: "Walkie couldn't write down the attempt (is the disk full?), so it sent nothing.",
};

/** What the dashboard says after a reset attempt, and whether trying again (same attempt) makes sense. */
export function resetOutcomeText(r: Pick<ResetResult, "outcome" | "left" | "failure">): { text: string; tone: "ok" | "bad" | "info"; retry: boolean } {
  const left = r.left;
  const leftText = left === null ? "" : ` · ${left === 0 ? "no resets" : left === 1 ? "1 reset" : `${left} resets`} left`;
  switch (r.outcome) {
    case "reset": return { text: `Reset used. The limits are refilled${leftText}.`, tone: "ok", retry: false };
    case "already_used": return { text: "The earlier try had already gone through (or Codex had nothing left to reset). This try used nothing more.", tone: "ok", retry: false };
    case "not_needed": return { text: "Codex says this account's usage doesn't need a reset right now. Nothing was used.", tone: "info", retry: false };
    case "none": return { text: "No reset is available on this account any more. Nothing was used.", tone: "info", retry: false };
    case "login_changed": return { text: "The login on this machine is now a different account (or signed out). Nothing was sent.", tone: "bad", retry: false };
    case "unverified": return { text: "Codex didn't say which account it is signed in as, so nothing was sent.", tone: "bad", retry: false };
    case "busy": return { text: "Another reset of this account is already in progress. Nothing more was sent.", tone: "info", retry: false };
    case "check_usage": return { text: "An earlier attempt may have gone through. Check usage before trying again; Walkie is re-reading it now.", tone: "bad", retry: false };
    case "dismissed": return { text: "You marked the earlier attempt as checked. Nothing was sent.", tone: "info", retry: false };
    case "unconfirmed": return { text: "Couldn't confirm the reset went through. Check the meter; trying again repeats this same attempt, so it can't use a second reset.", tone: "bad", retry: true };
    case "failed": return { text: `${FAILURE_TEXT[r.failure ?? "unreachable"]} Nothing was used.`, tone: "bad", retry: true };
  }
  return { text: "Unexpected answer from the daemon.", tone: "bad", retry: false };
}

/** The parts of an AgentView the unswitched-session check needs. */
export interface AgentLite {
  node: string; hostname: string; handle: string; agent: string; effective_state: string;
  status: { runtime?: string };
}

export interface UnswitchedSession { node: string; hostname: string; handle: string; agent: string; provider: "claude" | "codex" }

/**
 * ACCOUNTS-2: running Claude Code / Codex sessions on a machine that holds vault accounts for that CLI but that run
 * outside the switcher (started before the shims were on PATH, or with WALKIE_NO_SWITCH): they will hit their limit
 * instead of moving. "Restart to enable switching."
 */
export function unswitchedSessions(agents: readonly AgentLite[], accounts: readonly AccountView[]): UnswitchedSession[] {
  const vaultNodes = { claude: new Set<string>(), codex: new Set<string>() };
  const covered = new Set<string>();
  for (const a of accounts) {
    for (const m of a.machines) {
      if (m.vault && (a.provider === "claude" || a.provider === "codex")) vaultNodes[a.provider].add(m.node_id);
      if (m.vault) for (const ag of m.agents) covered.add(`${m.node_id}/${ag}`);
    }
    for (const l of a.leases ?? []) if (l.agent) covered.add(`${l.node_id}/${l.agent}`);
  }
  return agents.flatMap((g) => {
    const provider = g.status.runtime === "claude-code" ? "claude" : g.status.runtime === "codex" ? "codex" : null;
    if (!provider || g.effective_state === "offline" || !vaultNodes[provider].has(g.node) || covered.has(`${g.node}/${g.agent}`)) return [];
    return [{ node: g.node, hostname: g.hostname, handle: g.handle, agent: g.agent, provider }];
  });
}
