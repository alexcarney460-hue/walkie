// walkie daemon start|stop|status|run|install|uninstall
// start and stop take --json: one result object on stdout (src/cli/json-result.ts), prose on stderr.
import { spawn } from "node:child_process";
import { noteChildProcess } from "../../daemon/adopted-zombies.ts";
import { existsSync, openSync, readFileSync } from "node:fs";
import { WalkieClient } from "../../client/index.ts";
import { runForeground } from "../../daemon/main.ts";
import { defaultHome, ensureHome, pathsFor } from "../../daemon/paths.ts";
import { daemonCommand, installService, uninstallService, type ServicePlan } from "../../daemon/service.ts";
import { bool, need, UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { c } from "../format.ts";
import { runJsonCommand, type JsonOutcome } from "../json-result.ts";

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

async function start(ctx: Ctx): Promise<JsonOutcome> {
  if ((await up()).ok) { ctx.out("daemon already running"); return { exit: EXIT.ok, facts: { state: "already_running" } }; }
  const paths = pathsFor(defaultHome());
  ensureHome(paths);
  const out = openSync(paths.out, "a", 0o600);
  const [cmd, ...args] = daemonCommand();
  const child = spawn(cmd as string, args, { detached: true, stdio: ["ignore", out, out], env: process.env });
  noteChildProcess(child);
  child.unref();
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(100);
    if ((await up()).ok) { ctx.out(`${c.green("daemon started")} (pid ${child.pid}); logs: ${paths.log}`); return { exit: EXIT.ok, facts: { state: "started", pid: child.pid ?? null, log: paths.log } }; }
    if (child.exitCode !== null) break;
  }
  const message = `daemon did not come up; see ${paths.out}`;
  ctx.err(c.red(message));
  return { exit: EXIT.error, error: { code: "daemon_start_failed", message }, facts: { output: paths.out } };
}

/**
 * How long `walkie daemon stop` waits for the daemon to exit after SIGTERM. The daemon shuts down in bounded steps (stop() in
 * src/daemon/main.ts): the orchestrator's halt comes first (up to 2 s), then running seats get up to 14 s
 * (src/daemon/seats/host.ts close()), then the rest of the teardown. It keeps answering on its socket until its listeners close,
 * which is after the seats, so a shorter wait gave up on a shutdown that was still going, and an immediate `walkie daemon start`
 * then found that dying daemon "already running".
 */
export const STOP_WAIT_MS = 30_000;

/** How far into the wait `walkie daemon stop` says what it is waiting for (running seats), if it is still waiting. */
export const STOP_NOTICE_AFTER_MS = 3_000;

/** The clock and the process calls `stop` makes; tests substitute a clock of their own and a daemon that leaves when they say. */
export interface StopSys {
  now(): number;
  sleep(ms: number): Promise<void>;
  alive(pid: number): boolean;
  /** Asks the daemon to shut down (SIGTERM). */
  terminate(pid: number): void;
}

const realSys: StopSys = {
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
  alive,
  terminate(pid) { process.kill(pid, "SIGTERM"); },
};

/** What `stop` reads from outside itself; tests substitute each. */
export interface StopDeps {
  /** How long to wait for the daemon to exit after SIGTERM (default STOP_WAIT_MS). */
  waitMs?: number;
  /** How far into the wait to say what it is waiting for, when that is running seats (default STOP_NOTICE_AFTER_MS). */
  noticeAfterMs?: number;
  /** How many seats run here now, or null when the daemon can't say (default: asks the daemon). */
  runningSeats?: () => Promise<number | null>;
  /** The clock and process calls (default: the real ones). */
  sys?: Partial<StopSys>;
}

/** Seats running on this machine, or null when the daemon can't say (not answering, an older one): a hint for the person, never a condition. */
async function runningSeats(): Promise<number | null> {
  try {
    const running = (await new WalkieClient({ timeoutMs: 1_000 }).seats()).local.running;
    return typeof running === "number" ? running : null;
  } catch {
    return null; // optional information: a daemon that is already closing its socket, or an older one, just doesn't give it
  }
}

/** SIGTERM once (never again: a second one would cut the daemon's own shutdown short), then wait for the pid to go. */
export async function stop(ctx: Ctx, deps: StopDeps = {}): Promise<number> {
  return (await stopRun(ctx, deps)).exit;
}

async function stopRun(ctx: Ctx, deps: StopDeps): Promise<JsonOutcome> {
  const sys: StopSys = { ...realSys, ...deps.sys };
  const waitMs = deps.waitMs ?? STOP_WAIT_MS;
  const noticeAfterMs = deps.noticeAfterMs ?? STOP_NOTICE_AFTER_MS;
  const seatCount = deps.runningSeats ?? runningSeats;
  const paths = pathsFor(defaultHome());
  const pid = readPid(paths.pid);
  if (!pid || !sys.alive(pid)) {
    const running = (await up()).ok;
    ctx.out(running ? c.yellow("daemon is running but has no pid file (managed by launchd/systemd?)") : "daemon not running");
    return { exit: EXIT.ok, facts: { state: running ? "running_unmanaged" : "not_running" } };
  }
  sys.terminate(pid);
  const started = sys.now();
  let asked = false;
  for (;;) {
    await sys.sleep(100);
    if (!sys.alive(pid)) { ctx.out(c.green("daemon stopped")); return { exit: EXIT.ok, facts: { state: "stopped", pid } }; }
    const waited = sys.now() - started;
    if (waited >= waitMs) break;
    if (!asked && waited >= noticeAfterMs) {
      asked = true; // once: a slow shutdown is told what it waits for, a quick one never asks
      const seats = await seatCount();
      if (seats !== null && seats > 0) ctx.out(`waiting for ${seats} running seat${seats === 1 ? "" : "s"} to finish before the daemon exits (up to ${waitMs / 1000} s)…`);
    }
  }
  const message = `daemon (pid ${pid}) did not exit within ${waitMs / 1000}s`;
  ctx.err(c.red(message));
  return { exit: EXIT.error, error: { code: "daemon_stop_timeout", message }, facts: { pid } };
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
    case "start": return ctx.json ? runJsonCommand(ctx, "daemon start", start) : (await start(ctx)).exit;
    case "stop": return ctx.json ? runJsonCommand(ctx, "daemon stop", (quiet) => stopRun(quiet, {})) : stop(ctx);
    // No such verb: with --json the refusal is still the one parseable object (the exit code and prose are the usage error's).
    case "restart": if (ctx.json) return runJsonCommand(ctx, "daemon restart", async () => { throw new UsageError(`unknown daemon subcommand: ${sub}`); }); throw new UsageError(`unknown daemon subcommand: ${sub}`);
    case "status": return status(ctx);
    case "run": await runForeground(); return EXIT.ok;
    case "install": ctx.out(describe(await installService(defaultHome(), dry), "install", dry)); return EXIT.ok;
    case "uninstall": ctx.out(describe(await uninstallService(defaultHome(), dry), "uninstall", dry)); return EXIT.ok;
    default: throw new UsageError(`unknown daemon subcommand: ${sub}`);
  }
}
