// Agent auto-discovery (v0.1.2; activity-based states since WALKIE-MISSION-1). Claude Code only loads hooks in
// sessions started after `walkie hooks install`, and headless seats (`claude -p`, `codex exec`) often run with no
// hooks at all. Every 15 s the daemon looks at THIS user's processes for Claude Code, Codex, Kimi and Grok and names
// each one the way its hooks/MCP would (resolveAgentName). Its state comes from what the session is doing
// (activity.ts): `working` when its session file was written or its process tree used CPU in the last minute, or a
// turn is in progress; `idle` when it is alive and doing nothing; `offline` the moment its process is gone.
//
// Discovery never overwrites a hook's or set_status's word with older evidence: it replaces another source's status
// only when what it saw happened after that status (and, for waiting/stuck, only after the agent kept working for
// ATTENTION_HOLD_MS). Statuses it posted itself (remembered by event id, across restarts) it keeps current. A hook- or
// MCP-reported agent of this machine whose process is gone is marked offline too (sweep), so ended sessions don't
// linger as idle ghosts.
//
// Privacy (fix round 1, src/agent/share-policy.ts): the state, runtime, model, repo, branch and working directory are
// shared. A title from a prompt only with share_prompts (and a title cached earlier is dropped once it is off, unless a
// person set it with walkie_set_status); a tool call's text only with share_activity, else a fixed phrase.
//
// Accuracy (fix round 1): a failed process listing changes nothing (Codex 5); a session goes idle only after two idle
// scans and 90 s without activity (Opus 8); a pid-named session (its id unknown) takes over the hook card of the same
// runtime and directory instead of posting a ghost beside it, and while one is running that runtime's hook cards are
// not swept (Opus 5); claude-mem observer sessions are not agents (Opus 6); each runtime reports at most
// MAX_PER_RUNTIME sessions per machine.
//
// Only the session id (and WALKIE_AGENT, which is the agent's name) is ever read from a process's environment, and
// only the session id is sent. ACCOUNTS-1 adds CLAUDE_CONFIG_DIR / CODEX_HOME (directory paths, read from the session
// process itself and kept on this machine) so the accounts service knows which login a session uses, and checks
// whether a session runs on an environment token by variable NAME only: the value is never read into a result.
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { detectTask, resolveAgentName } from "../agent/identity.ts";
import type { RepoContext } from "../agent/identity.ts";
import { SHARE_NOTHING, type SharePolicy } from "../agent/share-policy.ts";
import { ACTIVITY_PHRASES, type StatusProvenance } from "../protocol/status-projection.ts";
import { walkieHome } from "../client/index.ts";
import { IDLE_ARCHIVE_MS, OFFLINE_GRACE_MS } from "../protocol/agent-roster.ts";
import { isSeatAgent } from "../protocol/seats.ts";
import type { BodyOf } from "../protocol/schemas.ts";
import { CPU_BUSY_RATIO, CpuTracker, judge, SESSION_ID_RE, titleOf, type FileKind, type TailInfo } from "./activity.ts";
import { agentStatus } from "./agent-table.ts";
import { DiscoveryFiles, LOOKUP_FAILED, type HookState } from "./discovery-files.ts";
import type { Core } from "./core.ts";
import { RESERVED_AGENTS } from "./local-routes.ts";
import { FLEET_AGENT, STEWARD_AGENT } from "../protocol/projects/steward-core.ts";
import type { Logger } from "./logger.ts";
import { SystemProcessProvider, type ProcessProvider, type ProcRow } from "./procs.ts";
import { classifyAgent, hermesProcessOf, hermesProfileOf, modelServers, RELAUNCHING, runtimeName, wireRuntime, type AgentKind, type AgentRuntime, type Launch } from "./agent-procs.ts";
import { hermesProfileLive, hermesProfileStatus, noteHermesCensus, offlineExitedHermesSessions, purgeEndedHermesSessions, shownCard, type HermesProcess } from "./hermes-status.ts";
import { scrubHermesActivity } from "./hermes-scrub.ts";
import { assignKimiSessions, ScanBudget, type KimiProc } from "./kimi-sessions.ts";
import { observedAt } from "./views.ts";
import { trackOp } from "./watchdog.ts";

type Status = BodyOf<"agent.status">;

/** The activity of an idle discovered session. */
export const DISCOVERED_ACTIVITY = "Idle (no activity seen in the last minute)";
/** A working discovered session whose last step is unknown. */
export const WORKING_ACTIVITY = "Working (seen from the process)";
export const DETAILS_PENDING_ACTIVITY = "Working (details pending)";
/** What discovery posted through v0.2.0: statuses carrying it are discovery's own. */
export const LEGACY_DISCOVERED_ACTIVITY = "Running (no hooks yet — restart to see live activity)";
export const EXITED_ACTIVITY = "Process exited";
/** An `offline` status older than this is replaced when its session turns out to be running. */
export const DISCOVERY_STALE_MS = 10 * 60_000;
/** A working status discovery keeps is re-posted this often, so it never goes stale (views.ts STALE_STATUS_MS). */
export const HEARTBEAT_MS = 10 * 60_000;
/** A new activity line of a working session is posted at most this often. */
export const STEP_MIN_MS = 30_000;
/** Activity must come this long after another source's idle status to replace it (the turn's last writes). */
export const OVERRIDE_MARGIN_MS = 20_000;
/** A waiting / stuck status is replaced by working only after the agent kept working this long past it. */
export const ATTENTION_HOLD_MS = 5 * 60_000;
/** Another source's `working` becomes idle after this long with no activity (an interrupted turn fires no Stop hook). */
export const IDLE_AFTER_MS = 2 * 60_000;
/** A status of this machine for a session that is not running goes offline once it is this old (sweep). */
export const SWEEP_GRACE_MS = 2 * 60_000;
/**
 * A session discovery can't name (`grok-pid<N>`, `claude-pid<N>`) gets a card only once its process has run this long:
 * one-shot runs (a health probe's `grok -p "Reply with exactly PONG."` every ~15 s) came and went as cards (LIVE-2).
 */
export const UNNAMED_MIN_AGE_MS = 20_000;
/** A working session is reported idle only after this many idle scans in a row... */
export const IDLE_SCANS = 2;
/** ...and this long without activity (the minute of ACTIVE_WINDOW_MS plus two scans). */
export const IDLE_HOLD_MS = 90_000;
/** Sessions per runtime one machine reports (the most recently started); more are not posted, and not swept. */
export const MAX_PER_RUNTIME = 100;
/** One scan's wall-clock budget: sessions not examined in time keep their last state until the next scan. */
export const SCAN_BUDGET_MS = 10_000;
/** Sessions examined at once (each may need an `lsof`). */
export const SCAN_CONCURRENCY = 6;
/** A live session's working directory is looked up again this often. */
export const CWD_REFRESH_MS = 60_000;
/** Sessions every scan examines even when its budget is spent. */
export const MIN_EXAMINED = 4;
const SWEEP_MAX_PER_TICK = 100;
/** A Kimi process whose session isn't found yet is looked for again this often (Kimi writes it on its first turn). */
export const KIMI_RETRY_MS = 30_000;
/** How long a session file that can't be read keeps its last verdict (then CPU decides, as for a session without one). */
export const READ_FAIL_HOLD_MS = 10 * 60_000;
/**
 * A process-list census that keeps failing is held (flagged stale) this long; after that its counts are no longer a measurement
 * and the machine publishes no agent counts at all (unknown), with the stale flag kept until a scan succeeds.
 */
export const CENSUS_MAX_AGE_MS = 5 * 60_000;
/** File operations (stats, small reads) Kimi's session lookup may spend in one scan, across all its directories. */
export const KIMI_OPS_PER_SCAN = 2_000;
/** An enrichment provider that hangs must not hold the process census behind it. */
export const ENRICH_READ_TIMEOUT_MS = 500;
/** Process listing is a single provider call, with room for a busy host but never an unbounded wait. */
export const PROCESS_LIST_TIMEOUT_MS = 5_000;
export const SCAN_WARNING_INTERVAL_MS = 10 * 60_000;
const CODEX_FILE_RETRY_BASE_MS = 15_000;
const CODEX_FILE_RETRY_MAX_MS = 5 * 60_000;

