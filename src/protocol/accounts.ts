// Model-provider accounts (WALKIE-ACCOUNTS-1 phase 1, watch-only). Each daemon records which Claude / Codex / Kimi /
// Grok account its running agent sessions use and how much of each usage window is left, and shares a summary with
// the team as an optional `accounts` field on the peer `vv` answer (PROTOCOL §3 "Accounts"), the same way machine
// stats ride there: no event kind is added (v0.1.3 peers would reject one), nothing is written to the event log, and
// daemons without accounts neither send the field nor read it (zod objects strip unknown keys).
//
// Only numbers, enums and controlled labels travel: never a token, a full email, a path or a raw provider string.
import { z } from "zod";
import type { TeamPolicy } from "./pool-rules.ts";

export const PROVIDERS = ["claude", "codex", "kimi", "grok"] as const;
export const AccountProvider = z.enum(PROVIDERS);
export type AccountProvider = z.infer<typeof AccountProvider>;

/** session = the rolling 5-hour window; weekly = the 7-day window; weekly_model = a 7-day window for one model. */
export const WindowKind = z.enum(["session", "weekly", "weekly_model", "other"]);
export type WindowKind = z.infer<typeof WindowKind>;

/** ok = a reading; unknown = no reading (see reason); exhausted = a limit is hit; relogin = the login must be renewed. */
export const UsageState = z.enum(["ok", "unknown", "exhausted", "relogin"]);
export type UsageState = z.infer<typeof UsageState>;

export const UsageReason = z.enum([
  "no_usage_api", "token_expiring", "no_token", "keychain_unavailable", "api_key_login", "http_error", "rate_limited",
  "login_expired", "limit_reached", "identity_pending", "not_polled", "token_login",
]);
export type UsageReason = z.infer<typeof UsageReason>;

export const UsageSource = z.enum(["api", "session", "log", "none"]);
export type UsageSource = z.infer<typeof UsageSource>;

export const MAX_ACCOUNTS_PER_NODE = 16;
export const MAX_WINDOWS = 6;
export const MAX_ACCOUNT_AGENTS = 32;
/** Unix ms far beyond any real reset (year ~3084); keeps a peer from sending absurd numbers. */
const MAX_TS = 2 ** 45;

// Labels are CONTROLLED, not free text (ACCOUNTS-FIX-1, Codex 6 / Codex 1): an account label is a masked email or
// one of the fixed provider labels, a plan is a known plan word, a model scope is a capitalised model name with an
// optional version. So a full email, a secret or an instruction cannot be published, and a peer cannot send one.
/** maskEmail's output: at most two characters of the local part and of the domain, then the TLD. */
export const MASKED_EMAIL_RE = /^[A-Za-z0-9]{1,2}\*\*\*@[A-Za-z0-9]{1,2}\*\*\*(?:\.[A-Za-z]{1,6})?$/;
/** The labels used when there is no email (Token login: a session on an environment token, account unknown). */
export const PROVIDER_LABELS = ["Claude account", "ChatGPT account", "Kimi account", "Grok account", "Token login"] as const;
export const PLAN_RE = /^(?:Free|Go|Plus|Pro|Max|Max [0-9]{1,3}x|Team|Business|Enterprise|Edu)$/;
export const MODEL_SCOPE_RE = /^[A-Z][a-z]{1,15}(?: [0-9]{1,2}(?:\.[0-9]{1,2})?)?$/;
const FIXED_LABELS: ReadonlySet<string> = new Set(PROVIDER_LABELS);

export function isAccountLabel(v: string): boolean {
  return v.length <= 48 && (MASKED_EMAIL_RE.test(v) || FIXED_LABELS.has(v));
}

const AccountLabel = z.string().max(48).refine(isAccountLabel, "masked email or provider label");
const PlanLabel = z.string().max(24).regex(PLAN_RE);
const ModelScope = z.string().max(24).regex(MODEL_SCOPE_RE);
const Ts = z.number().int().nonnegative().max(MAX_TS);

export const AccountId = z.string().regex(/^[0-9a-f]{24}$/);
/** The agent names that use an account on that machine (same rule as schemas.ts AgentName). */
const AgentRef = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,47}$/);

