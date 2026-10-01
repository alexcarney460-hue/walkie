// walkie setup — one command from download to connected agents:
//   install the binary on PATH → run the daemon as a service → create or join a team → connect agents.
//   walkie setup                                  interactive (prompts for what it needs)
//   walkie setup --team "Our Team" --handle alex  create a team (Walkie Direct; --tailscale for a tailnet team)
//   walkie setup --invite wk1…                    join with a Walkie Direct invite code
//   walkie setup --join 100.101.102.103           join a Tailscale team through a teammate's machine
//   --no-service  --no-hooks  --bin-dir <dir>  --switching | --no-switching (account switching shims, ACCOUNTS-2)
//   --allow-team-agents | --no-team-agents        the answer to "let your team start agents here?" (no terminal: no)
//   --invite wk1… --company-machine --owner-ssh <packet>   the add-machine command: the packet (owner SSH) rides in the
//                                                  one company consent; --owner-ssh is refused without --company-machine
import { copyFileSync, chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { WalkieClient, WalkieError } from "../../client/index.ts";
import { isInviteCode } from "../../daemon/invite.ts";
import { defaultHome } from "../../daemon/paths.ts";
import { installService } from "../../daemon/service.ts";
import { VERSION } from "../../daemon/version.ts";
import { installClaude, installCodex } from "../../hooks/install.ts";
import { installShims, profileFile } from "../../switch/shims.ts";
import { recordClis } from "./vault.ts";
import { underAgent } from "../agent-output.ts";
import { askLine, PromptCancelled, type Answer } from "../prompt.ts";
import { bool, str, UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { c } from "../format.ts";
import type { MeView } from "../../protocol/schemas.ts";
import { inviteHint, transportFlag } from "./team.ts";
import { realRootBatch } from "../root-batch.ts";
import { realSshStepDeps } from "../ssh-enroll.ts";
import type { SshFinal } from "../ssh-ready.ts";
import { checkRuntime, installSeatUsers, teamAgentsFlag, teamAgentsStep, type TeamAgentsOutcome } from "./team-agents.ts";
import { RESTART_WAIT_MS, restartService, sameVersion, waitForDaemon as waitForVersion, type HealthProbe, type RestartDeps } from "./update.ts";

const compiled = (): boolean => import.meta.dir.startsWith("/$bunfs") || basename(process.execPath).startsWith("walkie");
const COMPANY_ENROLLMENT_INCOMPLETE = 4;

export function companyConsentExit(ctx: Ctx, outcome: TeamAgentsOutcome): number | null {
  if (!bool(ctx.args, "company-machine") || !["refused", "incomplete", "unsupported"].includes(outcome)) return null;
  ctx.err(c.yellow("Company enrollment is incomplete. Resolve the issue above, then run walkie setup --invite <private-code> --company-machine (with --owner-ssh <packet> when the link has one) on this machine's terminal and type yes."));
  return COMPANY_ENROLLMENT_INCOMPLETE;
}

/** Owner SSH was carried and did not become ready: everything else is set up, but the enrollment is not complete. */
export function sshEnrollmentExit(ctx: Ctx, result: SshFinal | null): number | null {
  if (result?.state !== "failed") return null;
  ctx.err(c.yellow("Company enrollment is incomplete: owner SSH is not ready (see above). Everything else was set up. Fix it as described, then run walkie ssh status."));
  return COMPANY_ENROLLMENT_INCOMPLETE;
}

function step(ctx: Ctx, n: number, text: string): void {
  ctx.out(`${c.bold(`${n}.`)} ${text}`);
}

async function ask(question: string, fallback?: string): Promise<string> {
  if (!process.stdin.isTTY) {
    if (fallback !== undefined) return fallback;
    throw new UsageError(`${question} (not a terminal: pass it as a flag, see walkie setup --help)`);
  }
  let a: Answer;
  try {
    a = await askLine(`   ${question}${fallback ? c.dim(` [${fallback}]`) : ""} `);
  } catch (e) {
    if (e instanceof PromptCancelled) throw new UsageError("setup cancelled (Ctrl-C): nothing more was changed");
    throw e;
  }
  if (a.how === "typed") return a.text || fallback || "";
  // No answer (the terminal went away, or none in time): the default, else stop with the flag to pass. Never hang.
  const why = a.how === "timeout" ? "no answer in time" : "no answer";
  if (fallback !== undefined) {
    if (fallback) process.stdout.write(`   ${c.dim(`(${why}: ${fallback})`)}\n`);
    return fallback;
  }
  throw new UsageError(`${question} (${why}: pass it as a flag, see walkie setup --help)`);
}

/** Copy a downloaded binary onto PATH and re-run setup from there, so the service and hooks point at a stable path. */
async function ensureInstalled(ctx: Ctx, argv: string[]): Promise<number | null> {
  if (!compiled() || process.env.WALKIE_SETUP_REEXEC === "1") return null;
  const dir = str(ctx.args, "bin-dir") ?? join(homedir(), ".local", "bin");
  const target = join(dir, "walkie");
  const self = realpathSync(process.execPath);
  if (existsSync(target) && realpathSync(target) === self) return null;
  mkdirSync(dir, { recursive: true });
  copyFileSync(self, target);
  chmodSync(target, 0o755);
  ctx.out(`${c.green("installed")} ${target}${(process.env.PATH ?? "").split(":").includes(dir) ? "" : c.yellow(`  (add ${dir} to your PATH)`)}`);
  const child = Bun.spawn([target, "setup", ...argv], { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, WALKIE_SETUP_REEXEC: "1" } });
  return await child.exited;
}

export interface ServiceDeps extends RestartDeps { install?: () => Promise<unknown> }

/**
 * Brings the background service to this binary's version: already running as VERSION → nothing to do; running
 * an older (or otherwise mismatched) version → restart it (update.ts's restartService, the same logic `walkie
 * update` uses) and wait for healthz to answer as VERSION; not running at all → install it fresh and wait. A
 * healthy old daemon is never left in place just because it answers healthz (WALK-50).
 */
export async function ensureService(ctx: Ctx, client: WalkieClient, deps: ServiceDeps = {}): Promise<boolean> {
  const probe: HealthProbe = deps.probe ?? (() => client.healthz());
  const health = await probe().catch((): { ok: boolean; version: string } => ({ ok: false, version: "" }));
  if (health.ok && sameVersion(health.version, VERSION)) {
    ctx.out(`   daemon already running (${VERSION})`);
    return true;
  }
  if (health.ok) {
    ctx.out(`   daemon running ${health.version}, not ${VERSION}; restarting…`);
    return restartService(ctx, VERSION, deps);
  }
  const install = deps.install ?? (() => installService(defaultHome(), false));
  await install();
  const limit = deps.timeoutMs ?? RESTART_WAIT_MS;
  const up = await waitForVersion(VERSION, probe, limit, deps.intervalMs);
  if (up.ok) { ctx.out(`   ${c.green("running")} (starts at login, restarts on crash), answering as ${VERSION} after ${(up.ms / 1000).toFixed(1)} s`); return true; }
  ctx.err(c.red(`   the daemon did not come up within ${limit / 1000} s (last: ${up.last}); run walkie doctor`));
  return false;
}

async function onPath(cmd: string): Promise<boolean> {
  try {
    const p = Bun.spawn(["/bin/sh", "-lc", `command -v ${cmd}`], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

function tailscaleMissing(me: MeView): WalkieError {
  return new WalkieError("tailscale_unavailable", `Tailscale isn't ready: ${me.tailscale.error ?? "sign in to Tailscale first"} (or join with a Walkie Direct invite code instead)`, 0);
}

/**
 * Create or join a team. Walkie Direct needs nothing else installed: a new team uses it unless --tailscale (or,
 * with Tailscale signed in, the person picks it at the prompt; the default is Direct). Joining takes an invite
 * code (Direct) or, on a Tailscale team, a teammate's tailnet machine.
 */
async function joinOrInit(ctx: Ctx, client: WalkieClient): Promise<void> {
  const me = await client.me();
  if (me.team) { ctx.out(`   already in ${c.bold(me.team.name)} as @${me.handle}`); return; }
  const tailscale = me.tailscale.ok;
  let invite = str(ctx.args, "invite");
  let joinTarget = str(ctx.args, "join");
  let team = str(ctx.args, "team");
  if (joinTarget && isInviteCode(joinTarget)) { invite = joinTarget; joinTarget = undefined; }
  if (!invite && !joinTarget && !team) {
    const choice = (await ask("Create a new team, or join one? (create/join)", "create")).toLowerCase();
    if (choice.startsWith("j")) {
      const answer = await ask(tailscale ? "Invite code (or a teammate's Tailscale machine):" : "Invite code (from a teammate's walkie invite):");
      if (isInviteCode(answer)) invite = answer;
      else if (tailscale) joinTarget = answer;
      else throw new UsageError("that isn't a Walkie invite code (it starts with wk1); ask an owner to run: walkie invite --handle <you>");
    } else {
      team = await ask("Team name:");
    }
  }
  if (invite || joinTarget) {
    if (joinTarget && !tailscale) throw tailscaleMissing(me);
    const r = await client.join((invite ?? joinTarget) as string);
    if (!r.admitted) throw new WalkieError(r.reason ?? "join_failed", `join was not admitted: ${r.reason ?? "unknown reason"}`, 0);
    ctx.out(`   ${c.green("joined")} ${r.team?.name ?? ""} as @${r.handle}${invite ? " (Walkie Direct)" : ""}`);
    return;
  }
  let transport: "direct" | "tailscale" = transportFlag(ctx) ?? "direct";
  if (!transportFlag(ctx) && tailscale) {
    const pick = (await ask("Connect over Walkie Direct (nothing else to install) or your tailnet? (direct/tailscale)", "direct")).toLowerCase();
    transport = pick.startsWith("t") ? "tailscale" : "direct";
  }
  if (transport === "tailscale" && !tailscale) throw tailscaleMissing(me);
  const base = tailscale && transport === "tailscale" ? (me.tailscale.login ?? "").split("@")[0] : userInfo().username;
  const suggested = (base ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^[^a-z]+/, "").slice(0, 24) || undefined;
  const handle = str(ctx.args, "handle") ?? await ask("Your handle (what teammates call you):", suggested);
  const r = await client.init(team as string, handle, transport);
  ctx.out(`   ${c.green("created")} ${r.team?.name} — you are @${r.handle}, the owner${r.transport?.mode === "direct" ? " (Walkie Direct)" : ""}.`);
  ctx.out(`   ${inviteHint(r)}`);
}

/**
 * ACCOUNTS-2: with the person's consent, the claude / codex shims (and the one PATH line in their shell profile), so
 * every session moves to the next account before a usage limit. --switching / --no-switching answer without a prompt.
 */
async function switching(ctx: Ctx): Promise<void> {
  const home = defaultHome();
  if (bool(ctx.args, "no-switching")) { ctx.out(c.dim("   skipped (--no-switching)")); return; }
  const profile = profileFile();
  let yes = bool(ctx.args, "switching");
  if (!yes && process.stdin.isTTY && !underAgent()) {
    const a = await ask(`Move Claude Code / Codex sessions to another account automatically when one hits its usage limit? This adds claude/codex shims in ${join(home, "bin")} and one PATH line to ${profile}. (y/N)`, "n");
    yes = /^y/i.test(a);
  }
  if (!yes) { ctx.out(c.dim("   not now (later: walkie accounts shims install --profile)")); return; }
  for (const l of recordClis(home)) ctx.out(`   ${l}`);
  const r = installShims(home, { profile });
  ctx.out(`   ${c.green("on")} — shims in ${r.dir}, PATH line in ${r.profile ?? profile}. Next: ${c.bold("walkie accounts add claude")} / ${c.bold("walkie accounts add codex")} for each of your accounts`);
}

export async function setup(ctx: Ctx): Promise<number> {
  if (bool(ctx.args, "company-machine") && !str(ctx.args, "invite")) throw new UsageError("--company-machine requires a private --invite code");
  if (str(ctx.args, "owner-ssh") !== undefined && !bool(ctx.args, "company-machine")) throw new UsageError("--owner-ssh is part of the company-machine consent: add --company-machine");
  teamAgentsFlag(ctx); // conflicting answers fail before anything changes
  if (bool(ctx.args, "seat-users") && !bool(ctx.args, "allow-team-agents") && !bool(ctx.args, "allow-seats"))
    throw new UsageError("--seat-users requires --allow-team-agents (or --allow-seats)");
  if (bool(ctx.args, "seat-users") && bool(ctx.args, "same-user")) throw new UsageError("choose --same-user or --seat-users");
  const reexec = await ensureInstalled(ctx, process.argv.slice(3));
  if (reexec !== null) return reexec;
  const client = new WalkieClient({ underAgent: ctx.agentMarker() !== null });

  step(ctx, 1, "Background service");
  if (bool(ctx.args, "no-service")) {
    ctx.out(c.dim("   skipped (--no-service); run walkie daemon start yourself"));
  } else if (!(await ensureService(ctx, client))) {
    return EXIT.error;
  }

  step(ctx, 2, "Team");
  await joinOrInit(ctx, client);

  let n = 3;
  let ownerSsh: SshFinal | null = null;
  const companyOutcome = await teamAgentsStep(ctx, client, {
    interactive: !!process.stdin.isTTY, ask: (q) => ask(q, ""), checkRuntime, installSeatUsers,
    root: realRootBatch(defaultHome()), ssh: realSshStepDeps(client), onSsh: (result) => { ownerSsh = result; },
  }, () => step(ctx, n++, "Team agents on this machine"));
  const consentExit = companyConsentExit(ctx, companyOutcome);
  if (consentExit !== null) return consentExit;

  step(ctx, n++, "Agents");
  if (bool(ctx.args, "no-hooks")) {
    ctx.out(c.dim("   skipped (--no-hooks)"));
  } else {
    const found: string[] = [];
    if (await onPath("claude")) { await installClaude({ dryRun: false, uninstall: false }); found.push("Claude Code"); }
    if (await onPath("codex")) { await installCodex({ dryRun: false, uninstall: false }); found.push("Codex"); }
    ctx.out(found.length ? `   ${c.green("connected")} ${found.join(" + ")} — restart open sessions to pick it up` : c.yellow("   no Claude Code or Codex found on PATH; run walkie hooks install claude|codex later"));
  }

  step(ctx, n++, "Account switching (optional)");
  await switching(ctx);

  step(ctx, n, "Dashboard");
  ctx.out(`   ${c.bold("walkie dashboard")} opens it · ${c.bold("walkie who")} shows everyone in the terminal`);
  return sshEnrollmentExit(ctx, ownerSsh) ?? EXIT.ok;
}
