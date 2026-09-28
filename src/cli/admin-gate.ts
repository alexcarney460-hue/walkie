// AGENT-ADMIN-1: the CLI's admin gate. A person at a terminal confirms an admin command as before (or passes --yes);
// an agent, or anything else without a terminal, goes ahead while this machine's agent admin switch is on (config.json,
// `walkie agents admin off|on`). Its daemon requests are marked as an agent's, so the daemon audits them; steps that
// never reach the daemon (the vault, hooks, sudo setup, llama.cpp) are audited through POST /v1/admin/audit.
import { appendFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient, WalkieError } from "../client/index.ts";
import { readSwitches } from "../daemon/admin/switches.ts";
import { AGENT_ADMIN_OFF } from "../daemon/admin/gate.ts";
import { defaultHome } from "../daemon/paths.ts";
import { runtimeLabel } from "./agent-detect.ts";
import { agentFrom, requirePerson, TERMINAL, type Ctx } from "./context.ts";

export type AdminCaller = { kind: "person" } | { kind: "agent"; why: string };

/** Who runs this admin command: a person at a terminal, or an agent (a marker, or no terminal to confirm on). */
export function adminCaller(ctx: Pick<Ctx, "agentMarker" | "agentSignals" | "person">): AdminCaller {
  const signals = ctx.agentSignals?.() ?? { marker: ctx.agentMarker(), inspection: "ok" as const };
  if (signals.marker) return { kind: "agent", why: signals.marker };
  if (!(ctx.person ?? TERMINAL).interactive()) return { kind: "agent", why: "no terminal (an unattended caller)" };
  return { kind: "person" };
}

export function agentAdminOn(home = defaultHome()): boolean {
  return readSwitches(join(home, "config.json")).agent_admin;
}

function refuseOff(what: string): never {
  throw new WalkieError("agent_admin_off", `agents can't ${what} here: ${AGENT_ADMIN_OFF}`, 403);
}

/**
 * An admin command: a person confirms by typing `confirm` (unless --yes); an agent goes ahead while agent admin is on.
 * Returns the client to use: an agent's requests are marked (the daemon's gate audits them, naming the agent).
 */
export async function requireAdmin(ctx: Ctx, what: string, confirm: string): Promise<WalkieClient> {
  const caller = adminCaller(ctx);
  if (caller.kind === "person") {
    if (ctx.args.flags.get("yes") !== true) await requirePerson(ctx, what, confirm);
    return ctx.client();
  }
  if (!agentAdminOn()) refuseOff(what);
  return ctx.client({ underAgent: true });
}

/**
 * A CLI-only admin step (it changes this machine without a daemon request): refused while agent admin is off, and
 * recorded (the daemon's audit route; its local log directly when the daemon is down). A person: nothing to do.
 */
export async function auditLocal(ctx: Ctx, action: string): Promise<void> {
  if (adminCaller(ctx).kind === "person") return;
  if (!agentAdminOn()) refuseOff(action);
  try {
    await ctx.client({ underAgent: true }).adminAudit(action);
  } catch (err) {
    if (err instanceof WalkieError && err.code === "agent_admin_off") throw err;
    // The daemon is down (setup, a broken install): the local log still has it; the team post waits for nothing.
    const actor = `${agentFrom(ctx.args) ?? runtimeLabel() ?? "agent"} (daemon unreachable)`;
    try {
      const p = join(defaultHome(), "admin-audit.jsonl");
      appendFileSync(p, JSON.stringify({ ts: Date.now(), actor, action, machine: "", via: "local" }) + "\n", { mode: 0o600 });
      chmodSync(p, 0o600);
    } catch { /* no Walkie home yet: nothing to append to */ }
  }
}

/**
 * The context an admin command runs with: the same for a person; for an agent (agent admin on, else refused) one whose
 * daemon requests are all marked as an agent's, so the daemon's gates audit every step, naming the agent.
 */
export function adminCtx(ctx: Ctx, what: string): Ctx {
  if (adminCaller(ctx).kind === "person") return ctx;
  if (!agentAdminOn()) refuseOff(what);
  return { ...ctx, client: () => ctx.client({ underAgent: true }) };
}