export const AccountWindow = z.object({
  kind: WindowKind,
  /** Share of the window used, 0–100. The dashboard shows what is LEFT (100 − used). */
  used_pct: z.number().min(0).max(100),
  resets_at: Ts.nullable(),
  /** The window's length in seconds when the provider says it (Codex, Kimi); null otherwise. */
  window_s: z.number().int().positive().max(90 * 86_400).nullable(),
  /** weekly_model: the model's display name ("Opus"); null for the others. */
  scope: ModelScope.nullable(),
});
export type AccountWindow = z.infer<typeof AccountWindow>;

/**
 * Limit resets the provider says the account holds (ACCOUNTS-RESET-1). Absent: the provider does not report resets
 * to Walkie (Claude serves its count to claude.ai only; Kimi and Grok have none). Only two small integers travel.
 */
export const AccountResets = z.object({
  /** Resets available to use. */
  available: z.number().int().min(0).max(99),
  /** Of those, how many the provider says would apply right now (Codex); null when it does not say. */
  applicable: z.number().int().min(0).max(99).nullable(),
});
export type AccountResets = z.infer<typeof AccountResets>;

export const AccountUsage = z.object({
  /** When this reading was taken (the reporting node's clock; on views, the viewer's). */
  at: Ts,
  state: UsageState,
  reason: UsageReason.nullable(),
  source: UsageSource,
  windows: z.array(AccountWindow).max(MAX_WINDOWS),
  /** exhausted: when the limit lifts, if known. */
  until: Ts.nullable(),
  /**
   * RESET-CLOCK-1 (additive; pre.7 RC): `until` is a time the provider named (true). Absent on readings from older
   * peers, whose CLI-log `until` of exactly its time + 60 min was a placeholder (accounts-format usageUntil).
   */
  until_reported: z.literal(true).optional().catch(undefined),
  /** Limit resets on the account, when the provider reports them (optional: pre-RESET-1 peers omit it). */
  resets: AccountResets.optional(),
});
export type AccountUsage = z.infer<typeof AccountUsage>;

/**
 * RESET-CLOCK-1: where a remembered reset time came from. api = a usage-meter read; session = a CLI's session file or
 * a wrapped session's own reading; log = a CLI log; message = a provider's "limit reached, resets …" message.
 */
export const ClockSource = z.enum(["api", "session", "log", "message"]);
export type ClockSource = z.infer<typeof ClockSource>;

/**
 * RESET-CLOCK-1: the last reset time a provider reported for one window of an account, kept after the reading that
 * carried it goes stale or fails, across restarts, so the countdown runs without asking again. resets_at null = the
 * provider did not say (shown as unknown, never guessed). Only numbers and enums; never a token.
 */
export const ResetClock = z.object({
  kind: WindowKind,
  scope: ModelScope.nullable(),
  window_s: z.number().int().positive().max(90 * 86_400).nullable(),
  resets_at: Ts.nullable(),
  /** When it was reported (the reading's time, or the limit message's). */
  observed_at: Ts,
  /** The window was used up (or a limit named it) when observed: its reset should make the account usable again. */
  exhausted: z.boolean(),
  source: ClockSource,
});
export type ResetClock = z.infer<typeof ResetClock>;
/** Remembered windows per account (the session, weekly and a few model windows). */
export const MAX_CLOCK = 8;

/**
 * ACCOUNTS-2: the account is in this machine's vault, so `walkie claude` / `walkie codex` can switch to it. `policy`
 * says who else may have it handed out (local = nobody; own = the owner's other machines; shared = also the listed
 * teammates). Old peers strip the field.
 */
