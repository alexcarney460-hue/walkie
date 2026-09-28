// `walkie claude [args…]` / `walkie codex [args…]` (ACCOUNTS-2): the real CLI, in the same terminal, on the vault
// account with the most room — and, when that account hits its limit, the same session resumed on another account.
//   1. at launch: pick the account (select.ts: own accounts first, a teammate's only when borrowing is on and every own
//      account is affirmatively at its limit) and lease it (leases.ts); hand its credential ONLY to the trusted native
//      claude / codex binary (trusted.ts; anything else runs without Walkie credentials); Claude gets the setup-token
//      on fd 3, Codex the account's CODEX_HOME; the user's own CLAUDE_CONFIG_DIR / sessions stay, so `--resume` finds
//      the conversation;
//   2. watch the session (watch.ts) for the HARD limit (round 3: nothing is switched ahead of it) — a limit the API
//      reported, or a refused token;
//   3. once it hit: wait (bounded, 10 min by default, one line saying so) while background work the session started is
//      still running; then, with nothing written for a moment and nothing new after the account selection, end the
//      CLI, restore the terminal, print ONE line, and resume the SAME session (`claude --resume <id>` / `codex resume
//      <id>`, never an unknown id) on another account with a continuation prompt — one that asks it to answer a prompt
//      typed after the limit, when there was one; every account out: say when the earliest resets, wait, resume;
//   4. the other account refuses the resumed conversation (signed thinking / encrypted reasoning): a new session is
//      pointed at a redacted summary in a 0600 file (never on a command line), once;
//   5. nothing that fails after launch ends the wrapper while the CLI runs; a relaunch that cannot go to an account
//      resumes the session on the CLI's own login rather than leave nothing running.
// Passes straight through (the real CLI, untouched) for subcommands, --help/--version, WALKIE_NO_SWITCH=1, a command
// that brings its own token, or when no account is available to this machine at all.
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAgentName } from "../agent/identity.ts";
import { walkieCommand } from "../hooks/install.ts";
import { markKey, readMarks, releaseLease, updateLease, writeLease, writeMark, writeSessionReading, type Lease } from "../accounts/leases.ts";
import { DEFAULT_THRESHOLD_PCT, READING_MAX_AGE_MS, roomOf, selectOwnFirst, type Candidate, type Selection } from "../accounts/select.ts";
import { PERSONAL_RESERVE_PCT } from "../protocol/pool-rules.ts";
import type { AccountUsage } from "../protocol/accounts.ts";
import { codexBaseHome, codexSessionsDir } from "../accounts/vault/codex-home.ts";
import { privateDir } from "../accounts/vault/vault.ts";
import type { AccountSource, Credentials } from "./accounts.ts";
import { claudeArgv, codexArgv, parseClaude, parseCodex, type Parsed } from "./args.ts";
import { holdSignals, restoreTerminal, saveTerminal, spawnInherit, type Child, type Spawner } from "./launch.ts";
import { realCli } from "./shims.ts";
import { ANSWER_PROMPT, CONTINUE_PROMPT, summaryInstruction, writeSummaryFile } from "./summary.ts";
import { checkTrusted, sameObjects, type TrustCheck } from "./trusted.ts";
import { CLAUDE_ENDPOINT_KEYS, launchSettings, ownCredentialSetting, readUserSettings, settingsValue, withoutSettings } from "./claude-settings.ts";
import { pinnedCodexArgv, planCodexArgv, routingOverride } from "./codex-routing.ts";
import { plainText } from "../protocol/plain-text.ts";
import { ClaudeWatcher, CodexWatcher, type Signals } from "./watch.ts";

export type Provider = "claude" | "codex";

export interface WrapOptions {
  provider: Provider;
  args: string[];
  walkieHome: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  source: AccountSource;
  spawn?: Spawner;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** One-line notices (stderr). */
  say?: (line: string) => void;
  /** Where a headless run's kept stdout goes (process.stdout). */
  stdout?: (b: Uint8Array) => void;
  thresholdPct?: number;
  tickMs?: number;
  /** How long nothing must have been written before the CLI is ended at the limit. */
  settleMs?: number;
  /** COMPANY POOL: how often a borrowed pooled session checks the person's reserve (default RESERVE_CHECK_MS). */
  reserveCheckMs?: number;
  /** The longest the switch waits at the limit for the session's background work to finish (default 10 min). */
  backgroundWaitMs?: number;
  tokenVia?: "fd" | "env";
  /** Codex: the rollout file the child holds open. */
  openRollout?: (pid: number) => Promise<string | readonly string[] | null>;
  maxSwitches?: number;
  /** Headless runs (claude -p) retried on another account after a limit. */
  maxHeadlessRetries?: number;
  /** Whether the CLI resolved on PATH may receive credentials (default: the recorded trusted binary, trusted.ts). */
  trust?: (provider: Provider, resolved: string) => TrustCheck;
}

/** A run that could not continue anywhere: every account out (sysexits EX_TEMPFAIL). */
export const EXIT_ALL_EXHAUSTED = 75;
/**
 * Whether a refused token is a strike on the ACCOUNT (a lasting "needs re-login" mark). COMPANY POOL (Codex p8 MEDIUM
 * 3): a leased Codex copy that stops working has simply expired — the lender renews its own login — so it is only
 * avoided for this run; the next launch leases a fresh copy.
 */
