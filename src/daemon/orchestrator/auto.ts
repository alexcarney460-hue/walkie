// ORCH-2: WalkieTalkie starts on its own. Pure decision for one check of the auto-start loop (host.ts autoTick): run
// here (this machine is the team's lead and has a Claude login), stand by for the lead, wait for a model login, or
// leave it alone (a person or agent started it by hand, or stopped it: both stick until changed by hand).
import type { NodeView } from "../../protocol/schemas.ts";
import type { Core } from "../core.ts";
import type { Logger } from "../logger.ts";
import { ORCHESTRATOR_AGENT } from "../../protocol/orchestrator.ts";
import { electLead, type LeadNode } from "./lead.ts";
import { detectLogins, type Logins, type LoginProvider } from "./logins.ts";
import { vmMayLead } from "./vm-lead.ts";

export type AutoDecision =
  | { kind: "none" }
  | { kind: "stopped" }
  | { kind: "run" }
  | { kind: "standby"; lead: string | null }
  | { kind: "needs_login"; found: LoginProvider[] };

export interface AutoInput {
  inTeam: boolean;
  observer: boolean;
  /** Started by hand (walkie talkie start, the dashboard's Start, an agent): it runs as asked, outside the election. */
  manual: boolean;
  /** Stopped by hand: stays stopped until started again by hand. */
  stopped: boolean;
  logins: Logins;
  lead: LeadNode | null;
  self: string;
}

export function decide(i: AutoInput): AutoDecision {
  if (!i.inTeam || i.observer || i.manual) return { kind: "none" };
  if (i.stopped) return { kind: "stopped" };
  if (!i.logins.claude) return { kind: "needs_login", found: i.logins.found };
  if (i.lead?.node_id === i.self) return { kind: "run" };
  return { kind: "standby", lead: i.lead?.hostname ?? null };
}

/** What the dashboard and `walkie talkie status` say when there is no Claude login. */
export function needsLoginText(found: readonly LoginProvider[]): string {
  const others = found.filter((p) => p !== "claude");
  return others.length
    ? `WalkieTalkie needs a Claude login for now (found ${others.join(" and ")}; Codex/Kimi support is coming). Sign in with: claude`
    : "WalkieTalkie needs a model login: sign in to Claude Code on this machine (run: claude), or add one with walkie accounts add claude";
}

/** Whether a machine's latest WalkieTalkie status is there (not offline): it has a login and wasn't stopped by hand. */
export function peerLive(core: Core, node: string): boolean {
  const row = core.store.agent(node, ORCHESTRATOR_AGENT);
  if (!row) return false;
  try {
    return (JSON.parse(row.body) as { state?: string }).state !== "offline";
  } catch {
    return false;
  }
}

/** This machine's model logins (presence only), the vault's Claude accounts included. */
export function defaultLogins(core: Core, env: NodeJS.ProcessEnv): Promise<Logins> {
  return detectLogins({
    env, ...(env.HOME ? { home: env.HOME } : {}),
    vaultClaude: () => (core.vault?.list() ?? []).filter((e) => e.provider === "claude").map((e) => e.id),
  });
}

/** The lead if this machine ran (eligible with a Claude login, whatever its stop or manual mode). */
export function leadIfRunning(core: Core, nodes: NodeView[], hasLogin: boolean, offlineMs?: number): LeadNode | null {
  const owners = new Set([...core.roster.members.values()].filter((m) => m.role === "owner").map((m) => m.handle));
  return electLead({
    self: core.nodeId, authority: core.authority, nodes, owners, now: Date.now(), ...(offlineMs ? { offlineMs } : {}),
    eligible: (id) => (id === core.nodeId ? hasLogin && vmMayLead(core, nodes) : peerLive(core, id)),
  });
}

/** What the loop needs from the host (host.ts autoHost). */
export interface AutoHost {
  core: Core;
  log: Logger;
  env: () => NodeJS.ProcessEnv;
  nodes: () => NodeView[];
  manual: () => boolean;
  stoppedByHand: () => boolean;
  setLogins: (l: Logins) => void;
  /** The lead's hostname when it is another machine (a start by hand here then asks first), else null. */
  setLead: (hostname: string | null) => void;
  /** pre.8: this machine would lead (if running): a start by hand here becomes automatic (no manual mode on the lead). */
  promote: (selfLeads: boolean, gen: number) => Promise<void>;
  /** Bumped by every start, stop or resume by hand: a decision taken before one is stale and not applied. */
  gen: () => number;
  apply: (gen: number, d: AutoDecision) => Promise<void>;
}

export interface PilotOptions {
  everyMs?: number;
  leadOfflineMs?: number;
  logins?: () => Promise<Logins>;
}

/** The auto-start loop: on start, then every `everyMs` (15 s): detect logins, elect the lead, apply the decision. */
export class AutoPilot {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly h: AutoHost, private readonly o: PilotOptions = {}) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.o.everyMs ?? 15_000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One check (exported for tests through the host's loop). */
  async tick(): Promise<void> {
    if (this.busy || !this.timer) return;
    this.busy = true;
    try {
      const { core } = this.h;
      const env = this.h.env();
      const gen = this.h.gen();
      const logins = await (this.o.logins ?? (() => defaultLogins(core, env)))();
      this.h.setLogins(logins);
      const stopped = this.h.stoppedByHand();
      const owners = new Set([...core.roster.members.values()].filter((m) => m.role === "owner").map((m) => m.handle));
      const lead = electLead({
        self: core.nodeId, authority: core.authority, nodes: this.h.nodes(), owners, now: Date.now(),
        ...(this.o.leadOfflineMs ? { offlineMs: this.o.leadOfflineMs } : {}),
        eligible: (id) => (id === core.nodeId ? !!logins.claude && !stopped && vmMayLead(core, this.h.nodes()) : peerLive(core, id)),
      });
      // Who would lead with this machine running (its stop and manual mode aside): a machine that would lead has no
      // manual mode (pre.8), and a start by hand elsewhere asks first.
      const would = leadIfRunning(core, this.h.nodes(), !!logins.claude, this.o.leadOfflineMs);
      this.h.setLead(would && would.node_id !== core.nodeId ? would.hostname : null);
      await this.h.promote(would?.node_id === core.nodeId, gen);
      await this.h.apply(gen, decide({
        inTeam: !!core.teamId && !!core.myHandle(), observer: core.me()?.role === "observer",
        manual: this.h.manual(), stopped, logins, lead, self: core.nodeId,
      }));
    } catch (err) {
      this.h.log.warn("orchestrator_auto_check_failed", { err: (err as Error).message.slice(0, 200) });
    } finally {
      this.busy = false;
    }
  }
}
