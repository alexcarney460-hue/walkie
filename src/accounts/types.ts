// Internal (this machine only) account types. Nothing here leaves the machine except through AccountSummary.
import type { AccountProvider, AccountResets, AccountWindow, UsageReason, UsageSource, UsageState } from "../protocol/accounts.ts";

/** Where a provider CLI keeps its login on this machine (a config directory; never replicated). */
export interface Login {
  provider: AccountProvider;
  /** Claude: CLAUDE_CONFIG_DIR or ~/.claude · Codex: CODEX_HOME or ~/.codex · Kimi: ~/.kimi-code · Grok: ~/.grok */
  dir: string;
  /** The provider's default location (Claude: the macOS Keychain item applies only there). */
  isDefault: boolean;
  /**
   * ACCOUNTS-2: a vault login. Claude: `dir` is "vault:<id>" and the token is the vault's setup-token. Codex: `dir` is
   * the account's own CODEX_HOME, whose sessions/ is shared with the user's (so no passive session readings).
   */
  vault?: true;
}

/** Who a login belongs to, read from the CLI's own files (never from a token, except Kimi's /me answer). */
export interface Identity {
  provider: AccountProvider;
  id: string;
  label: string;
  plan: string | null;
  /** Kimi before its /me answer: a provisional id for this login. */
  pending?: boolean;
  /** The login file itself says the login is over (Grok: expired access and no working refresh). */
  expired?: boolean;
  /** Sessions on an environment token (by variable name): the account is unknown and nothing is polled. */
  tokenLogin?: boolean;
}

/** The CLI's current access token, read-only, held only for one request. */
export interface AccessToken {
  value: string;
  /** Unix ms; null when unknown. */
  expiresAt: number | null;
  /** Claude Code login metadata needed to accept an access-only credential. */
  scopes?: string[];
  subscriptionType?: string;
  /** Codex: the ChatGPT-Account-Id header. */
  accountId?: string;
  /** The refresh token is past its own expiry: only a new login helps. */
  refreshExpired?: boolean;
  /** Codex API-key login: nothing to meter. */
  apiKey?: boolean;
}

/** One usage reading as an adapter produces it. */
export interface Reading {
  at: number;
  state: UsageState;
  reason: UsageReason | null;
  source: UsageSource;
  windows: AccountWindow[];
  until: number | null;
  /** `until` is a time the provider named (see AccountUsage.until_reported). */
  until_reported?: true;
  /** Limit resets, when the provider reports them (Codex). */
  resets?: AccountResets;
}

export const unknownReading = (at: number, reason: UsageReason, source: Reading["source"] = "none"): Reading =>
  ({ at, state: "unknown", reason, source, windows: [], until: null });