export function refusalMarksAccount(acct: Pick<Candidate, "source" | "provider">): boolean {
  return !(acct.source === "peer" && acct.provider === "codex");
}

/** COMPANY POOL: how often a borrowed pooled session checks its room against the person's reserve. */
export const RESERVE_CHECK_MS = 60_000;

/**
 * The machine-readable line when every account is out (RESET-CLOCK-1): until when, and which account frees first
 * (from the remembered reset times), so an orchestrator can schedule the work instead of retrying.
 */
export function exhaustedLine(sel: Pick<Selection, "waitUntil" | "nextFree">): Record<string, unknown> {
  const f = sel.nextFree;
  return {
    walkie: "all_accounts_exhausted", waiting_until: sel.waitUntil,
    next_free: f ? { at: f.at, at_iso: new Date(f.at).toISOString(), account: f.id, label: f.label, provider: f.provider, owner: f.owner } : null,
  };
}
/** A limit whose reset the provider did not name is looked at again after this long. */
export const UNKNOWN_RESET_MS = 60 * 60_000;
export const BACKGROUND_WAIT_MS = 10 * 60_000;

/** Start-up settings removed from a credentialed CLI's environment (plus every DYLD_* and LD_*). */
export const STARTUP_VARS: ReadonlySet<string> = new Set([
  "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE", "BUN_OPTIONS", "BUN_INSPECT", "BASH_ENV", "ENV", "ZDOTDIR",
]);

/**
 * Settings that send a credentialed CLI's requests (and so its token) somewhere else, or weaken TLS (round 3, Opus):
 * removed for a credentialed launch. The proxy variables stay only when the person turned `walkie accounts
 * allow-proxy on`; base URLs, CA overrides and TLS switches never stay.
 */
export const REDIRECT_VARS: ReadonlySet<string> = new Set([
  "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "CLAUDE_CODE_REMOTE", "ANTHROPIC_UNIX_SOCKET", "CLAUDE_CODE_MESSAGING_SOCKET", "OPENAI_BASE_URL", "OPENAI_API_BASE", "CODEX_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_GATEWAY",
  // Codex (round 5, Codex 2; names from the codex 0.156 binary): auth / refresh / revoke / cloud endpoints, its own CA
  // and the CA lists it reads.
  "CODEX_REFRESH_TOKEN_URL_OVERRIDE", "CODEX_REVOKE_TOKEN_URL_OVERRIDE", "CODEX_AUTHAPI_BASE_URL",
  "CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL", "CODEX_AGENT_IDENTITY_JWKS_BASE_URL", "CODEX_APP_SERVER_CHATGPT_BASE_URL",
  "CODEX_APP_SERVER_LOGIN_ISSUER", "CODEX_CA_CERTIFICATE", "CODEX_CLOUD_TASKS_BASE_URL", "CODEX_EXEC_SERVER_URL",
  "CODEX_EXEC_SERVER_NOISE_REGISTRY_URL", "CODEX_OSS_BASE_URL", "CODEX_URL", "CODEX_SNAPSHOT_PROXY_OVERRIDE",
  "CODEX_ACCESS_TOKEN", "GIT_SSL_CAINFO", "CARGO_HTTP_CAINFO", "PIP_CERT", "BUNDLE_SSL_CA_CERT",
]);
export const PROXY_VARS: ReadonlySet<string> = new Set([
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "WSS_PROXY", "wss_proxy",
  "CLAUDE_CODE_HTTP_PROXY", "CLAUDE_CODE_HTTPS_PROXY", "CLAUDE_CODE_PROXY_URL", "CLAUDE_CODE_PROXY_HOST",
]);

const ENDPOINT_KEYS: ReadonlySet<string> = new Set(CLAUDE_ENDPOINT_KEYS);

/** The environment a credentialed process gets: start-up, loader and redirect settings removed. */
export function credentialEnv(env: Record<string, string>, allowProxy: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (STARTUP_VARS.has(k) || REDIRECT_VARS.has(k) || k.startsWith("DYLD_") || k.startsWith("LD_")) continue;
    if (PROXY_VARS.has(k)) { if (allowProxy) out[k] = v; continue; }
    if (ENDPOINT_KEYS.has(k) || /^ANTHROPIC_.*_(URL|HOST|SOCKET)$/.test(k) || /^CLAUDE_(CODE|AI|BRIDGE|RUNNER|REMOTE|LOCAL)_(.*_)?(URL|HOST|BASE|ORIGIN)$/.test(k) || k === "CLAUDE_BASE") continue;
    if (/^CODEX_.*_(URL|OVERRIDE|ISSUER|CERTIFICATE)$/.test(k) || /^OPENAI_.*(BASE|_URL)$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** The person's `walkie accounts allow-proxy on` (config.json `allow_proxy`). */
export function proxyAllowed(walkieHome: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(walkieHome, "config.json"), "utf8")) as { allow_proxy?: unknown }).allow_proxy === true;
  } catch {
    return false;
  }
}

