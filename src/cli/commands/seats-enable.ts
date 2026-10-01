// "This should all be handled by the sign-up link" (Alex, SEATS product requirement): once a teammate joins and says
// yes to "let your team start agents on this machine", the team can start agents there over Walkie alone, on the
// machine's own Claude/Codex sign-in. Three commands for that:
//   walkie seats enable [--yes] [--seat-users|--same-user] [--launchers …] [--max n]
//       one command: company same-user seats by default, or explicit seat-user hardening, then doctor;
//   walkie seats doctor     whether this machine is ready to take seats, and what fixes each thing that isn't;
//   walkie seats start <machine> --count N --provider claude|codex (--prompt "…" | --brief file.md)
//       N seats on a teammate's machine from here (the dashboard's launch form has the same "How many").
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WalkieClient } from "../../client/index.ts";
import { RUNTIMES_DIR } from "../../daemon/seats/seat-user.ts";
import { doctorChecks, doctorFacts, type Check } from "../../daemon/seats/doctor.ts";
import { MAX_CONCURRENT_LIMIT, SEAT_MODES, SEAT_RUNTIMES, launcherPolicyLabel, parseLauncher, type SeatMode, type SeatRuntime, type SeatsLocalView } from "../../protocol/seats.ts";
import { enrollmentMode, readGrant } from "../../daemon/provision/grant.ts";
import { probeWorkerLeases, workerAccountChecks } from "../../daemon/seats/enrollment-account.ts";
import { defaultHome } from "../../daemon/paths.ts";
import { wslKeepaliveChecks } from "../../daemon/seats/wsl-keepalive.ts";
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

export function enableConsentLine(): string {
  return "This lets your team's owners and every agent they run, or listed person launchers and every agent they run, start Claude Code / Codex agents on this machine (remote code execution, on purpose). Exact agent entries cover only that agent.";
}

export function launcherSummary(entries: readonly string[]): string {
  return entries.map((entry) => {
    const parsed = parseLauncher(entry);
    if (!parsed) return entry;
    if (parsed.agent) return `${entry} only`;
    return `${entry} and every agent they run${parsed.machine ? " on that machine" : ""}`;
  }).join(", ");
}

export interface EnableOptions {
  sameUser?: boolean; seatUsers?: boolean; inheritPersonConfig?: boolean; acceptReadableHome?: boolean; launchers?: string[]; max?: number;
  /**
   * A Claude token for seats only (from `claude setup-token`), set in the same step (ADD-MACHINE-1 finding 5):
   * `walkie seats enable --claude-token-stdin`, or typed at a hidden prompt when this Mac's login is Keychain-only.
   */
  claudeToken?: string;
  /** Ask for an optional override at a hidden prompt when Claude has no usable login (a terminal only). */
  askClaudeToken?: boolean;
  /** The daemon to talk to (default: ctx.client()). */
  client?: WalkieClient;
  /** Tests: sets up seat users (default: seatUserSetup with --apply, the person's own sudo). */
  setupSeatUsers?: (ctx: Ctx, accept: boolean) => Promise<{ ok: boolean; applied: boolean; why?: string }>;
}

