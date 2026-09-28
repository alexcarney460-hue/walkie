// "This should all be handled by the sign-up link" (Alex, SEATS product requirement): once a teammate joins and says
// yes to "let your team start agents on this machine", the team can start agents there over Walkie alone, on the
// machine's own Claude/Codex sign-in. Three commands for that:
//   walkie seats enable [--yes] [--same-user] [--accept-readable-home] [--launchers …] [--max n]
//       one command (the installer's and `walkie setup --allow-seats`'s too): seat users set up if they aren't (its
//       only interactive step: the person's sudo for the root helper), seats allowed, then what it did and the doctor;
//   walkie seats doctor     whether this machine is ready to take seats, and what fixes each thing that isn't;
//   walkie seats start <machine> --count N --provider claude|codex (--prompt "…" | --brief file.md)
//       N seats on a teammate's machine from here (the dashboard's launch form has the same "How many").
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WalkieClient } from "../../client/index.ts";
import { RELEASE_BUILD } from "../../license/service.ts";
import { DEFAULT_ADMIN, DEFAULT_RUNNER, RUNTIMES_DIR, SEAT_ROOTS_FILE, runnerPathProblem } from "../../daemon/seats/seat-user.ts";
import { helperVersion, helperVersionProblem, type HelperVersion, type HelperVersionDeps } from "../../daemon/seats/helper-version.ts";
import { VERSION } from "../../daemon/version.ts";
import { MAX_CONCURRENT_LIMIT, SEAT_MODES, SEAT_RUNTIMES, type SeatMode, type SeatRuntime, type SeatsLocalView } from "../../protocol/seats.ts";
import { bool, int, need, str, UsageError } from "../args.ts";
import { EXIT, readStdin, requirePerson, type Ctx } from "../context.ts";
import { adminCaller } from "../admin-gate.ts";
import { askHidden } from "../prompt.ts";
import { teamAgentsFlag } from "./team-agents.ts";
import { c, safeTerm } from "../format.ts";
import { seatUserSetup } from "./seat-user.ts";

/**
 * The one consent flag (ADD-MACHINE-1: the installer asks with it): `--allow-team-agents` / `--no-team-agents`, with
 * `--allow-seats` / `--no-seats` as aliases.
 */
export function allowTeamAgents(ctx: Pick<Ctx, "args">): boolean {
  return teamAgentsFlag(ctx) === "yes";
}
export function noTeamAgents(ctx: Pick<Ctx, "args">): boolean {
  return teamAgentsFlag(ctx) === "no";
}

/** At most this many seats per `seats start` (a host's own `max` still applies: the rest queue there). */
export const MAX_START_COUNT = 10;

export interface EnableOptions {
  sameUser?: boolean; acceptReadableHome?: boolean; launchers?: string[]; max?: number;
  /**
   * A Claude token for seats only (from `claude setup-token`), set in the same step (ADD-MACHINE-1 finding 5):
   * `walkie seats enable --claude-token-stdin`, or typed at a hidden prompt when this Mac's login is Keychain-only.
   */
  claudeToken?: string;
  /** Ask for that token at a hidden prompt when Claude seats would have no login (a terminal only). */
  askClaudeToken?: boolean;
  /** The daemon to talk to (default: ctx.client()). */
  client?: WalkieClient;
  /** Tests: sets up seat users (default: seatUserSetup with --apply, the person's own sudo). */
  setupSeatUsers?: (ctx: Ctx, accept: boolean) => Promise<{ ok: boolean; applied: boolean; why?: string }>;
}

/**
 * Seats on, as fresh seat users (set up first when they aren't), or as the person with `sameUser`. Returns the view,
 * or null when it couldn't (already said why). Prints each thing it did.
 */
