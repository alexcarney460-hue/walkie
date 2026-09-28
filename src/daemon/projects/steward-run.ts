// FO-6 board steward in the daemon: one run over a project (plan, then the moves signed as this daemon's `steward`
// agent, each followed by a comment naming its evidence) and the loop that runs it on this machine's schedule.
// Only a daemon whose member stewards the project (an owner, or the project's creator) runs it; the fold accepts its
// moves on those terms (fold.ts CardContext.steward), and nothing else can sign as `steward` (the local API refuses
// the name). Moves never delete or reassign; a person's move wins (steward.ts).
import type { Core } from "../core.ts";
import { loadConfig, saveConfigField, StewardConfig } from "../config.ts";
import { HttpError } from "../http.ts";
import type { Logger } from "../logger.ts";
import type { PeerClient } from "../peer-client.ts";
import type { CatchUp } from "../requests.ts";
import type { SyncManager } from "../sync.ts";
import { agentsView, nodesView } from "../views.ts";
import { VERSION } from "../version.ts";
import { isPersonAddress } from "../../protocol/projects/fold.ts";
import type { LinearService } from "../../integrations/linear-service.ts";
import type { CardView, ProjectView } from "../../protocol/projects/schema.ts";
import {
  DEFAULT_STALE_HOURS, planSteward, STEWARD_AGENT, type StewardMove, type StewardPlan,
} from "../../protocol/projects/steward.ts";
import type { ProjectsIndex } from "./index.ts";
import { comment, findProject, updateCard, updateProject, visibleProjects, type WriteCtx } from "./service.ts";
import { gather, type AgentRow, type StewardSource } from "./steward-gather.ts";

export interface StewardDeps {
  readonly core: Core; readonly idx: ProjectsIndex; readonly sync: SyncManager; readonly client: PeerClient;
  readonly catchUp: CatchUp; readonly linear?: LinearService; readonly log?: Logger;
  /** Whether every machine folds a steward move of a person's card (default: peersFoldSteward); tests inject it. */
  readonly peersCapable?: () => string | null;
  /** Tests: runs between the plan and the writes (a change a person or another machine makes meanwhile). */
  readonly beforeWrites?: () => Promise<void>;
}

export interface RunOpts {
  readonly dryRun: boolean; readonly repos?: readonly string[]; readonly staleHours?: number; readonly now?: number;
  /** Who asked: an agent's (dry) runs have their own budget, so they never use up the people's (round 3, Opus r2 LOW). */
  readonly caller?: "person" | "agent" | "loop";
  /** A loop run: the lease (node id) it ran under, re-checked before every write (round 3, Codex r2 MED 4). */
  readonly lease?: string;
}

export interface RunResult {
  project: { channel: string; prefix: string; name: string; steward: "on" | "off"; steward_node: string };
  dry_run: boolean;
  repos: string[];
  plan: StewardPlan;
  applied: string[];
  failed: Array<{ key: string; error: string }>;
}

/**
 * The first release whose fold accepts the steward's move of a person's card (fold 9: this lane ships in pre.8; pre.7
 * has no steward fold change). Until every machine seen lately reports it (or this daemon's own version), such moves
 * wait, so an older machine never shows a different board (fix round 2, Codex MED 5). This daemon itself must be at
 * least that version too (a development build of an older version doesn't move a person's card).
 */
export const STEWARD_MIN_VERSION = "0.2.0-pre.8";

/** `a` >= `b` for x.y.z[-pre.n] versions (numeric parts compared as numbers; a release sorts after its prereleases). */
export function versionAtLeast(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("+")[0]?.split("-", 2) ?? [];
    return { core: (core ?? "").split(".").map((x) => Number(x) || 0), pre: pre ? pre.split(".") : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) > (y.core[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return !x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined) return false;
    if (q === undefined) return true;
    if (p === q) continue;
    const [pn, qn] = [Number(p), Number(q)];
    if (Number.isInteger(pn) && Number.isInteger(qn)) return pn > qn;
    return p > q;
  }
  return true;
}

/** A machine that hasn't been seen for this long doesn't hold the steward's moves back (fix round 3, Opus r2 LOW). */
export const PEER_STALE_MS = 24 * 3_600_000;

export interface PeerVersion { hostname: string; self?: boolean; online: boolean; last_seen: number | null; version?: string }

/**
 * Why a move of a person's card must wait, or null: the first machine online now or seen in the last PEER_STALE_MS whose
 * Walkie is older than STEWARD_MIN_VERSION (the first release whose fold accepts the move) or hasn't reported a version
 * (fail closed). No exception for "the same version as this daemon": a development build calling itself pre.5 must not
 * pass a released pre.5 (round 3, Codex r2 HIGH 1). Machines offline for longer don't count (round 3, Opus r2 LOW).
 */
