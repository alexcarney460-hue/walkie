// walkie admin (AGENT-ADMIN-1): this machine's admin switches and audit log, the team's machines an admin command may
// reach, and remote admin: an allow-listed walkie command run on team machines over Walkie (never a shell).
//   walkie admin [status] · walkie admin log [--limit n] · walkie admin machines [--json]
//   walkie admin agents on|off|status · walkie admin remote on|off|status   (also: walkie agents admin on|off|status)
//   walkie admin --machine <m>|--machines a,b|all-mine|all [--timeout s] [--json] <walkie command…>
import type { AdminRunResult, AdminView, WalkieClient } from "../../client/index.ts";
import { MAX_REMOTE_TIMEOUT_S, REMOTE_COMMANDS } from "../../protocol/admin.ts";
import { adminCaller } from "../admin-gate.ts";
import { need, UsageError } from "../args.ts";
import { EXIT, requirePerson, type Ctx } from "../context.ts";
import { ago, c, safeTerm } from "../format.ts";

export const ADMIN_USAGE = "admin [status] | admin log [--limit n] | admin machines [--json] | admin agents|remote on|off|status"
  + " | admin --machine <m> (or --machines a,b | all-mine | all) [--timeout s] [--json] <walkie command…>";

/** The leading options of a remote admin call; everything after them is the command to run there. */
export interface RemoteCall { machines: string; timeout_s?: number; json: boolean; forAgent: boolean; argv: string[] }

/**
 * Splits `walkie admin …` into the remote call, or null when no --machine/--machines leads (a local subcommand).
 * The remote command's own flags pass through untouched (`--yes --max 12` belong to it, not to walkie admin).
 */
export function splitRemote(rest: readonly string[]): RemoteCall | null {
  let machines: string | null = null;
  let timeout: number | undefined;
  let json = false;
  let forAgent = false;
  let i = 0;
  const value = (a: string): string => {
    const eq = a.indexOf("=");
    if (eq >= 0) return a.slice(eq + 1);
    const v = rest[++i];
    if (v === undefined) throw new UsageError(`${a} needs a value`);
    return v;
  };
  for (; i < rest.length; i++) {
    const a = rest[i] as string;
    const name = a.split("=")[0];
    if (name === "--machine" || name === "--machines") machines = value(a);
    else if (name === "--timeout") timeout = Number(value(a));
    else if (a === "--json") json = true;
    else if (a === "--for-agent") forAgent = true;
    else break;
  }
  if (machines === null) return null;
  const argv = rest.slice(i).filter((a, n) => !(n === 0 && a === "--"));
  if (!argv.length) throw new UsageError(`name the walkie command to run there, e.g. walkie admin --machine ${machines} seats doctor`);
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout >= 1 && timeout <= MAX_REMOTE_TIMEOUT_S)) throw new UsageError(`--timeout is 1-${MAX_REMOTE_TIMEOUT_S} seconds`);
  return { machines, ...(timeout ? { timeout_s: timeout } : {}), json, forAgent, argv: argv.map(String) };
}

export async function runRemote(ctx: Ctx, call: RemoteCall): Promise<number> {
  const client = adminCaller(ctx).kind === "agent" ? ctx.client({ underAgent: true }) : ctx.client();
  const res = await client.adminRun({ machines: call.machines, argv: call.argv, ...(call.timeout_s ? { timeout_s: call.timeout_s } : {}) });
  if (call.json || ctx.json) { ctx.out(JSON.stringify(res)); return res.ok ? EXIT.ok : EXIT.error; }
  printResults(ctx, res);
  return res.ok ? EXIT.ok : EXIT.error;
}

function printResults(ctx: Ctx, res: AdminRunResult): void {
  for (const r of res.results) {
    const head = r.error ? c.red(`${r.error.code}`) : r.timed_out ? c.red("timed out") : r.exit === 0 ? c.green("exit 0") : c.yellow(`exit ${r.exit}`);
    ctx.out(`${c.bold(`== ${safeTerm(r.machine)}`)} ${head}`);
    if (r.error) ctx.out(`   ${safeTerm(r.error.message)}`);
    if (r.stdout) ctx.out(safeTerm(r.stdout.replace(/\n$/, "")));
    if (r.stderr) ctx.err(safeTerm(r.stderr.replace(/\n$/, "")));
    if (r.truncated) ctx.out(c.dim("   (output cut at 64 KB)"));
  }
}

