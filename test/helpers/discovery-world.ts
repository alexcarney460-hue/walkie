// A discovery test world (WALKIE-MISSION-1 fix round 1): a Core, a fake process list, a Claude config directory with a
// transcript the test writes, and a clock the test moves. The default process tree is a headless seat: `claude -p`
// (pid 100, CLAUDE_CONFIG_DIR = cfg) whose MCP child (pid 101) carries the session id.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SharePolicy } from "../../src/agent/share-policy.ts";
import type { StatusProvenance } from "../../src/protocol/status-projection.ts";
import { claudeProjectSlug } from "../../src/daemon/activity.ts";
import type { Core } from "../../src/daemon/core.ts";
import { AgentDiscovery, type DiscoveryOptions } from "../../src/daemon/discovery.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { ProcessProvider, ProcRow } from "../../src/daemon/procs.ts";
import { DEFAULT_LIMITS } from "../../src/daemon/ratelimit.ts";
import type { AgentState, BodyOf } from "../../src/protocol/schemas.ts";
import { makeCore } from "./core.ts";
import { createTeam, now, tnode } from "./events.ts";

export const ME = 501;
export const SID = "5eed0001-1111-4222-8333-944455556666";
export const AGENT = "cc-5eed00";

export class Fixture implements ProcessProvider {
  procs: ProcRow[] = [];
  env = new Map<number, Record<string, string>>();
  cwds = new Map<number, string>();
  files = new Map<number, string[]>();
  /** Claude's sessions/<pid>.json per config directory: `${dir}\n${pid}`. */
  sessions = new Map<string, { sessionId: string; startedAt?: number }>();
  /** Set: the next list() fails this way. */
  failList: "null" | "throw" | "empty" | null = null;
  lists = 0;
  async list(): Promise<ProcRow[] | null> {
    this.lists++;
    if (this.failList === "null") return null;
    if (this.failList === "throw") throw new Error("ps timed out");
    if (this.failList === "empty") return [];
    return this.procs;
  }
  async envVars(pids: readonly number[], names: readonly string[]): Promise<Map<number, Record<string, string>>> {
    return new Map(pids.map((p) => [p, Object.fromEntries(Object.entries(this.env.get(p) ?? {}).filter(([k]) => names.includes(k)))]));
  }
  async cwd(pid: number): Promise<string | undefined> { return this.cwds.get(pid); }
  async openFiles(pid: number): Promise<string[] | null> { return this.files.get(pid) ?? []; }
  async claudeSession(pid: number, dir?: string) { return this.sessions.get(`${dir}\n${pid}`); }
}

export const jl = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
export const toolCall = (name: string, input: Record<string, unknown>) => ({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t", name, input }] } });
export const prompt = (text: string) => ({ type: "user", message: { role: "user", content: text } });
export const toolResult = (content: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", content }] } });
export const endTurn = () => [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, { type: "system", subtype: "turn_duration" }];

export interface World {
  core: Core; fx: Fixture; clock: { t: number }; root: string; cfg: string; cwd: string; home: string; transcript: string;
  disc(extra?: Partial<DiscoveryOptions>): AgentDiscovery;
  /** Appends records to the transcript and sets its mtime (default: now). */
  write(recs: unknown[], at?: number): void;
}

export function world(cleanups: (() => void)[], share: SharePolicy = { prompts: true, activity: true }): World {
  const alex = tnode("alex");
  const { team, create } = createTeam(alex);
  const clock = { t: now() };
  const core = makeCore(alex, team, cleanups, { clock: () => clock.t, limits: { ...DEFAULT_LIMITS, status: { capacity: 100_000, perSecond: 100_000 } } });
  if (core.ingest(create, "local").status !== "accepted") throw new Error("team create not accepted");
  // The daemon's own sharing policy (what Core.emit's projection allows) matches discovery's.
  writeFileSync(core.paths.config, JSON.stringify({ share_prompts: share.prompts, share_activity: share.activity, share_paths: !!share.paths }));
  const root = mkdtempSync("/tmp/walkie-discfix-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cfg = join(root, "claude-config");
  const cwd = join(root, "repo");
  const home = join(root, "walkie-home");
  mkdirSync(join(home, "agents"), { recursive: true });
  mkdirSync(join(cwd, ".git"), { recursive: true });
  writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/walkie-mission-1\n");
  mkdirSync(join(cfg, "projects", claudeProjectSlug(cwd)), { recursive: true });
  const transcript = join(cfg, "projects", claudeProjectSlug(cwd), `${SID}.jsonl`);
  const fx = new Fixture();
  fx.procs.push(
    { pid: 1, ppid: 0, uid: 0, startedAt: clock.t - 86_400_000, command: "/sbin/launchd", cpuMs: 0 },
    { pid: 100, ppid: 1, uid: ME, startedAt: clock.t - 60_000, command: "claude -p --output-format stream-json", cpuMs: 1_000 },
    { pid: 101, ppid: 100, uid: ME, startedAt: clock.t - 59_000, command: "walkie mcp", cpuMs: 10 },
  );
  fx.env.set(100, { CLAUDE_CONFIG_DIR: cfg });
  fx.env.set(101, { CLAUDE_CODE_SESSION_ID: SID });
  fx.cwds.set(100, cwd);
  let text = "";
  const write = (recs: unknown[], at = clock.t) => {
    text += jl(...recs);
    writeFileSync(transcript, text);
    utimesSync(transcript, new Date(at), new Date(at));
  };
  const disc = (extra: Partial<DiscoveryOptions> = {}) => new AgentDiscovery(core, createLogger({}), {
    provider: fx, uid: ME, now: () => clock.t, share, home, claudeConfigDir: join(root, "default-claude"),
    nonAgentDirs: [join(root, "claude-mem")], ...extra,
  });
  return { core, fx, clock, root, cfg, cwd, home, transcript, disc, write };
}

export type Status = BodyOf<"agent.status"> & { _id: string; _ts: number };

export function status(core: Core, agent: string): Status | null {
  const row = core.store.agent(core.nodeId, agent);
  return row ? { ...(JSON.parse(row.body) as BodyOf<"agent.status">), _id: row.event_id, _ts: row.ts } : null;
}

/**
 * A status as a hook (or the MCP server) would post it: through the same projection, remembering its cwd locally like
 * the local API does. `provenance` as the writer would send it (default: unknown).
 */
export function hook(core: Core, state: AgentState, activity: string, agent = AGENT, extra: Partial<BodyOf<"agent.status">> = {}, provenance?: StatusProvenance) {
  core.noteLocalCwd(agent, extra.cwd);
  return core.emit("agent.status", { agent, state, runtime: "claude-code", activity, title: "Hook title", ...extra }, { agent, ...(provenance ? { provenance } : {}) });
}

export function addCpu(fx: Fixture, pid: number, ms: number): void {
  fx.procs = fx.procs.map((p) => (p.pid === pid ? { ...p, cpuMs: (p.cpuMs ?? 0) + ms } : p));
}
