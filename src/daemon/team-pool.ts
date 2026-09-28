// COMPANY POOL: the team's pool setting as this machine knows it (Alex 2026-09-27: "Team setting, on for us"). An owner
// (the person or the owner's agent) sets it with `walkie accounts pool on|off` in that machine's config.json; it travels
// on the owner machine's accounts snapshot. Every machine takes the newest OWNER setting it has seen (its time moved
// onto this node's clock by the peer's measured skew), keeps it on disk (`~/.walkie/team-pool.json`, 0600) so a restart
// or an offline owner does not forget it, and fails CLOSED: nothing known means the pool is off.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localTeamPolicy } from "../accounts/pool.ts";
import { DEFAULT_TEAM_POLICY, TEAM_POLICIES, type TeamPolicy } from "../protocol/accounts.ts";
import type { Core } from "./core.ts";
import type { SyncManager } from "./sync.ts";
import { activeNodes } from "./roster.ts";

export interface EffectiveTeamPool { policy: TeamPolicy; at: number | null; by: string | null }

const OFF: EffectiveTeamPool = { policy: DEFAULT_TEAM_POLICY, at: null, by: null };

function valid(raw: unknown): EffectiveTeamPool | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!(TEAM_POLICIES as readonly unknown[]).includes(r.policy)) return null;
  if (typeof r.at !== "number" || !Number.isSafeInteger(r.at) || r.at < 0) return null;
  if (typeof r.by !== "string" || !/^[a-z][a-z0-9-]{0,23}$/.test(r.by)) return null;
  return { policy: r.policy as TeamPolicy, at: r.at, by: r.by };
}

export class TeamPoolState {
  private remembered: EffectiveTeamPool | null;

  constructor(private readonly walkieHome: string, private readonly configPath: string) {
    this.remembered = TeamPoolState.load(this.file());
  }

  private file(): string { return join(this.walkieHome, "team-pool.json"); }

  static load(file: string): EffectiveTeamPool | null {
    try { return existsSync(file) ? valid(JSON.parse(readFileSync(file, "utf8"))) : null; } catch { return null; }
  }

  /** The newest owner setting among this machine's own config (read directly, accounts on or off), peers' and disk. */
  current(core: Core, sync: SyncManager): EffectiveTeamPool {
    const r = core.roster;
    if (this.remembered?.by && ![...r.members.values()].some((m) => m.handle === this.remembered?.by && m.role === "owner")) {
      this.save(OFF);
    }
    let best = this.remembered?.by ? this.remembered : null;
    for (const n of activeNodes(r)) {
      const member = r.members.get(n.login);
      if (!member || member.role !== "owner") continue;
      const self = n.node_id === core.nodeId;
      const ad = self ? localTeamPolicy(this.configPath) : sync.peerState(n.node_id)?.accounts?.team_policy;
      if (!ad) continue;
      // A peer's time on this node's clock (skew = its clock − ours), so a fast owner clock cannot win by drift.
      const at = self ? ad.at : Math.max(0, ad.at - (sync.peerState(n.node_id)?.skewMs ?? 0));
      if (!best || at > (best.at ?? -1)) best = { policy: ad.policy, at, by: member.handle };
    }
    if (best && JSON.stringify(best) !== JSON.stringify(this.remembered)) this.save(best);
    return best ?? OFF;
  }

  private save(p: EffectiveTeamPool): void {
    this.remembered = p;
    try {
      const tmp = `${this.file()}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(p)}\n`, { mode: 0o600 });
      renameSync(tmp, this.file());
    } catch { /* kept in memory; written again at the next change */ }
  }
}