/** on|off|status of one switch. Turning one back on is a person's, typed at this machine (never an agent's). */
export async function switchCmd(ctx: Ctx, key: "agent_admin" | "remote_admin", action: string | undefined): Promise<number> {
  const label = key === "agent_admin" ? "agent admin" : "remote admin";
  const agent = adminCaller(ctx).kind === "agent";
  const client: WalkieClient = agent ? ctx.client({ underAgent: true }) : ctx.client();
  if (action === undefined || action === "status") {
    const v = await client.admin(0);
    if (ctx.json) ctx.out(JSON.stringify({ [key]: v[key] }));
    else ctx.out(`${label}: ${v[key] ? c.green("on") : c.yellow("off")}${switchHint(key, v[key])}`);
    return EXIT.ok;
  }
  if (action !== "on" && action !== "off") throw new UsageError(`${label} on|off|status`);
  if (action === "on") {
    if (agent) throw new UsageError(`${label} is turned back on by this machine's person, in their own terminal or the dashboard, never by an agent`);
    await requirePerson(ctx, `turn ${label} back on`, "yes");
  }
  const v = await client.adminSwitches({ [key]: action === "on" });
  if (ctx.json) ctx.out(JSON.stringify(v));
  else ctx.out(`${label}: ${v[key] ? c.green("on") : c.yellow("off")}${switchHint(key, v[key])}`);
  return EXIT.ok;
}

function switchHint(key: "agent_admin" | "remote_admin", on: boolean): string {
  if (key === "agent_admin") {
    return c.dim(on ? " — agents on this machine may set Walkie up for you (audited in #general); off: walkie agents admin off"
      : " — agents here are refused setup; turn it back on yourself: walkie agents admin on");
  }
  return c.dim(on ? " — team owners (and your own other machines) may run allow-listed walkie commands here; off: walkie admin remote off"
    : " — nobody can administer this machine remotely; turn it back on yourself: walkie admin remote on");
}

function statusLines(v: AdminView): string[] {
  const out = [
    `${c.bold(v.machine)}  agent admin ${v.agent_admin ? c.green("on") : c.yellow("off")} · remote admin ${v.remote_admin ? c.green("on") : c.yellow("off")}`,
  ];
  if (!v.audit.length) out.push(c.dim("no admin actions recorded on this machine yet"));
  for (const a of v.audit) {
    out.push(`${c.dim(ago(Date.now() - a.ts).padStart(4))} ${safeTerm(a.actor)} ${a.via === "remote" ? c.dim("(remote) ") : ""}${safeTerm(a.action)}${a.refused ? c.red(` [refused: ${a.refused}]`) : ""}`);
  }
  return out;
}

async function machines(ctx: Ctx): Promise<number> {
  const v = await ctx.client().adminMachines();
  if (ctx.json) { ctx.out(JSON.stringify(v)); return EXIT.ok; }
  for (const m of v.machines) {
    const state = m.online ? c.green("online") : c.dim("offline");
    ctx.out(`${m.can_admin ? c.green("✓") : c.dim("·")} ${safeTerm(m.hostname).padEnd(24)} @${safeTerm(m.handle ?? "?").padEnd(10)} ${state}${m.self ? c.dim(" (this machine)") : ""}${m.last_result ? c.dim(` last: ${m.last_result}`) : ""}${m.can_admin ? "" : c.dim(` — ${safeTerm(m.why ?? "")}`)}`);
  }
  ctx.out(c.dim(`remote: walkie admin --machine <host> <command…> (allowed: ${Object.keys(REMOTE_COMMANDS).join(", ")})`));
  return EXIT.ok;
}

export async function admin(ctx: Ctx): Promise<number> {
  const sub = ctx.args.pos[0] ?? "status";
  switch (sub) {
    case "status": {
      const v = await ctx.client().admin(Number(ctx.args.flags.get("limit") ?? 10) || 10);
      if (ctx.json) ctx.out(JSON.stringify(v)); else for (const l of statusLines(v)) ctx.out(l);
      return EXIT.ok;
    }
    case "log": {
      const v = await ctx.client().admin(Number(ctx.args.flags.get("limit") ?? 50) || 50);
      if (ctx.json) ctx.out(JSON.stringify({ audit: v.audit })); else for (const l of statusLines(v).slice(1)) ctx.out(l);
      return EXIT.ok;
    }
    case "machines": return machines(ctx);
    case "agents": return switchCmd(ctx, "agent_admin", ctx.args.pos[1]);
    case "remote": return switchCmd(ctx, "remote_admin", ctx.args.pos[1]);
    default: throw new UsageError(`unknown: walkie admin ${need(ctx.args, 0, "subcommand")} (${ADMIN_USAGE})`);
  }
}