export function blockingPeer(nodes: readonly PeerVersion[], now: number): string | null {
  for (const n of nodes) {
    if (n.self) continue;
    if (!n.online && (n.last_seen === null || now - n.last_seen > PEER_STALE_MS)) continue;
    if (!n.version) return `waiting for ${n.hostname} to report its Walkie version`;
    if (!versionAtLeast(n.version, STEWARD_MIN_VERSION)) return `waiting for ${n.hostname} to upgrade (it runs Walkie ${n.version}; this needs ${STEWARD_MIN_VERSION})`;
  }
  return null;
}

/** blockingPeer over this daemon's view of the machines. */
export function peersFoldSteward(core: Core, sync: SyncManager, now = Date.now()): string | null {
  if (!versionAtLeast(VERSION, STEWARD_MIN_VERSION)) return `this machine runs Walkie ${VERSION}; moves of a person's card need ${STEWARD_MIN_VERSION}`;
  return blockingPeer(nodesView(core, sync).map((n) => ({
    hostname: n.hostname, self: n.self, online: n.online, last_seen: n.last_seen, ...(n.stats?.sys?.version ? { version: n.stats.sys.version } : {}),
  })), now);
}

/**
 * This daemon itself as the steward's evidence source. A dry run signs and sends nothing; it may bring this machine's
 * derived board index up to date and refresh the Linear lookup cache, as any read of the board does.
 */
export function daemonSource(d: StewardDeps): StewardSource {
  const ro = { core: d.core, idx: d.idx };
  return {
    project: async (ref) => { d.idx.flushAll(); return findProject(ro, ref); },
    cards: async (p) => d.idx.db.cards(p.channel, { states: ["open"], limit: 20_000 }),
    timeline: async (p, c) => d.idx.foldCardNow(p.channel, c.id)?.state.timeline ?? [],
    agents: async () => agentsView(d.core, d.sync) as unknown as AgentRow[],
    owners: async () => [...d.core.roster.members.values()].filter((m) => m.role === "owner").map((m) => m.handle),
    linear: async (keys) => {
      if (!d.linear) return null;
      const r = await d.linear.issues(keys);
      return r.enabled ? r.issues : null;
    },
  };
}

/** Whether this daemon's member stewards the project: an owner, or its creator (fold.ts isStewardAuthor). */
export function stewards(core: Core, p: ProjectView): boolean {
  const m = core.me();
  return !!m && (m.role === "owner" || (m.role === "member" && m.handle === p.creator));
}

function stewardCtx(d: StewardDeps): WriteCtx {
  return { core: d.core, idx: d.idx, client: d.client, catchUp: d.catchUp, agent: STEWARD_AGENT, steward: true };
}

/** The posts one move signs, reserved together from the write limit (fix round 2: charged per post). */
export function eventsOf(m: StewardMove): number {
  if (!m.to && !m.blocked_reason) return m.duplicate_of ? 2 : 1; // a duplicate flag: a comment on both cards
  return (m.to ? 1 : 0) + (m.blocked_reason ? 1 : 0) + 1;
}

/** What must not have changed between the plan and the write: every field an op or a comment moves. */
function fingerprint(c: CardView): string {
  return JSON.stringify([c.rev, c.updated_at, c.column, c.pos, c.board, c.state, c.blocked, c.assignee, c.comments, c.title]);
}

/** The column role a rule moves a card into. */
const TARGET_ROLE: Record<string, string> = { done: "done", review: "review", doing: "active", stale: "todo" };

/** What the run expects each card to look like now: the plan's reads, updated after each of its own writes. */
type Expected = Map<string, string>;

/**
 * One move, re-validated against a fresh read first (round 2, Codex MED 4; round 3, Codex r2 HIGH 2 + MED 3/4/6):
 *  - the project: still active, its steward on, the lease still this machine's (a loop run), and for a done move on a
 *    comment alone, agents_can_close still on;
 *  - the destination: the column still exists on the card's board with the role the rule means;
 *  - the card, and for a duplicate flag the kept card too: exactly as the plan read them, or as this run's own earlier
 *    writes left them (a person's reorder, a move away and back, a comment: all change it);
 *  - a duplicate flag: both cards still open, on the same board.
 * Then the op(s) and the evidence comment; a duplicate flag is a comment on both cards.
 */
