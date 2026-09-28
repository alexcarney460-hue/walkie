// Accounts on this machine (WALKIE-ACCOUNTS-1 phase 1, watch-only).
//   record: after each discovery pass, the account each running Claude Code / Codex / Kimi / Grok session uses is
//           identified from the CLI's own files and remembered in ~/.walkie/accounts.json (0600; ids, masked labels,
//           plan, the local login directory and the last reading — never a token) for 7 days after it was last seen.
//   poll:   each remembered account whose login is on this machine is polled (poll.ts): every 5 min, every 60 s
//           while a window is ≥ 80 % used, backing off on 429 / 5xx. Only while it is still the account AT that login
//           (ACCOUNTS-FIX-1, Codex 5): the login is re-identified before each poll and after it, so after a login change
//           the old account is left alone (its last reading goes stale) and a result that raced the change is dropped.
//           Kimi is verified by /me on every poll. A session on an environment token is recorded as "Token login"
//           (account unknown) and never polled; an explicit CLAUDE_CONFIG_DIR is never the default login.
//   share:  snapshot() is what the peer `vv` answer carries (`accounts`) and what the local views show.
// Tokens are read only inside poll.ts, for one request, and are never stored, logged or moved.
import { existsSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import {
  AccountsSnapshot, MAX_ACCOUNT_AGENTS, MAX_ACCOUNTS_PER_NODE, type AccountSummary,
} from "../protocol/accounts.ts";
import { scrubMessage } from "../integrations/scrub.ts";
import type { Logger } from "../daemon/logger.ts";
import { identifyClaude, systemKeychain, type KeychainReader } from "./adapters/claude.ts";
import { codexAuthSnapshot, identifyCodex } from "./adapters/codex.ts";
import { ResetAttempts, type Attempt } from "./attempts.ts";
import {
  keepAside, leftoverCorrupt, LEDGER_FILE, markCorruptChecked, MAX_RECORDS, readAccountsFile, readLedgerFile, writeAccountsFile, writeLedgerFile,
  type HoldRow, type KimiAliases, type RecordRow, type Recovery,
} from "./store.ts";
import { identifyGrok } from "./adapters/grok.ts";
import { provisionalKimiIdentity } from "./adapters/kimi.ts";
import type { FetchLike } from "./http.ts";
import { accountId } from "./mask.ts";
import { pollAccount, POLL_MS } from "./poll.ts";
import { launchCodexAppServer, redeemCodexReset, renewCodexLogin, type AppServerLauncher, type ResetResult } from "./resets.ts";
import { freshRoomOf } from "./select.ts";
import { sweepLeaseHomes } from "./vault/codex-lease-home.ts";
import type { ResetAttemptView } from "../protocol/accounts.ts";
import type { Identity, Login, Reading } from "./types.ts";
import { activeLeases, markApplies, markExcludes, markLifted, readMarks, readSessionReadings, type Lease } from "./leases.ts";
import { clockFromMark, clockFromReading, markGuessed, mergeClock, validClock } from "./clock.ts";
import type { VaultEntry } from "./vault/vault.ts";
import type { CodexAccess } from "./vault/codex-access.ts";
import { type AccountLease, type AccountVault, type AccountUsage as UsageT, type ResetClock, type TeamPolicyAd } from "../protocol/accounts.ts";

export const RECORD_TTL_MS = 7 * 86_400_000;
/** COMPANY POOL: a lent Codex login is renewed when its access token has less than this left, */
export const RENEW_AHEAD_MS = 48 * 3_600_000;
/** … at most once per this per login, */
export const RENEW_RETRY_MS = 60 * 60_000;
/** … and leased homes of ended sessions are swept this often. */
export const SWEEP_MS = 10 * 60_000;
export const TICK_MS = 15_000;

/** What discovery tells the service about one running session. */
export interface SessionRef {
  agent: string;
  runtime: "claude-code" | "codex" | "kimi" | "grok";
  /** CLAUDE_CONFIG_DIR (Claude) or CODEX_HOME (Codex) from the session's environment, when set. */
  login_dir?: string;
  /** The session runs on an environment token (detected by variable name only): its account is unknown. */
  token_login?: boolean;
  /** ACCOUNTS-2: WALKIE_ACCOUNT of a session a Walkie wrapper launched on a vault account (an account id, not a secret). */
  account?: string;
}

/** ACCOUNTS-2: this machine's vault as the daemon sees it (no secrets except through claudeToken, for one poll). */
export interface VaultSource {
  list(): VaultEntry[];
  claudeToken(id: string): Promise<string>;
  /** COMPANY POOL: a Codex login's lease copy (never its refresh token or email); null when it must not be lent. */
  codexAccess?(id: string, now: number): CodexAccess | null;
  /** COMPANY POOL: when a vault Codex login's access token runs out (null: unreadable), for renewal. */
  codexExpiry?(id: string): number | null;
}

export interface AccountsOptions {
  /** The user's home, where the provider CLIs keep their logins (tests use a temp dir). */
  home?: string;
  fetch?: FetchLike;
  keychain?: KeychainReader;
  clock?: () => number;
  tickMs?: number;
  /** false: record accounts but never poll (tests of recording alone). */
  poll?: boolean;
  /** Starts the Codex CLI's app-server for a reset (tests pass a fake; RESET-1). */
  codexAppServer?: AppServerLauncher;
  /** ACCOUNTS-2: the vault (switchable accounts); none = watch-only as in phase 1. */
  vault?: VaultSource | null;
  /** COMPANY POOL: the team accounts policy this machine's person set (config.json), read at each tick. */
  teamPolicy?: () => TeamPolicyAd | null;
  /** COMPANY POOL: whether the team's pool is on as this machine knows it (fail closed: false when unknown). */
  poolOn?: () => boolean;
}

/** Why a reset or refresh request was refused before anything happened (the route maps it to an HTTP status). */
export class AccountActionError extends Error {
  constructor(readonly code: "not_found" | "not_supported" | "not_signed_in" | "login_changed" | "unknown_attempt" | "request_reused" | "ledger_unreadable" | "ledger_unwritable", readonly detail?: string) { super(code); }
}

/** A person's "refresh" brings an account's next poll forward at most this often. */
export const REFRESH_MIN_MS = 30_000;
/**
 * An unconfirmed attempt may be retried only after a usage reading that STARTED at least this long after the try
 * (RESET-5): Codex's own count needs a moment to reflect a use that went through.
 */
export const REREAD_DELAY_MS = 30_000;

interface Rec {
  identity: Identity;
  login: Login;
  agents: readonly string[];
  lastSeen: number;
  reading: Reading | null;
  nextAt: number;
  backoffMs: number;
  /** Polls in a row skipped for an expiring token (poll.ts tokenGate). */
  skips: number;
  /** Its login now belongs to another account (logged once, when that is first seen). */
  unbound?: boolean;
  /** A provider's Retry-After, a backoff or a Keychain hold: no poll before this, even on a person's refresh. */
  notBefore?: number;
  /** A re-read due after an unconfirmed reset try (RESET-5): kept through other polls until one starts at or after it. */
  rereadAt?: number;
  /**
   * RESET-CLOCK-1: the last reset time reported per window (clock.ts). Kept when a reading goes stale or a poll fails
   * (a reading without windows never erases it), saved in accounts.json, shared on the snapshot.
   */
  resetClock: readonly ResetClock[];
}


const AGENT_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
/** Never polled (token logins). */
const NEVER = Number.MAX_SAFE_INTEGER;

/**
 * The login a session uses. Any set CLAUDE_CONFIG_DIR / CODEX_HOME is NOT the default login, even when it names the
 * default directory (Opus MED 2): Claude then reads <dir>/.claude.json and its own Keychain item, not ~/.claude.json.
 */
export function loginFor(s: Pick<SessionRef, "runtime" | "login_dir">, home: string): Login {
  const def = (name: string) => join(home, name);
  const pick = (name: string): Login => {
    const dir = s.login_dir ? resolve(s.login_dir) : def(name);
    return { provider: s.runtime === "claude-code" ? "claude" : "codex", dir, isDefault: !s.login_dir };
  };
  if (s.runtime === "claude-code") return pick(".claude");
  if (s.runtime === "codex") return pick(".codex");
  if (s.runtime === "kimi") return { provider: "kimi", dir: def(".kimi-code"), isDefault: true };
  return { provider: "grok", dir: def(".grok"), isDefault: true };
}

export class AccountsService {
  private readonly records = new Map<string, Rec>();
  private kimiAliases: KimiAliases = {};
  /**
   * The reset ledger could not be read (the file kept aside, by name). Persisted: resets stay refused, across restarts,
   * until a person says they checked usage (resolveReset), since an unconfirmed attempt may be in what was lost.
   */
  private ledgerProblem: Recovery | null = null;
  /** Polling holds read from the ledger for accounts not recorded (again) yet: applied when discovery records them. */
  private pendingHolds = new Map<string, HoldRow>();
  private readonly walkieHome: string;
  private readonly ledgerFile: string;
  private readonly home: string;
  private readonly fetchFn: FetchLike;
  private readonly keychain: KeychainReader;
  private readonly clock: () => number;
  private readonly tickMs: number;
  private readonly polling: boolean;
  private readonly file: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;
  private keychainBlockedUntil = 0;
  private identityCache = new Map<string, { mtime: number; identity: Identity | null }>();
  private readonly launcher: AppServerLauncher;
  /** Reset attempts, minted and bound by this daemon (attempts.ts). */
  private readonly attempts = new ResetAttempts(() => this.clock());
  /** Attempts whose use is running now, by id: the same id gets the same promise, never a second use. */
  private readonly inflight = new Map<string, Promise<ResetResult>>();
  private readonly refreshedAt = new Map<string, number>();
  private readonly vault: VaultSource | null;
  /** Vault entries as of the last sync (by id). */
  private vaultEntries = new Map<string, VaultEntry>();
  /** Last readings of vault accounts from accounts.json (used when the vault record is first re-created). */
  private readonly savedVaultReadings = new Map<string, Reading>();
  /** RESET-CLOCK-1: the remembered reset times of vault accounts from accounts.json (like savedVaultReadings). */
  private readonly savedVaultClocks = new Map<string, readonly ResetClock[]>();
  private lastLeases = "";
  private readonly teamPolicy: () => TeamPolicyAd | null;
  private readonly poolOn: () => boolean;
  private lastTeamPolicy = "";
  /** COMPANY POOL: vault Codex logins' last renewal try (the home renews what it lends), and the one running. */
  private readonly renewTried = new Map<string, number>();
  private renewing: Promise<void> | null = null;
  private lastSweep = 0;

  constructor(walkieHome: string, private readonly log: Logger, private readonly onChange: (s: AccountsSnapshot) => void, opts: AccountsOptions = {}) {
    this.home = opts.home ?? homedir();
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.keychain = opts.keychain ?? systemKeychain;
    this.clock = opts.clock ?? Date.now;
    this.tickMs = opts.tickMs ?? TICK_MS;
    this.polling = opts.poll !== false;
    this.launcher = opts.codexAppServer ?? launchCodexAppServer;
    this.vault = opts.vault ?? null;
    this.teamPolicy = opts.teamPolicy ?? (() => null);
    this.poolOn = opts.poolOn ?? (() => false);
    this.file = join(walkieHome, "accounts.json");
    this.walkieHome = walkieHome;
    this.ledgerFile = join(walkieHome, LEDGER_FILE);
    this.load();
  }

  start(): void {
    this.stopped = false;
    this.publish();
    if (!this.polling) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    (this.timer as { unref?: () => void }).unref?.();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- recording -----------------------------------------------------------------

  private identify(login: Login, now: number): Identity | null {
    if (login.vault && login.provider === "claude") {
      const e = this.vaultEntries.get(login.dir.slice("vault:".length));
      return e ? { provider: "claude", id: e.id, label: e.label, plan: e.plan } : null;
    }
    const file = login.provider === "claude" ? (login.isDefault ? join(this.home, ".claude.json") : join(login.dir, ".claude.json"))
      : login.provider === "codex" ? join(login.dir, "auth.json")
      : login.provider === "kimi" ? join(login.dir, "credentials", "kimi-code.json")
      : join(login.dir, "auth.json");
    let mtime = -1;
    try { mtime = statSync(file).mtimeMs; } catch { return null; }
    const key = `${login.provider}|${login.dir}`;
    const hit = this.identityCache.get(key);
    // Kimi's credentials file is rewritten every refresh; its provisional identity depends on the path only.
    if (hit && (hit.mtime === mtime || login.provider === "kimi")) return hit.identity;
    const identity = login.provider === "claude" ? identifyClaude(login, this.home)
      : login.provider === "codex" ? identifyCodex(login)
      : login.provider === "kimi" ? provisionalKimiIdentity(login)
      : identifyGrok(login, now);
    this.identityCache.set(key, { mtime, identity });
    return identity;
  }

  /** The alias-resolved identity for a Kimi login once /me has answered. */
  private resolveKimi(ident: Identity): Identity {
    const real = ident.pending ? this.kimiAliases[ident.id] : undefined;
    return real ? { provider: "kimi", id: real.id, label: real.label, plan: real.plan } : ident;
  }

  /** The account a login belongs to right now (from its files; Kimi through the /me alias). */
  private currentIdentity(login: Login, now: number): Identity | null {
    const raw = this.identify(login, now);
    return raw && raw.provider === "kimi" ? this.resolveKimi(raw) : raw;
  }

  /** "Token login" for sessions on an environment token: one per provider on this machine, never polled. */
  private tokenLoginIdentity(login: Login): Identity {
    return { provider: login.provider, id: accountId(login.provider, "token-login", hostname(), this.home), label: "Token login", plan: null, tokenLogin: true };
  }

  /** Whether the record's login still belongs to its account (else it is not polled, and a raced result is dropped). */
  private bound(rec: Rec, now: number): boolean {
    if (rec.identity.tokenLogin) return false;
    if (rec.identity.pending) return true; // a provisional Kimi id is the login itself
    return this.currentIdentity(rec.login, now)?.id === rec.identity.id;
  }

  /** Called after each discovery pass with every running session on this machine. */
  observe(sessions: readonly SessionRef[]): void {
    const now = this.clock();
    const agentsBy = new Map<string, string[]>();
    let changed = false;
    for (const s of sessions) {
      const wrapped = s.account ? this.records.get(s.account) : undefined;
      if (s.account && !wrapped) continue; // a vault account not synced yet: next pass
      const login = wrapped?.login ?? loginFor(s, this.home);
      const ident = wrapped ? wrapped.identity : s.token_login ? this.tokenLoginIdentity(login) : this.currentIdentity(login, now);
      if (!ident) continue;
      const list = agentsBy.get(ident.id) ?? [];
      if (AGENT_RE.test(s.agent) && !list.includes(s.agent)) list.push(s.agent);
      agentsBy.set(ident.id, list);
      const prev = this.records.get(ident.id);
      if (!prev) {
        this.log.info("account_recorded", { provider: ident.provider, account: ident.id });
        changed = true;
      } else if (prev.identity.label !== ident.label || prev.identity.plan !== ident.plan || prev.identity.expired !== ident.expired || prev.login.dir !== login.dir) {
        changed = true;
      }
      // Everything the poller keeps (next poll, backoff, a provider's Retry-After hold) survives a discovery pass
      // (RESET-3): a rebuilt record would otherwise let the next tick poll through a hold every 15 s.
      this.records.set(ident.id, prev
        ? { ...prev, identity: ident, login, lastSeen: now, ...(ident.tokenLogin ? { nextAt: NEVER } : {}) }
        : this.withHold({ identity: ident, login, agents: [], lastSeen: now, reading: null, nextAt: ident.tokenLogin ? NEVER : now, backoffMs: 0, skips: 0, resetClock: [] }, now));
    }
    for (const [id, rec] of this.records) {
      const agents = (agentsBy.get(id) ?? []).slice(0, MAX_ACCOUNT_AGENTS).sort();
      if (agents.join(",") !== rec.agents.join(",")) {
        this.records.set(id, { ...rec, agents });
        changed = true;
      }
      if (now - rec.lastSeen > RECORD_TTL_MS) {
        this.records.delete(id);
        changed = true;
      }
    }
    if (this.capRecords()) changed = true;
    if (changed) {
      this.save();
      this.publish();
    }
  }

  /** At most MAX_RECORDS accounts, in memory as in the file: the least recently seen go first. */
  private capRecords(): boolean {
    const extra = this.records.size - MAX_RECORDS;
    if (extra <= 0) return false;
    [...this.records.values()].sort((a, b) => a.lastSeen - b.lastSeen).slice(0, extra).forEach((r) => this.records.delete(r.identity.id));
    return true;
  }

  // ---- polling -------------------------------------------------------------------

  /** Polls every account that is due, one at a time. Never throws. */
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      this.syncVault();
      this.syncLeases();
      this.syncTeamPolicy();
      this.learnPassive();
      this.sweepLeases();
      if (!this.polling) return;
      this.renewCodexLogins();
      const isDue = (r: Rec, at: number) => !r.identity.tokenLogin && r.nextAt <= at && (r.notBefore ?? 0) <= at;
      const now = this.clock();
      const due = [...this.records.values()].filter((r) => isDue(r, now)).sort((a, b) => a.nextAt - b.nextAt).map((r) => r.identity.id);
      for (const id of due) {
        if (this.stopped) return;
        // Re-checked right before it starts (Codex r3 LOW 3): an earlier poll in this batch may have taken a while, the
        // clock may have moved, and a refresh or reset may have changed the record.
        const rec = this.records.get(id);
        if (!rec || !isDue(rec, this.clock())) continue;
        await this.pollOne(rec);
      }
    } catch (err) {
      this.log.warn("accounts_tick_failed", { err: scrubMessage((err as Error).message, [], 200) });
    } finally {
      this.running = false;
    }
  }

  /** Leaves a record whose login changed hands unpolled for now (re-checked every 5 min: the user may log back in). */
  private unbound(rec: Rec, now: number): void {
    this.records.set(rec.identity.id, { ...rec, nextAt: now + POLL_MS, backoffMs: 0, skips: 0, unbound: true });
    if (!rec.unbound) this.log.info("account_login_changed", { provider: rec.identity.provider, account: rec.identity.id });
  }

  private async pollOne(rec: Rec): Promise<void> {
    const now = this.clock();
    if (!this.bound(rec, now)) { this.unbound(rec, now); return; }
    const vaultId = rec.login.vault && rec.login.provider === "claude" ? rec.identity.id : null;
    const entry = vaultId ? this.vaultEntries.get(vaultId) : undefined;
    const res = await pollAccount(rec.identity.provider, rec.login, rec.identity, rec.reading, rec.backoffMs, {
      fetch: this.fetchFn, keychain: this.keychain, now, keychainBlockedUntil: this.keychainBlockedUntil, tokenSkips: rec.skips,
      ...(vaultId && this.vault ? { vaultToken: { read: () => (this.vault as VaultSource).claudeToken(vaultId), expiresAt: entry?.expires_at ?? null } } : {}),
    });
    if (res.keychainBlockedUntil) {
      this.keychainBlockedUntil = res.keychainBlockedUntil;
      this.log.warn("accounts_keychain_unavailable", { note: "Keychain did not answer without a prompt; Claude usage unknown for 6 h" });
    }
    if (res.error) this.log.warn("account_usage_failed", { provider: rec.identity.provider, account: rec.identity.id, err: scrubMessage(res.error, [], 200) });
    const current = this.records.get(rec.identity.id);
    if (!current) return; // forgotten meanwhile
    const after = this.clock();
    const skips = res.skipped ? current.skips + 1 : 0;
    const held = !!res.error || res.backoffMs > 0 || !!res.keychainBlockedUntil || res.reading?.reason === "keychain_unavailable" || res.reading?.reason === "rate_limited";
    // Anchored to when the answer ARRIVED (RESET-4): a Retry-After counts from its receipt, not from the request's start.
    const reread = (current.rereadAt ?? 0) > now ? current.rereadAt as number : 0; // not yet satisfied by this poll
    const cadenceAt = after + res.nextInMs;
    const next: Rec = {
      ...current, reading: res.reading ?? current.reading, backoffMs: res.backoffMs, skips, unbound: false,
      resetClock: mergeClock(current.resetClock, clockFromReading(res.reading), after),
      nextAt: held || !reread ? cadenceAt : Math.min(cadenceAt, reread), notBefore: held ? cadenceAt : 0, rereadAt: reread,
    };
    if (res.identity) this.kimiAnswered(current, next, res.identity);
    else if (!this.bound(current, after)) this.unbound(current, after); // the login changed during the request: dropped
    else this.records.set(rec.identity.id, next);
    this.save();
    this.publish();
  }

  /**
   * Kimi: /me named the account the polled token belongs to. The same account: the reading is its own. Another one
   * (the provisional record identified, or the user logged in to a different account): the reading, the login and its
   * agents go to that account, the alias follows, and the old real record keeps its last reading, unpolled.
   */
  private kimiAnswered(current: Rec, next: Rec, real: Identity): void {
    const oldId = current.identity.id;
    if (real.id === oldId) { this.records.set(oldId, next); return; }
    const provisional = this.identify(current.login, this.clock());
    if (provisional?.pending) this.kimiAliases = { ...this.kimiAliases, [provisional.id]: { id: real.id, label: real.label, plan: real.plan } };
    const target = this.records.get(real.id);
    if (current.identity.pending) this.records.delete(oldId);
    else this.records.set(oldId, { ...current, agents: [], nextAt: this.clock() + POLL_MS, unbound: true });
    this.records.set(real.id, {
      ...next, identity: real, reading: next.reading, login: current.login,
      agents: [...new Set([...(target?.agents ?? []), ...current.agents])].sort(),
      lastSeen: Math.max(next.lastSeen, target?.lastSeen ?? 0),
      resetClock: mergeClock(target?.resetClock ?? [], next.resetClock, this.clock()),
    });
    this.identityCache.clear();
    this.log.info(current.identity.pending ? "account_identified" : "account_login_changed", { provider: "kimi", account: real.id });
  }

  // ---- limit resets (RESET-1/2) ---------------------------------------------------

  /** A Codex account held here, with its login's identity read ONCE (the snapshot every check compares against). */
  private resetTarget(account: string): { rec: Rec; snap: NonNullable<ReturnType<typeof codexAuthSnapshot>> } {
    if (this.ledgerProblem !== null) throw new AccountActionError("ledger_unreadable", this.ledgerProblem.kept);
    const rec = this.records.get(account);
    if (!rec) throw new AccountActionError("not_found");
    if (rec.identity.provider !== "codex" || rec.identity.tokenLogin) throw new AccountActionError("not_supported");
    const snap = codexAuthSnapshot(rec.login);
    if (!snap) throw new AccountActionError("not_signed_in");
    if (snap.identityId !== account) throw new AccountActionError("login_changed");
    return { rec, snap };
  }

  /** Usage was read from the provider after `at` (an unconfirmed try's result can then be checked by a person). */
  private rereadSince(account: string, at: number): boolean {
    const r = this.records.get(account)?.reading;
    return !!r && r.source === "api" && r.at >= at + REREAD_DELAY_MS; // `at` is when the reading's poll STARTED
  }

  /**
   * The attempt the confirmation sheet confirms (RESET-2). While this account has an attempt that is not final, that
   * attempt comes back (never a new id): above all an unconfirmed one, which a new id could double-spend. A new one is
   * bound to the account (Walkie and ChatGPT account ids) and its login directory, from one read of the login.
   */
  prepareReset(account: string): ResetAttemptView {
    const { rec, snap } = this.resetTarget(account);
    this.attempts.sweep();
    const pending = this.attempts.pendingFor(account);
    if (pending && pending.state === "open" && (pending.chatgptAccount !== snap.chatgptAccount || pending.loginDir !== rec.login.dir)) this.attempts.drop(pending.id);
    else if (pending) return this.attempts.view(pending, pending.triedAt !== null && this.rereadSince(account, pending.triedAt));
    const a = this.attempts.mint({ account, loginDir: rec.login.dir, chatgptAccount: snap.chatgptAccount });
    if (!this.save()) { this.attempts.drop(a.id); throw new AccountActionError("ledger_unwritable"); }
    return this.attempts.view(a, false);
  }

  /**
   * Uses the reset an attempt (from prepareReset) stands for. The same id while it runs gets the same promise; a final
   * attempt's answer is replayed; an id is never used for another account. An unconfirmed attempt is retried only
   * after usage was read again, with the same idempotency key and credit, so Codex reconciles it.
   */
  useReset(account: string, id: string): Promise<ResetResult> {
    this.attempts.sweep();
    const a = this.attempts.get(id);
    if (!a) return Promise.reject(new AccountActionError("unknown_attempt"));
    if (a.account !== account) return Promise.reject(new AccountActionError("request_reused"));
    if (a.state === "final" && a.result) return Promise.resolve(a.result);
    const running = this.inflight.get(id);
    if (running) return running;
    const other = this.attempts.pendingFor(account);
    if (other && other.id !== id) return Promise.resolve({ outcome: "busy", left: null });
    if (a.state === "unconfirmed" && !(a.triedAt !== null && this.rereadSince(account, a.triedAt))) return Promise.resolve({ outcome: "check_usage", left: null });
    let target: ReturnType<AccountsService["resetTarget"]>;
    try { target = this.resetTarget(account); } catch (err) {
      if (err instanceof AccountActionError && err.code === "login_changed") return Promise.resolve(this.finish(a, { outcome: "login_changed", left: null }));
      return Promise.reject(err);
    }
    const promise = this.runAttempt(target.rec, a).finally(() => this.inflight.delete(id));
    this.inflight.set(id, promise);
    return promise;
  }

  /**
   * Records an attempt's answer: final, open again (nothing was sent), or unconfirmed (it may have been). An attempt
   * that was unconfirmed stays so unless Codex itself answered for it: a failure, a login switch or an unverified
   * app-server says nothing about whether the earlier try went through, so it is handed back when the login returns.
   */
  private finish(a: Attempt, result: ResetResult, wasUnconfirmed = a.state === "unconfirmed"): ResetResult {
    const silent = result.outcome === "failed" || result.outcome === "login_changed" || result.outcome === "unverified";
    const state = result.outcome === "unconfirmed" || (wasUnconfirmed && silent) ? "unconfirmed"
      : result.outcome === "failed" ? "open"
      : "final";
    this.attempts.update(a.id, { state, result: state === "final" ? result : null, ...(result.outcome === "unconfirmed" ? { triedAt: this.clock() } : {}) });
    this.save();
    return result;
  }

  private async runAttempt(rec: Rec, a: Attempt): Promise<ResetResult> {
    // A sent attempt is reconciled on every retry (same key, same credit), whatever state it is in (RESET-4).
    const wasUnconfirmed = a.state === "unconfirmed" || a.sent;
    const account = a.account;
    const stillBound = (): boolean => {
      const now = codexAuthSnapshot(rec.login);
      return !!now && now.identityId === account && now.chatgptAccount === a.chatgptAccount && rec.login.dir === a.loginDir;
    };
    if (!stillBound() || !this.bound(rec, this.clock())) return this.finish(a, { outcome: "login_changed", left: null }, wasUnconfirmed);
    // Marked running (and persisted) before anything is sent: a daemon that stops mid-use reloads it as unconfirmed.
    this.attempts.update(a.id, { state: "running", interrupted: false, triedAt: wasUnconfirmed ? a.triedAt : this.clock() });
    if (!this.save()) {
      this.attempts.update(a.id, { state: a.state, triedAt: a.triedAt });
      return { outcome: "failed", left: null, failure: "not_saved" };
    }
    this.log.info("account_reset_requested", { provider: "codex", account, retry: wasUnconfirmed });
    let result: ResetResult;
    try {
      result = await redeemCodexReset(this.launcher, rec.login, {
        chatgptAccount: a.chatgptAccount, key: a.id, afterUnconfirmed: wasUnconfirmed, creditId: a.creditId, stillBound,
        // Recorded (and persisted) BEFORE the use goes out: only a sent attempt can be unconfirmed after a restart.
        // Persistence must succeed first (RESET-4): a use that could not be written down is never sent.
        onCredit: (creditId) => {
          const before = this.attempts.get(a.id);
          this.attempts.update(a.id, { creditId, sent: true, triedAt: this.clock() });
          if (this.save()) return true;
          if (before) this.attempts.update(a.id, { creditId: before.creditId, sent: before.sent, triedAt: before.triedAt });
          return false;
        },
      }, this.clock());
    } catch (err) {
      this.log.warn("account_reset_failed", { account, err: scrubMessage((err as Error).message, [], 200) });
      result = this.attempts.get(a.id)?.sent ? { outcome: "unconfirmed", left: null } : { outcome: "failed", left: null, failure: "unreachable" };
    }
    this.log.info("account_reset_result", { provider: "codex", account, outcome: result.outcome, ...(result.failure ? { failure: result.failure } : {}) });
    this.finish(a, result, wasUnconfirmed);
    if (result.outcome === "reset" && result.left !== null) this.noteResetsLeft(account, result.left);
    if (result.outcome === "unconfirmed") this.pollAt(account, this.clock() + REREAD_DELAY_MS);
    else if (result.outcome !== "failed" && result.outcome !== "login_changed" && result.outcome !== "unverified") await this.pollNow(account);
    return result;
  }

  /**
   * A person checked usage and says so (RESET-4): the account's unconfirmed attempt is released as "dismissed" (never
   * retried), and a ledger that could not be read stops blocking resets. The only way besides Codex's own answer to a
   * retry; nothing expires on a clock.
   */
  resolveReset(account: string): { attempt: string | null; ledger: boolean } {
    if (!this.records.has(account)) throw new AccountActionError("not_found");
    const pending = this.attempts.pendingFor(account);
    if (pending && this.inflight.has(pending.id)) return { attempt: null, ledger: false };
    const release = pending && pending.state !== "open" ? pending : null;
    const ledger = this.ledgerProblem;
    if (release) this.attempts.update(release.id, { state: "final", result: { outcome: "dismissed", left: null } });
    this.ledgerProblem = null;
    let ok = true;
    if (ledger) {
      // Confirmed for EVERY account on this machine: the leftover copies stop blocking (renamed `.checked`, kept).
      try { markCorruptChecked(this.walkieHome); } catch { ok = false; }
    }
    if (ok && (release || ledger)) ok = this.save();
    if (!ok) {
      if (release) this.attempts.update(release.id, { state: release.state, result: release.result });
      this.ledgerProblem = ledger;
      throw new AccountActionError("ledger_unwritable");
    }
    this.log.info("account_reset_resolved", { account, attempt: release !== null, ledger: ledger !== null });
    return { attempt: release?.id ?? null, ledger: ledger !== null };
  }

  /** After a use, until the re-poll lands: the count the provider just gave. */
  private noteResetsLeft(id: string, left: number): void {
    const rec = this.records.get(id);
    if (!rec?.reading?.resets) return;
    this.records.set(id, { ...rec, reading: { ...rec.reading, resets: { ...rec.reading.resets, available: left, applicable: null } } });
    this.save();
    this.publish();
  }

  /**
   * Polls one account now (the meter after a reset), unless a provider's Retry-After, a backoff or a Keychain hold is
   * active (then it waits for that, RESET-2). Returns whether a poll was brought forward.
   */
  private async pollNow(id: string): Promise<boolean> {
    const rec = this.records.get(id);
    if (!rec || rec.identity.tokenLogin) return false;
    const now = this.clock();
    if ((rec.notBefore ?? 0) > now) return false;
    this.records.set(id, { ...rec, nextAt: now });
    await this.tick();
    return true;
  }

  /** Brings an account's next poll to `at` (never earlier than its hold). */
  private pollAt(id: string, at: number): void {
    const rec = this.records.get(id);
    if (!rec || rec.identity.tokenLogin) return;
    this.records.set(id, { ...rec, rereadAt: at, nextAt: Math.max(Math.min(rec.nextAt, at), rec.notBefore ?? 0) });
  }

  /** A new record with the ledger's hold for it, if one is pending (a Retry-After survives a dropped account row). */
  private withHold(rec: Rec, now: number): Rec {
    const h = this.pendingHolds.get(rec.identity.id);
    this.pendingHolds.delete(rec.identity.id);
    if (!h || h.not_before <= now || rec.identity.tokenLogin) return rec;
    return { ...rec, nextAt: Math.max(rec.nextAt, h.not_before), notBefore: h.not_before, backoffMs: h.backoff_ms };
  }

  /**
   * A person used a reset on the provider's own page (Claude on claude.ai): bring the account's next poll forward, at
   * most every REFRESH_MIN_MS, and never ahead of a provider's Retry-After or a backoff ("held").
   */
  refresh(id: string): "scheduled" | "throttled" | "held" {
    const rec = this.records.get(id);
    if (!rec) throw new AccountActionError("not_found");
    const now = this.clock();
    if (rec.identity.tokenLogin || now - (this.refreshedAt.get(id) ?? 0) < REFRESH_MIN_MS) return "throttled";
    if ((rec.notBefore ?? 0) > now) return "held";
    this.refreshedAt.set(id, now);
    void this.pollNow(id);
    return "scheduled";
  }

  // ---- vault + leases (ACCOUNTS-2) --------------------------------------------------

  /**
   * Vault accounts become records (so they are polled, shared and pickable) unless a real login of the same account
   * is already recorded here (a linked setup-token): then that login's record stands for it and only carries the
   * vault badge. Removed vault accounts are forgotten. In accounts.json a vault record is flagged `vault` and only its
   * last reading is used again (the record itself is re-created from the vault).
   */
  syncVault(): void {
    if (!this.vault) return;
    let list: VaultEntry[] = [];
    try { list = this.vault.list(); } catch (err) { this.log.warn("vault_unreadable", { err: scrubMessage((err as Error).message, [], 200) }); return; }
    const now = this.clock();
    // The credential generation is part of what changed (round 3, Codex 6): a replaced credential is published at once.
    const prevEntries = this.vaultEntries;
    const before = JSON.stringify([...prevEntries.values()].map((e) => [e.id, e.policy, e.share_with, e.label, e.plan, e.gen, e.home_at]));
    this.vaultEntries = new Map(list.map((e) => [e.id, e]));
    let changed = before !== JSON.stringify(list.map((e) => [e.id, e.policy, e.share_with, e.label, e.plan, e.gen, e.home_at]));
    for (const [id, rec] of this.records) {
      if (rec.login.vault && !this.vaultEntries.has(id)) { this.records.delete(id); changed = true; }
    }
    for (const e of list) {
      const prev = this.records.get(e.id);
      if (prev && !prev.login.vault) continue; // a real login of the same account is recorded: it meters it
      // A new credential under the same id: its old reading and polling deadline are about the old one.
      const replaced = !!prev && prevEntries.get(e.id)?.gen !== undefined && prevEntries.get(e.id)?.gen !== e.gen;
      const login: Login = e.provider === "codex" && e.home
        ? { provider: "codex", dir: e.home, isDefault: false, vault: true }
        : { provider: "claude", dir: `vault:${e.id}`, isDefault: false, vault: true };
      if (e.provider === "codex" && !e.home) continue;
      this.records.set(e.id, {
        identity: { provider: e.provider, id: e.id, label: e.label, plan: e.plan }, login,
        agents: prev?.agents ?? [], lastSeen: now,
        reading: replaced ? null : prev?.reading ?? this.savedVaultReadings.get(e.id) ?? null, nextAt: replaced ? now : prev?.nextAt ?? now,
        backoffMs: replaced ? 0 : prev?.backoffMs ?? 0, skips: replaced ? 0 : prev?.skips ?? 0,
        // The same account under a new credential: its windows (and their resets) are the account's, so they stay.
        resetClock: prev?.resetClock ?? this.savedVaultClocks.get(e.id) ?? clockFromReading(this.savedVaultReadings.get(e.id)),
      });
      if (!prev) { this.log.info("vault_account_recorded", { provider: e.provider, account: e.id }); changed = true; }
    }
    if (changed) this.publish();
  }

  private leaseSummaries(): AccountLease[] {
    let leases: Lease[] = [];
    try { leases = activeLeases(this.walkieHome); } catch { return []; }
    return leases.map((l) => ({
      account: l.account, provider: l.provider, since: l.since,
      ...(l.agent ? { agent: l.agent } : {}), ...(l.owner ? { owner: l.owner } : {}), ...(l.grant ? { grant: l.grant } : {}),
    }));
  }

  /** Publishes when the wrapped sessions on this machine changed. */
  syncLeases(): void {
    const now = JSON.stringify(this.leaseSummaries());
    if (now === this.lastLeases) return;
    this.lastLeases = now;
    this.publish();
  }

  private poolOnNow(): boolean {
    try { return this.poolOn(); } catch { return false; }
  }

  /** Publishes when this machine's team pool setting, or the team's pool as this machine knows it, changed. */
  syncTeamPolicy(): void {
    const now = JSON.stringify([this.currentTeamPolicy(), this.poolOnNow()]);
    if (now === this.lastTeamPolicy) return;
    this.lastTeamPolicy = now;
    this.publish();
  }

  private currentTeamPolicy(): TeamPolicyAd | null {
    try { return this.teamPolicy(); } catch { return null; }
  }

  // ---- company pool: what the home machine does for its lent logins ------------------

  /**
   * The least room (%) left on a vault login right now, from this machine's own readings (the poll, or a wrapped
   * session's own): the lender's check of the 10 % personal reserve. Null when no reading under an hour old says —
   * the caller fails closed.
   */
  roomLeft(id: string, now = this.clock()): number | null {
    const rec = this.records.get(id);
    if (!rec) return null;
    const u = newer(rec.reading, readSessionReadings(this.walkieHome, now)[id]);
    return freshRoomOf(u, null, now);
  }

  /**
   * The home machine is its Codex logins' one refresher (COMPANY POOL): a lent login whose access token runs out
   * within RENEW_AHEAD_MS (or whose expiry cannot be read) is renewed by the user's own Codex CLI (renewCodexLogin),
   * one login at a time, at most once per RENEW_RETRY_MS each — so an idle home keeps serving the pool.
   */
  private renewCodexLogins(): void {
    const due = [...this.vaultEntries.values()].find((e) => this.poolOnNow() && !e.personal && this.renewalEligible(e.id));
    if (due) this.renewCodex(due.id);
  }

  /** Authorized demand and scheduled renewal share expiry, serialization and retry limits. */
  private renewalEligible(id: string): boolean {
    const e = this.vaultEntries.get(id);
    if (this.renewing || !this.vault?.codexExpiry || !e || e.provider !== "codex" || !e.home) return false;
    const now = this.clock();
    const tried = this.renewTried.get(id);
    if (tried !== undefined && now - tried < RENEW_RETRY_MS) return false;
    const expiry = this.vault.codexExpiry(id);
    return expiry === null || expiry - now < RENEW_AHEAD_MS;
  }

  /** Renews one eligible vault Codex login (also asked for by a refused lease). */
  renewCodex(id: string): void {
    if (!this.renewalEligible(id)) return;
    const e = this.vaultEntries.get(id);
    if (!e?.home) return;
    this.renewTried.set(id, this.clock());
    const before = this.vault?.codexExpiry?.(id) ?? null;
    this.renewing = renewCodexLogin(this.launcher, { provider: "codex", dir: e.home, isDefault: false, vault: true })
      .then((ok) => { this.log.info("vault_codex_renew", { account: id, ok, before, after: this.vault?.codexExpiry?.(id) ?? null }); })
      .catch(() => undefined)
      .finally(() => { this.renewing = null; });
  }

  /** Leased Codex homes whose session process is gone are removed (also swept by the switcher on its next use). */
  private sweepLeases(): void {
    const now = this.clock();
    if (now - this.lastSweep < SWEEP_MS) return;
    this.lastSweep = now;
    try {
      const n = sweepLeaseHomes(this.walkieHome);
      if (n) this.log.info("lease_homes_swept", { count: n });
    } catch (err) {
      this.log.warn("lease_homes_sweep_failed", { err: scrubMessage((err as Error).message, [], 200) });
    }
  }

  // ---- reset clock (RESET-CLOCK-1) --------------------------------------------------

  /**
   * Learns reset times from what sessions on this machine already wrote down, at no cost (local files only): the
   * switcher's limit marks ("limit reached, resets 4:10am") and wrapped sessions' own readings. Also drops long-passed
   * times. Saves and publishes only when something changed.
   */
  private learnPassive(): void {
    const now = this.clock();
    const marks = readMarks(this.walkieHome, now);
    const sessions = readSessionReadings(this.walkieHome, now);
    let changed = false;
    for (const [id, rec] of this.records) {
      if (rec.identity.tokenLogin) continue;
      const mark = marks[id];
      const learned = [...clockFromMark(markApplies(mark, this.vaultEntries.get(id)?.gen) ? mark : undefined), ...clockFromReading(sessions[id])];
      const resetClock = mergeClock(rec.resetClock, learned, now);
      if (resetClock === rec.resetClock) continue;
      this.records.set(id, { ...rec, resetClock });
      changed = true;
    }
    if (!changed) return;
    this.save();
    this.publish();
  }

  // ---- views ---------------------------------------------------------------------

  /** This machine's accounts as the team sees them (validated; only numbers, enums and masked labels). */
  snapshot(): AccountsSnapshot {
    const now = this.clock();
    const marks = readMarks(this.walkieHome, now);
    const sessions = readSessionReadings(this.walkieHome, now);
    const accounts: AccountSummary[] = [...this.records.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, MAX_ACCOUNTS_PER_NODE)
      .map((r) => ({
        id: r.identity.id, provider: r.identity.provider, label: r.identity.label, plan: r.identity.plan,
        agents: r.agents.filter((a) => AGENT_RE.test(a)).slice(0, MAX_ACCOUNT_AGENTS),
        usage: r.identity.tokenLogin ? { at: this.clock(), state: "unknown", reason: "token_login", source: "none", windows: [], until: null }
          : withMark(newer(r.reading, sessions[r.identity.id]) ?? (r.identity.pending ? { at: this.clock(), state: "unknown", reason: "identity_pending", source: "none", windows: [], until: null } : null), marks[r.identity.id], now, this.vaultEntries.get(r.identity.id)?.gen),
        last_seen: r.lastSeen,
        ...(this.vaultEntries.has(r.identity.id) ? { vault: vaultOf(this.vaultEntries.get(r.identity.id) as VaultEntry, this.poolOnNow()) } : {}),
        ...(!r.identity.tokenLogin && r.resetClock.length ? { clock: [...r.resetClock] } : {}),
      }));
    const leases = this.leaseSummaries();
    const team = this.currentTeamPolicy();
    const snap = { at: this.clock(), accounts, ...(leases.length ? { leases } : {}), ...(team ? { team_policy: team } : {}) };
    const ok = AccountsSnapshot.safeParse(snap);
    if (ok.success) return ok.data;
    // A malformed entry (never expected) is dropped rather than published.
    const valid = accounts.filter((a) => AccountsSnapshot.shape.accounts.element.safeParse(a).success);
    this.log.warn("accounts_snapshot_invalid", { dropped: accounts.length - valid.length });
    return { at: snap.at, accounts: valid, ...(leases.length ? { leases } : {}), ...(team ? { team_policy: team } : {}) };
  }

  private publish(): void {
    try { this.onChange(this.snapshot()); } catch (err) { this.log.warn("accounts_publish_failed", { err: (err as Error).message }); }
  }

  // ---- persistence (local file; no tokens) ---------------------------------------

  /**
   * Loads accounts.json (rebuildable) and the reset ledger, reset-attempts.json (store.ts). Polling holds come from the
   * ledger, so a dropped account row keeps its Retry-After. The ledger blocks resets (until a person confirms) when it
   * cannot be read (the original stays in place, a copy is kept aside), when an attempt row cannot be read, when a
   * recovery marker says so, or when an unconfirmed `reset-attempts.json.corrupt-*` copy is left over.
   */
  private load(): void {
    const now = this.clock();
    let problem: Recovery | null = null;
    let rewrite = false;
    const lr = readLedgerFile(this.ledgerFile, now);
    if (lr.kind === "unreadable") {
      problem = { kept: lr.kept ?? LEDGER_FILE, at: now };
      rewrite = true; // the marker is written OVER the unreadable original; if that fails it is read again next start
      this.log.warn("accounts_reset_ledger_unreadable", { kept: lr.kept });
    } else if (lr.kind === "ok") {
      this.pendingHolds = new Map([...lr.ledger.holds].filter(([, h]) => h.not_before > now));
      this.keychainBlockedUntil = lr.ledger.keychainBlockedUntil > now ? lr.ledger.keychainBlockedUntil : 0;
      problem = lr.ledger.recovery;
      const bad = this.attempts.load(lr.ledger.attemptRows);
      if (bad) {
        problem = { kept: keepAside(this.ledgerFile, now) ?? LEDGER_FILE, at: now };
        this.log.warn("accounts_reset_ledger_rows_unreadable", { rows: bad, kept: problem.kept });
      }
    }
    const af = readAccountsFile(this.file, now);
    if (af) {
      if (af.badRecords) this.log.warn("accounts_file_rows_dropped", { rows: af.badRecords });
      this.kimiAliases = af.kimiAliases;
      if (lr.kind === "none" && af.legacyAttempts?.length) {
        // A RESET-2..4 build kept the ledger inside accounts.json: move it into its own file.
        rewrite = true;
        if (this.attempts.load(af.legacyAttempts)) problem = { kept: keepAside(this.file, now) ?? "accounts.json", at: now };
      }
      for (const row of af.records) {
        if (now - row.last_seen > RECORD_TTL_MS) continue;
        // A vault account's record is re-created from the vault (syncVault); only its last reading is kept (ACCOUNTS-2).
        // RESET-CLOCK-1: a file from before the clock (pre.5) seeds it from the saved reading's windows.
        const resetClock = row.clock !== undefined ? validClock(row.clock) : clockFromReading(row.reading);
        if (row.vault) { if (row.reading) this.savedVaultReadings.set(row.id, row.reading); this.savedVaultClocks.set(row.id, resetClock); continue; }
        this.records.set(row.id, this.withHold({
          identity: { provider: row.provider, id: row.id, label: row.label, plan: row.plan, ...(row.pending ? { pending: true } : {}), ...(row.token_login ? { tokenLogin: true } : {}) },
          login: { provider: row.provider, dir: row.dir, isDefault: row.is_default },
          agents: [], lastSeen: row.last_seen, reading: row.reading, nextAt: row.token_login ? NEVER : now, backoffMs: 0, skips: 0, resetClock,
        }, now));
      }
    } else if (existsSync(this.file)) {
      this.log.warn("accounts_file_unreadable", {});
    }
    const left = leftoverCorrupt(this.walkieHome);
    if (!problem && left.length) problem = { kept: left[left.length - 1] as string, at: now };
    this.ledgerProblem = problem;
    if (rewrite) this.save();
  }

  /**
   * Writes both files. accounts.json failing is logged; the returned value is whether the reset ledger was written
   * (a reset is refused before anything is sent when it was not).
   */
  private save(): boolean {
    const records: RecordRow[] = [...this.records.values()].map((r) => ({
      id: r.identity.id, provider: r.identity.provider, label: r.identity.label, plan: r.identity.plan,
      ...(r.identity.pending ? { pending: true } : {}), ...(r.identity.tokenLogin ? { token_login: true } : {}),
      dir: r.login.dir, is_default: r.login.isDefault, last_seen: r.lastSeen, reading: r.reading, ...(r.login.vault ? { vault: true } : {}),
      clock: [...r.resetClock],
    }));
    try {
      writeAccountsFile(this.file, records, this.kimiAliases);
    } catch (err) {
      this.log.warn("accounts_file_write_failed", { err: (err as Error).message });
    }
    const now = this.clock();
    const holds = new Map<string, HoldRow>([...this.pendingHolds].filter(([, h]) => h.not_before > now));
    for (const r of this.records.values()) {
      if ((r.notBefore ?? 0) > now) holds.set(r.identity.id, { not_before: r.notBefore as number, backoff_ms: r.backoffMs });
    }
    try {
      writeLedgerFile(this.ledgerFile, { attemptRows: this.attempts.toJSON(), holds, keychainBlockedUntil: this.keychainBlockedUntil, recovery: this.ledgerProblem });
      return true;
    } catch (err) {
      this.log.warn("accounts_reset_ledger_write_failed", { err: (err as Error).message });
      return false;
    }
  }
}

