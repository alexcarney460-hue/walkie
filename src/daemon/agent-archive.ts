// The Agent archive's upkeep (WALKIE-MISSION-1, PROTOCOL §4 "Agent archive"). Every minute: agents past the archive's
// time limit, and the oldest beyond its per-machine cap, are deleted from this node's agent table (their signed status
// events stay in the log; a new status brings an agent straight back), and dashboards are told when an agent moved
// between the live roster and the archive because time passed (no new status arrives to announce that).
import { ARCHIVE_CAP_PER_NODE, isExpired } from "../protocol/agent-roster.ts";
import { SUBAGENT_ARCHIVE_CAP_PER_NODE, SUBAGENT_ARCHIVE_TTL_MS } from "../protocol/subagents.ts";
import { SEATS_AGENT, isSeatAgent } from "../protocol/seats.ts";
import type { AgentView } from "../protocol/schemas.ts";
import type { Core } from "./core.ts";
import type { Logger } from "./logger.ts";
import type { SyncManager } from "./sync.ts";
import { agentsView } from "./views.ts";
import { trackOp } from "./watchdog.ts";

export const ARCHIVE_UPKEEP_MS = 60_000;
export const SEAT_ARCHIVE_CAP_PER_NODE = 100;
export const SEAT_ARCHIVE_TTL_MS = 7 * 86_400_000;

function isSeatCard(a: AgentView): boolean {
  return a.status.parent === SEATS_AGENT && isSeatAgent(a.agent);
}

/**
 * Which archived agents to delete: expired ones, and per node the oldest beyond `cap`. Sub-agents (WALKIE-MISSION-SUB-1)
 * are many and short-lived: at most SUBAGENT_ARCHIVE_CAP_PER_NODE of them per node, for SUBAGENT_ARCHIVE_TTL_MS, so they
 * never crowd sessions out of the archive. Pure.
 */
export function archiveOverflow(views: readonly AgentView[], now: number, cap = ARCHIVE_CAP_PER_NODE): AgentView[] {
  const byNode = new Map<string, AgentView[]>();
  for (const a of views) {
    if (!a.archived) continue;
    const list = byNode.get(a.node);
    if (list) list.push(a); else byNode.set(a.node, [a]);
  }
  const out: AgentView[] = [];
  const subCap = Math.min(cap, SUBAGENT_ARCHIVE_CAP_PER_NODE);
  for (const list of byNode.values()) {
    const newestFirst = [...list].sort((x, y) => y.updated_at - x.updated_at);
    const seats = newestFirst.filter(isSeatCard);
    const dropSeats = new Set(seats.filter((a, i) => i >= SEAT_ARCHIVE_CAP_PER_NODE || now - a.updated_at >= SEAT_ARCHIVE_TTL_MS));
    out.push(...dropSeats);
    const dropSub = new Set<AgentView>();
    newestFirst.filter((a) => !isSeatCard(a) && a.status.parent).forEach((a, i) => {
      if (i >= subCap || now - a.updated_at >= SUBAGENT_ARCHIVE_TTL_MS) dropSub.add(a);
    });
    newestFirst.filter((a) => !isSeatCard(a) && !dropSub.has(a)).forEach((a, i) => { if (i >= cap || isExpired(a, now)) out.push(a); });
    out.push(...dropSub);
  }
  return out;
}

export class AgentArchive {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastLive = "";
  private lastArchived = "";

  constructor(
    private readonly core: Core, private readonly sync: SyncManager, private readonly log: Logger,
    private readonly opts: { intervalMs?: number; cap?: number; now?: () => number } = {},
  ) {}

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs ?? ARCHIVE_UPKEEP_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass; never throws. Returns how many agents were deleted. */
  tick(): number {
    return trackOp("agent_archive", () => this.pass());
  }

  private pass(): number {
    try {
      const now = (this.opts.now ?? Date.now)();
      const views = agentsView(this.core, this.sync, now);
      const drop = archiveOverflow(views, now, this.opts.cap);
      const removed = drop.length ? this.core.store.deleteAgents(drop) : 0;
      this.core.forgetStatusProvenance(drop.filter((a) => a.node === this.core.nodeId).map((a) => a.agent));
      if (removed) this.log.info("agent_archive_pruned", { removed });
      // Then statuses the sharing policy no longer allows are re-signed under it: only the kept ones (round 6, Opus
      // r5 #6; MISSION-1 fix round 3, Opus r3 #1).
      const reprojected = this.core.reprojectOwnStatuses();
      if (reprojected) this.log.info("agent_statuses_reprojected", { reprojected });
      const gone = new Set(drop.map((a) => a.id));
      const live = views.filter((a) => !a.archived && !gone.has(a.id)).map((a) => a.id).sort().join("\n");
      // What the archive holds, entry by entry (an agent aging in while the cap drops another keeps the counts equal).
      const archived = views.filter((a) => a.archived && !gone.has(a.id)).map((a) => `${a.id}@${a.updated_at}:${a.effective_state}`).sort().join("\n");
      if (archived !== this.lastArchived) this.core.archiveRev++;
      if (removed || live !== this.lastLive || archived !== this.lastArchived) this.core.hub.agentsChanged();
      this.lastLive = live;
      this.lastArchived = archived;
      return removed;
    } catch (err) {
      this.log.warn("agent_archive_failed", { err: (err as Error).message });
      return 0;
    }
  }
}
