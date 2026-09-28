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
import { detectTask, repoContext, resolveAgentName } from "../agent/identity.ts";
import { SHARE_NOTHING, type SharePolicy } from "../agent/share-policy.ts";
import { readSmallFile } from "../agent/safe-read.ts";
import { ACTIVITY_PHRASES, type StatusProvenance } from "../protocol/status-projection.ts";
import { walkieHome } from "../client/index.ts";
import { IDLE_ARCHIVE_MS } from "../protocol/agent-roster.ts";
import { isSeatAgent } from "../protocol/seats.ts";
import type { BodyOf } from "../protocol/schemas.ts";
import { CPU_BUSY_RATIO, CpuTracker, judge, SESSION_ID_RE, SessionFiles, titleOf, type FileKind, type TailInfo } from "./activity.ts";
import type { Core } from "./core.ts";
import { RESERVED_AGENTS } from "./local-routes.ts";
import { FLEET_AGENT, STEWARD_AGENT } from "../protocol/projects/steward-core.ts";
import type { Logger } from "./logger.ts";
import { SystemProcessProvider, type ProcessProvider, type ProcRow } from "./procs.ts";
import { classifyAgent, modelServers, RELAUNCHING, runtimeName, wireRuntime, type AgentKind, type AgentRuntime, type Launch } from "./agent-procs.ts";
import { assignKimiSessions, containedWire, listKimiSessions, ScanBudget, type KimiProc } from "./kimi-sessions.ts";
import { observedAt } from "./views.ts";
import { trackOp } from "./watchdog.ts";

type Status = BodyOf<"agent.status">;

/** The activity of an idle discovered session. */
export const DISCOVERED_ACTIVITY = "Idle (no activity seen in the last minute)";
/** A working discovered session whose last step is unknown. */
export const WORKING_ACTIVITY = "Working (seen from the process)";
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
/** File operations (stats, small reads) Kimi's session lookup may spend in one scan, across all its directories. */
export const KIMI_OPS_PER_SCAN = 2_000;
const SWEEP_RUNTIMES: ReadonlySet<string> = new Set(["claude-code", "codex", "kimi"]);
/** Cards owned by daemon hosts are authoritative only at their host, never by process discovery. */
function daemonOwnsAgent(agent: string): boolean {
  return agent === "orchestrator" || agent.startsWith("orchestrator.")
    || agent === STEWARD_AGENT || agent === FLEET_AGENT || RESERVED_AGENTS.has(agent);
}
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
  /** How long an unnamed session's process must run before it is reported (default 0; the daemon sets UNNAMED_MIN_AGE_MS). */
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

const SESSION_VARS = ["WALKIE_AGENT", "CLAUDE_CODE_SESSION_ID", "KIMI_SESSION_ID"] as const;
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