function apply(d: StewardDeps, m: StewardMove, channel: string, expected: Expected, lease: string | undefined): void {
  d.idx.flushAll();
  const p = d.idx.project(channel);
  if (!p || p.steward === "off" || p.state !== "active") throw new Error("the project's steward was turned off");
  if (lease !== undefined && p.steward_node !== lease) throw new Error("the project's steward lease moved to another machine");
  if (m.text_only && !p.automations.agents_can_close) throw new Error("agents_can_close was turned off: a person closes it");
  const cur = d.idx.db.card(m.card);
  if (!cur || expected.get(m.card) !== fingerprint(cur)) throw new Error("the card changed since the plan");
  if (m.to) {
    const col = p.boards.find((b) => b.id === cur.board)?.columns.find((c) => c.id === m.to);
    if (!col || col.role !== TARGET_ROLE[m.rule]) throw new Error("the board's columns changed since the plan");
  }
  const keep = m.duplicate_of ? d.idx.db.cardsByShort(m.duplicate_of.slice(-8)).find((c) => c.channel === channel) : undefined;
  if (m.duplicate_of) {
    if (!keep || keep.state !== "open" || keep.board !== cur.board || expected.get(keep.id) !== fingerprint(keep)) throw new Error("the kept card changed since the plan");
  }
  const w = stewardCtx(d);
  if (m.to) updateCard(w, m.card, { column: m.to });
  if (m.blocked_reason) updateCard(w, m.card, { blocked: true, blocked_reason: m.blocked_reason });
  comment(w, m.card, m.comment, m.ping.map((h) => `@${h}`));
  if (!m.to && !m.blocked_reason && keep) comment(w, keep.id, `Board steward: ${m.key} looks like a duplicate of this card (flagged, not archived; a person archives one).`);
  // This run's own writes are expected from now on (a flag's comment must not void a later move of the same card).
  d.idx.flushAll();
  for (const id of [m.card, ...(keep ? [keep.id] : [])]) {
    const after = d.idx.db.card(id);
    if (after) expected.set(id, fingerprint(after));
  }
}

/** Runs in flight per project on this daemon: one at a time (fix round 2, Codex MED 6). */
const inFlight = new WeakMap<Core, Set<string>>();

/** Plans (and unless dry, makes) the steward's moves on one project. */
export async function runSteward(d: StewardDeps, projectRef: string, opts: RunOpts): Promise<RunResult> {
  const cfg = stewardConfig(d.core);
  d.idx.flushAll();
  const ref = findProject({ core: d.core, idx: d.idx }, projectRef);
  const running = inFlight.get(d.core) ?? new Set<string>();
  inFlight.set(d.core, running);
  if (running.has(ref.channel)) throw new HttpError(409, "steward_busy", `a board steward run for ${ref.name} is already running`);
  // Every run (a dry one too) reads every card and may scan repositories: people's and the loop's runs share the
  // people's write budget, agents' runs the agent write budget, each under its own key.
  const agentRun = opts.caller === "agent";
  if (!d.core.limiter.take(agentRun ? "steward-run:agent" : "steward-run", agentRun ? d.core.limits.agentWrite : d.core.limits.humanWrite)) throw new HttpError(429, "rate_limited", "too many board steward runs; try again in a minute");
  running.add(ref.channel);
  try {
    return await runLocked(d, ref.channel, ref.prefix, opts, cfg);
  } finally {
    running.delete(ref.channel);
  }
}