/**
 * The vault badge on the wire. COMPANY POOL: `company: true` while the team's pool is on and its person has not marked
 * it personal (this machine then lends it to every member's machines); `home_at` says which holder lends.
 */
export function vaultOf(e: VaultEntry, poolOn = false): AccountVault {
  return {
    policy: e.policy, ...(e.policy === "shared" && e.share_with.length ? { share_with: e.share_with.slice(0, 16) } : {}),
    ...(/^[0-9a-f]{1,32}$/.test(e.gen) ? { gen: e.gen } : {}),
    ...(poolOn && !e.personal ? { company: true as const } : {}),
    ...(e.personal ? { personal: true as const } : {}),
    ...(Number.isSafeInteger(e.home_at) && e.home_at > 0 ? { home_at: e.home_at } : {}),
  };
}

/**
 * A session's mark (a limit it hit, a refused token) wins over a reading taken before it: the account shows exhausted
 * until the reset the provider named (or needs re-login). A newer reading replaces it.
 */
function withMark(u: UsageT | null, mark: ReturnType<typeof readMarks>[string] | undefined, now: number, gen?: string): UsageT | null {
  // As the selector sees it (round 1, Codex 9): a mark about another credential generation does not apply; a limit
  // mark yields to a newer reading; a refused-token mark only to a new credential.
  if (!markApplies(mark, gen)) return u;
  // Round 5: a model-scoped limit or a single (unconfirmed) refusal does not make the whole account look out; a limit
  // mark yields only to a reading taken well after it with room (hysteresis).
  if (!markExcludes(mark, null) || mark.model) return u;
  if (mark.state === "exhausted" && markLifted(mark, u)) return u;
  // RESET-CLOCK-1: a guessed reset (the provider named none) is not published as one: the account shows exhausted,
  // reset time not reported, while the mark lasts.
  const until = mark.until !== null && mark.until > now && !markGuessed(mark) ? mark.until : null;
  if (mark.state === "relogin") return { at: mark.at, state: "relogin", reason: "login_expired", source: "session", windows: u?.windows ?? [], until: null };
  return { at: mark.at, state: "exhausted", reason: "limit_reached", source: "session", windows: u?.windows ?? [], until, ...(until !== null ? { until_reported: true as const } : {}) };
}

/** A wrapped session's own reading when it is newer than the poller's (vault Codex homes have no passive reading). */
function newer(polled: UsageT | null, session: UsageT | undefined): UsageT | null {
  if (!session) return polled;
  if (!polled || polled.state === "unknown" || session.at > polled.at) return session;
  return polled;
}