async function readWithin<T>(read: Promise<T>, fallback: T, timeoutMs = ENRICH_READ_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); });
  try { return await Promise.race([read, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}
const SWEEP_RUNTIMES: ReadonlySet<string> = new Set(["claude-code", "codex", "kimi"]);
/** Cards owned by daemon hosts are authoritative only at their host, never by process discovery. */
function daemonOwnsAgent(agent: string): boolean {
  return agent === "orchestrator" || agent.startsWith("orchestrator.")
    || agent === STEWARD_AGENT || agent === FLEET_AGENT || RESERVED_AGENTS.has(agent);
}
/**
 * The runtimes the machine's published process counts can name (MachineStats.agent_processes: its wire enum, one entry each).
 * Hermes is not on it: a peer that does not know a name drops the whole list, so a machine with a Hermes session would show
 * no counts at all to every older peer. Hermes sessions are agents, but they are not counted there.
 */
type CountedRuntime = Exclude<AgentRuntime, "hermes">;
const ACCOUNT_RUNTIMES: ReadonlySet<AgentRuntime> = new Set(["claude-code", "codex", "kimi", "grok"]);
/** A discovered session of a runtime whose login the accounts service knows. */
export type AccountSession = DiscoveredAgent & { runtime: "claude-code" | "codex" | "kimi" | "grok" };
const isAccountSession = (a: DiscoveredAgent): a is AccountSession => ACCOUNT_RUNTIMES.has(a.runtime);
const OWNED_META = "discovery_owned";
/** AGENT-SEE-1 / Codex p8 #2: which hook card each running unnamed process took over, by pid:start. */
const ADOPTED_META = "discovery_adopted";
const OWNED_MAX = 4_000;

export interface DiscoveryOptions {
  intervalMs?: number;
  provider?: ProcessProvider;
  /** Whose processes to report (default: the daemon's own user). */
  uid?: number;
  now?: () => number;
  /** What statuses may carry beyond the state (src/agent/share-policy.ts), or a getter re-read every scan; default: nothing. */
  share?: SharePolicy | (() => SharePolicy);
  /** The Hermes profiles whose status may carry activity text (src/protocol/hermes-activity.ts), or a getter re-read every scan; default: none. */
  hermesActivity?: readonly string[] | (() => readonly string[]);
  /** Walkie's home: the hooks' per-agent state, which says whether a cached title was set explicitly (default ~/.walkie). */
  home?: string;
  /** Claude's config directory for sessions that don't set CLAUDE_CONFIG_DIR (default: ~/.claude). */
  claudeConfigDir?: string;
  /** Directories whose sessions are not agents (default: ~/.claude-mem, claude-mem's observer sessions). */
  nonAgentDirs?: readonly string[];
  /** Sessions per runtime reported (default MAX_PER_RUNTIME). */
  maxPerRuntime?: number;
  /** Wall-clock budget of one scan (default SCAN_BUDGET_MS) and how many sessions are examined at once. */
  scanBudgetMs?: number;
  concurrency?: number;
  /** How long an unnamed session's process must run before it gets a card; census counts are immediate. */
  unnamedMinAgeMs?: number;
}

/** What discovery saw a session doing (activity.ts). */
export interface SeenActivity {
  working: boolean;
  /** Last turn write to the session file, or (a session without one) busy CPU (ms); absent = never seen active. */
  last_active_at?: number;
  /** Last turn write to the session file (ms): the only evidence that ends a hook's waiting / blocked. */
  file_active_at?: number;
  /** A session file was found (its evidence is trusted over a hook's `working`). */
  file?: true;
  /** The turn's last record is a tool call: a quiet tool may run for long; a hook's `working` is kept. */
  tool_running?: true;
  /** The session file's last record could not be read (longer than the read-back limit). */
  unknown?: true;
  /** A tool call is verifiably running (its process is alive): working, and a hook's working is kept fresh. */
  pending?: true;
  step?: string; model?: string; title?: string;
}

export interface DiscoveredAgent {
  agent: string; runtime: AgentRuntime; pid: number;
  /** AGENT-SEE-1: how it runs, when known ("headless": `-p`, `exec`, no terminal; "acp": an editor's ACP adapter). */
  launch?: Launch;
  /** pid:start of its process (local). */
  key?: string;
  session?: string; started_at?: number; repo?: string; branch?: string; cwd?: string;
  /** CLAUDE_CONFIG_DIR (Claude) or CODEX_HOME (Codex) of the session process; local only, never posted. */
  login_dir?: string;
  /** The session process has a token variable set (by name; the value is never read): its account is unknown. */
  token_login?: true;
  activity?: SeenActivity;
  /** ACCOUNTS-2: the vault account a Walkie wrapper launched this session on (its WALKIE_ACCOUNT; an id, not a secret). */
  account?: string;
}

const SESSION_VARS = ["WALKIE_AGENT", "CLAUDE_CODE_SESSION_ID", "KIMI_SESSION_ID", "GROK_SESSION_ID"] as const;
/** Read from a Kimi process itself: where its sessions live (a seat may run with its own KIMI_CODE_HOME). */
const KIMI_VARS = ["KIMI_CODE_HOME", "WALKIE_AGENT"] as const;
/** Read from the session process itself (not its children): which login directory it uses. */
const LOGIN_VARS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "WALKIE_ACCOUNT", "WALKIE_SWITCH_PID"] as const;
/** Set in a session's environment, the CLI runs on that token, not on the config directory's login (names only). */
export const TOKEN_VARS: Readonly<Record<"claude-code" | "codex", readonly string[]>> = {
  "claude-code": ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
};
const ALL_TOKEN_VARS = [...TOKEN_VARS["claude-code"], ...TOKEN_VARS.codex];

/** Which of the named variables each pid has set, as names; a provider without envNames has its values dropped here. */
async function envNamesOf(provider: ProcessProvider, pids: readonly number[], names: readonly string[]): Promise<Map<number, string[]>> {
  if (!pids.length) return new Map();
  if (provider.envNames) return provider.envNames(pids, names);
  const vars = await provider.envVars(pids, names);
  return new Map([...vars].map(([pid, env]) => [pid, Object.keys(env).filter((k) => names.includes(k) && !!env[k])]));
}
/** A parent process whose Claude children are not agents (claude-mem's worker runs its observer sessions). */
const NON_AGENT_PARENT = /claude-mem|thedotmack\/.*worker-service/;

const ROLLOUT_RE = /rollout-[^/]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Which agent runtime a process is, from its executable (never its environment, which children inherit). */
export { runtimeOf } from "./agent-procs.ts";

/** A `codex app-server` (the Codex desktop app / IDE) runs sessions discovery can't see as their own processes. */
function isCodexHost(command: string): boolean {
  const argv = command.trim().split(/\s+/);
  return basename(argv[0] ?? "") === "codex" && argv[1] === "app-server";
}

function loginDirOf(rt: AgentRuntime, env: Record<string, string> | undefined): string | undefined {
  const v = rt === "claude-code" ? env?.CLAUDE_CONFIG_DIR : rt === "codex" ? env?.CODEX_HOME : undefined;
  return v && v.startsWith("/") && v.length <= 1024 ? v : undefined;
}

/**
 * The vault account of a wrapped session: WALKIE_ACCOUNT counts only on the process the wrapper itself started (its
 * parent is WALKIE_SWITCH_PID), not on a process that merely inherited the variable from a wrapped session.
 */
function wrappedAccount(p: ProcRow, env: Record<string, string> | undefined): string | undefined {
  const id = env?.WALKIE_ACCOUNT;
  return id && /^[0-9a-f]{24}$/.test(id) && Number(env?.WALKIE_SWITCH_PID) === p.ppid ? id : undefined;
}

function tokenLogin(rt: AgentRuntime, set: readonly string[] | undefined): boolean {
  const vars = rt === "claude-code" || rt === "codex" ? TOKEN_VARS[rt] : [];
  return !!set?.some((name) => vars.includes(name));
}

/** A Kimi process's KIMI_CODE_HOME (an absolute path), else ~/.kimi-code. */
function kimiHomeOf(env: Record<string, string> | undefined): string {
  const v = env?.KIMI_CODE_HOME;
  return v && v.startsWith("/") && v.length <= 1024 && !v.split("/").includes("..") ? v : join(homedir(), ".kimi-code");
}

function pidName(rt: AgentRuntime, pid: number): string {
  return `${rt === "claude-code" ? "claude" : rt}-pid${pid}`;
}

const PLACEHOLDER_NAME = /^(claude|codex|kimi|grok|gemini|opencode)-pid[0-9]+$/;
/**
 * A process-only placeholder card whose every process this scan reported under another name: the process gained its name
 * (a lookup that timed out earlier succeeded), so the placeholder is a duplicate of the named card, not a session that ended.
 */
function renamedPlaceholder(name: string, keys: ReadonlySet<string>, next: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  if (!PLACEHOLDER_NAME.test(name) || !keys.size) return false;
  return [...keys].every((key) => [...next.values()].some((named) => named.has(key)));
}

/** Per process (pid + start): what earlier scans learned about it. */
interface Entry {
  /** Last successful enrichment; a later failed lookup cannot erase a live agent's identity. */
  discovered?: DiscoveredAgent;
  ctx?: RepoContext; cwdAbs?: string; thread?: string; file?: string | null;
  /** The Codex rollout path found among the process's open files, kept while the worker could not open it (retried each scan, no new listing). */
  rollout?: string;
  /** Next Codex rollout lookup after a CONFIRMED missing file, and the delay to use after another miss. */
  fileRetryAt?: number; fileRetryDelayMs?: number;
  /** Kimi (AGENT-SEE-1): when its session was last looked for, and the session's wire.jsonl and sessions directory. */
  kimiAt?: number; kimiPath?: string; kimiRoot?: string;
  /** The last verdict, and when the session file was last read (a read that fails later keeps the verdict for a while). */
  seen?: SeenActivity; readAt?: number;
  lastBusyAt?: number; title?: string;
  /** Not an agent (a claude-mem observer): skipped from then on. */
  excluded?: boolean;
  /** The session file's last turn write seen so far (a bookkeeping write after it doesn't move it). */
  fileAt?: number | null;
  /** The verdict last reported (working?) and how many idle scans followed it (hysteresis). */
  reported?: boolean; idleScans?: number;
  /** Busy CPU readings in a row. */
  busyScans?: number;
  /** When it was last examined (fair rotation under the scan budget) and its cwd last looked up. */
  examinedAt?: number; cwdAt?: number;
}

/** A status discovery posted: its event id, or (rate-limited, emitted later) its state and activity. */
interface Owned { id?: string; state: string; activity?: string }

export class AgentDiscovery {
  private readonly provider: ProcessProvider;
  private readonly uid: number;
  private readonly intervalMs: number;
  private readonly unnamedMinAgeMs: number;
  /** Runtimes with an unnamed session this scan held back as too young (a card it may adopt is not swept meanwhile). */
  private youngUnnamed = new Set<string>();
  private hermesCensus: { processes: readonly HermesProcess[]; capturedAt: number } = { processes: [], capturedAt: 0 };
  private readonly now: () => number;
  /** The collection policy: re-read every scan (the daemon's config may change while it runs, Codex r3 #8). */
  private share: SharePolicy;
  private readonly sharePolicy: () => SharePolicy;
  /** The Hermes profiles allowed to show activity text, as of the last scan (read again when its results are applied): every other Hermes card shows its state only. */
  private hermesActivity: readonly string[];
  private readonly hermesActivityProfiles: () => readonly string[];
  private readonly home: string;
  private readonly claudeDir: string;
  private readonly nonAgentDirs: readonly string[];
  private readonly maxPerRuntime: number;
  private readonly cpu = new CpuTracker();
  private files: DiscoveryFiles;
  private hookStates: Record<string, HookState> = {};
  /** Unnamed sessions (pid:start) that took over a hook card → that card's agent name (adopt). */
  private adoptedMap: Map<string, string> | null = null;
  /** A no-cwd placeholder's temporary hook reservation; re-matched when enrichment supplies a directory. */
  private provisional = new Map<string, string>();
  private adoptedDirty = false;
  /** Runtimes with more sessions than maxPerRuntime in the last scan: their hook cards are not swept. */
  private truncated = new Set<string>();
  /** pid:start of every process of this user in the last successful scan (a session not reported is not gone). */
  private runningKeys = new Set<string>();
  /** pid:start of candidates the last scan had no time for: they keep their state. */
  private unexamined = new Set<string>();
  /** Sessions over the per-runtime cap in the last scan. */
  private unselected = 0;
  /** When the process list last produced the published counts (this.now()). */
  private censusAt = 0;
  private readonly scanBudgetMs: number;
  private readonly concurrency: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly scanWarnings = new Map<string, { at: number; suppressed: number }>();
  /** Custom providers in tests cannot run in the file worker; keep one call per session record. */
  private readonly providerSessionReads = new Map<string, Promise<{ sessionId: string; startedAt?: number } | undefined>>();
  /** Sessions seen running by the last COMPLETE scan (null: none yet, or the last one was incomplete). */
  private runningNames: ReadonlySet<string> | null = null;
  private stopped = false;
  /** Agents seen in the last scan → their processes (pid:start). */
  private live = new Map<string, Set<string>>();
  private readonly cache = new Map<string, Entry>();
  private codexHost = false;
  /** Every pid of this user in the last scan (an MCP server's fallback name carries its parent's pid). */
  private minePids = new Set<number>();
  private owned: Map<string, Owned> | null = null;
  /** Local model servers seen in the last scan (AGENT-SEE-1): machine load, published with the machine's stats. */
  private models: { name: string; count: number }[] = [];
  private agentCounts: { name: CountedRuntime; count: number }[] = [];
  private ownedDirty = false;
  /** Every scan's result, for the accounts service (which login each session uses). */
  onScan: ((found: readonly AccountSession[]) => void) | null = null;

  constructor(private readonly publishingCore: Core | undefined, private readonly log: Logger, opts: DiscoveryOptions = {}) {
    this.provider = opts.provider ?? new SystemProcessProvider();
    this.uid = opts.uid ?? process.getuid?.() ?? -1;
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.unnamedMinAgeMs = opts.unnamedMinAgeMs ?? 0;
    this.now = opts.now ?? Date.now;
    const given = opts.share ?? SHARE_NOTHING;
    this.sharePolicy = typeof given === "function" ? given : () => given;
    this.share = this.sharePolicy();
    const hermesGiven = opts.hermesActivity ?? [];
    this.hermesActivityProfiles = typeof hermesGiven === "function" ? hermesGiven : () => hermesGiven;
    this.hermesActivity = this.hermesActivityProfiles();
    this.home = opts.home ?? walkieHome();
    this.claudeDir = opts.claudeConfigDir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
    this.nonAgentDirs = opts.nonAgentDirs ?? [join(homedir(), ".claude-mem")];
    this.maxPerRuntime = opts.maxPerRuntime ?? MAX_PER_RUNTIME;
    this.scanBudgetMs = opts.scanBudgetMs ?? SCAN_BUDGET_MS;
    this.concurrency = Math.max(1, opts.concurrency ?? SCAN_CONCURRENCY);
    this.files = new DiscoveryFiles(this.share.activity, log); // filesystem work stays off the daemon event loop
  }

  /** A diagnostic scanner never opens a store or a daemon socket. */
  private get core(): Core {
    if (!this.publishingCore) throw new Error("read-only discovery cannot publish");
    return this.publishingCore;
  }

  async report() {
    const found = await this.scanOnce();
    if (found === null) throw new Error("process listing unavailable");
    return { agents: found.map((a) => ({ pid: a.pid, runtime: a.runtime, launch: a.launch ?? "interactive",
      project: a.repo ?? (a.cwd ? basename(a.cwd) : undefined),
      elapsed_ms: a.started_at === undefined ? null : Math.max(0, this.now() - a.started_at),
      state: a.activity?.working ? "working" : "idle" })),
      model_servers: this.models, incomplete: !!(this.unexamined.size || this.unselected),
      unreported: this.unexamined.size + this.unselected };
  }

  start(): void {
    this.stopped = false;
    this.files.reopen();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.files.close();
  }

  /** Read-only: the agents this user is running right now, named as their hooks would name them, with activity. */
  async scan(): Promise<DiscoveredAgent[]> {
    return (await this.scanOnce()) ?? [];
  }

  /** A cwd in a directory whose sessions are not agents (claude-mem's observer sessions). */
  private nonAgentCwd(cwd: string): boolean {
    return this.nonAgentDirs.some((d) => cwd === d || cwd.startsWith(d.endsWith("/") ? d : d + "/"));
  }

  /**
   * The candidates of this scan: agent processes not run by a non-agent parent, at most maxPerRuntime per runtime.
   * AGENT-SEE-1: one agent per top-level runtime process: a relaunched child of the same runtime (Gemini, opencode) is
   * its parent's, and an ACP adapter counts only while it runs no agent process (that process is then the agent, marked
   * "acp"). Helpers (MCP servers, tools, `codex-code-mode-host`) are no runtime at all (agent-procs.ts).
   */
  private candidatesOf(mine: readonly ProcRow[]): Array<{ p: ProcRow; rt: AgentRuntime; kind: AgentKind }> {
    const byPid = new Map(mine.map((p) => [p.pid, p]));
    const kinds = new Map<number, AgentKind>();
    for (const p of mine) {
      // This daemon's own children (the orchestrator's Claude) announce themselves (PROTOCOL §8).
      if (p.ppid === process.pid) continue;
      const kind = classifyAgent(p.command, p.tty);
      if (kind) kinds.set(p.pid, kind);
    }
    const kids = new Map<number, number[]>();
    for (const p of mine) {
      const list = kids.get(p.ppid);
      if (list) list.push(p.pid); else kids.set(p.ppid, [p.pid]);
    }
    /** An agent process (not a host) below `pid`, within a few levels. */
    const runsAgent = (pid: number): boolean => {
      let level = kids.get(pid) ?? [];
      for (let depth = 0; depth < 4 && level.length; depth++) {
        if (level.some((k) => { const kk = kinds.get(k); return !!kk && !kk.host; })) return true;
        level = level.flatMap((k) => kids.get(k) ?? []).slice(0, 400);
      }
      return false;
    };
    const byRt = new Map<AgentRuntime, ProcRow[]>();
    const chosen = new Map<number, AgentKind>();
    for (const p of mine) {
      let kind = kinds.get(p.pid);
      if (!kind) continue;
      const rt = kind.runtime;
      const parent = byPid.get(p.ppid);
      if (parent && NON_AGENT_PARENT.test(parent.command)) continue;
      if (this.cache.get(`${p.pid}:${p.startedAt ?? 0}`)?.excluded) continue;
      const parentKind = kinds.get(p.ppid);
      if (parentKind && !parentKind.host && parentKind.runtime === rt && RELAUNCHING.has(rt)) continue;
      if (kind.host && runsAgent(p.pid)) continue;
      if (parentKind?.host) kind = { ...kind, launch: "acp" };
      chosen.set(p.pid, kind);
      byRt.set(rt, [...(byRt.get(rt) ?? []), p]);
    }
    this.truncated = new Set();
    this.unselected = 0;
    const kept = new Map<number, AgentRuntime>();
    this.agentCounts = [...byRt].flatMap(([name, list]) => name === "hermes" ? [] : [{ name, count: list.length }]);
    for (const [rt, list] of byRt) {
      if (list.length > this.maxPerRuntime) { this.truncated.add(wireRuntime(rt)); this.unselected += list.length - this.maxPerRuntime; }
      // Over the cap, the least recently examined go first (never examined: first of all, newest first), so the whole
      // population rotates through (Codex r4 #7); the rest keep their last status (keepAlive).
      const seenAt = (p: ProcRow) => this.cache.get(`${p.pid}:${p.startedAt ?? 0}`)?.examinedAt ?? 0;
      const picked = [...list].sort((a, b) => seenAt(a) - seenAt(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.pid - a.pid).slice(0, this.maxPerRuntime);
      for (const p of picked) kept.set(p.pid, rt);
    }
    return mine.flatMap((p) => { const rt = kept.get(p.pid); const kind = chosen.get(p.pid); return rt && kind ? [{ p, rt, kind }] : []; }); // in listing order
  }

  /** One scan; null when the process list could not be read (then nothing may change: Codex 5). */
  /** Picks up a changed collection policy: session-file caches (their activity lines) and cached titles start over. */
  private refreshPolicy(): void {
    this.hermesActivity = this.hermesActivityProfiles();
    const next = this.sharePolicy();
    if (next.prompts === this.share.prompts && next.activity === this.share.activity) { this.share = next; return; }
    this.share = next;
    this.files.policy(next.activity);
    for (const e of this.cache.values()) delete e.title;
  }

  private warnScan(kind: string, data: Record<string, unknown>): void {
    const at = this.now();
    const previous = this.scanWarnings.get(kind);
    if (previous && at - previous.at < SCAN_WARNING_INTERVAL_MS) {
      this.scanWarnings.set(kind, { ...previous, suppressed: previous.suppressed + 1 });
      return;
    }
    this.log.warn(kind, { ...data, suppressed: previous?.suppressed ?? 0 });
    this.scanWarnings.set(kind, { at, suppressed: 0 });
  }

  private markCensusStale(): void {
    // Once the counts are unknown and flagged there is nothing left to hold or expire. A census that never completed (ps failed
    // from the first scan, as after a restart on an overloaded machine) has no counts to hold: it is flagged at once, because
    // that machine's load is unknown, not zero.
    if (!this.core.agentProcesses && this.core.discoveryHealth?.stale) return;
    const wasStale = this.core.discoveryHealth?.stale;
    const expired = !this.core.agentProcesses || this.now() - this.censusAt >= CENSUS_MAX_AGE_MS;
    if (expired) this.core.agentProcesses = null;
    this.core.discoveryHealth = { incomplete: true,
      unreported: this.core.discoveryHealth?.unreported ?? 0, stale: true };
    if (!wasStale || expired) this.core.hub.nodesChanged();
  }

  private async scanOnce(onCensus?: () => void, active: () => boolean = () => true,
    onPartial?: (snapshot: () => { found: DiscoveredAgent[]; unexamined: Set<string> }) => void): Promise<DiscoveredAgent[] | null> {
    this.refreshPolicy();
    // The scan's wall-clock budget counts from its start (Codex p8 #5): the listing, environment reads, Kimi's session
    // lookup and the examinations all come out of it. Once the census exists, finish the bounded
    // current batch and publish its cards even when enrichment exceeds the soft budget.
    const deadline = Date.now() + this.scanBudgetMs;
    const capturedAt = this.now();
    const all = await readWithin(this.provider.list(), null, PROCESS_LIST_TIMEOUT_MS).catch(() => null);
    if (!active()) return null;
    if (!all || !all.length) return null; // `ps` itself is always running: an empty list is a failed one
    const now = this.now();
    // Local model servers are machine load, whoever runs them (ollama has its own user on Linux): names and counts only.
    this.models = modelServers(all.map((p) => p.command));
    const mine = all.filter((p) => p.uid === this.uid);
    // Hermes sessions and the processes that host hooked turns (gateway runs, `cron run|tick`, dashboard and serve backends) are
    // what hooked rows are matched against; only the sessions are agents (below).
    this.hermesCensus = { processes: mine.flatMap((p) => {
      const kind = hermesProcessOf(p.command, p.tty);
      return kind ? [{ pid: p.pid, profile: kind.profile, ...(p.startedAt == null ? {} : { startedAt: p.startedAt }) }] : [];
    }), capturedAt };
    this.codexHost = mine.some((p) => isCodexHost(p.command));
    this.minePids = new Set(mine.map((p) => p.pid));
    const candidates = this.candidatesOf(mine);
    // Counts come from the process table alone. Make them available to vv/views before any slower enrichment awaits.
    if (active()) onCensus?.();
    const running = new Set(mine.map((p) => `${p.pid}:${p.startedAt ?? 0}`));
    this.runningKeys = running;
    this.unexamined = new Set();
    this.youngUnnamed = new Set();
    // What is known about a process (excluded, when examined: the rotation's history) is kept while it runs, whether
    // or not this scan selects it, and forgotten when it exits (Codex r5 #2). Done here, from the process table alone: a
    // scan cut by its hard limit never reaches its end, and with every scan cut the cache of exited processes grew forever.
    for (const k of [...this.cache.keys()]) if (!running.has(k)) this.cache.delete(k);
    if (!candidates.length) {
      await this.files.retain(new Set(), deadline);
      return [];
    }
    const children = new Map<number, ProcRow[]>();
    for (const p of mine) {
      const list = children.get(p.ppid);
      if (list) list.push(p); else children.set(p.ppid, [p]);
    }
    const cpu = this.cpu.sample(mine, candidates.map(({ p }) => p), now);
    const usedFiles = new Set<string>();
    // A single process-table pass gives every selected process a card even if all slower lookups fail.
    const out = new Map<string, DiscoveredAgent>();
    for (const { p, rt, kind } of candidates) {
      const key = `${p.pid}:${p.startedAt ?? 0}`;
      const entry = this.cache.get(key) ?? {};
      this.cache.set(key, entry);
      const prior = entry.discovered;
      const busy = (cpu.get(p.pid) ?? 0) >= CPU_BUSY_RATIO;
      // The short-run ghost gate applies only to cards; the process was already counted in onCensus above.
      if (this.unnamedMinAgeMs > 0 && !prior && p.startedAt !== null && now - p.startedAt < this.unnamedMinAgeMs) {
        this.youngUnnamed.add(wireRuntime(rt));
        continue;
      }
      out.set(key, {
        ...(prior ?? { agent: pidName(rt, p.pid), runtime: rt, pid: p.pid }), key,
        ...(kind.launch ? { launch: kind.launch } : {}), ...(p.startedAt ? { started_at: p.startedAt } : {}),
        activity: busy || !prior ? { working: true, last_active_at: now, step: DETAILS_PENDING_ACTIVITY } : prior.activity,
      });
    }
    const completed = new Set<string>();
    onPartial?.(() => ({
      found: candidates.flatMap(({ p }) => { const row = out.get(`${p.pid}:${p.startedAt ?? 0}`); return row ? [row] : []; }),
      unexamined: new Set(candidates.map(({ p }) => `${p.pid}:${p.startedAt ?? 0}`).filter((key) => !completed.has(key))),
    }));
    const examine = async ({ p, rt, kind }: { p: ProcRow; rt: AgentRuntime; kind: AgentKind },
      env: Map<number, Record<string, string>>, loginEnv: Map<number, Record<string, string>>,
      kimiEnv: Map<number, Record<string, string>>, tokenEnv: Map<number, string[]>): Promise<void> => {
      const key = `${p.pid}:${p.startedAt ?? 0}`;
      const entry = this.cache.get(key) as Entry;
      entry.examinedAt = Date.now();
      // The cwd is looked up again every CWD_REFRESH_MS (a session may cd); repo and branch every scan (a checkout
      // changes the branch, and with it the branch's task key: Codex r3 #6). repoContext only stats and reads HEAD.
      if (!entry.ctx || now - (entry.cwdAt ?? 0) >= CWD_REFRESH_MS) {
        const cwd = await readWithin(this.provider.cwd(p.pid), undefined).catch(() => undefined);
        if (!active()) return;
        if (cwd) { entry.cwdAbs = cwd; entry.cwdAt = now; }
      }
      if (entry.cwdAbs) {
        const ctx = await this.files.repoContext(entry.cwdAbs, deadline);
        if (!active()) return;
        if (ctx) entry.ctx = ctx;
      }
      if (entry.cwdAbs && this.nonAgentCwd(entry.cwdAbs)) { entry.excluded = true; out.delete(key); return; }
      const login = loginDirOf(rt, loginEnv.get(p.pid));
      const newestKid = [...(children.get(p.pid) ?? [])].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.pid - a.pid)
        .map((k) => env.get(k.pid)).find((e) => e && (e.CLAUDE_CODE_SESSION_ID || e.KIMI_SESSION_ID || e.GROK_SESSION_ID || e.WALKIE_AGENT));
      const session = await this.sessionOf(p, rt, newestKid, entry, login, deadline, active);
      if (!active()) return;
      const agentEnv: NodeJS.ProcessEnv = {
        ...((loginEnv.get(p.pid)?.WALKIE_AGENT ?? kimiEnv.get(p.pid)?.WALKIE_AGENT ?? newestKid?.WALKIE_AGENT)
          ? { WALKIE_AGENT: loginEnv.get(p.pid)?.WALKIE_AGENT ?? kimiEnv.get(p.pid)?.WALKIE_AGENT ?? newestKid?.WALKIE_AGENT } : {}),
        ...(session && rt === "claude-code" ? { CLAUDE_CODE_SESSION_ID: session } : {}),
        ...(session && rt === "codex" ? { CODEX_THREAD_ID: session } : {}),
        ...(session && rt === "kimi" ? { KIMI_SESSION_ID: session } : {}),
        ...(session && rt === "grok" ? { GROK_SESSION_ID: session } : {}),
      };
      const hermesProfile = rt === "hermes" ? hermesProfileOf(p.command) : null;
      const agent = rt === "hermes" ? (hermesProfile ? `hermes-${hermesProfile}` : pidName(rt, p.pid))
        : resolveAgentName(agentEnv) ?? pidName(rt, p.pid);
      // A seat running as this user (`--same-user`) is published by its host daemon, never as a discovered session
      // (Opus seats r9 LOW): its WALKIE_AGENT, or the runtime's own, names a seat.
      // The daemon's own names (board steward, fleet desk) are never a discovered session (fix round 2, Opus LOW).
      if (RESERVED_AGENTS.has(agent) || agent === STEWARD_AGENT || agent === FLEET_AGENT || isSeatAgent(agent) || isSeatAgent(loginEnv.get(p.pid)?.WALKIE_AGENT) || isSeatAgent(kimiEnv.get(p.pid)?.WALKIE_AGENT)) { out.delete(key); return; }
      if (this.unnamedMinAgeMs > 0 && agent === pidName(rt, p.pid) && p.startedAt !== null && now - p.startedAt < this.unnamedMinAgeMs && !this.live.has(agent)) {
        this.youngUnnamed.add(wireRuntime(rt));
        out.delete(key);
        return;
      }
      const ratio = cpu.get(p.pid);
      // CPU (only evidence for a session without a session file) counts after two busy readings in a row (Opus r3 #6).
      const busy = ratio !== null && ratio !== undefined && ratio >= CPU_BUSY_RATIO;
      entry.busyScans = busy ? (entry.busyScans ?? 0) + 1 : 0;
      if (entry.busyScans >= 2) entry.lastBusyAt = now;
      const activity = await this.activityOf(p, rt, session, login, entry, now, usedFiles, deadline, kind.launch === "headless", active);
      if (!active()) return;
      const discovered: DiscoveredAgent = {
        agent, runtime: rt, pid: p.pid, key, ...(kind.launch ? { launch: kind.launch } : {}), ...(session ? { session: session.slice(0, 80) } : {}),
        ...(p.startedAt ? { started_at: p.startedAt } : {}),
        ...(entry.ctx ? { repo: (entry.ctx.repo ?? basename(entry.cwdAbs ?? "")).slice(0, 120) } : {}),
        ...(entry.ctx?.branch ? { branch: entry.ctx.branch.slice(0, 120) } : {}),
        ...(entry.ctx?.cwd ? { cwd: entry.ctx.cwd.slice(0, 300) } : {}),
        ...(login ? { login_dir: login } : {}),
        ...(wrappedAccount(p, loginEnv.get(p.pid)) ? { account: wrappedAccount(p, loginEnv.get(p.pid)) }
          : tokenLogin(rt, tokenEnv.get(p.pid)) ? { token_login: true as const } : {}),
        activity,
      };
      entry.discovered = discovered;
      out.set(key, discovered);
      completed.add(key);
    };
    // Bounded concurrency under an overall budget (Codex r2 #12): what isn't examined in time keeps its last state.
    // The least recently examined first: a budget that runs out never starves the same sessions (Codex r3 #4).
    const lastSeen = (c: { p: ProcRow }) => this.cache.get(`${c.p.pid}:${c.p.startedAt ?? 0}`)?.examinedAt ?? 0;
    const queue = [...candidates].sort((x, y) => lastSeen(x) - lastSeen(y));
    // A scan starts at least MIN_EXAMINED sessions under a soft budget (Codex r4 #7).
    let started = 0;
    while (active() && queue.length && (Date.now() < deadline || started < MIN_EXAMINED)) {
      const batch = queue.splice(0, Math.min(this.concurrency, queue.length));
      started += batch.length;
      for (const { p } of batch) (this.cache.get(`${p.pid}:${p.startedAt ?? 0}`) as Entry).examinedAt = Date.now();
      try {
        const kids = batch.flatMap(({ p }) => (children.get(p.pid) ?? []).map((k) => k.pid));
        const loginPids = batch.filter(({ rt }) => rt === "claude-code" || rt === "codex").map(({ p }) => p.pid);
        const kimiPids = batch.filter(({ rt }) => rt === "kimi").map(({ p }) => p.pid);
        const [env, loginEnv, kimiEnv, tokenEnv] = await Promise.all([
          kids.length ? readWithin(this.provider.envVars(kids, SESSION_VARS), new Map<number, Record<string, string>>()) : Promise.resolve(new Map<number, Record<string, string>>()),
          loginPids.length ? readWithin(this.provider.envVars(loginPids, [...LOGIN_VARS, "WALKIE_AGENT"]), new Map<number, Record<string, string>>()) : Promise.resolve(new Map<number, Record<string, string>>()),
          kimiPids.length ? readWithin(this.provider.envVars(kimiPids, KIMI_VARS), new Map<number, Record<string, string>>()) : Promise.resolve(new Map<number, Record<string, string>>()),
          this.onScan ? readWithin(envNamesOf(this.provider, loginPids, ALL_TOKEN_VARS), new Map<number, string[]>()) : Promise.resolve(new Map<number, string[]>()),
        ]);
        if (!active()) return null;
        await this.bindKimi(batch, kimiEnv, now, new ScanBudget(deadline, KIMI_OPS_PER_SCAN), active);
        if (!active()) return null;
        await Promise.all(batch.map((c) => examine(c, env, loginEnv, kimiEnv, tokenEnv)
          .catch((err) => this.warnScan("agent_discovery_examine_failed", { err: (err as Error).message }))));
        if (!active()) return null;
      } catch (err) {
        this.warnScan("agent_discovery_examine_failed", { err: (err as Error).message });
      }
    }
    if (!active()) return null;
    this.unexamined = new Set(queue.map(({ p }) => `${p.pid}:${p.startedAt ?? 0}`));
    for (const { p } of queue) {
      const key = `${p.pid}:${p.startedAt ?? 0}`;
      const f = this.cache.get(key)?.file;
      if (f) usedFiles.add(f);
    }
    if (queue.length) this.warnScan("agent_discovery_budget_exhausted", { unexamined: queue.length, budget_ms: this.scanBudgetMs });
    await this.files.retain(usedFiles, deadline);
    return candidates.flatMap(({ p }) => {
      const a = out.get(`${p.pid}:${p.startedAt ?? 0}`);
      return a ? [a] : [];
    });
  }

  /**
   * Binds running Kimi processes to their sessions on disk (kimi-sessions.ts), per directory: every unbound process of
   * one directory and Kimi home is matched in one pass over that bucket, listed once, under the scan's budget. A process
   * whose working directory isn't known yet has it looked up here (bounded by the same deadline). Unambiguous pairs
   * only; a bound process keeps its session for its life.
   */
  private async bindKimi(candidates: ReadonlyArray<{ p: ProcRow; rt: AgentRuntime }>, kimiEnv: Map<number, Record<string, string>>, now: number, budget: ScanBudget, active: () => boolean): Promise<void> {
    const kimi = candidates.filter(({ rt }) => rt === "kimi");
    if (!kimi.length) return;
    const taken = new Set<string>();
    const groups = new Map<string, { home: string; cwd: string; procs: KimiProc[]; entries: Map<string, Entry>; due: boolean }>();
    for (const { p } of kimi) {
      const key = `${p.pid}:${p.startedAt ?? 0}`;
      const entry = this.cache.get(key) ?? {};
      this.cache.set(key, entry);
      if (entry.thread) { taken.add(entry.thread); continue; }
      if (!entry.cwdAbs) {
        if (budget.spent) continue;
        const cwd = await readWithin(this.provider.cwd(p.pid), undefined).catch(() => undefined);
        if (!active()) return;
        if (cwd) { entry.cwdAbs = cwd; entry.cwdAt = now; }
      }
      if (!entry.cwdAbs) continue;
      const home = kimiHomeOf(kimiEnv.get(p.pid));
      const gk = `${home}\n${entry.cwdAbs}`;
      // Every unbound process of the directory takes part in its matching (a sibling tried recently still competes for
      // the sessions it could own); the bucket is read only when one of them is due for a retry.
      const g = groups.get(gk) ?? { home, cwd: entry.cwdAbs, procs: [], entries: new Map<string, Entry>(), due: false };
      g.procs.push({ key, startedAt: p.startedAt });
      g.entries.set(key, entry);
      g.due ||= now - (entry.kimiAt ?? 0) >= KIMI_RETRY_MS;
      groups.set(gk, g);
    }
    const uid = process.getuid?.() ?? null;
    for (const g of groups.values()) {
      if (!g.due) continue;
      const sessions = await this.files.listKimiSessions(g.home, g.cwd, uid, budget.deadlineAt, KIMI_OPS_PER_SCAN);
      if (!active()) return;
      if (sessions === null) { this.warnScan("agent_discovery_kimi_budget", { processes: g.procs.length }); continue; } // next scan
      for (const e of g.entries.values()) e.kimiAt = now;
      for (const [key, s] of assignKimiSessions(g.procs, sessions, taken)) {
        const entry = g.entries.get(key);
        if (!entry || !await this.files.containedWire(s, budget.deadlineAt)) continue;
        if (!active()) return;
        taken.add(s.id);
        entry.thread = s.id;
        entry.kimiPath = s.file;
        entry.kimiRoot = s.root;
      }
    }
  }

  /** The session's file (transcript / rollout) and CPU, judged (activity.ts), with the idle hysteresis. */
  private async activityOf(p: ProcRow, rt: AgentRuntime, session: string | undefined, login: string | undefined, entry: Entry, now: number, used: Set<string>, deadline: number, headless = false, active: () => boolean = () => true): Promise<SeenActivity> {
    let kind: FileKind = "other";
    if (rt === "claude-code" && session) {
      kind = "claude";
      const file = await this.files.claudeTranscript(login ?? this.claudeDir, entry.cwdAbs, session, now, deadline);
      if (!active()) return entry.seen ?? { working: false };
      entry.file = file;
    } else if (rt === "codex") {
      kind = "codex";
    } else if (rt === "kimi") {
      // The session's wire.jsonl, found on disk by its directory and start (kimi-sessions.ts; Kimi holds no file open),
      // re-validated every scan (this user's regular file, inside the sessions directory).
      if (entry.kimiPath && entry.kimiRoot) {
        const file = await this.files.kimiFile(entry.kimiPath, entry.kimiRoot, deadline);
        if (!active()) return entry.seen ?? { working: false };
        entry.file = file;
        if (entry.file) kind = "kimi";
      } else if (entry.file === undefined) {
        // An older Kimi that holds its session file open.
        // null: the listing got no answer (timed out, failed): leave the file unknown so the next scan looks again.
        const open = await readWithin<string[] | null>(this.provider.openFiles(p.pid), null).catch((): null => null);
        if (!active()) return entry.seen ?? { working: false };
        if (open) {
          const files = await Promise.all(open.map((f) => this.files.openFile(f, deadline)));
          if (!active()) return entry.seen ?? { working: false };
          const found = files.find((f): f is string => typeof f === "string");
          // A worker that did not answer is not an answer: leave the file unknown so the next scan looks again.
          if (found || !files.includes(LOOKUP_FAILED)) entry.file = found ?? null;
        }
      }
    }
    const path = entry.file ?? null;
    const read = path ? await this.files.readAsync(path, kind, entry.cwdAbs ?? "", deadline) : null;
    if (!active()) return entry.seen ?? { working: false };
    if (path && read) used.add(path);
    const info: TailInfo = read?.info ?? { midTurn: false };
    // The file's last TURN write: a slash command, a meta or a bookkeeping record written after it doesn't count.
    let fileAt: number | null = null;
    if (read) {
      if (info.unknown || info.newestIsTurn !== false) fileAt = read.mtime;
      else fileAt = info.lastTurnAt !== undefined ? Math.min(info.lastTurnAt, read.mtime) : entry.fileAt ?? null;
      if (kind === "claude" && path) {
        const sub = await this.files.subagentsMtime(path, deadline);
        if (!active()) return entry.seen ?? { working: false };
        if (sub !== null && sub > (fileAt ?? 0)) fileAt = sub;
      }
    }
    entry.fileAt = fileAt;
    // A tool still running (Codex r2 #6 / r3 #3): a tool call with no result after it in the transcript / rollout, and
    // the session process alive (it is: it is being scanned). A long MCP call or a poll of an older command writes
    // nothing for minutes and starts no process; it is still work.
    // A session file read before that can't be read now (a transient failure, Codex p8 #4): the last verdict stands, for
    // at most READ_FAIL_HOLD_MS; never a change of state on missing evidence.
    if (!read && entry.seen && entry.readAt !== undefined && now - entry.readAt < READ_FAIL_HOLD_MS) return entry.seen;
    if (read) entry.readAt = now;
    const pending = !!info.toolRunning && !info.unknown && read !== null;
    const judged = judge(now, fileAt, info.midTurn, entry.lastBusyAt ?? null, !!read);
    // AGENT-SEE-1 liveness (Codex p8 #6): a headless run (`-p`, `exec`, no terminal) exists only to do its one job, so
    // while it runs and has no session file to judge by, it is working. An interactive session without one is judged
    // by its CPU (MISSION-1): it may sit at its prompt, waiting for its person. A hook's own state still wins (decide).
    const live = headless && !read && entry.readAt === undefined;
    const v = pending || live ? { ...judged, working: true } : judged;
    // Hysteresis (Opus 8): working turns idle only after IDLE_SCANS idle scans and IDLE_HOLD_MS without activity.
    entry.idleScans = v.working ? 0 : (entry.idleScans ?? 0) + 1;
    const quiet = v.lastActiveAt === null ? Infinity : now - v.lastActiveAt;
    const holding = !v.working && entry.reported === true && (entry.idleScans < IDLE_SCANS || quiet < IDLE_HOLD_MS);
    const working = v.working || holding;
    entry.reported = working;
    if (this.share.prompts) {
      const title = titleOf(info.prompt) ?? (entry.title === undefined && path ? titleOf(await this.files.firstPrompt(path, kind, deadline)) : undefined);
      if (!active()) return entry.seen ?? { working: false };
      if (title) entry.title = title;
      else if (entry.title === undefined) entry.title = "";
    }
    const seen: SeenActivity = {
      working,
      ...(v.lastActiveAt !== null ? { last_active_at: Math.round(v.lastActiveAt) } : {}),
      ...(fileAt !== null ? { file_active_at: Math.round(fileAt) } : {}),
      ...(read ? { file: true as const } : {}),
      ...(info.toolRunning ? { tool_running: true as const } : {}),
      ...(pending ? { pending: true as const } : {}),
      ...(info.unknown ? { unknown: true as const } : {}),
      ...(info.step ? { step: info.step } : {}),
      ...(info.model ? { model: info.model } : {}),
      ...(this.share.prompts && entry.title ? { title: entry.title } : {}),
    };
    entry.seen = seen;
    return seen;
  }

  private async sessionOf(p: ProcRow, rt: AgentRuntime, kid: Record<string, string> | undefined, entry: Entry, login: string | undefined,
    deadline: number, active: () => boolean): Promise<string | undefined> {
    const valid = (s: string | undefined) => (s && SESSION_ID_RE.test(s) ? s : undefined);
    if (rt === "claude-code") {
      // Claude's own record lives in the session's config directory (its CLAUDE_CONFIG_DIR), not the daemon's (Opus 5).
      const configDir = login ?? this.claudeDir;
      const s = this.provider instanceof SystemProcessProvider
        ? await this.files.claudeSession(p.pid, configDir, deadline)
        : await readWithin(this.providerClaudeSession(p.pid, configDir), undefined).catch(() => undefined);
      // A record left by an earlier process with the same pid started before this one.
      if (s && valid(s.sessionId) && (s.startedAt === undefined || p.startedAt === null || s.startedAt >= p.startedAt - 5_000)) return s.sessionId;
      return valid(kid?.CLAUDE_CODE_SESSION_ID);
    }
    if (rt === "kimi") return valid(kid?.KIMI_SESSION_ID) ?? entry.thread;
    if (rt === "grok") return valid(kid?.GROK_SESSION_ID);
    if (rt === "gemini" || rt === "opencode" || rt === "hermes") return undefined;
    if (!entry.thread || !entry.file) {
      if (entry.fileRetryAt !== undefined && this.now() < entry.fileRetryAt) return entry.thread;
      // The backoff below is for a file the lookup confirmed missing. A lookup that got no answer (the listing timed out or
      // failed, the worker is down) says nothing about the file: it is tried again on the next scan, and the delay stays.
      let rollout = entry.rollout;
      if (!rollout) {
        const open = await readWithin<string[] | null>(this.provider.openFiles(p.pid), null).catch((): null => null);
        if (!active()) return undefined;
        if (open === null) return entry.thread;
        rollout = open.find((f) => ROLLOUT_RE.test(f));
        if (rollout) { entry.thread = ROLLOUT_RE.exec(rollout)?.[1]; entry.rollout = rollout; }
      }
      if (rollout) {
        const file = await this.files.openFile(rollout, deadline);
        if (!active()) return undefined;
        if (file === LOOKUP_FAILED) return entry.thread;
        entry.file = file;
        if (!file) delete entry.rollout; // missing: the next lookup lists the open files again
      }
      if (entry.file) {
        delete entry.fileRetryAt;
        delete entry.fileRetryDelayMs;
      } else {
        const delay = entry.fileRetryDelayMs ?? CODEX_FILE_RETRY_BASE_MS;
        entry.fileRetryAt = this.now() + delay;
        entry.fileRetryDelayMs = Math.min(delay * 2, CODEX_FILE_RETRY_MAX_MS);
      }
    }
    return entry.thread;
  }

  private providerClaudeSession(pid: number, configDir: string): Promise<{ sessionId: string; startedAt?: number } | undefined> {
    const key = `${configDir}\n${pid}`;
    const existing = this.providerSessionReads.get(key);
    if (existing) return existing;
    const read = this.provider.claudeSession(pid, configDir);
    this.providerSessionReads.set(key, read);
    void read.then(() => { if (this.providerSessionReads.get(key) === read) this.providerSessionReads.delete(key); },
      () => { if (this.providerSessionReads.get(key) === read) this.providerSessionReads.delete(key); });
    return read;
  }

  /** One pass: scan, post statuses, mark exited sessions offline. Never throws. */
  /**
   * The agent names of the sessions running now, from the last complete scan; null when that isn't known (no scan
   * yet, or the last one didn't examine or name every session). The hook-state prune uses it (Opus mission-sub r2).
   */
  runningAgents(): ReadonlySet<string> | null {
    return this.runningNames;
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    let abandoned = false;
    let partial: (() => { found: DiscoveredAgent[]; unexamined: Set<string> }) | undefined;
    const deadline = Date.now() + this.scanBudgetMs;
    // Keep a distinct hard limit: tiny test/overload budgets still allow the minimum
    // examination batch to make progress, while a stalled batch cannot block later ticks.
    const hardBudgetMs = Math.max(Math.ceil(this.scanBudgetMs * 1.5), this.scanBudgetMs < 10 ? 200 : 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const overdue = new Promise<DiscoveredAgent[] | null>((resolve) => {
      timer = setTimeout(() => {
        abandoned = true;
        if (!partial) { resolve(null); return; }
        const snapshot = partial();
        this.unexamined = snapshot.unexamined;
        if (snapshot.unexamined.size) this.warnScan("agent_discovery_budget_exhausted",
          { unexamined: snapshot.unexamined.size, budget_ms: this.scanBudgetMs });
        resolve(snapshot.found);
      }, hardBudgetMs);
    });
    try {
      const scan = this.scanOnce(() => {
        if (this.stopped) return;
        const changed = JSON.stringify(this.core.agentProcesses) !== JSON.stringify(this.agentCounts)
          || JSON.stringify(this.core.modelServers) !== JSON.stringify(this.models.length ? this.models : null);
        this.core.agentProcesses = this.agentCounts;
        this.censusAt = this.now();
        this.core.modelServers = this.models.length ? this.models : null;
        if (changed) this.core.hub.nodesChanged(); // the hub debounces node frames for open streams
      }, () => !abandoned && !this.stopped, (snapshot) => { partial = snapshot; });
      const found = await Promise.race([scan, overdue]);
      if (this.stopped) return;
      if (abandoned && found === null) {
        this.markCensusStale();
        this.runningNames = null;
        this.warnScan("agent_discovery_scan_abandoned", { budget_ms: this.scanBudgetMs });
        return;
      }
      if (found === null) {
        this.markCensusStale();
        this.runningNames = null;
        this.warnScan("agent_discovery_scan_failed", {});
        return;
      }
      const unreported = this.unexamined.size + this.unselected;
      const wasStale = this.core.discoveryHealth?.stale;
      this.core.discoveryHealth = unreported ? { incomplete: true, unreported } : null;
      if (wasStale) this.core.hub.nodesChanged();
      this.core.modelServers = this.models.length ? this.models : null;
      this.core.agentProcesses = this.agentCounts;
      const agents = [...new Set([...found.map((agent) => agent.agent),
        ...this.core.store.agents().filter((row) => row.node === this.core.nodeId).map((row) => row.agent)])];
      const states = await Promise.race([this.files.hookStates(this.home, agents, deadline), overdue.then(() => null)]);
      if (this.stopped) return;
      if (states !== null) this.hookStates = states;
      trackOp("agent_discovery", () => this.apply(found));
      // The accounts service knows the logins of Claude, Codex, Kimi and Grok only.
      try { this.onScan?.(found.filter(isAccountSession)); } catch (err) { this.log.warn("agent_discovery_listener_failed", { err: (err as Error).message }); }
    } catch (err) {
      this.log.warn("agent_discovery_failed", { err: (err as Error).message });
    } finally {
      if (timer) clearTimeout(timer);
      this.running = false;
    }
  }

  // ---- posting --------------------------------------------------------------------------------------------

  private ownedMap(): Map<string, Owned> {
    if (this.owned) return this.owned;
    const map = new Map<string, Owned>();
    try {
      const raw = this.core.store.getMeta(OWNED_META);
      for (const [k, v] of Object.entries(raw ? (JSON.parse(raw) as Record<string, Owned>) : {})) {
        if (v && typeof v.state === "string") map.set(k, v);
      }
    } catch { /* unreadable: start empty */ }
    this.owned = map;
    return map;
  }

  /** Discovery posted this agent's current status (by event id; or, still rate-limited, by its state + activity). */
  private isOwned(agent: string, row: { event_id: string }, prev: Status): boolean {
    if (prev.activity === LEGACY_DISCOVERED_ACTIVITY) return true;
    const o = this.ownedMap().get(agent);
    if (!o) return false;
    if (o.id) return o.id === row.event_id;
    if (o.state === prev.state && o.activity === prev.activity) {
      this.ownedMap().set(agent, { ...o, id: row.event_id });
      this.ownedDirty = true;
      return true;
    }
    return false;
  }

  /** Posts statuses for a scan's result (exported for tests through tick()). */
  private apply(scanned: readonly DiscoveredAgent[]): void {
    const core = this.core;
    if (!core.teamId || !core.me()) return;
    // The scan awaited the process list, the environments and the hook states since refreshPolicy() read the allow list. A profile listed
    // (or taken off) in the meantime is judged by the list as it is now, in every Hermes card this pass posts and in its scrub.
    this.hermesActivity = this.hermesActivityProfiles();
    const now = this.now();
    const found = this.adopt(scanned, now);
    const next = new Map<string, Set<string>>();
    const byAgent = new Map<string, DiscoveredAgent[]>();
    for (const a of found) {
      next.set(a.agent, (next.get(a.agent) ?? new Set()).add(a.key ?? `${a.pid}:${a.started_at ?? 0}`));
      byAgent.set(a.agent, [...(byAgent.get(a.agent) ?? []), a]);
    }
    for (const [name, list] of byAgent) {
      const a = merge(list);
      this.core.noteLocalCwd(name, a.cwd);
      this.decide(name, a, now);
    }
    // Not in this scan: exited (offline right away, whoever posted its status) only when its process is gone. A
    // process still running that wasn't reported (over the per-runtime cap, or not examined within the scan's budget)
    // keeps its agent and state (Codex r2 #8 / #12).
    for (const [name, keys] of this.live) {
      if (next.has(name)) continue;
      if ([...keys].some((k) => this.runningKeys.has(k) && ![...next.values()].some((v) => v.has(k)))) { next.set(name, keys); this.keepAlive(name, now); }
      // A card whose own process is gone stays while a hooked working session of its profile is still live under the
      // census rule that retires rows (hermes-status.ts): a hook after this scan began, or, until ten minutes pass since
      // the last hook, a Hermes process that names the profile or names none.
      else if (name.startsWith("hermes-") && hermesProfileLive(core.store, name.slice(7), this.hermesCensus.processes,
        this.hermesCensus.capturedAt)) { next.set(name, keys); this.keepAlive(name, now); }
      else this.markOffline(name, true, renamedPlaceholder(name, keys, next) ? now : undefined);
    }
    this.live = next;
    try {
      // The sweep ends what the census says is over: ended rows past their ten minutes that no live process could own (a session
      // at its prompt hooks no more, and only the census knows it is still there), and working rows whose process is gone. The
      // ended rows go first, so that a row retired by this sweep stays one scan more: the marker that its session ended, which
      // a stale duplicate hook cannot overwrite. A profile that lost a working session or an ended row shows what its remaining
      // rows say (idle while a session has not ended), offline only when none is left: the computation a hook gets. Once both have
      // run the sweep says so (noteHermesCensus): while it keeps doing that, a hook ends no row by age; where it does not, one does.
      const { processes, capturedAt } = this.hermesCensus;
      const purged = purgeEndedHermesSessions(core.store, processes, capturedAt);
      const retired = offlineExitedHermesSessions(core.store, processes, capturedAt);
      noteHermesCensus(core.store, capturedAt);
      for (const profile of new Set([...retired, ...purged])) {
        const card = shownCard(hermesProfileStatus(core.store, profile), this.hermesActivity);
        core.statuses.submit(card.body.agent, card.body, card.provenance);
      }
      scrubHermesActivity(core, this.hermesActivity); // the daemon also does this on a timer of its own, whether or not discovery runs (hermes-scrub.ts)
    } catch (err) {
      this.log.warn("hermes_session_sweep_failed", { err: (err as Error).message });
    }
    // Complete only when every session was examined and named: then "not in it" means not running.
    const complete = !this.unexamined.size && !this.truncated.size && !found.some((a) => a.agent === pidName(a.runtime, a.pid));
    this.runningNames = complete ? new Set(next.keys()) : null;
    this.sweep(found, now);
    this.saveOwned();
  }

  /**
   * A session discovery can't name (no session id: `claude-pid<N>`) takes over a hook / MCP card of this machine with
   * the same runtime and working directory that no running session claims: one card, not a ghost beside it (Opus 5).
   */
  private adopt(found: readonly DiscoveredAgent[], now: number): DiscoveredAgent[] {
    const key = (a: DiscoveredAgent) => `${a.pid}:${a.started_at ?? 0}`;
    const unnamed = found.filter((a) => a.agent === pidName(a.runtime, a.pid));
    const adopted = this.adoptedByProcess();
    // A takeover lasts as long as its process runs (Codex p8 #2): kept through a scan that didn't examine or report
    // it (budget, cap) and across restarts (persisted); dropped once the process is gone from a successful listing.
    for (const k of [...adopted.keys()]) if (!this.runningKeys.has(k)) { adopted.delete(k); this.adoptedDirty = true; }
    const unnamedKeys = new Set(unnamed.map(key));
    for (const k of [...this.provisional.keys()]) if (!unnamedKeys.has(k)) this.provisional.delete(k);
    if (!unnamed.length) { this.saveAdopted(); return [...found]; }
    const claimed = new Set(found.map((a) => a.agent)); // named sessions' cards are theirs
    const cards = this.core.store.agents().flatMap((row) => {
      if (row.node !== this.core.nodeId || claimed.has(row.agent)) return [];
      const prev = agentStatus(row) as Status; // parsed once per row (agent-table.ts); only read here
      if (now - observedAt(prev, row.ts) >= IDLE_ARCHIVE_MS) return [];
      // The card's directory as its writer reported it to this daemon (kept locally; cwd is not published by default).
      const cwd = this.core.localCwds?.get(row.agent) ?? prev.cwd;
      // A sub-agent's card (WALKIE-MISSION-SUB-1) is its session's child, never a process's to take over.
      if (prev.state === "offline" || prev.parent || !cwd || (this.isOwned(row.agent, row, prev) && ![...this.provisional.values()].includes(row.agent))) return [];
      return [{ agent: row.agent, ts: row.ts, runtime: prev.runtime === "other" ? prev.runtime_name ?? "other" : prev.runtime, cwd }];
    }).sort((x, y) => y.ts - x.ts);
    const taken = new Set<string>(adopted.values());
    const replacements = new Map<string, DiscoveredAgent>();
    // Known directories claim their matching cards before provisional, no-directory reservations.
    for (const a of [...unnamed].sort((x, y) => Number(!!y.cwd) - Number(!!x.cwd))) {
      // Once taken over, the card stays this process's (its status is discovery's own from then on).
      const kept = adopted.get(key(a));
      if (kept && !claimed.has(kept)) { replacements.set(key(a), { ...a, agent: kept }); continue; }
      if (kept) { adopted.delete(key(a)); this.adoptedDirty = true; } // a session now reported under that name owns the card
      // Same directory first; else one inside the other (the session cd'd into a subdirectory, Opus r2 #4).
      const mine = cards.filter((c) => !taken.has(c.agent) && c.runtime === (runtimeName(a.runtime) ?? a.runtime));
      const card = a.cwd ? mine.find((c) => c.cwd === a.cwd) ?? mine.find((c) => sameTree(c.cwd, a.cwd as string))
        : mine.find((c) => c.agent === this.provisional.get(key(a))) ?? mine[0];
      if (a.cwd) this.provisional.delete(key(a));
      if (!card) continue;
      taken.add(card.agent);
      if (a.cwd) { adopted.set(key(a), card.agent); this.adoptedDirty = true; }
      else this.provisional.set(key(a), card.agent);
      replacements.set(key(a), { ...a, agent: card.agent });
    }
    this.saveAdopted();
    return found.map((a) => replacements.get(key(a)) ?? a);
  }

  /** Takeovers by process (pid:start → the card's agent), from the store (persisted across restarts). */
  private adoptedByProcess(): Map<string, string> {
    if (this.adoptedMap) return this.adoptedMap;
    const map = new Map<string, string>();
    try {
      const raw = this.core.store.getMeta(ADOPTED_META);
      for (const [k, v] of Object.entries(raw ? (JSON.parse(raw) as Record<string, unknown>) : {})) {
        if (/^\d+:\d+$/.test(k) && typeof v === "string" && /^[a-z0-9][a-z0-9._-]{0,47}$/.test(v)) map.set(k, v);
      }
    } catch { /* unreadable: start empty */ }
    this.adoptedMap = map;
    return map;
  }

  private saveAdopted(): void {
    if (!this.adoptedDirty || !this.adoptedMap) return;
    this.adoptedDirty = false;
    const entries = [...this.adoptedMap].slice(-OWNED_MAX);
    try { this.core.store.setMeta(ADOPTED_META, JSON.stringify(Object.fromEntries(entries))); } catch (err) {
      this.log.warn("agent_discovery_adopted_save_failed", { err: (err as Error).message });
    }
  }

  /**
   * A live agent this scan did not examine (over the cap, or out of budget): its last status is re-sent unchanged
   * when it would otherwise turn stale, so a running agent never renders offline (Codex r3 #4). Liveness only: the
   * state is not re-judged.
   */
  private keepAlive(name: string, now: number): void {
    const row = this.core.store.agent(this.core.nodeId, name);
    if (!row) return;
    const prev = JSON.parse(row.body) as Status;
    if (prev.state === "idle" || prev.state === "offline" || now - observedAt(prev, row.ts) < HEARTBEAT_MS) return;
    // Freshness only: whoever held the status keeps holding it (Codex r4 #5).
    this.post(name, prev, false, { own: this.isOwned(name, row, prev) });
  }

  /** One running agent: post its state when it changed, keeping hooks' and set_status's fresher word. */
  private decide(name: string, a: DiscoveredAgent, now: number): void {
    const row = this.core.store.agent(this.core.nodeId, name);
    const prev = row ? (JSON.parse(row.body) as Status) : null;
    const act = a.activity ?? { working: false };
    const state: "working" | "idle" = act.working ? "working" : "idle";
    const seen = act.last_active_at ?? 0;
    // When the current status was observed (a re-signed copy keeps its original time: Opus r4 #1).
    const rts = row && prev ? observedAt(prev, row.ts) : 0;
    if (!row || !prev) {
      // Our own status was deleted by the archive's upkeep: an unchanged idle session doesn't come back as new.
      if (state === "idle" && this.ownedMap().get(name)?.state === "idle") return;
      this.post(name, this.ownBody(a, null, state), !prev);
      return;
    }
    if (this.isOwned(name, row, prev)) {
      const due = now - rts >= HEARTBEAT_MS || (!!act.step && act.step !== prev.activity && now - rts >= STEP_MIN_MS);
      if (prev.state !== state || (state === "working" && due) || prev.activity === LEGACY_DISCOVERED_ACTIVITY) this.post(name, this.ownBody(a, prev, state));
      return;
    }
    // Another source's status (hooks, MCP, set_status): replaced only by evidence newer than it.
    if (prev.state === "offline") {
      if ((state === "working" && seen > rts) || now - rts > DISCOVERY_STALE_MS) this.post(name, this.ownBody(a, prev, state));
      return;
    }
    // Waiting / stuck and the session is still there: kept fresh (it would render offline after 30 min).
    if ((prev.state === "waiting" || prev.state === "blocked") && now - rts >= HEARTBEAT_MS && !(state === "working" && (act.file ? act.file_active_at ?? 0 : 0) > rts + ATTENTION_HOLD_MS)) {
      // Freshness only: the hook / set_status keeps its authority over the state (Codex r4 #5).
      this.post(name, { ...prev, ...(a.repo ? { repo: a.repo } : {}), ...(a.branch ? { branch: a.branch } : {}) }, false, { own: false });
      return;
    }
    if (state === "working") {
      // Waiting / stuck: only a session-file write well after it (the person answered and the turn went on) replaces
      // it, never CPU (a background process of the session, Opus 3).
      const fileSeen = act.file ? act.file_active_at ?? 0 : 0;
      const replace = (prev.state === "idle" && seen > rts + OVERRIDE_MARGIN_MS)
        || ((prev.state === "waiting" || prev.state === "blocked") && fileSeen > rts + ATTENTION_HOLD_MS)
        || (prev.state === "working" && (seen > rts || !!act.pending) && now - rts >= HEARTBEAT_MS);
      if (replace) this.post(name, this.theirs(prev, a, "working"));
      return;
    }
    // Idle by our evidence: a hook's `working` that its session file contradicts (an interrupted turn fires no Stop),
    // but never while its last record is a tool call (a quiet tool) or could not be read (Opus 4).
    if (prev.state === "working" && act.file && !act.tool_running && !act.pending && !act.unknown && now - Math.max(rts, seen) >= IDLE_AFTER_MS) {
      this.post(name, this.theirs(prev, a, "idle"));
    }
  }

  /** A status of discovery's own for a running session (what may be shared of it is decided at emit). */
  private ownBody(a: DiscoveredAgent, prev: Status | null, state: "working" | "idle"): Status {
    if (a.runtime === "hermes") return { agent: a.agent, state, runtime: "other", runtime_name: "hermes" };
    const act = a.activity;
    const title = act?.title || prev?.title;
    // A key a person or an agent set deliberately stays, before any derived one (Codex r4 #9).
    const rec = prev ? this.core.currentStatusProvenance?.(a.agent) ?? null : null;
    const deliberateTask = prev?.task && (rec?.task === "person" || rec?.task === "agent") ? prev.task : undefined;
    const task = deliberateTask ?? detectTask(title, a.branch?.toUpperCase()) ?? prev?.task;
    const model = act?.model ?? prev?.model;
    return {
      // Grok has no runtime value on the wire yet (v0.1.3 peers would reject one): it reports as "other".
      agent: a.agent, state, runtime: wireRuntime(a.runtime),
      ...(runtimeName(a.runtime) ? { runtime_name: runtimeName(a.runtime) } : {}), ...(a.launch ? { launch: a.launch } : {}),
      activity: state === "working" ? act?.step ?? WORKING_ACTIVITY : DISCOVERED_ACTIVITY,
      ...(title ? { title } : {}), ...(task ? { task } : {}), ...(model ? { model } : {}),
      ...(a.repo ? { repo: a.repo } : {}), ...(a.branch ? { branch: a.branch } : {}), ...(a.cwd ? { cwd: a.cwd } : {}),
      ...(a.session ? { session: a.session } : {}), ...(a.started_at ? { started_at: a.started_at } : {}),
      ...(prev?.ask_policy ? { ask_policy: prev.ask_policy } : {}),
    };
  }

  /** Another source's status with discovery's state: its fields are kept (and projected again at emit). */
  private theirs(prev: Status, a: DiscoveredAgent, state: "working" | "idle"): Status {
    if (a.runtime === "hermes") {
      const profile = a.agent.startsWith("hermes-") ? a.agent.slice(7) : "";
      return (a.agent === pidName("hermes", a.pid) || !this.hermesActivity.includes(profile)) ? { agent: a.agent, state, runtime: "other", runtime_name: "hermes" }
        : { ...prev, state };
    }
    const act = a.activity;
    return {
      ...prev, state,
      // The session's repo and branch as discovery sees them now (a checkout changes them, Codex r3 #6).
      ...(a.repo ? { repo: a.repo } : {}), ...(a.branch ? { branch: a.branch } : {}),
      // Working: its last step; else the card's own line only if it already said working ("Finished turn" would lie).
      activity: state === "working" ? act?.step ?? (prev.state === "working" ? prev.activity : undefined) ?? WORKING_ACTIVITY : DISCOVERED_ACTIVITY,
      ...(!prev.title && act?.title ? { title: act.title } : {}),
      ...(!prev.model && act?.model ? { model: act.model } : {}),
      ...(!prev.launch && a.launch ? { launch: a.launch } : {}),
    };
  }

  /**
   * `retiredAt`: this card was a process-only placeholder (`claude-pid<N>`) whose process now has a name of its own, so the
   * placeholder is not an agent that exited but a duplicate. It goes offline already past the offline grace
   * (observed_at, which views and archives count from), so it leaves the live roster at once instead of sitting beside
   * the named card for OFFLINE_GRACE_MS.
   */
  private markOffline(name: string, exited: boolean, retiredAt?: number): boolean {
    if (daemonOwnsAgent(name)) return false;
    const row = this.core.store.agent(this.core.nodeId, name);
    const prev = row ? (JSON.parse(row.body) as Status) : null;
    if (!prev || prev.state === "offline") return false;
    const privateHermes = prev.runtime === "other" && prev.runtime_name === "hermes" && name.startsWith("hermes-")
      && !this.hermesActivity.includes(name.slice(7));
    this.post(name, privateHermes ? { agent: name, state: "offline", runtime: "other", runtime_name: "hermes" }
      : { ...prev, state: "offline", activity: EXITED_ACTIVITY }, false,
      retiredAt === undefined || privateHermes ? {} : { observedAt: retiredAt - OFFLINE_GRACE_MS });
    this.log.info(exited ? "agent_exited" : "agent_swept", { agent: name });
    return true;
  }

  /**
   * Where a status's text came from, for the projection at emit (status-projection.ts). A title / task counts as a
   * person's (explicit) only when the hooks' state for the agent records it so (walkie_set_status); a task is the
   * branch's when the branch names it; anything else counts as a prompt's (shared only with share_prompts). An activity
   * line is a fixed phrase or a tool call's text.
   */
  private provenanceOf(agent: string, body: Status): StatusProvenance {
    // What the daemon recorded when the current status was signed: a title / task carried forward unchanged keeps
    // its provenance (a person's `walkie status "…" --task`, a redacted walkie_set_status title: Opus r3 #5).
    const row = this.core.store.agent(this.core.nodeId, agent);
    const rec = row ? this.core.currentStatusProvenance?.(agent) ?? null : null;
    if (rec && row) {
      const prev = JSON.parse(row.body) as Status;
      const keepTitle = !!body.title && body.title === prev.title && (rec.title === "person" || rec.title === "agent" || rec.title === "placeholder");
      const keepTask = !!body.task && body.task === prev.task && (rec.task === "person" || rec.task === "agent");
      if (keepTitle || keepTask) {
        const base = this.provenanceFromHooks(agent, body);
        return { ...base, ...(keepTitle ? { title: rec.title } : {}), ...(keepTask ? { task: rec.task } : {}) };
      }
    }
    return this.provenanceFromHooks(agent, body);
  }

  private provenanceFromHooks(agent: string, body: Status): StatusProvenance {
    const st = this.hookStates[agent];
    const deliberate = (src: string | undefined): "person" | "agent" | null => (src === "person" ? "person" : src === "agent" || src === "explicit" ? "agent" : null);
    const titleSrc = !body.title || st?.title !== body.title ? "prompt"
      : deliberate(st.title_src) ?? (st.title_src === "placeholder" ? "placeholder" : "prompt");
    const taskSrc = !body.task ? "prompt"
      : st?.task === body.task && deliberate(st.task_src) ? deliberate(st.task_src) as "person" | "agent"
      : body.branch && detectTask(body.branch.toUpperCase()) === body.task ? "branch"
      : (titleSrc === "person" || titleSrc === "agent") && detectTask(body.title) === body.task ? titleSrc
      : "prompt";
    return { title: titleSrc, task: taskSrc, activity: body.activity && ACTIVITY_PHRASES.has(body.activity) ? "phrase" : "tool" };
  }

  /**
   * This machine's agents whose session isn't running: offline. Discovery's own at once; a hook's or MCP's once it
   * is SWEEP_GRACE_MS old (a session discovery can't name yet keeps its status), and only for runtimes discovery
   * sees (plus hook-reported Grok under `other`; never generic `cli` / `other`) or an MCP server's fallback name whose parent
   * process is gone, or whose parent is a session discovery reports under its own name (a duplicate card). Not for a
   * runtime with an unnamed session running or more sessions than it reports. Statuses older than IDLE_ARCHIVE_MS
   * are left alone: they are in the archive already (or stale), and a new offline status would make a long-dead
   * session look just seen. Only after a successful process listing (tick).
   */
  private sweep(found: readonly DiscoveredAgent[], now: number): void {
    // Sessions the scan had no time to examine could be any of these cards: sweep only after a complete scan.
    if (this.unexamined.size) return;
    const alive = new Set([...found.map((a) => a.agent), ...this.live.keys()]); // incl. running sessions not reported
    const sessionPids = new Map(found.map((a) => [a.pid, a.agent]));
    const unnamed = new Set<string>([...found.filter((a) => a.agent === pidName(a.runtime, a.pid)).map((a) => wireRuntime(a.runtime)), ...this.youngUnnamed]);
    let n = 0;
    for (const row of this.core.store.agents()) {
      if (n >= SWEEP_MAX_PER_TICK) break;
      if (row.node !== this.core.nodeId || alive.has(row.agent) || isSeatAgent(row.agent)) continue;
      const prev = agentStatus(row) as Status; // parsed once per row (agent-table.ts); only read here
      const observed = observedAt(prev, row.ts);
      if (now - observed >= IDLE_ARCHIVE_MS) continue;
      if (prev.state === "offline") continue;
      if (prev.parent) {
        // A sub-agent (WALKIE-MISSION-SUB-1) is no process of its own: it runs as long as its session does. Its session
        // gone (and seen gone for sure): it ended with it.
        const rt = prev.runtime ?? "other";
        if (alive.has(prev.parent) || now - observed < SWEEP_GRACE_MS || !SWEEP_RUNTIMES.has(rt) || unnamed.has(rt) || this.truncated.has(rt)) continue;
        if (this.markOffline(row.agent, false)) n++;
        continue;
      }
      if (!this.isOwned(row.agent, row, prev)) {
        if (now - observed < SWEEP_GRACE_MS) continue;
        const parent = mcpFallbackParent(row.agent);
        if (parent !== null) {
          const session = sessionPids.get(parent);
          if (this.minePids.has(parent) && (session === undefined || session === row.agent)) continue;
        } else {
          const rt = prev.runtime ?? "other";
          const sweepable = SWEEP_RUNTIMES.has(rt) || (rt === "other" && prev.runtime_name === "grok");
          if (!sweepable || unnamed.has(rt) || this.truncated.has(rt)) continue;
          if (rt === "codex" && this.codexHost) continue; // the Codex app's sessions aren't processes of their own
        }
      }
      if (this.markOffline(row.agent, false)) n++;
    }
  }

  /** `own` false: a freshness-only re-send of another source's status, which keeps its authority (Codex r4 #5). */
  private post(agent: string, body: Status, discovered = false, opts: { own?: boolean; observedAt?: number } = {}): void {
    try {
      const ev = this.core.statuses.submit(agent, body, this.provenanceOf(agent, body), opts.observedAt);
      if (opts.own === false) {
        if (this.ownedMap().delete(agent)) this.ownedDirty = true;
        return;
      }
      this.ownedMap().set(agent, ev ? { id: ev.id, state: body.state } : { state: body.state, ...(body.activity ? { activity: body.activity } : {}) });
      this.ownedDirty = true;
      if (discovered) this.log.info("agent_discovered", { agent, state: body.state });
    } catch (err) {
      this.log.warn("agent_discovery_status_failed", { agent, err: (err as Error).message });
    }
  }

  /** Keeps only entries that still own their agent's current status, and persists them when they changed. */
  private saveOwned(): void {
    const owned = this.ownedMap();
    for (const [name, o] of [...owned]) {
      const row = this.core.store.agent(this.core.nodeId, name);
      // Kept: the idle of a running session whose row the archive deleted (so it isn't re-posted), and posts still
      // held by the rate limit (no id yet).
      const keep = row ? o.id === undefined || o.id === row.event_id : o.state === "idle" && this.live.has(name);
      if (!keep) { owned.delete(name); this.ownedDirty = true; }
    }
    while (owned.size > OWNED_MAX) { owned.delete(owned.keys().next().value as string); this.ownedDirty = true; }
    if (!this.ownedDirty) return;
    this.ownedDirty = false;
    try { this.core.store.setMeta(OWNED_META, JSON.stringify(Object.fromEntries(owned))); } catch (err) {
      this.log.warn("agent_discovery_owned_save_failed", { err: (err as Error).message });
    }
  }
}

/** One path is the other or inside it. */
function sameTree(x: string, y: string): boolean {
  return x === y || x.startsWith(y.endsWith("/") ? y : y + "/") || y.startsWith(x.endsWith("/") ? x : x + "/");
}

/**
 * The MCP server's name when its session id is unknown (src/mcp/server.ts): `agent-<parent pid in base 36>`. The
 * parent pid, or null for any other name.
 */
export function mcpFallbackParent(agent: string): number | null {
  const m = /^agent-([0-9a-z]{1,7})$/.exec(agent);
  if (!m) return null;
  const pid = parseInt(m[1] as string, 36);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Several processes under one agent name: working if any is; the most recent evidence and details win. */
function merge(list: readonly DiscoveredAgent[]): DiscoveredAgent {
  if (list.length === 1) return list[0] as DiscoveredAgent;
  const byRecent = [...list].sort((x, y) => (y.activity?.last_active_at ?? 0) - (x.activity?.last_active_at ?? 0));
  const top = byRecent[0] as DiscoveredAgent;
  return { ...top, activity: { ...(top.activity ?? { working: false }), working: list.some((a) => a.activity?.working) } };
}