/**
 * A command that brings its own credential (an explicit token or API key in its environment) keeps it: the switcher
 * steps aside rather than replace what the caller chose.
 */
export function ownCredential(provider: Provider, env: NodeJS.ProcessEnv): string | null {
  const names = provider === "claude"
    ? ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
    : ["CODEX_API_KEY"];
  return names.find((n) => !!env[n]) ?? null;
}

type Outcome =
  | { kind: "exit"; code: number }
  | { kind: "switch"; reason: string; resume: boolean; avoid: boolean; answer?: boolean; stopped?: string[] }
  | { kind: "resume_failed" };

function envRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

export { plainText };

/** The continuation prompt, plus which background work the move stopped (so the session can restart it). */
export function withStopped(prompt: string | null, stopped: readonly string[]): string | null {
  if (!stopped.length) return prompt;
  const list = stopped.slice(0, 10).map((x) => plainText(x, 120)).join("; ");
  const note = `Background work that was still running when the session moved was stopped by the move: ${list}${stopped.length > 10 ? `; and ${stopped.length - 10} more` : ""}. Start it again if it is still needed.`;
  return prompt ? `${prompt}\n\n${note}` : note;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function inWords(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}


export async function runWrapped(o: WrapOptions): Promise<number> {
  const spawn = o.spawn ?? spawnInherit;
  const clock = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const say = o.say ?? ((l: string) => process.stderr.write(`${l}\n`));
  const provider = o.provider;

  const real = realCli(provider, o.walkieHome, o.env);
  if (!real) { say(`walkie: no real ${provider} found on PATH (outside ${join(o.walkieHome, "bin")})`); return 127; }
  const baseEnv = envRecord(o.env);
  delete baseEnv.WALKIE_SHIM_ACTIVE;

  const parsed: Parsed = provider === "claude" ? parseClaude(o.args) : parseCodex(o.args);
  let child: Child | null = null;
  let stopping: NodeJS.Signals | null = null;
  const release = holdSignals(() => child, (sig) => { stopping = sig; });
  const passthrough = async (): Promise<number> => {
    child = spawn({ argv: [real, ...o.args], env: baseEnv, cwd: o.cwd });
    return child.exited;
  };
  try {
    if (o.env.WALKIE_NO_SWITCH === "1" || parsed.mode === "passthrough" || ownCredential(provider, o.env)) return await passthrough();
    let available = false;
    try { available = await o.source.available(provider, clock()); } catch { available = false; }
    if (!available) return await passthrough();
    const trustNow = () => (o.trust ?? ((p: Provider, r: string) => checkTrusted(o.walkieHome, p, r, { cwd: o.cwd, shimDir: join(o.walkieHome, "bin") })))(provider, real);
    const trust = trustNow();
    if (!trust.ok) {
      say(`walkie: ${plainText(trust.why, 300)}; running ${provider} without Walkie accounts (no switching)`);
      return await passthrough();
    }
    // Round 5 (Codex 1): Codex routing is pinned with -c overrides; a caller's own override of those keys cannot be.
    const override = provider === "codex" ? routingOverride(o.args) : null;
    if (override) {
      say(`walkie: your ${plainText(override, 60)} would send the account's requests elsewhere or load an unchecked config; running ${provider} without Walkie accounts (no switching)`);
      return await passthrough();
    }
    // Round 8 (Opus r7): the pins must land after every subcommand; a line that cannot be read with certainty gets none.
    const plan = provider === "codex" ? planCodexArgv(o.args) : null;
    if (plan && !plan.ok) {
      say(`walkie: this codex command line could not be read with certainty (${plainText(plan.why, 120)}); running ${provider} without Walkie accounts (no switching)`);
      return await passthrough();
    }
    // Round 4: a caller's own --settings is merged with the credential routing the wrapper pins; one that cannot be
    // read cannot be merged, so that run gets no Walkie credentials.
    let userSettings: Record<string, unknown> | null = null;
    const rawSettings = provider === "claude" ? settingsValue(o.args) : null;
    if (rawSettings !== null) {
      try { userSettings = readUserSettings(rawSettings, o.cwd); } catch (err) {
        say(`walkie: your --settings could not be read (${plainText((err as Error).message, 120)}); running ${provider} without Walkie accounts (no switching)`);
        return await passthrough();
      }
    }
    // Round 5 (Opus 3): a settings file that gives the session its own credential (apiKeyHelper, an API key) wins over
    // the vault's anyway — so the vault credential is not handed over at all.
    if (provider === "claude") {
      const configDir = o.env.CLAUDE_CONFIG_DIR && o.env.CLAUDE_CONFIG_DIR.startsWith("/") ? o.env.CLAUDE_CONFIG_DIR : join(o.env.HOME ?? homedir(), ".claude");
      const own = ownCredentialSetting({ cwd: o.cwd, configDir, home: o.env.HOME ?? homedir(), user: userSettings });
      if (own) {
        say(`walkie: ${plainText(own, 200)} gives this session its own credential; running ${provider} on it, without Walkie accounts (no switching)`);
        return await passthrough();
      }
    }
    return await new Session(o, {
      spawn, clock, sleep, say, trust: trustNow, pathReal: real, baseEnv, parsed,
      threshold: o.thresholdPct ?? DEFAULT_THRESHOLD_PCT, tickMs: o.tickMs ?? 500,
      settleMs: o.settleMs ?? 3_000, backgroundWaitMs: o.backgroundWaitMs ?? BACKGROUND_WAIT_MS, reserveCheckMs: o.reserveCheckMs ?? RESERVE_CHECK_MS,
      setChild: (c) => { child = c; }, stopping: () => stopping, passthrough, userSettings, rawSettings,
    }).run();
  } finally {
    release();
  }
}

interface Ctx {
  spawn: Spawner; clock: () => number; sleep: (ms: number) => Promise<void>; say: (l: string) => void;
  threshold: number; tickMs: number; settleMs: number; backgroundWaitMs: number; reserveCheckMs: number;
  /**
   * Re-validates the credential recipient (round 2, Codex 3): run before EVERY credential-bearing launch; its `argv`
   * (the validated native executable) is what runs. `pathReal` = the CLI as found on PATH
   * (the own-login fallback runs it, without credentials).
   */
  trust: () => TrustCheck; pathReal: string; baseEnv: Record<string, string>;
  parsed: Parsed; setChild: (c: Child | null) => void; stopping: () => NodeJS.Signals | null; passthrough: () => Promise<number>;
  /** Claude: the caller's own --settings (parsed, and as given), merged into / restored on each launch. */
  userSettings: Record<string, unknown> | null; rawSettings: string | null;
}

interface Launch { relaunch: boolean; prompt: string | null; fresh: boolean }

class Session {
  private session: string | null;
  private readonly eventsFile: string;
  private readonly runDir: string;
  private readonly configDir: string;
  private readonly terminal: string | null;
  private readonly avoid = new Set<string>();
  /** Refusal events already counted as a strike (account key @ the refusal's time). */
  private readonly refusalsMarked = new Set<string>();
  private resumeRetried = false;
  private readonly summaries: string[] = [];
  private lastTranscript: string | null = null;
  private childPid: number | null = null;
  private headlessRetries = 0;
  /** A headless run's output that a retry replaced: printed if no later run produces one. */
  private held: Uint8Array | null = null;
  /** Codex: the rollout of the running session was positively tied to it (switching allowed). */
  private bound = false;
  /** The running credential's generation (a hand-out reports the owner's): marks bind to it. */
  private gen: string | undefined;

  constructor(private readonly o: WrapOptions, private readonly c: Ctx) {
    const p = c.parsed;
    this.session = p.session && !p.fork ? p.session : o.provider === "claude" && !p.session && !p.sessionFromRun && !p.fork ? randomUUID() : null;
    this.runDir = join(o.walkieHome, "run");
    privateDir(this.runDir, true);
    this.eventsFile = join(this.runDir, `switch-${process.pid}.jsonl`);
    writeFileSync(this.eventsFile, "", { mode: 0o600 });
    this.configDir = o.env.CLAUDE_CONFIG_DIR && o.env.CLAUDE_CONFIG_DIR.startsWith("/") ? o.env.CLAUDE_CONFIG_DIR : join(homedir(), ".claude");
    this.terminal = saveTerminal();
  }

  private agent(): string | null {
    if (!this.session) return null;
    const key = this.o.provider === "claude" ? "CLAUDE_CODE_SESSION_ID" : "CODEX_THREAD_ID";
    return resolveAgentName({ ...(this.o.env.WALKIE_AGENT ? { WALKIE_AGENT: this.o.env.WALKIE_AGENT } : {}), [key]: this.session });
  }

  private async choose(exclude: readonly string[]): Promise<Selection> {
    const now = this.c.clock();
    return selectOwnFirst(await this.o.source.gather(this.o.provider, now), {
      provider: this.o.provider, model: this.c.parsed.model, now, thresholdPct: this.c.threshold, exclude: [...exclude, ...this.avoid],
    });
  }

  /**
   * The CLI's arguments for a launch. Claude, credentialed: ONE merged --settings (the caller's, the switcher's hooks,
   * the pinned credential routing: claude-settings.ts); on the CLI's own login, the caller's --settings as given.
   */
  private argv(n: Launch, credentialed = true): string[] {
    const p = this.c.parsed;
    if (this.o.provider === "codex") {
      const args = codexArgv(p, { session: this.session, relaunch: n.relaunch, prompt: n.prompt, fresh: n.fresh });
      return credentialed ? pinnedCodexArgv(args) : args;
    }
    const args = withoutSettings(claudeArgv(p, { session: this.session ?? randomUUID(), relaunch: n.relaunch, prompt: n.prompt, fresh: n.fresh }));
    if (!credentialed) return this.c.rawSettings !== null ? ["--settings", this.c.rawSettings, ...args] : args;
    return ["--settings", launchSettings({ walkie: walkieCommand(), allowProxy: proxyAllowed(this.o.walkieHome), user: this.c.userSettings }), ...args];
  }

  private childEnv(acct: Candidate, creds: Credentials): { env: Record<string, string>; fd3?: string } {
    const env: Record<string, string> = {
      ...this.c.baseEnv, WALKIE_ACCOUNT: acct.id, WALKIE_SWITCH_PID: String(process.pid), WALKIE_SWITCH_EVENTS: this.eventsFile,
      ...(this.o.provider === "claude" ? { WALKIE_SWITCH_HOOKS: "1" } : {}),
    };
    // Start-up / loader settings could run other code inside the credentialed process; redirect settings could send
    // its requests (and the token) elsewhere: cleared for it.
    const clean = credentialEnv(env, proxyAllowed(this.o.walkieHome));
    for (const k of Object.keys(env)) if (!(k in clean)) delete env[k];
    if (this.o.provider === "codex") {
      delete env.CODEX_API_KEY;
      return { env: { ...env, CODEX_HOME: creds.home as string } };
    }
    for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) delete env[k];
    if ((this.o.tokenVia ?? (this.o.env.WALKIE_TOKEN_VIA === "env" ? "env" : "fd")) === "env") return { env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: creds.token as string } };
    return { env: { ...env, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" }, fd3: creds.token as string };
  }

  private watcher(since: number, creds: Credentials): ClaudeWatcher | CodexWatcher {
    if (this.o.provider === "claude") {
      return new ClaudeWatcher({ eventsFile: this.eventsFile, configDir: this.configDir, cwd: this.o.cwd, session: this.session, since, childPid: () => this.childPid });
    }
    // Where THIS account home's sessions really go (the base's, through its link), not a guess.
    const sessionsDir = creds.home ? codexSessionsDir(creds.home) : join(codexBaseHome(this.o.walkieHome, this.o.env), "sessions");
    const pid = () => this.childPid ?? 0;
    return new CodexWatcher({
      sessionsDir, cwd: this.o.cwd, session: this.session, since,
      ...(this.o.openRollout ? { openRollout: () => (this.o.openRollout as (p: number) => Promise<string | readonly string[] | null>)(pid()) } : {}),
    });
  }

  async run(): Promise<number> {
    const headless = this.c.parsed.mode === "headless";
    let n: Launch = { relaunch: false, prompt: null, fresh: false };
    let switches = 0;
    const max = this.o.maxSwitches ?? 50;
    /** Why the last session was ended (printed with the account it moves to). */
    let pending: string | null = null;
    /** The account just left for its usage: not picked again right away even if a stale reading says it has room. */
    let justLeft: string | null = null;
    try {
      for (;;) {
        if (this.c.stopping()) return 128 + 15;
        let sel: Selection;
        try {
          sel = await this.choose(justLeft ? [justLeft] : []);
        } catch (err) {
          if (!n.relaunch) throw err; // nothing launched yet: wrap() runs the CLI directly
          return this.ownLogin(n, `accounts unavailable: ${(err as Error).message}`);
        }
        if (!sel.pick) {
          if (n.relaunch && this.avoid.size > 0) return this.ownLogin(n, "the next account's credentials could not be used");
          if (!sel.exhausted) {
            // Nothing usable, and nothing known to be out of room (re-login needed, credentials failing): the CLI's
            // own login, resuming the session when there is one.
            if (!n.relaunch) {
              this.c.say(`walkie: no ${this.o.provider} account can be used right now (${plainText(sel.excluded.map((e) => `${e.label}: ${e.why}`).join("; ") || "none")}); running ${this.o.provider} on its own login`);
              return await this.c.passthrough();
            }
            return this.ownLogin(n, "no other account can be used");
          }
          if (headless) {
            if (this.held) (this.o.stdout ?? ((b: Uint8Array) => process.stdout.write(b)))(this.held);
            this.c.say(JSON.stringify(exhaustedLine(sel)));
            return EXIT_ALL_EXHAUSTED;
          }
          // Round 5 (Opus 9): an own account that cannot be reached is not "at its limit" — say which.
          const unreachable = sel.excluded.filter((e) => e.why === "unreachable right now").map((e) => e.label);
          if (unreachable.length) this.c.say(`walkie: ${plainText(unreachable.join(", "), 160)} ${unreachable.length === 1 ? "is" : "are"} not reachable right now (the machine holding ${unreachable.length === 1 ? "it" : "them"} is offline), so ${unreachable.length === 1 ? "it is" : "they are"} not used and a teammate's account is not borrowed`);
          const waited = await this.waitFor(sel.waitUntil, sel.nextFree?.label ?? null);
          if (!waited) return 130;
          this.avoid.clear();
          justLeft = null;
          continue;
        }
        const acct = sel.pick;
        let creds: Credentials;
        try {
          creds = await this.o.source.credentials(acct, this.agent());
        } catch (err) {
          this.c.say(`walkie: could not use ${acct.label} (${plainText((err as Error).message, 160)}); trying the next account`);
          this.avoid.add(markKey(acct));
          continue;
        }
        if (pending) {
          this.c.say(`walkie: switched to ${acct.label}: ${pending}${n.relaunch && !n.fresh ? " — the same conversation continues" : ""}`);
          pending = null;
        }
        let out: Outcome;
        try {
          out = await this.launch(acct, creds, n, headless);
        } catch (err) {
          // Before or at the start of a launch (the trust re-check, the token hand-over, a lease file): the session
          // continues on the CLI's own login instead (round 2, Codex 5 / Opus 4).
          creds.release?.();
          return this.ownLogin(n, (err as Error).message);
        }
        // COMPANY POOL: a leased Codex home is deleted as soon as the session on it ended (the next launch leases anew).
        creds.release?.();
        if (out.kind === "exit") return out.code;
        if (++switches > max) { this.c.say(`walkie: switched ${max} times in this run; stopping here`); return 1; }
        if (out.kind === "resume_failed") {
          this.c.say(`walkie: ${acct.label} could not resume this conversation; starting a new session pointed at a summary of it`);
          this.resumeRetried = true;
          try {
            const file = writeSummaryFile(this.runDir, this.lastTranscript, this.summaries.length);
            this.summaries.push(file);
            this.session = this.o.provider === "claude" ? randomUUID() : null;
            n = { relaunch: true, prompt: summaryInstruction(file), fresh: true };
          } catch (err) {
            return this.ownLogin(n, `the summary could not be written: ${(err as Error).message}`);
          }
          continue;
        }
        // A limit or a refused token is a mark (excluded until its reset); a usage switch just must not bounce back.
        justLeft = out.avoid ? null : markKey(acct);
        pending = out.reason;
        n = { relaunch: true, prompt: withStopped(out.answer ? ANSWER_PROMPT : out.resume ? CONTINUE_PROMPT : null, out.stopped ?? []), fresh: false };
      }
    } finally {
      for (const f of [this.eventsFile, ...this.summaries]) { try { rmSync(f, { force: true }); } catch { /* gone */ } }
    }
  }

  /**
   * The relaunch could not go to an account (round 1, Opus 3): the session continues on the CLI's own login (resumed
   * when its id is known) rather than leave nothing running.
   */
  private async ownLogin(n: Launch, why: string): Promise<number> {
    this.c.say(`walkie: could not continue on a Walkie account (${plainText(why, 160)}); continuing on ${this.o.provider}'s own login`);
    const argv = this.session ? this.argv(n, false) : this.c.parsed.original;
    const env = { ...this.c.baseEnv };
    for (const k of ["WALKIE_ACCOUNT", "WALKIE_SWITCH_PID", "WALKIE_SWITCH_EVENTS", "WALKIE_SWITCH_HOOKS"]) delete env[k];
    const child = this.c.spawn({ argv: [this.c.pathReal, ...argv], env, cwd: this.o.cwd });
    this.c.setChild(child);
    try { return await child.exited; } finally { this.c.setChild(null); }
  }

  /** Waits until `until` (or 5 min when unknown), printing one line; false when interrupted (Ctrl-C / SIGTERM). */
  private async waitFor(until: number | null, label: string | null = null): Promise<boolean> {
    const now = this.c.clock();
    const target = until !== null ? until + 30_000 : now + 5 * 60_000;
    this.c.say(until !== null
      ? `walkie: every ${this.o.provider} account is at its limit; the next frees at ${fmtTime(until)} (in ${inWords(until - now)})${label ? `, ${plainText(label, 80)}` : ""}. Waiting, then resuming automatically (Ctrl-C to stop).`
      : `walkie: every ${this.o.provider} account is at its limit and no reset time is known; checking again in 5 min (Ctrl-C to stop).`);
    let interrupted = false;
    const onInt = () => { interrupted = true; };
    process.on("SIGINT", onInt);
    try {
      while (!interrupted && !this.c.stopping() && this.c.clock() < target) await this.c.sleep(Math.min(1_000, Math.max(10, target - this.c.clock())));
    } finally {
      process.off("SIGINT", onInt);
    }
    return !interrupted && !this.c.stopping();
  }

  private async launch(acct: Candidate, creds: Credentials, n: Launch, headless: boolean): Promise<Outcome> {
    const since = this.c.clock();
    const watcher = this.watcher(since, creds);
    const { env, fd3 } = this.childEnv(acct, creds);
    const agent = this.agent();
    let lease: Lease = writeLease(this.o.walkieHome, {
      provider: this.o.provider, account: acct.id, pid: process.pid,
      ...(agent ? { agent } : {}), ...(this.session ? { session: this.session } : {}),
      ...(!acct.own && acct.owner ? { owner: acct.owner } : {}), ...(acct.source === "peer" && acct.node ? { from_node: acct.node } : {}),
      ...(creds.grant ? { grant: creds.grant } : {}),
    });
    this.gen = creds.gen ?? acct.gen;
    // Headless runs that may be retried keep stdout, so a script sees one result (round 1, Opus 11).
    const capture = headless && this.o.provider === "claude" && this.c.parsed.outputFormat !== "stream-json";
    // Round 2 (Codex 3): every credential-bearing launch re-validates the recipient, and the objects validated must be
    // exactly those about to run (dev / inode / size / mtime), checked right before the spawn.
    const trust = this.c.trust();
    if (!trust.ok) { releaseLease(this.o.walkieHome, lease); throw new Error(trust.why); }
    const argv = [...trust.argv, ...this.argv(n)];
    if (!sameObjects(trust.ids)) { releaseLease(this.o.walkieHome, lease); throw new Error("the trusted CLI changed between its check and the launch"); }
    const child = this.c.spawn({ argv, env, cwd: this.o.cwd, ...(fd3 !== undefined ? { fd3 } : {}), ...(capture ? { captureStdout: true } : {}) });
    // Owned at once (round 2, Codex 5): registered for signals and supervision before anything else can fail.
    this.childPid = child.pid;
    this.c.setChild(child);
    if (child.handoffError) {
      await this.end(child);
      this.c.setChild(null);
      releaseLease(this.o.walkieHome, lease);
      throw new Error(`the token could not be handed over (${child.handoffError})`);
    }
    this.bound = this.o.provider === "claude";
    try {
      const out = await this.supervise(child, watcher, acct, n.relaunch, headless, (sid) => {
        if (sid === this.session && lease.session === sid) return;
        this.session = sid;
        const a = this.agent();
        try { lease = updateLease(this.o.walkieHome, lease, { session: sid, ...(a ? { agent: a } : {}) }); } catch { /* the lease file is advisory */ }
      });
      if (capture && child.output) {
        if (out.kind === "exit") { (this.o.stdout ?? ((b: Uint8Array) => process.stdout.write(b)))(child.output()); this.held = null; }
        else this.held = child.output();
      }
      return out;
    } finally {
      this.c.setChild(null);
      try { releaseLease(this.o.walkieHome, lease); } catch { /* gone */ }
    }
  }

  private async poll(w: ClaudeWatcher | CodexWatcher): Promise<Signals> {
    const now = this.c.clock();
    const s = w instanceof CodexWatcher ? await w.refresh(now) : w.poll(now);
    if (s.transcript) this.lastTranscript = s.transcript;
    if (w instanceof CodexWatcher) this.bound = s.bound;
    return s;
  }

  private async end(child: Child): Promise<void> {
    await child.stop(5_000);
    try { restoreTerminal(this.terminal, this.o.provider === "codex"); } catch { /* best effort */ }
  }

  /** An error after launch (round 1, Opus 3): say it once, stop switching, and simply wait for the CLI to end. */
  private async degrade(child: Child, err: unknown): Promise<Outcome> {
    this.c.say(`walkie: account switching stopped for this session (${plainText((err as Error)?.message ?? String(err), 160)}); ${this.o.provider} keeps running`);
    return { kind: "exit", code: await child.exited };
  }

  private async supervise(child: Child, w: ClaudeWatcher | CodexWatcher, acct: Candidate, relaunched: boolean, headless: boolean, onSession: (sid: string) => void): Promise<Outcome> {
    let noted = false;
    let waitedNoted = false;
    let limitHandled = false;
    let cutSeen: number | null = null;
    let lastReadingAt = 0;
    // COMPANY POOL (Codex p8 HIGH 2): a borrowed pooled login is left at its person's reserve, not only at the limit.
    let reserveCheckedAt = 0;
    let reserveHit: { at: number } | null = null;
    for (;;) {
      const done = await Promise.race([child.exited, this.c.sleep(this.c.tickMs).then(() => null)]);
      try {
        const s = await this.poll(w);
        if (s.session) onSession(s.session);
        const now = this.c.clock();
        if (s.reading && s.reading.at !== lastReadingAt) { lastReadingAt = s.reading.at; writeSessionReading(this.o.walkieHome, acct.id, s.reading, now); }
        if (done !== null) {
          if (headless && !this.c.stopping()) return this.afterHeadless(s, acct, done);
          return { kind: "exit", code: done };
        }
        if (this.c.stopping()) continue; // the forwarded signal ends the child; its exit ends the run
        if (!reserveHit && acct.pooled && !acct.own && now - reserveCheckedAt >= this.c.reserveCheckMs) {
          reserveCheckedAt = now;
          const room = await this.roomNow(acct, s.reading, now);
          if (room !== null && room - PERSONAL_RESERVE_PCT <= 0) reserveHit = { at: now };
        }
        const cut = s.limit ?? (s.refused ? { at: s.refused.at, until: null, window: "token refused" } : null)
          ?? (reserveHit ? { at: reserveHit.at, until: null, window: "personal reserve" } : null);
        if (cut && !limitHandled && !(reserveHit && !s.limit && !s.refused)) {
          limitHandled = true;
          cutSeen = now;
          this.markCut(acct, s, now);
        }
        if (cut && cutSeen === null) cutSeen = now; // a reserve stop waits for background work like a limit
        if (headless) continue;
        const quiet = now - s.lastActivity >= this.c.settleMs;
        if (s.resumeFailed && relaunched && !this.resumeRetried && quiet) { await this.end(child); return { kind: "resume_failed" }; }
        if (!cut || !quiet) continue;
        // Moving the session needs its id and, for Codex, a rollout positively tied to this process.
        if (!this.session || !this.bound) {
          if (!noted) { this.c.say(`walkie: ${acct.label} hit a limit; this session cannot be moved (its session could not be tied to the process), so it stays`); noted = true; }
          continue;
        }
        // Background work the session started (a shell, an agent, an exec session) is not cut off: wait for it, bounded.
        if (s.background.length && cutSeen !== null && now - cutSeen < this.c.backgroundWaitMs) {
          if (!waitedNoted) {
            this.c.say(`walkie: ${acct.label} hit its limit; waiting for ${s.background.length} background task${s.background.length === 1 ? "" : "s"} to finish (up to ${Math.round(this.c.backgroundWaitMs / 60_000)} min) before moving the session`);
            waitedNoted = true;
          }
          continue;
        }
        const alt = await this.choose([]); // the current account is excluded by its new mark (and counts for the wait)
        if (!alt.pick && alt.waitUntil === null && !alt.exhausted) {
          if (!noted) { this.c.say(`walkie: ${acct.label} hit a limit and no other ${this.o.provider} account is available`); noted = true; }
          continue;
        }
        // The selection awaited: anything written meanwhile (a prompt, more output) means look again next tick.
        const again = await this.poll(w);
        if (again.lastActivity !== s.lastActivity) continue;
        await this.end(child);
        const after = await this.poll(w).catch(() => again);
        const why = s.limit ? `${acct.label} reached its ${s.limit.window.replace(/_/g, "-")} limit${s.limit.until ? ` (resets ${fmtTime(s.limit.until)})` : ""}`
          : s.refused ? `${acct.label}'s token was refused`
          : `${acct.label} reached the last ${PERSONAL_RESERVE_PCT}% kept for @${acct.owner ?? "its person"}`;
        // Background work still running at the bound is ended with the CLI: the resumed session is told what it was.
        const stopped = again.background.map((b) => (again.backgroundInfo[b] ? `${again.backgroundInfo[b]} (${b})` : b));
        // A reserve stop writes no mark (the login is not out for its person): it is only skipped by the next pick.
        return { kind: "switch", reason: why, resume: true, avoid: !!(s.limit || s.refused), answer: after.promptAfterLimit, stopped };
      } catch (err) {
        if (done !== null) return { kind: "exit", code: done };
        return this.degrade(child, err);
      }
    }
  }

  /**
   * Records what a session hit (round 5): a limit (model-scoped when the provider named one model); a refused token as
   * a strike — one refusal moves the session (the account is avoided for this run) but excludes nothing, a second
   * one within a day confirms "needs re-login". Keyed by owner for a borrowed account (Codex 7).
   */
  private markCut(acct: Candidate, s: Signals, now: number): void {
    const key = markKey(acct);
    const gen = this.gen ? { gen: this.gen } : {};
    if (s.limit) {
      writeMark(this.o.walkieHome, key, { state: "exhausted", until: s.limit.until ?? now + UNKNOWN_RESET_MS, at: now, reason: s.limit.window.slice(0, 40), ...(s.limit.model ? { model: s.limit.model } : {}), ...(s.limit.until === null ? { guessed: true } : {}), ...gen }, now);
      return;
    }
    if (!s.refused) return;
    this.avoid.add(markKey(acct));
    if (!refusalMarksAccount(acct)) return;
    // One strike per refusal EVENT (round 7, Codex r6 3): supervision and a headless run's exit handling see the same one.
    const event = `${key}@${s.refused.at}`;
    if (this.refusalsMarked.has(event)) return;
    this.refusalsMarked.add(event);
    const prev = readMarks(this.o.walkieHome, now)[key];
    const again = !!prev && prev.state === "relogin" && (prev.gen ?? null) === (this.gen ?? null) && now - prev.at < 86_400_000;
    const strikes = again ? Math.min(10, (prev.strikes ?? 2) + 1) : 1;
    writeMark(this.o.walkieHome, key, { state: "relogin", until: null, at: now, reason: "token_refused", strikes, ...gen }, now);
  }

  /**
   * The room (%) left on a borrowed pooled login now: the session's own reading when it has one (Codex), else the
   * team's pooled view (at most a minute stale). Null when nothing current says (the lender blocks new leases then).
   */
  private async roomNow(acct: Candidate, reading: AccountUsage | null | undefined, now: number): Promise<number | null> {
    const fresh = (u: AccountUsage | null | undefined) => (u && u.state === "ok" && u.windows.length && now - u.at <= READING_MAX_AGE_MS ? u : null);
    const own = fresh(reading);
    if (own) return roomOf(own, this.c.parsed.model, now);
    try {
      const again = (await this.o.source.gather(this.o.provider, now)).find((c) => markKey(c) === markKey(acct));
      const u = fresh(again?.usage);
      return u ? roomOf(u, this.c.parsed.model, now) : again?.usage?.state === "exhausted" ? 0 : null;
    } catch {
      return null;
    }
  }

  /** A headless run (claude -p) that ended on a limit is run again on the next account, resuming its session. */
  private async afterHeadless(s: Signals, acct: Candidate, code: number): Promise<Outcome> {
    const now = this.c.clock();
    if (!s.limit && !s.refused) return { kind: "exit", code };
    this.markCut(acct, s, now);
    if (this.o.provider !== "claude" || !this.session || this.headlessRetries >= (this.o.maxHeadlessRetries ?? 3)) return { kind: "exit", code };
    this.headlessRetries++;
    return { kind: "switch", reason: s.limit ? `${acct.label} reached its ${s.limit.window.replace(/_/g, "-")} limit` : `${acct.label}'s token was refused`, resume: true, avoid: true };
  }
}