async function runLocked(d: StewardDeps, channel: string, prefix: string, opts: RunOpts, cfg: StewardConfig): Promise<RunResult> {
  const g = await gather(daemonSource(d), channel, {
    now: opts.now ?? Date.now(), staleHours: opts.staleHours ?? cfg.stale_hours,
    repos: [...(opts.repos ?? []), ...(cfg.repos?.[prefix] ?? [])],
  });
  const p = g.project;
  if (!opts.dryRun && !stewards(d.core, p)) {
    throw new HttpError(403, "forbidden", `only an owner's or ${p.name}'s creator's machine stewards its board`);
  }
  if (!opts.dryRun && p.steward === "off") throw new HttpError(409, "steward_off", `the board steward is off for ${p.name} (a project admin turns it on)`);
  const planned = planSteward(g.input);
  // A move of a person's card folds only on machines with fold 9: until all report it, those moves wait.
  const why = (d.peersCapable ?? (() => peersFoldSteward(d.core, d.sync)))();
  const byId = new Map(g.cards.map((c) => [c.id, c]));
  const gated = why ? planned.moves.filter((m) => m.to && isPersonAddress(byId.get(m.card)?.assignee ?? null)) : [];
  const plan: StewardPlan = {
    ...planned,
    moves: planned.moves.filter((m) => !gated.includes(m)),
    held: [...planned.held, ...gated.map((m) => ({ card: m.card, key: m.key, reason: `${why} (a move of a person's card)` }))],
  };
  const result: RunResult = {
    project: { channel: p.channel, prefix: p.prefix, name: p.name, steward: p.steward ?? "on", steward_node: p.steward_node ?? "" },
    dry_run: opts.dryRun, repos: g.repos, plan, applied: [], failed: [],
  };
  if (opts.dryRun) return result;
  await d.beforeWrites?.();
  let deferred = plan.deferred;
  const expected: Expected = new Map(g.cards.map((c) => [c.id, fingerprint(c)]));
  for (const m of plan.moves) {
    // The board write limits apply to the steward like to any agent, per post, the op and its comments together.
    if (!d.core.limiter.take(`write:${STEWARD_AGENT}`, d.core.limits.agentWrite, Date.now(), eventsOf(m))) { deferred++; continue; }
    try {
      apply(d, m, p.channel, expected, opts.lease);
      result.applied.push(m.key);
      d.log?.info("steward_move", { project: p.prefix, card: m.key, rule: m.rule, from: m.from, to: m.to ?? null });
    } catch (err) {
      result.failed.push({ key: m.key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ...result, plan: { ...plan, deferred } };
}

/** This machine's steward settings (config.json, re-read so a CLI change applies without a restart). */
export function stewardConfig(core: Core): StewardConfig {
  try {
    return loadConfig(core.paths.config, false).steward ?? StewardConfig.parse({});
  } catch {
    return core.config.steward ?? StewardConfig.parse({ stale_hours: DEFAULT_STALE_HOURS });
  }
}

/** Runs the steward on this machine's schedule when the person turned `auto` on. */
export class StewardLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private closed = false;

  constructor(private readonly d: StewardDeps) {}

  start(): void { this.schedule(60_000); }

  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.tick(); }, ms);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Upgrading from a build without the lease (round 3, Opus r2 LOW): a machine whose person had turned `auto` on keeps
   * running it. Once, it takes the lease of every project it stewards, administers and nobody holds yet (a settings op
   * signed as its person, whose choice `auto` was), then records that the migration ran. A config written by this
   * version (`walkie board steward auto …`) is marked migrated already, so nothing is taken behind a person's back.
   */
  private async migrateLeases(cfg: StewardConfig): Promise<void> {
    const me = this.d.core.me();
    const person = { core: this.d.core, idx: this.d.idx, client: this.d.client, catchUp: this.d.catchUp };
    for (const p of visibleProjects({ core: this.d.core, idx: this.d.idx })) {
      const admin = !!me && (me.role === "owner" || p.creator === me.handle);
      if (p.state !== "active" || p.steward === "off" || p.steward_node || !admin || !stewards(this.d.core, p)) continue;
      try {
        await updateProject(person, p.channel, { steward_node: this.d.core.nodeId });
        this.d.log?.info("steward_lease_migrated", { project: p.prefix });
      } catch (err) {
        this.d.log?.warn("steward_lease_migrate_failed", { project: p.prefix, err: err instanceof Error ? err.message : String(err) });
      }
    }
    saveConfigField(this.d.core.paths.config, "steward", { ...cfg, lease_migrated: true });
  }

  /** One pass over every project this machine stewards (exported for tests). */
  async tick(): Promise<string[]> {
    const cfg = stewardConfig(this.d.core);
    const done: string[] = [];
    if (this.running || this.closed) return done;
    this.running = true;
    try {
      if (!cfg.auto || !this.d.core.me()) return done;
      if (!cfg.lease_migrated) await this.migrateLeases(cfg);
      for (const p of visibleProjects({ core: this.d.core, idx: this.d.idx })) {
        // The lease: only the machine a project admin chose runs a project's loop; the run re-checks it before each write.
        if (p.state !== "active" || p.steward === "off" || p.steward_node !== this.d.core.nodeId || !stewards(this.d.core, p)) continue;
        try {
          const r = await runSteward(this.d, p.channel, { dryRun: false, caller: "loop", lease: this.d.core.nodeId });
          done.push(...r.applied.map((k) => `${p.prefix}:${k}`));
        } catch (err) {
          this.d.log?.warn("steward_run_failed", { project: p.prefix, err: err instanceof Error ? err.message : String(err) });
        }
      }
      return done;
    } finally {
      this.running = false;
      this.schedule(cfg.interval_min * 60_000);
    }
  }
}

