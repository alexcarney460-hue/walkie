// walkie setup — one command from download to connected agents:
//   install the binary on PATH → run the daemon as a service → create or join a team → connect agents.
//   walkie setup                                  interactive (prompts for what it needs)
//   walkie setup --team "Our Team" --handle alex  create a team (Walkie Direct; --tailscale for a tailnet team)
//   walkie setup --invite wk1…                    join with a Walkie Direct invite code
//   walkie setup --join 100.101.102.103           join a Tailscale team through a teammate's machine
//   --no-service  --no-hooks  --bin-dir <dir>  --switching | --no-switching (account switching shims, ACCOUNTS-2)
//   --allow-team-agents | --no-team-agents        the answer to "let your team start agents here?" (no terminal: no)
import { copyFileSync, chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { WalkieClient, WalkieError } from "../../client/index.ts";
import { isInviteCode } from "../../daemon/invite.ts";
import { defaultHome } from "../../daemon/paths.ts";
import { installService } from "../../daemon/service.ts";
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
import { checkRuntime, installSeatUsers, teamAgentsFlag, teamAgentsStep } from "./team-agents.ts";

const compiled = (): boolean => import.meta.dir.startsWith("/$bunfs") || basename(process.execPath).startsWith("walkie");

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

async function waitForDaemon(client: WalkieClient): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try { if ((await client.healthz()).ok) return true; } catch { /* starting */ }
    await Bun.sleep(100);
  }
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
  teamAgentsFlag(ctx); // conflicting answers fail before anything changes
  const reexec = await ensureInstalled(ctx, process.argv.slice(3));
  if (reexec !== null) return reexec;
  const client = new WalkieClient({ underAgent: ctx.agentMarker() !== null });

  step(ctx, 1, "Background service");
  if (bool(ctx.args, "no-service")) {
    ctx.out(c.dim("   skipped (--no-service); run walkie daemon start yourself"));
  } else if (await client.healthz().then((h) => h.ok, () => false)) {
    ctx.out("   daemon already running");
  } else {
    await installService(defaultHome(), false);
    if (!(await waitForDaemon(client))) { ctx.err(c.red("   the daemon did not come up; run walkie doctor")); return EXIT.error; }
    ctx.out(`   ${c.green("running")} (starts at login, restarts on crash)`);
  }

  step(ctx, 2, "Team");
  await joinOrInit(ctx, client);

  let n = 3;
  await teamAgentsStep(ctx, client, {
    interactive: !!process.stdin.isTTY, ask: (q) => ask(q, ""), checkRuntime, installSeatUsers,
  }, () => step(ctx, n++, "Team agents on this machine"));

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
  return EXIT.ok;
}