export async function enableSeats(ctx: Ctx, o: EnableOptions = {}): Promise<SeatsLocalView | null> {
  const client = o.client ?? ctx.client();
  const before = (await client.seats()).local;
  const did: string[] = [];
  // Asked before anything is set up (the daemon refuses it anyway): which one to turn off (Opus seats r9 HIGH).
  if (before.pool_conflict) {
    ctx.err(c.red(`seats were not turned on: ${before.pool_conflict}`));
    return null;
  }
  if (!o.sameUser && !before.ephemeral) {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      ctx.err(c.red(`seat users are set up on macOS and Linux only (this is ${process.platform}); seats as your own user: walkie seats enable --same-user`));
      return null;
    }
    ctx.out(c.bold("Setting up seat users (a fresh OS user per seat, removed after it): sudo asks for your password once"));
    const r = await (o.setupSeatUsers ?? ((x, accept) => seatUserSetup(x, { apply: true, accept, plan: false })))(ctx, o.acceptReadableHome === true);
    if (!r.ok) {
      ctx.err(c.red(`seats were not turned on: ${r.why ?? "seat users could not be set up"}`));
      return null;
    }
    did.push(`set up seat users: the group walkie-seats, the root-owned runner and user helper in ${RUNTIMES_DIR.replace(/\/runtimes$/, "")}, their sudo rules`);
  } else if (before.ephemeral) {
    did.push("seat users were already set up");
  }
  // A dedicated Claude token is checked and stored BEFORE seats are allowed (Codex r8 MEDIUM 5): no launch in between
  // may get the machine's own login instead.
  const pre = (await client.seats()).local;
  if (!o.claudeToken && o.askClaudeToken && pre.claude_login === "unavailable" && !o.sameUser && process.stdin.isTTY) {
    ctx.out("This machine's Claude login is in its Keychain, which seat users can't use. Give seats a token of their own:");
    ctx.out(c.dim("run `claude setup-token` in another terminal, then paste the token here (hidden; Enter skips)."));
    const typed = (await askHidden("Claude token for seats: ")).text.trim();
    if (typed) o = { ...o, claudeToken: typed };
  }
  if (o.claudeToken) {
    const token = extractClaudeToken(o.claudeToken);
    if (!token) {
      ctx.err(c.red("that isn't a Claude token (claude setup-token prints one starting sk-ant-): seats were not turned on"));
      return null;
    }
    await client.seatsToken(token);
    did.push("a Claude token for seats only is set (0600 in the Walkie home; never echoed)");
  }
  const res = await client.seatsConfig({
    allow: true, ...(o.sameUser ? { same_user: true } : {}),
    ...(o.acceptReadableHome ? { accept_readable_home: true } : {}),
    ...(o.launchers ? { launchers: o.launchers } : {}), ...(o.max ? { max: o.max } : {}),
  });
  const local = res.local;
  did.push(`seats allowed: ${local.launchers?.length ? local.launchers.join(", ") : "the team's owners"} may start up to ${local.max ?? 3} at once here${o.sameUser ? ", as your own OS user" : ", each as a fresh seat user"}`);
  ctx.out(c.green("Seats are on for this machine."));
  for (const d of did) ctx.out(`  ${c.green("✓")} ${d}`);
  if (local.channel_ok === false) {
    // The seats channel is made through the team's roster authority (ADD-MACHINE-1 finding 3): offline, it is queued.
    ctx.out(`  ${c.yellow("!")} the seats channel waits for the team's roster authority (an owner's machine) to be online`
      + ` (${local.channel_error ?? "queued"}): nothing to do, seats start taking launches once it is; walkie seats doctor shows it`);
  }
  return local;
}

/** A Claude setup-token in `text` (the whole output of `claude setup-token` may be piped in), or null. */
export function extractClaudeToken(text: string): string | null {
  const m = /sk-ant-[A-Za-z0-9_-]{8,4000}/.exec(text);
  if (m) return m[0];
  const t = text.trim();
  return /^[A-Za-z0-9._~+/=-]{20,4096}$/.test(t) ? t : null;
}

// ---- doctor --------------------------------------------------------------------------------------------------

export type Check = { ok: boolean | "warn"; what: string; fix?: string };

/** What the doctor looks at on this machine besides the daemon's view (injectable for tests). */
export interface DoctorFacts {
  team: string | null;
  release: boolean;
  /** For seat users: the runner/helper paths' problems, sudo reaching the helper, the helper's roots file. */
  runnerProblem: string | null;
  helper: "ok" | string;
  rootsFile: "ok" | string;
  /** The runtimes seats would run: found or not. */
  runtimes: Record<"claude" | "codex", string | null>;
  /** The installed runner and helper's versions against this walkie (release builds with seat users; else absent). */
  helperVersion?: HelperVersion | null;
}