/**
 * Seats on as this machine's person by default, preserving an existing seat-user mode. Returns the view,
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
  if (o.sameUser && o.seatUsers) { ctx.err(c.red("choose --same-user or --seat-users, not both")); return null; }
  const seatUsers = o.seatUsers === true || (!o.sameUser && before.ephemeral === true);
  if (o.sameUser && before.ephemeral) {
    ctx.err(c.red("seat-user migration requires the person here: run walkie seats migration-preflight, then walkie seats migrate --same-user"));
    return null;
  }
  if (seatUsers && !before.ephemeral) {
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
  } else if (seatUsers) {
    did.push("seat users were already set up");
  }
  // A dedicated Claude token is checked and stored BEFORE seats are allowed (Codex r8 MEDIUM 5): no launch in between
  // may get the machine's own login instead.
  const pre = (await client.seats()).local;
  if (!o.claudeToken && o.askClaudeToken && pre.claude_login === "unavailable" && seatUsers && process.stdin.isTTY) {
    ctx.out("This machine has no usable Claude access token for seats. Give seats a token of their own:");
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
    allow: true, ...(o.sameUser || o.seatUsers ? { mode: seatUsers ? "seat_users" as const : "same_user" as const } : {}), same_user: !seatUsers, ephemeral: seatUsers,
    ...(o.acceptReadableHome ? { accept_readable_home: true } : {}),
    ...(o.inheritPersonConfig ? { inherit_person_config: true } : {}),
    ...(o.launchers ? { launchers: o.launchers } : {}), ...(o.max ? { max: o.max } : {}),
  });
  const local = res.local;
  did.push(`seats allowed: ${local.launcher_policy_empty ? "nobody" : local.launchers?.length ? launcherSummary(local.launchers) : launcherPolicyLabel(local)} may start up to ${local.max ?? 3} at once here${seatUsers ? ", each as a fresh seat user" : ", as your own OS user"}`);
  ctx.out(c.green("Seats are on for this machine."));
  for (const d of did) ctx.out(`  ${c.green("✓")} ${d}`);
  ctx.out(local.claude_login === "dedicated"
    ? "Claude seats use the token set for seats only; a running seat can read it."
    : local.ephemeral
      ? "A running seat can read this machine's short-lived Claude access token, never the refresh token."
      : "A running seat can read everything you can, including your full Claude login.");
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

export function doctorLines(checks: Check[]): string[] {
  const lines = checks.map((k) => `  ${k.ok === true ? c.green("✓") : k.ok === "warn" ? c.yellow("!") : c.red("✗")} ${k.what}${k.fix && k.ok !== true ? c.dim(`  → ${k.fix}`) : ""}`);
  const bad = checks.filter((k) => k.ok === false);
  const enrolled = checks.some((k) => k.what.startsWith("owner Claude account"));
  const claudeOk = checks.some((k) => k.ok === true && k.what.startsWith(enrolled ? "owner Claude account" : "Claude seats: using"));
  const codexOk = checks.some((k) => k.ok === true && k.what.startsWith(enrolled ? "owner Codex account" : "Codex seats: signed in"));
  const ready = enrolled ? bad.length === 0
    : bad.filter((k) => !k.what.startsWith("Claude seats") && !k.what.startsWith("Claude Code isn't")).length === 0;
  const which = [claudeOk ? "Claude" : "", codexOk ? "Codex" : ""].filter(Boolean).join(" and ");
  lines.push(ready && which && (!enrolled || (claudeOk && codexOk))
    ? c.green(`Ready: the team can start ${which} seats on this machine.`)
    : c.red(`Not ready${bad.length ? `: fix the ${bad.length === 1 ? "item" : `${bad.length} items`} marked ✗` : ""}.`));
  return lines;
}

async function readinessChecks(client: WalkieClient, local: SeatsLocalView, me: Awaited<ReturnType<WalkieClient["me"]>>): Promise<Check[]> {
  let checks = doctorChecks(local, doctorFacts(local, me.team?.name ?? null));
  try {
    const grant = readGrant(defaultHome());
    const enrolled = local.enrolled ?? enrollmentMode(defaultHome());
    if (grant && !enrolled) checks.push({ ok: false, what: "root enrollment marker is missing: grant cannot authorize seats" });
    if (enrolled && !grant) {
      checks.push({ ok: false, what: "enrollment grant is missing: seats cannot launch", fix: "renew the grant through local consent, or disable seats and run walkie provision unenroll locally" });
    }
    if (grant) {
      // An enrolled company seat uses its owner binding, never the recipient's browser or default provider login.
      checks = checks.filter((k) => !/^(Claude seats:|Codex seats:|Claude's projected|Claude seats use)/.test(k.what));
      checks = checks.map((k) => k.what.startsWith("Codex isn't installed") || k.what.startsWith("the seats channel waits")
        ? { ...k, ok: false } : k);
      const [team, view] = await Promise.all([client.team(), client.accounts()]);
      const owner = team.nodes.find((n) => n.node_id === grant.owner_node)?.handle;
      if (!owner || !team.members.some((m) => m.handle === owner && m.role === "owner")) {
        checks.push({ ok: false, what: "owner account: waiting for current roster owner" });
      } else {
        const worker = workerAccountChecks(grant, { me: me.handle ?? "", owner, role: me.role,
          accounts: view.accounts, team: view.pool?.policy ?? "per-account" });
        checks.push(...await probeWorkerLeases(worker, (b) => client.vaultProbe(b)));
      }
    }
  } catch {
    checks.push({ ok: false, what: "owner account: private grant or vault view is unreadable" });
  }
  return checks;
}

async function doctor(ctx: Ctx): Promise<number> {
  const client = ctx.client();
  // The doctor is the explicit check: it asks the daemon to look at the sign-ins now (a status read serves the last answer).
  const [{ local }, me] = await Promise.all([client.seatsDoctor(), client.me()]);
  const checks = [...await readinessChecks(client, local, me), ...await wslKeepaliveChecks()];
  if (ctx.json) { ctx.out(JSON.stringify({ checks })); return checks.some((k) => k.ok === false) ? EXIT.error : EXIT.ok; }
  ctx.out(c.bold("Seats on this machine"));
  for (const l of doctorLines(checks)) ctx.out(l);
  return checks.some((k) => k.ok === false) ? EXIT.error : EXIT.ok;
}

// ---- enable --------------------------------------------------------------------------------------------------

async function enable(ctx: Ctx): Promise<number> {
  // A person types "yes" at their terminal unless `--yes` (or --allow-team-agents) answers for them; an agent of theirs
  // (AGENT-ADMIN-1: seats.ts adminCtx checked agent admin is on) goes ahead with the flags it gave, audited.
  // Moving seat users to same-user mode is not this command's: enableSeats refuses it, `seats migrate` is the person's.
  const yes = bool(ctx.args, "yes") || allowTeamAgents(ctx) || adminCaller(ctx).kind === "agent";
  const sameUser = bool(ctx.args, "same-user");
  const seatUsers = bool(ctx.args, "seat-users");
  if (sameUser && seatUsers) throw new UsageError("choose --same-user or --seat-users");
  if (!yes) {
    const before = (await ctx.client().seats()).local;
    ctx.out(enableConsentLine());
    const ownUser = sameUser || (!seatUsers && !before.ephemeral);
    ctx.out(ownUser ? "as your own OS user, with access to your files, keys and Walkie daemon." : "each as a fresh OS user of its own, removed after it. Turn it off any time: walkie seats deny.");
    if (ownUser) ctx.out("Only allow trusted launchers: Grok path and output checks cannot restrict your user's file access.");
    ctx.out(before.claude_login === "dedicated"
      ? "Claude seats use the token set for seats only; a running seat can read it."
      : ownUser ? "A running seat can read everything you can, including your full Claude login."
        : "A running seat can read this machine's short-lived Claude access token, never the refresh token.");
    await requirePerson(ctx, "let your team start agents on this machine", "yes");
  }
  const launchers = str(ctx.args, "launchers")?.split(",").map((s) => s.trim()).filter(Boolean);
  const max = int(ctx.args, "max");
  const claudeToken = bool(ctx.args, "claude-token-stdin") ? await readStdin() : undefined;
  const local = await enableSeats(ctx, {
    sameUser, seatUsers, inheritPersonConfig: bool(ctx.args, "inherit-person-config"), acceptReadableHome: bool(ctx.args, "accept-readable-home"), ...(launchers ? { launchers } : {}), ...(max ? { max } : {}),
    ...(claudeToken !== undefined ? { claudeToken } : {}), askClaudeToken: !ctx.json,
  });
  if (!local) return EXIT.error;
  const me = await ctx.client().me();
  const checks = [...await readinessChecks(ctx.client(), local, me), ...await wslKeepaliveChecks()];
  if (ctx.json) { ctx.out(JSON.stringify({ local, checks })); return checks.some((k) => k.ok === false) ? EXIT.error : EXIT.ok; }
  for (const l of doctorLines(checks)) ctx.out(l);
  ctx.out(c.dim("Turn seats off (and stop every running one) any time: walkie seats deny"));
  return checks.some((k) => k.ok === false) ? EXIT.error : EXIT.ok;
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
