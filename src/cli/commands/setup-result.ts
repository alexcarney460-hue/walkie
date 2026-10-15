// The result object of `walkie setup --json`: what each step did, from the facts setup gathered. Pure.
import type { MeView } from "../../protocol/schemas.ts";
import type { JsonFacts } from "../json-result.ts";
import type { TeamAgentsOutcome } from "./team-agents.ts";

/** How the Team step ended: nothing to do, a join or a new team, or a fleet link still waiting for an owner. */
export type TeamResult = "already_member" | "joined" | "created" | "pending_approval";
export type ServiceState = "running" | "restarted" | "started" | "skipped" | "failed";

export interface SetupFacts {
  /** This machine's daemon after the steps ran. */
  me: MeView;
  team: TeamResult;
  service: { state: ServiceState; reason?: string };
  teamAgents: TeamAgentsOutcome;
  hooks: { state: "connected" | "none_found" | "skipped"; agents?: string[]; reason?: string };
  switching: { state: "on" | "declined" | "skipped"; reason?: string };
}

function nextSteps(f: SetupFacts): string[] {
  const steps: string[] = [];
  if (f.team === "pending_approval") steps.push("Ask a team owner to approve this machine (dashboard: Team → Waiting to join); it joins by itself once approved. Check: walkie who");
  if (f.team === "created") steps.push(f.me.transport?.mode === "direct" ? "Invite teammates: walkie invite --handle <name> prints a one-time code; they run walkie join <code>" : "Invite teammates: walkie invite <tailscale-login> --handle <name>");
  if (f.service.state === "skipped") steps.push("Start the daemon: walkie daemon start");
  if (f.hooks.state === "connected") steps.push("Restart open Claude Code and Codex sessions to pick up the hooks");
  else steps.push("Connect your agents: walkie hooks install claude|codex|all");
  if (f.switching.state === "on") steps.push("Add each account: walkie accounts add claude, walkie accounts add codex");
  else if (f.switching.state === "declined") steps.push("Account switching later: walkie accounts shims install --profile");
  if (f.teamAgents === "declined") steps.push("Let your team start agents here: walkie seats enable");
  steps.push("walkie dashboard opens the dashboard; walkie who shows everyone in the terminal");
  return steps;
}

export function setupResult(f: SetupFacts): JsonFacts {
  const mode = f.me.transport?.mode ?? null;
  return {
    version: f.me.version,
    team: f.me.team,
    handle: f.me.handle,
    machine: { id: f.me.node.id, hostname: f.me.node.hostname },
    transport: f.me.team ? mode : null,
    admitted: f.me.team !== null,
    pending: f.team === "pending_approval" && f.me.team === null,
    team_result: f.team,
    service: f.service,
    team_agents: f.teamAgents,
    hooks: f.hooks,
    switching: f.switching,
    next_steps: nextSteps(f),
  };
}