export function doctorChecks(local: SeatsLocalView, f: DoctorFacts): Check[] {
  const out: Check[] = [];
  out.push(f.team ? { ok: true, what: `in the team ${f.team}` } : { ok: false, what: "not in a team", fix: "walkie setup (or walkie join <invite>)" });
  out.push(local.allow ? { ok: true, what: "seats allowed" } : { ok: false, what: "seats are off here", fix: "walkie seats enable" });
  if (local.disabled_reason) out.push({ ok: false, what: `seats don't run: ${local.disabled_reason}` });
  if (local.allow && !local.channel_ok) {
    const waiting = /offline|queued|waiting/i.test(local.channel_error ?? "waiting");
    out.push(waiting
      ? { ok: "warn", what: `the seats channel waits for the team's roster authority: ${local.channel_error ?? "waiting"}`, fix: "nothing to do: it completes when an owner's machine is online" }
      : { ok: false, what: `the seats channel isn't ready: ${local.channel_error}` });
  }
  if (local.ephemeral) {
    out.push({ ok: true, what: "every seat runs as a fresh OS user, removed after it" });
    if (f.release) out.push(f.runnerProblem ? { ok: false, what: `the seat runner and helper: ${f.runnerProblem}`, fix: "walkie seats setup-user --apply" } : { ok: true, what: "the runner and user helper are root's" });
    if (f.release) out.push(f.helper === "ok" ? { ok: true, what: "sudo reaches the user helper without a password" } : { ok: false, what: `the user helper: ${f.helper}`, fix: "walkie seats setup-user --apply" });
    if (f.release) out.push(f.rootsFile === "ok" ? { ok: true, what: "the helper knows this machine's world-writable directories" } : { ok: false, what: f.rootsFile, fix: "walkie seats setup-user --apply" });
    // `walkie update` replaces walkie, never the root-owned copies: a stale one lacks this release's helper fixes.
    if (f.release && !f.runnerProblem && f.helperVersion) {
      const v = f.helperVersion;
      const problem = helperVersionProblem(v);
      out.push(!problem ? { ok: true, what: `the runner and user helper are this Walkie's (${v.want})` }
        : { ok: v.state === "stale" ? false : "warn", what: problem, fix: "walkie seats setup-user --apply" });
    }
  } else if (local.same_user) {
    out.push({ ok: "warn", what: "seats run as YOUR OS user (they can reach your Walkie and your files)", fix: "walkie seats setup-user --apply" });
  } else {
    out.push({ ok: false, what: "no seat users set up", fix: "walkie seats enable" });
  }
  const claudeBin = f.runtimes.claude;
  const claudeLogin = local.claude_login === "dedicated" ? "a token set for seats only"
    : local.claude_login === "machine" ? "this machine's own login" : null;
  out.push(!claudeBin ? { ok: false, what: "Claude Code isn't installed where seats can run it", fix: local.ephemeral ? "install claude, then walkie seats setup-user --apply" : "install claude" }
    : claudeLogin ? { ok: true, what: `Claude seats: logged in (${claudeLogin})` }
    : { ok: false, what: "Claude seats: this machine's Claude login is only in its Keychain, which seat users can't use", fix: "claude setup-token, then walkie seats token set < token.txt" });
  const codexBin = f.runtimes.codex;
  out.push(!codexBin ? { ok: "warn", what: "Codex isn't installed where seats can run it (only Claude seats)", fix: local.ephemeral ? "install codex, then walkie seats setup-user --apply" : "install codex" }
    : local.codex_login === "unavailable" ? { ok: false, what: "Codex seats: not signed in where seat users can use it (no ~/.codex/auth.json)", fix: "codex login" }
    : { ok: true, what: "Codex seats: signed in (this machine's own sign-in)" });
  if (local.reconcile_error) out.push({ ok: false, what: `new seats wait: the seat users the helper still holds couldn't be listed (${local.reconcile_error})`, fix: "walkie seats setup-user --apply (reinstalls the helper and its sudo rule); Walkie retries by itself every 30 s, no restart needed" });
  if (local.quarantined?.length) out.push({ ok: false, what: `seat users not verified removed: ${local.quarantined.join(", ")}`, fix: "see walkie seats (the reason), https://github.com/alexcarney460-hue/walkie/blob/main/docs/INSTALL.md#8-remote-seats-optional" });
  if (local.availability?.state === "busy") out.push({ ok: "warn", what: "this machine is busy (its person is using it): new seats queue", fix: "walkie seats resume" });
  if (!f.release && local.ephemeral) out.push({ ok: "warn", what: "a source build: its own runner and helper, not the installed ones (not checked)" });
  return out;
}