/** Per process (pid + start): what earlier scans learned about it. */
interface Entry {
  ctx?: ReturnType<typeof repoContext>; cwdAbs?: string; thread?: string; file?: string | null;
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
  private readonly now: () => number;
  /** The collection policy: re-read every scan (the daemon's config may change while it runs, Codex r3 #8). */
  private share: SharePolicy;
  private readonly sharePolicy: () => SharePolicy;
  private readonly home: string;
  private readonly claudeDir: string;
  private readonly nonAgentDirs: readonly string[];
  private readonly maxPerRuntime: number;
  private readonly cpu = new CpuTracker();
  private files: SessionFiles;
  /** Unnamed sessions (pid:start) that took over a hook card → that card's agent name (adopt). */
  private adoptedMap: Map<string, string> | null = null;
  private adoptedDirty = false;
  /** Runtimes with more sessions than maxPerRuntime in the last scan: their hook cards are not swept. */
  private truncated = new Set<string>();
  /** pid:start of every process of this user in the last successful scan (a session not reported is not gone). */
  private runningKeys = new Set<string>();
  /** pid:start of candidates the last scan had no time for: they keep their state. */
  private unexamined = new Set<string>();
  /** Sessions over the per-runtime cap in the last scan. */
  private unselected = 0;
  private readonly scanBudgetMs: number;
  private readonly concurrency: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
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
    this.home = opts.home ?? walkieHome();
    this.claudeDir = opts.claudeConfigDir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
    this.nonAgentDirs = opts.nonAgentDirs ?? [join(homedir(), ".claude-mem")];
    this.maxPerRuntime = opts.maxPerRuntime ?? MAX_PER_RUNTIME;
    this.scanBudgetMs = opts.scanBudgetMs ?? SCAN_BUDGET_MS;
    this.concurrency = Math.max(1, opts.concurrency ?? SCAN_CONCURRENCY);
    this.files = new SessionFiles({ detail: this.share.activity }); // files of the daemon's own user only
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
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
    const next = this.sharePolicy();
    if (next.prompts === this.share.prompts && next.activity === this.share.activity) { this.share = next; return; }
    this.share = next;
    this.files = new SessionFiles({ detail: next.activity });
    for (const e of this.cache.values()) delete e.title;
  }

  private async scanOnce(): Promise<DiscoveredAgent[] | null> {
    this.refreshPolicy();
    // The scan's wall-clock budget counts from its start (Codex p8 #5): the listing, environment reads, Kimi's session
    // lookup and the examinations all come out of it (every scan still examines MIN_EXAMINED sessions).
    const deadline = Date.now() + this.scanBudgetMs;
    const all = await this.provider.list().catch(() => null);
    if (!all || !all.length) return null; // `ps` itself is always running: an empty list is a failed one
    const now = this.now();
    // Local model servers are machine load, whoever runs them (ollama has its own user on Linux): names and counts only.
    this.models = modelServers(all.map((p) => p.command));
    const mine = all.filter((p) => p.uid === this.uid);
    this.codexHost = mine.some((p) => isCodexHost(p.command));
    this.minePids = new Set(mine.map((p) => p.pid));
    const candidates = this.candidatesOf(mine);
    const running = new Set(mine.map((p) => `${p.pid}:${p.startedAt ?? 0}`));
    this.runningKeys = running;
    this.unexamined = new Set();
    this.youngUnnamed = new Set();
    // What is known about a process (excluded, when examined: the rotation's history) is kept while it runs, whether
    // or not this scan selects it, and forgotten when it exits (Codex r5 #2).
    if (!candidates.length) {
      for (const k of [...this.cache.keys()]) if (!running.has(k)) this.cache.delete(k);
      this.files.retain(new Set());
      return [];
    }
    const children = new Map<number, ProcRow[]>();
    for (const p of mine) {
      const list = children.get(p.ppid);
      if (list) list.push(p); else children.set(p.ppid, [p]);
    }
    const cpu = this.cpu.sample(mine, candidates.map(({ p }) => p), now);
    // What the hooks would see: a child's environment (a session's own process may carry its launcher's session id).
    const kids = candidates.flatMap(({ p }) => (children.get(p.pid) ?? []).map((k) => k.pid));
    const env = await this.provider.envVars(kids, SESSION_VARS);
    const loginPids = candidates.filter(({ rt }) => rt === "claude-code" || rt === "codex").map(({ p }) => p.pid);
    // WALKIE_AGENT too: a seat's own process names it even before it has children (Opus seats r9 LOW).
    const loginEnv = loginPids.length ? await this.provider.envVars(loginPids, [...LOGIN_VARS, "WALKIE_AGENT"]) : new Map<number, Record<string, string>>();
    const tokenEnv = this.onScan ? await envNamesOf(this.provider, loginPids, ALL_TOKEN_VARS) : new Map<number, string[]>();
    const kimiPids = candidates.filter(({ rt }) => rt === "kimi").map(({ p }) => p.pid);
    const kimiEnv = kimiPids.length ? await this.provider.envVars(kimiPids, KIMI_VARS) : new Map<number, Record<string, string>>();
    await this.bindKimi(candidates, kimiEnv, now, new ScanBudget(deadline, KIMI_OPS_PER_SCAN));
    const usedFiles = new Set<string>();
    const out: DiscoveredAgent[] = [];
    const examine = async ({ p, rt, kind }: { p: ProcRow; rt: AgentRuntime; kind: AgentKind }): Promise<void> => {
      const key = `${p.pid}:${p.startedAt ?? 0}`;
      const entry = this.cache.get(key) ?? {};
      this.cache.set(key, entry);
      entry.examinedAt = Date.now();
      // The cwd is looked up again every CWD_REFRESH_MS (a session may cd); repo and branch every scan (a checkout
      // changes the branch, and with it the branch's task key: Codex r3 #6). repoContext only stats and reads HEAD.
      if (!entry.ctx || now - (entry.cwdAt ?? 0) >= CWD_REFRESH_MS) {
        const cwd = await this.provider.cwd(p.pid).catch(() => undefined);
        if (cwd) entry.cwdAbs = cwd;
        entry.cwdAt = now;
      }
      if (entry.cwdAbs) entry.ctx = repoContext(entry.cwdAbs);
      if (entry.cwdAbs && this.nonAgentCwd(entry.cwdAbs)) { entry.excluded = true; return; }
      const login = loginDirOf(rt, loginEnv.get(p.pid));
      const newestKid = [...(children.get(p.pid) ?? [])].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.pid - a.pid)
        .map((k) => env.get(k.pid)).find((e) => e && (e.CLAUDE_CODE_SESSION_ID || e.KIMI_SESSION_ID || e.WALKIE_AGENT));
      const session = await this.sessionOf(p, rt, newestKid, entry, login);
      const agentEnv: NodeJS.ProcessEnv = {
        ...(newestKid?.WALKIE_AGENT ? { WALKIE_AGENT: newestKid.WALKIE_AGENT } : {}),
        ...(session && rt === "claude-code" ? { CLAUDE_CODE_SESSION_ID: session } : {}),
        ...(session && rt === "codex" ? { CODEX_THREAD_ID: session } : {}),
        ...(session && rt === "kimi" ? { KIMI_SESSION_ID: session } : {}),
      };
      const agent = resolveAgentName(agentEnv) ?? pidName(rt, p.pid);
      // A seat running as this user (`--same-user`) is published by its host daemon, never as a discovered session
      // (Opus seats r9 LOW): its WALKIE_AGENT, or the runtime's own, names a seat.
      // The daemon's own names (board steward, fleet desk) are never a discovered session (fix round 2, Opus LOW).
      if (RESERVED_AGENTS.has(agent) || agent === STEWARD_AGENT || agent === FLEET_AGENT || isSeatAgent(agent) || isSeatAgent(loginEnv.get(p.pid)?.WALKIE_AGENT) || isSeatAgent(kimiEnv.get(p.pid)?.WALKIE_AGENT)) return;
      if (this.unnamedMinAgeMs > 0 && agent === pidName(rt, p.pid) && p.startedAt !== null && now - p.startedAt < this.unnamedMinAgeMs && !this.live.has(agent)) {
        this.youngUnnamed.add(wireRuntime(rt));
        return;
      }
      const ratio = cpu.get(p.pid);
      // CPU (only evidence for a session without a session file) counts after two busy readings in a row (Opus r3 #6).
      const busy = ratio !== null && ratio !== undefined && ratio >= CPU_BUSY_RATIO;
      entry.busyScans = busy ? (entry.busyScans ?? 0) + 1 : 0;
      if (entry.busyScans >= 2) entry.lastBusyAt = now;
      const activity = await this.activityOf(p, rt, session, login, entry, now, usedFiles, kind.launch === "headless");
      out.push({
        agent, runtime: rt, pid: p.pid, key, ...(kind.launch ? { launch: kind.launch } : {}), ...(session ? { session: session.slice(0, 80) } : {}),
        ...(p.startedAt ? { started_at: p.startedAt } : {}),
        ...(entry.ctx ? { repo: (entry.ctx.repo ?? basename(entry.cwdAbs ?? "")).slice(0, 120) } : {}),
        ...(entry.ctx?.branch ? { branch: entry.ctx.branch.slice(0, 120) } : {}),
        ...(entry.ctx?.cwd ? { cwd: entry.ctx.cwd.slice(0, 300) } : {}),
        ...(login ? { login_dir: login } : {}),
        ...(wrappedAccount(p, loginEnv.get(p.pid)) ? { account: wrappedAccount(p, loginEnv.get(p.pid)) }
          : tokenLogin(rt, tokenEnv.get(p.pid)) ? { token_login: true as const } : {}),
        activity,
      });
    };
    // Bounded concurrency under an overall budget (Codex r2 #12): what isn't examined in time keeps its last state.
    // The least recently examined first: a budget that runs out never starves the same sessions (Codex r3 #4).
    const lastSeen = (c: { p: ProcRow }) => this.cache.get(`${c.p.pid}:${c.p.startedAt ?? 0}`)?.examinedAt ?? 0;
    const queue = [...candidates].sort((x, y) => lastSeen(x) - lastSeen(y));
    // Every scan examines at least MIN_EXAMINED sessions whatever the budget, so a slow machine still makes progress
    // (Codex r4 #7).
    let started = 0;
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        if (Date.now() >= deadline && started >= MIN_EXAMINED) { queue.unshift(next); return; }
        started++;
        await examine(next).catch((err) => this.log.warn("agent_discovery_examine_failed", { err: (err as Error).message }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, candidates.length) }, worker));
    this.unexamined = new Set(queue.map(({ p }) => `${p.pid}:${p.startedAt ?? 0}`));
    for (const { p } of queue) {
      const key = `${p.pid}:${p.startedAt ?? 0}`;
      const f = this.cache.get(key)?.file;
      if (f) usedFiles.add(f);
    }
    if (queue.length) this.log.warn("agent_discovery_budget_exhausted", { unexamined: queue.length, budget_ms: this.scanBudgetMs });
    out.sort((x, y) => candidates.findIndex((c) => c.p.pid === x.pid) - candidates.findIndex((c) => c.p.pid === y.pid));
    for (const k of [...this.cache.keys()]) if (!running.has(k)) this.cache.delete(k);
    this.files.retain(usedFiles);
    return out;
  }

  /**
   * Binds running Kimi processes to their sessions on disk (kimi-sessions.ts), per directory: every unbound process of
   * one directory and Kimi home is matched in one pass over that bucket, listed once, under the scan's budget. A process
   * whose working directory isn't known yet has it looked up here (bounded by the same deadline). Unambiguous pairs
   * only; a bound process keeps its session for its life.
   */
  private async bindKimi(candidates: ReadonlyArray<{ p: ProcRow; rt: AgentRuntime }>, kimiEnv: Map<number, Record<string, string>>, now: number, budget: ScanBudget): Promise<void> {
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
        const cwd = await this.provider.cwd(p.pid).catch(() => undefined);
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
      const sessions = listKimiSessions(g.home, g.cwd, uid, budget);
      if (sessions === null) { this.log.warn("agent_discovery_kimi_budget", { processes: g.procs.length }); continue; } // next scan
      for (const e of g.entries.values()) e.kimiAt = now;
      for (const [key, s] of assignKimiSessions(g.procs, sessions, taken)) {
        const entry = g.entries.get(key);
        if (!entry || !containedWire(s)) continue;
        taken.add(s.id);
        entry.thread = s.id;
        entry.kimiPath = s.file;
        entry.kimiRoot = s.root;
      }
    }
  }

  /** The session's file (transcript / rollout) and CPU, judged (activity.ts), with the idle hysteresis. */
  private async activityOf(p: ProcRow, rt: AgentRuntime, session: string | undefined, login: string | undefined, entry: Entry, now: number, used: Set<string>, headless = false): Promise<SeenActivity> {
    let kind: FileKind = "other";
    if (rt === "claude-code" && session) {
      kind = "claude";
      entry.file = this.files.claudeTranscript(login ?? this.claudeDir, entry.cwdAbs, session, now);
    } else if (rt === "codex") {
      kind = "codex";
    } else if (rt === "kimi") {
      // The session's wire.jsonl, found on disk by its directory and start (kimi-sessions.ts; Kimi holds no file open),
      // re-validated every scan (this user's regular file, inside the sessions directory).
      if (entry.kimiPath && entry.kimiRoot) {
        entry.file = this.files.kimiFile(entry.kimiPath, entry.kimiRoot);
        if (entry.file) kind = "kimi";
      } else if (entry.file === undefined) {
        // An older Kimi that holds its session file open.
        const open = await this.provider.openFiles(p.pid).catch(() => [] as string[]);
        entry.file = open.map((f) => this.files.openFile(f)).find((f): f is string => !!f) ?? null;
      }
    }
    const path = entry.file ?? null;
    const read = path ? this.files.read(path, kind, entry.cwdAbs ?? "") : null;
    if (path && read) used.add(path);
    const info: TailInfo = read?.info ?? { midTurn: false };
    // The file's last TURN write: a slash command, a meta or a bookkeeping record written after it doesn't count.
    let fileAt: number | null = null;
    if (read) {
      if (info.unknown || info.newestIsTurn !== false) fileAt = read.mtime;
      else fileAt = info.lastTurnAt !== undefined ? Math.min(info.lastTurnAt, read.mtime) : entry.fileAt ?? null;
      if (kind === "claude" && path) {
        const sub = this.files.subagentsMtime(path);
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
      const title = titleOf(info.prompt) ?? (entry.title === undefined && path ? titleOf(this.files.firstPrompt(path, kind)) : undefined);
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

  private async sessionOf(p: ProcRow, rt: AgentRuntime, kid: Record<string, string> | undefined, entry: Entry, login: string | undefined): Promise<string | undefined> {
    const valid = (s: string | undefined) => (s && SESSION_ID_RE.test(s) ? s : undefined);
    if (rt === "claude-code") {
      // Claude's own record lives in the session's config directory (its CLAUDE_CONFIG_DIR), not the daemon's (Opus 5).
      const s = await this.provider.claudeSession(p.pid, login ?? this.claudeDir).catch(() => undefined);
      // A record left by an earlier process with the same pid started before this one.
      if (s && valid(s.sessionId) && (s.startedAt === undefined || p.startedAt === null || s.startedAt >= p.startedAt - 5_000)) return s.sessionId;
      return valid(kid?.CLAUDE_CODE_SESSION_ID);
    }
    if (rt === "kimi") return valid(kid?.KIMI_SESSION_ID) ?? entry.thread;
    if (rt === "grok" || rt === "gemini" || rt === "opencode") return undefined;
    if (!entry.thread) {
      const files = await this.provider.openFiles(p.pid).catch(() => [] as string[]);
      const rollout = files.find((f) => ROLLOUT_RE.test(f));
      entry.thread = rollout ? ROLLOUT_RE.exec(rollout)?.[1] : undefined;
      if (rollout) entry.file = this.files.openFile(rollout);
    }
    return entry.thread;
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
    try {
      const found = await this.scanOnce();
      if (this.stopped) return;
      if (found === null) { this.log.warn("agent_discovery_scan_failed", {}); return; } // nothing changes (Codex 5)
      const unreported = this.unexamined.size + this.unselected;
      this.core.discoveryHealth = unreported ? { incomplete: true, unreported } : null;
      this.core.modelServers = this.models.length ? this.models : null;
      trackOp("agent_discovery", () => this.apply(found));
      // The accounts service knows the logins of Claude, Codex, Kimi and Grok only.
      try { this.onScan?.(found.filter(isAccountSession)); } catch (err) { this.log.warn("agent_discovery_listener_failed", { err: (err as Error).message }); }
    } catch (err) {
      this.log.warn("agent_discovery_failed", { err: (err as Error).message });
    } finally {
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
      else this.markOffline(name, true);
    }
    this.live = next;
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
    const unnamed = found.filter((a) => a.agent === pidName(a.runtime, a.pid) && !!a.cwd);
    const adopted = this.adoptedByProcess();
    // A takeover lasts as long as its process runs (Codex p8 #2): kept through a scan that didn't examine or report
    // it (budget, cap) and across restarts (persisted); dropped once the process is gone from a successful listing.
    for (const k of [...adopted.keys()]) if (!this.runningKeys.has(k)) { adopted.delete(k); this.adoptedDirty = true; }
    if (!unnamed.length) { this.saveAdopted(); return [...found]; }
    const claimed = new Set(found.map((a) => a.agent)); // named sessions' cards are theirs
    const cards = this.core.store.agents().flatMap((row) => {
      if (row.node !== this.core.nodeId || claimed.has(row.agent)) return [];
      const prev = JSON.parse(row.body) as Status;
      if (now - observedAt(prev, row.ts) >= IDLE_ARCHIVE_MS) return [];
      // The card's directory as its writer reported it to this daemon (kept locally; cwd is not published by default).
      const cwd = this.core.localCwds?.get(row.agent) ?? prev.cwd;
      // A sub-agent's card (WALKIE-MISSION-SUB-1) is its session's child, never a process's to take over.
      if (prev.state === "offline" || prev.parent || !cwd || this.isOwned(row.agent, row, prev)) return [];
      return [{ agent: row.agent, ts: row.ts, runtime: prev.runtime === "other" ? prev.runtime_name ?? "other" : prev.runtime, cwd }];
    }).sort((x, y) => y.ts - x.ts);
    const taken = new Set<string>(adopted.values());
    const out = found.map((a) => {
      if (!unnamed.includes(a)) return a;
      // Once taken over, the card stays this process's (its status is discovery's own from then on).
      const kept = adopted.get(key(a));
      if (kept && !claimed.has(kept)) return { ...a, agent: kept };
      if (kept) { adopted.delete(key(a)); this.adoptedDirty = true; } // a session now reported under that name owns the card
      // Same directory first; else one inside the other (the session cd'd into a subdirectory, Opus r2 #4).
      const mine = cards.filter((c) => !taken.has(c.agent) && c.runtime === (runtimeName(a.runtime) ?? a.runtime));
      const card = mine.find((c) => c.cwd === a.cwd) ?? mine.find((c) => sameTree(c.cwd, a.cwd as string));
      if (!card) return a;
      taken.add(card.agent);
      adopted.set(key(a), card.agent);
      this.adoptedDirty = true;
      return { ...a, agent: card.agent };
    });
    this.saveAdopted();
    return out;
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

  private markOffline(name: string, exited: boolean): boolean {
    if (daemonOwnsAgent(name)) return false;
    const row = this.core.store.agent(this.core.nodeId, name);
    const prev = row ? (JSON.parse(row.body) as Status) : null;
    if (!prev || prev.state === "offline") return false;
    this.post(name, { ...prev, state: "offline", activity: EXITED_ACTIVITY });
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
    const st = hookState(this.home, agent);
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
   * sees (never `cli` / `other`, e.g. `walkie status` or a custom agent) or an MCP server's fallback name whose parent
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
      const prev = JSON.parse(row.body) as Status;
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
          if (!SWEEP_RUNTIMES.has(rt) || unnamed.has(rt) || this.truncated.has(rt)) continue;
          if (rt === "codex" && this.codexHost) continue; // the Codex app's sessions aren't processes of their own
        }
      }
      if (this.markOffline(row.agent, false)) n++;
    }
  }

  /** `own` false: a freshness-only re-send of another source's status, which keeps its authority (Codex r4 #5). */
  private post(agent: string, body: Status, discovered = false, opts: { own?: boolean } = {}): void {
    try {
      const ev = this.core.statuses.submit(agent, body, this.provenanceOf(agent, body));
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

/** The hooks' state for an agent (<home>/agents/<agent>.json): what they know of its title's and task's origin. */
function hookState(home: string, agent: string): { title?: string; title_src?: string; task?: string; task_src?: string } | null {
  if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(agent) || agent.includes("..")) return null;
  const text = readSmallFile(join(home, "agents", `${agent}.json`), 64 * 1024);
  if (text === null) return null;
  try {
    const st = JSON.parse(text) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return { title: str(st.title), title_src: str(st.title_src), task: str(st.task), task_src: str(st.task_src) };
  } catch {
    return null;
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