export const VAULT_POLICIES = ["local", "own", "shared"] as const;
const HandleRef = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/);
export const AccountVault = z.object({
  policy: z.enum(VAULT_POLICIES),
  share_with: z.array(HandleRef).max(16).optional(),
  /**
   * An opaque credential generation (random, new on every add): a mark a borrower learned about this credential is
   * dropped once the owner replaces it (round 2, Codex 8). Not a secret.
   */
  gen: z.string().regex(/^[0-9a-f]{1,32}$/).optional(),
  /**
   * COMPANY POOL (additive): this machine lends the login to every member's machines right now (the team's pool is on
   * and its person has not marked it personal). Its `policy` is unchanged (released peers read that).
   */
  company: z.literal(true).optional().catch(undefined),
  /** COMPANY POOL (additive): its person keeps it out of the pool (`walkie accounts personal`). */
  personal: z.literal(true).optional().catch(undefined),
  /**
   * COMPANY POOL (additive): since when this machine is the account's home (the machine borrowers lease it from):
   * when it was added, or when its person promoted this machine's own login of it. The newest online one lends.
   */
  home_at: Ts.optional().catch(undefined),
});
export type AccountVault = z.infer<typeof AccountVault>;


/**
 * COMPANY POOL: the team's pool setting, set by an owner (`walkie accounts pool on|off`): company = on (every vault
 * login not marked personal is lent to every member's machines); per-account = off (the default, and when unknown).
 */
export const TEAM_POLICIES = ["company", "per-account"] as const satisfies readonly TeamPolicy[];
export { DEFAULT_TEAM_POLICY, type TeamPolicy } from "./pool-rules.ts";
export const TeamPolicyAd = z.object({ policy: z.enum(TEAM_POLICIES), at: Ts });
export type TeamPolicyAd = z.infer<typeof TeamPolicyAd>;

export const AccountSummary = z.object({
  /** sha256(provider | stable provider ids), first 24 hex: the same account on two machines has the same id. */
  id: AccountId,
  provider: AccountProvider,
  /** Masked email ("al***@gm***.com") or a provider label (PROVIDER_LABELS). */
  label: AccountLabel,
  plan: PlanLabel.nullable(),
  /** Agents on that machine using the account right now. */
  agents: z.array(AgentRef).max(MAX_ACCOUNT_AGENTS),
  usage: AccountUsage.nullable(),
  /** Last time a session was seen using it (reporting node's clock). */
  last_seen: Ts,
  vault: AccountVault.optional(),
  /**
   * RESET-CLOCK-1: the remembered reset times (reporting node's clock). Optional and additive: pre-RESET-CLOCK peers
   * strip it (zod objects drop unknown keys); a malformed list is dropped on its own, never the snapshot.
   */
  clock: z.array(ResetClock).max(MAX_CLOCK).optional().catch(undefined),
});
export type AccountSummary = z.infer<typeof AccountSummary>;

export const MAX_LEASES_PER_NODE = 64;

/**
 * ACCOUNTS-2: one wrapped session (`walkie claude` / `walkie codex`, or `walkie accounts exec`) on the reporting
 * machine and the account it runs on. `owner` is set when the account is another member's (a hand-out).
 */
export const AccountLease = z.object({
  account: AccountId,
  provider: z.enum(["claude", "codex"]),
  agent: AgentRef.optional(),
  since: Ts,
  owner: HandleRef.optional(),
  /** The owner-issued hand-out this session runs on (round 2, Codex 7): only a lease naming a live grant counts. */
  grant: z.string().regex(/^[0-9a-f]{16}$/).optional(),
});
export type AccountLease = z.infer<typeof AccountLease>;

export const AccountsSnapshot = z.object({
  at: Ts,
  accounts: z.array(AccountSummary).max(MAX_ACCOUNTS_PER_NODE),
  /** Old daemons neither send nor read it; a malformed list is dropped on its own. */
  leases: z.array(AccountLease).max(MAX_LEASES_PER_NODE).optional().catch(undefined),
  /**
   * COMPANY POOL (additive): the team accounts policy this machine's person set (only an owner's setting counts; the
   * newest wins). Absent = never set here.
   */
  team_policy: TeamPolicyAd.optional().catch(undefined),
});
export type AccountsSnapshot = z.infer<typeof AccountsSnapshot>;

/** One machine that has an account (an account can be logged in on several of its owner's machines). */
export interface AccountMachineView {
  node_id: string; hostname: string; handle: string; online: boolean; self: boolean; agents: string[];
  /** The reading THIS machine reported (on this node's clock), or null. An agent's chip uses its own machine's. */
  usage: AccountUsage | null;
  /** ACCOUNTS-2: this machine holds the account in its vault. */
  vault?: AccountVault;
  /** RESET-CLOCK-1: the reset times this machine remembers (on this node's clock). */
  clock?: ResetClock[];
}

