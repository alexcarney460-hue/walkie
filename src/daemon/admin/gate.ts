// AGENT-ADMIN-1: the daemon's admin gate. Setup routes (seats, accounts, pool, orchestrator, invites, project
// settings, …) take a person as before, and now an agent too: an agent-marked request (X-Walkie-Agent, or
// X-Walkie-Under-Agent from the CLI under an agent runtime) passes while this machine's agent admin switch is on, and
// is audited (local log + a #general post naming the agent). What stays a person's alone is `personOnly` below.
import { ORCHESTRATOR_AGENT, ORCHESTRATOR_TOKEN_HEADER } from "../../protocol/orchestrator.ts";
import { HttpError } from "../http.ts";
import { hostFor } from "../orchestrator/host.ts";
import { TALKIE_SHELL_HEADER } from "../orchestrator/os-user.ts";
import type { RouteCtx } from "../local-routes.ts";
import { appendAudit, recordAdmin } from "./audit.ts";
import { runFor } from "./runs.ts";
import { readSwitches } from "./switches.ts";

type Caller = Pick<RouteCtx, "agent" | "underAgent">;
/** What the gate reads of a request (a RouteCtx, or the auth routes' own). */
export type GateCtx = Pick<RouteCtx, "core" | "agent" | "underAgent" | "req">;

export const AGENT_ADMIN_OFF = "agent admin is off on this machine (its person turned it off; only they turn it back on: walkie agents admin on, or the dashboard)";

/** Whether the request comes from an agent (named, or the CLI marking itself as running under one). */
export function agentCaller(c: Caller): boolean {
  return !!c.agent || !!c.underAgent;
}

/** The agent part of the actor: its name, else the runtime the CLI reported (X-Walkie-Agent-Runtime), else "agent". */
function agentLabel(c: GateCtx): string {
  if (c.agent) return c.agent;
  const rt = c.req.headers.get("x-walkie-agent-runtime") ?? "";
  return /^[a-z0-9][a-z0-9._-]{0,39}$/.test(rt) ? `${rt} (unnamed)` : "agent (unnamed)";
}

/** `@handle/machine/agent` for this machine's own caller. */
export function localActor(c: GateCtx): string {
  return `@${c.core.myHandle() ?? "unknown"}/${c.core.hostname}/${agentLabel(c)}`;
}

/**
 * An admin action: a person passes (nothing recorded, as before); an agent passes while agent admin is on and the
 * action is audited. `action` says what was done, for the audit line ("enabled seats: same-user, max 12").
 */
export function adminGate(c: GateCtx, action: string, options: { post?: boolean } = {}): void {
  const privateJoinMint = c.req.method === "POST" && ["/v1/team/invite-code", "/v1/team/add-machine"].includes(new URL(c.req.url).pathname);
  if (c.req.headers.get(TALKIE_SHELL_HEADER) === "1" && !privateJoinMint) {
    throw new HttpError(403, "talkie_shell_forbidden", "WalkieTalkie shell access cannot make admin changes; switch WalkieTalkie back to Walkie platform access");
  }
  if (!agentCaller(c)) return;
  // The name "orchestrator" is this machine's orchestrator's alone (its per-run token proves it): nobody else is
  // audited under it (local-routes.ts refuseReservedAgent, for admin too).
  if (c.agent === ORCHESTRATOR_AGENT && !hostFor(c.core)?.acceptsToken(c.req.headers.get(ORCHESTRATOR_TOKEN_HEADER) ?? undefined)) {
    throw new HttpError(403, "forbidden", "the agent name \"orchestrator\" is reserved for this machine's orchestrator host");
  }
  const run = runFor(c.core, c.req.headers.get("x-walkie-admin-token"));
  const entry = { actor: run?.actor ?? localActor(c), action, machine: c.core.hostname, via: run ? "remote" as const : "local" as const };
  if (!readSwitches(c.core.paths.config).agent_admin) {
    appendAudit(c.core, { ...entry, refused: "agent_admin_off" });
    throw new HttpError(403, "agent_admin_off", AGENT_ADMIN_OFF);
  }
  // A remote run's command line is posted once by the peer route (remote.ts); its steps are logged here only.
  recordAdmin(c.core, entry, { post: !run && options.post !== false });
}

/** A read for an agent (orchestrator status, …): allowed while agent admin is on, not audited (no action). */
export function adminRead(c: GateCtx): void {
  if (agentCaller(c) && !readSwitches(c.core.paths.config).agent_admin) throw new HttpError(403, "agent_admin_off", AGENT_ADMIN_OFF);
}

/**
 * What stays a person's alone (AGENT-ADMIN-1 §3): secrets in plain text (a dashboard session), removing a member,
 * moving the roster authority, deleting the team, and turning an admin switch back on.
 */
export function personOnly(c: Caller, what: string): void {
  if (agentCaller(c)) throw new HttpError(403, "person_only", `agents can't ${what}; a person does it, in the dashboard or in their own terminal`);
}
