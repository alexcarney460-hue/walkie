// walkie daemon start|stop|status|run|install|uninstall
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync } from "node:fs";
import { WalkieClient } from "../../client/index.ts";
import { runForeground } from "../../daemon/main.ts";
import { defaultHome, ensureHome, pathsFor } from "../../daemon/paths.ts";
import { daemonCommand, installService, uninstallService, type ServicePlan } from "../../daemon/service.ts";
import { bool, need, UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { c } from "../format.ts";

async function up(): Promise<{ ok: boolean; version?: string }> {
  try {
    const h = await new WalkieClient().healthz();
    return { ok: h.ok, version: h.version };
  } catch {
    return { ok: false };
  }
}

function readPid(path: string): number | null {
  if (!existsSync(path)) return null;
  const n = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function start(ctx: Ctx): Promise<number> {
  if ((await up()).ok) { ctx.out("daemon already running"); return EXIT.ok; }
  const paths = pathsFor(defaultHome());
  ensureHome(paths);
  const out = openSync(paths.out, "a", 0o600);
  const [cmd, ...args] = daemonCommand();
  const child = spawn(cmd as string, args, { detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(100);
    if ((await up()).ok) { ctx.out(`${c.green("daemon started")} (pid ${child.pid}); logs: ${paths.log}`); return EXIT.ok; }
    if (child.exitCode !== null) break;
  }
  ctx.err(c.red(`daemon did not come up; see ${paths.out}`));
  return EXIT.error;
}

async function stop(ctx: Ctx): Promise<number> {
  const paths = pathsFor(defaultHome());
  const pid = readPid(paths.pid);
  if (!pid || !alive(pid)) {
    ctx.out((await up()).ok ? c.yellow("daemon is running but has no pid file (managed by launchd/systemd?)") : "daemon not running");
    return EXIT.ok;
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(100);
    if (!alive(pid)) { ctx.out(c.green("daemon stopped")); return EXIT.ok; }
  }
  ctx.err(c.red(`daemon (pid ${pid}) did not exit within 10s`));
  return EXIT.error;
}

async function status(ctx: Ctx): Promise<number> {
  const paths = pathsFor(defaultHome());
  const h = await up();
  const pid = readPid(paths.pid);
  if (!h.ok) {
    ctx.out(ctx.json ? JSON.stringify({ running: false }) : `daemon not running (socket ${paths.socket})`);
    return EXIT.unreachable;
  }
  const me = await new WalkieClient().me();
  if (ctx.json) { ctx.out(JSON.stringify({ running: true, pid, version: h.version, me })); return EXIT.ok; }
  ctx.out(`${c.green("running")} v${h.version}${pid ? ` pid ${pid}` : ""} · node ${me.node.hostname} (${me.node.id}) · ${me.team ? `team ${me.team.name} as @${me.handle}` : "no team"}`);
  return EXIT.ok;
}

function describe(plan: ServicePlan, verb: string, dry: boolean): string {
  const lines = [`${dry ? "would " : ""}${verb} ${plan.platform} unit: ${plan.path}`];
  if (dry && verb === "install") lines.push("--- unit file ---", plan.content.trimEnd(), "---");
  for (const cmd of verb === "install" ? plan.load : plan.unload) lines.push(`${dry ? "would run" : "ran"}: ${cmd.join(" ")}`);
  return lines.join("\n");
}

export async function daemon(ctx: Ctx): Promise<number> {
  const sub = need(ctx.args, 0, "subcommand (start|stop|status|run|install|uninstall)");
  const dry = bool(ctx.args, "dry-run");
  switch (sub) {
    case "start": return start(ctx);
    case "stop": return stop(ctx);
    case "status": return status(ctx);
    case "run": await runForeground(); return EXIT.ok;
    case "install": ctx.out(describe(await installService(defaultHome(), dry), "install", dry)); return EXIT.ok;
    case "uninstall": ctx.out(describe(await uninstallService(defaultHome(), dry), "uninstall", dry)); return EXIT.ok;
    default: throw new UsageError(`unknown daemon subcommand: ${sub}`);
  }
}