/** The facts the doctor needs, read from this machine (`versionDeps`: tests, a fake `version` run). */
export function doctorFacts(local: SeatsLocalView, team: string | null, versionDeps?: HelperVersionDeps): DoctorFacts {
  // A source build runs its own runner and helper (never the installed ones): those aren't checked.
  const installed = local.ephemeral && RELEASE_BUILD;
  const runner = DEFAULT_RUNNER;
  const runnerProblem = installed ? runnerPathProblem(runner) ?? runnerPathProblem(DEFAULT_ADMIN) : null;
  let helper: string = "ok";
  if (installed) {
    const p = Bun.spawnSync(["sudo", "-n", DEFAULT_ADMIN, "seat-admin", "pending"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: "/", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
    const out = p.stdout.toString().trim();
    helper = out.startsWith('{"ok":true') ? "ok" : `sudo -n ${DEFAULT_ADMIN} seat-admin pending didn't answer (${(out || p.stderr.toString().trim()).slice(0, 160)})`;
  }
  let rootsFile = "ok";
  if (installed) {
    const f = join(DEFAULT_ADMIN.replace(/\/[^/]+$/, ""), SEAT_ROOTS_FILE);
    try { JSON.parse(readFileSync(f, "utf8")); } catch { rootsFile = `${f} is missing or unreadable`; }
  }
  const found = (r: SeatRuntime): string | null => {
    if (installed) { const p = join(RUNTIMES_DIR, r); return existsSync(p) ? p : null; }
    for (const d of (process.env.PATH ?? "").split(":")) { const p = join(d, r); try { if (statSync(p).isFile()) return p; } catch { /* next */ } }
    return null;
  };
  const helperVersionFact = installed && !runnerProblem ? helperVersion([runner, DEFAULT_ADMIN], VERSION, versionDeps) : null;
  return { team, release: RELEASE_BUILD, runnerProblem, helper, rootsFile, runtimes: { claude: found("claude"), codex: found("codex") }, helperVersion: helperVersionFact };
}

export function doctorLines(checks: Check[]): string[] {
  const lines = checks.map((k) => `  ${k.ok === true ? c.green("✓") : k.ok === "warn" ? c.yellow("!") : c.red("✗")} ${k.what}${k.fix && k.ok !== true ? c.dim(`  → ${k.fix}`) : ""}`);
  const bad = checks.filter((k) => k.ok === false);
  const claudeOk = checks.some((k) => k.ok === true && k.what.startsWith("Claude seats: logged in"));
  const codexOk = checks.some((k) => k.ok === true && k.what.startsWith("Codex seats: signed in"));
  const ready = bad.filter((k) => !k.what.startsWith("Claude seats") && !k.what.startsWith("Codex seats") && !k.what.startsWith("Claude Code isn't")).length === 0;
  const which = [claudeOk ? "Claude" : "", codexOk ? "Codex" : ""].filter(Boolean).join(" and ");
  lines.push(ready && which
    ? c.green(`Ready: the team can start ${which} seats on this machine.`)
    : c.red(`Not ready${bad.length ? `: fix the ${bad.length === 1 ? "item" : `${bad.length} items`} marked ✗` : ""}.`));
  return lines;
}

async function doctor(ctx: Ctx): Promise<number> {
  const client = ctx.client();
  const [{ local }, me] = await Promise.all([client.seats(), client.me()]);
  const checks = doctorChecks(local, doctorFacts(local, me.team?.name ?? null));
  if (ctx.json) { ctx.out(JSON.stringify({ checks })); return checks.some((k) => k.ok === false) ? EXIT.error : EXIT.ok; }
  ctx.out(c.bold("Seats on this machine"));
  for (const l of doctorLines(checks)) ctx.out(l);
  return checks.some((k) => k.ok === false) ? EXIT.error : EXIT.ok;
}

// ---- enable --------------------------------------------------------------------------------------------------

async function enable(ctx: Ctx): Promise<number> {
  // A person types "yes" at their terminal unless `--yes` (or --allow-team-agents) answers for them; an agent of theirs
  // (AGENT-ADMIN-1: seats.ts adminCtx checked agent admin is on) goes ahead with the flags it gave, audited.
  const yes = bool(ctx.args, "yes") || allowTeamAgents(ctx) || adminCaller(ctx).kind === "agent";
  const sameUser = bool(ctx.args, "same-user");
  if (!yes) {
    ctx.out("This lets your team's owners start Claude Code / Codex agents on this machine (remote code execution, on purpose),");
    ctx.out(sameUser ? "as your own OS user." : "each as a fresh OS user of its own, removed after it. Turn it off any time: walkie seats deny.");
    await requirePerson(ctx, "let your team start agents on this machine", "yes");
  }
  const launchers = str(ctx.args, "launchers")?.split(",").map((s) => s.trim()).filter(Boolean);
  const max = int(ctx.args, "max");
  const claudeToken = bool(ctx.args, "claude-token-stdin") ? await readStdin() : undefined;
  const local = await enableSeats(ctx, {
    sameUser, acceptReadableHome: bool(ctx.args, "accept-readable-home"), ...(launchers ? { launchers } : {}), ...(max ? { max } : {}),
    ...(claudeToken !== undefined ? { claudeToken } : {}), askClaudeToken: !ctx.json,
  });
  if (!local) return EXIT.error;
  const me = await ctx.client().me();
  const checks = doctorChecks(local, doctorFacts(local, me.team?.name ?? null));
  if (ctx.json) { ctx.out(JSON.stringify({ local, checks })); return EXIT.ok; }
  for (const l of doctorLines(checks)) ctx.out(l);
  ctx.out(c.dim("Turn seats off (and stop every running one) any time: walkie seats deny"));
  return EXIT.ok;
}

// ---- start ---------------------------------------------------------------------------------------------------

async function start(ctx: Ctx): Promise<number> {
  const machine = need(ctx.args, 1, "machine (see: walkie seats)");
  const count = int(ctx.args, "count") ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_START_COUNT) throw new UsageError(`--count must be 1–${MAX_START_COUNT}`);
  const provider = (str(ctx.args, "provider") ?? str(ctx.args, "runtime") ?? "claude") as SeatRuntime;
  if (!SEAT_RUNTIMES.includes(provider)) throw new UsageError(`--provider must be one of ${SEAT_RUNTIMES.join(", ")}`);
  const mode = str(ctx.args, "permission-mode") as SeatMode | undefined;
  if (mode !== undefined && !SEAT_MODES.includes(mode)) throw new UsageError(`--permission-mode must be one of ${SEAT_MODES.join(", ")}`);
  const brief = str(ctx.args, "brief");
  const promptArg = str(ctx.args, "prompt");
  if ((brief ? 1 : 0) + (promptArg ? 1 : 0) !== 1) throw new UsageError("give the task with --prompt \"…\" or --brief <file> (- reads stdin)");
  const prompt = brief ? (brief === "-" ? await readStdin() : readFileSync(resolve(brief), "utf8")) : (promptArg as string);
  if (!prompt.trim()) throw new UsageError("the task is empty");
  const client: WalkieClient = ctx.client();
  const team = await client.team();
  const node = team.nodes.find((n) => n.node_id === machine || n.hostname === machine);
  if (!node) throw new UsageError(`no machine ${machine} in the team (see: walkie seats)`);
  const timeout = int(ctx.args, "timeout");
  const maxConcurrent = int(ctx.args, "max-concurrent");
  if (maxConcurrent !== undefined && (maxConcurrent < 1 || maxConcurrent > MAX_CONCURRENT_LIMIT)) throw new UsageError(`--max-concurrent must be 1–${MAX_CONCURRENT_LIMIT}`);
  const model = str(ctx.args, "model");
  const started: Array<{ seat: string; queued: boolean }> = [];
  const failed: string[] = [];
  for (let i = 0; i < count; i++) {
    try {
      const res = await client.seatRun({
        machine: node.node_id, runtime: provider, prompt, ...(model ? { model } : {}), ...(mode ? { permission_mode: mode } : {}),
        ...(timeout !== undefined ? { timeout_s: timeout } : {}), ...(maxConcurrent !== undefined ? { max_concurrent: maxConcurrent } : {}),
      });
      const a = res.host.availability;
      started.push({ seat: res.seat, queued: a?.state === "busy" });
    } catch (err) {
      failed.push((err as Error).message);
      break; // the next would fail the same way (rate limit, not allowed, offline)
    }
  }
  if (ctx.json) { ctx.out(JSON.stringify({ machine: node.hostname, started, failed })); return failed.length ? EXIT.error : EXIT.ok; }
  if (started.length) {
    ctx.out(`${c.green("requested")} ${started.length} ${provider} seat${started.length === 1 ? "" : "s"} on ${node.hostname}${started.some((s) => s.queued) ? c.yellow(" (its person is using it: they queue)") : ""}`);
    for (const s of started) ctx.out(`  ${s.seat}`);
    ctx.out(c.dim(`follow one: walkie seat show <id> --follow · all of them: walkie seats · stop one: walkie seat stop <id>`));
  }
  for (const f of failed) ctx.err(c.red(`not started${started.length ? ` (after ${started.length})` : ""}: ${safeTerm(f)}`));
  return failed.length ? EXIT.error : EXIT.ok;
}

export const enableCommand = enable;
export const doctorCommand = doctor;
export const startCommand = start;