/** ACCOUNTS-2: a wrapped session on some machine running on this account. */
export interface AccountLeaseView {
  handle: string; hostname: string; node_id: string; agent: string | null; since: number;
  /**
   * Backed by something checkable (round 1, Codex 7): the account owner's own machine, or a hand-out this daemon (the
   * owner's) granted to that machine. Anything else is a member's claim: shown, never used for scheduling.
   */
  verified?: boolean;
}

/**
 * GET /v1/accounts: one entry per (owner, account id). Readings are kept per reporting machine and never cross
 * members (ACCOUNTS-FIX-1, Codex 3 / Opus 1): another member's daemon reporting the same id is an unverified claim,
 * listed as its own entry and named in `claimed_by`, never allowed to overwrite the owner's reading.
 */
export interface AccountView {
  /** Unique per entry: "<owner handle>:<account id>". */
  key: string;
  id: string;
  provider: AccountProvider;
  label: string;
  plan: string | null;
  /** The member whose machines report this entry (one handle). */
  owners: string[];
  /** Other members whose machines report the same account id (unverified; each is its own entry). */
  claimed_by: string[];
  machines: AccountMachineView[];
  /** The freshest reading among the owner's machines, `at` and reset times on this node's clock. */
  usage: AccountUsage | null;
  /** The machine that took that reading. */
  usage_host: string | null;
  last_seen: number;
  /** ACCOUNTS-2: the owner's machines that hold it in a vault (switchable), with their policy. */
  vault?: AccountVault | null;
  /** ACCOUNTS-2: wrapped sessions running on it, team-wide (on any member's machine). */
  leases?: AccountLeaseView[];
  /**
   * RESET-CLOCK-1: the newest remembered reset time per window across the owner's machines, on this node's clock. The
   * dashboard and `walkie accounts` count down from it on their own.
   */
  clock?: ResetClock[];
}

/** What a reset attempt came to. Only "reset" spent one for sure; "unconfirmed" may have. */
export type ResetOutcome =
  | "reset" // a reset was used; the limits are refilled
  | "already_used" // this attempt's reset had gone through earlier (a retry after an unconfirmed try): nothing MORE used
  | "not_needed" // Codex: the usage does not need a reset right now; nothing was used
  | "none" // no reset is available; nothing was used
  | "login_changed" // the login on this machine is not the confirmed account any more; nothing was used
  | "unverified" // Codex did not say which account it is signed in as; nothing was used (fail closed)
  | "busy" // another attempt on this account is running; nothing more was used
  | "check_usage" // an earlier try may have gone through: usage must be re-read before trying again; nothing sent
  | "dismissed" // a person marked an unconfirmed attempt as checked (RESET-4); nothing was sent
  | "unconfirmed" // the use was sent but its answer did not arrive: it may have gone through
  | "failed"; // the attempt failed before anything was sent; nothing was used

/** Why a "failed" attempt failed (nothing was sent in any of these). */
export type ResetFailure = "codex_missing" | "not_signed_in" | "unreachable" | "refused" | "not_saved";

/** POST /v1/accounts/reset's answer (ACCOUNTS-RESET-1/2). */
export interface ResetResult {
  outcome: ResetOutcome;
  /** Resets left afterwards, when known. */
  left: number | null;
  failure?: ResetFailure;
}

/**
 * POST /v1/accounts/reset/prepare's answer: the attempt the confirmation sheet is about to confirm, minted and bound
 * by the daemon (RESET-2). `earlier` is set while an earlier try on this account is unconfirmed: the same id comes back
 * (never a new one) and `reread` says whether usage was read again after that try.
 */
export interface ResetAttemptView {
  id: string;
  account: string;
  earlier: { tried_at: number; reread: boolean } | null;
  /** The daemon stopped during this attempt's last try before anything was sent to Codex: nothing was used. */
  interrupted?: boolean;
}
