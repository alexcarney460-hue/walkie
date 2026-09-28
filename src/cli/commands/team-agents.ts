// The "team agents" step of `walkie setup` (WALKIE-ADD-MACHINE-1, Alex 2026-09-26: "this should all be handled by the
// sign up link"). Joining through an owner's add-machine link is the only thing the person does; setup then asks ONE
// question: may the team start agents (seats, PROTOCOL §11) on this machine? Yes turns on seat hosting the way
// `walkie seats setup-user --apply` + `walkie seats allow` do (the seats lane's own commands and routes, not a copy):
// a fresh OS user per seat through one explained sudo prompt, this machine's own Claude/Codex login, off any time
// with `walkie seats deny`. No SSH, no Tailscale share, no user accounts made by hand.
//
//   --allow-team-agents / --no-team-agents   the answer for a non-interactive install (no terminal: default no)
//
// Only the machine's person decides: never under an agent (its environment, or --for-agent), and only for this
// machine (the daemon's local socket; the seats route refuses X-Walkie-Agent too). A build without seats (the daemon
// has no /v1/seats) skips the step without asking.
import { agentAdminOn } from "../admin-gate.ts";
import { basename, join } from "node:path";
import type { WalkieClient } from "../../client/index.ts";
import { WalkieError } from "../../client/index.ts";
import { bool, UsageError } from "../args.ts";
import type { Ctx } from "../context.ts";
import { c } from "../format.ts";
import { enableSeats } from "./seats-enable.ts";

export const TEAM_AGENTS_QUESTION = "Let your team start agents on this machine? They run under their own separate user, use this machine's "
  + "own Claude/Codex login, and you can turn it off any time with walkie seats deny.";

export const OFF_COMMAND = "walkie seats deny";

/** What the seats lane's local view says after a change (the fields this step reads; the rest is ignored). */
export interface SeatsLocal {
  allow: boolean;
  ephemeral?: boolean;
  disabled_reason?: string;
  claude_login?: "dedicated" | "machine" | "unavailable";
}

export interface RuntimeCheck { installed: boolean; loggedIn: boolean | null }

export interface TeamAgentsDeps {
  /** Whether the person can be asked (stdin is a terminal). */
  interactive: boolean;
  ask(question: string): Promise<string>;
  /** Is `claude` / `codex` installed, and signed in for this person (null: can't tell)? */
  checkRuntime(name: "claude" | "codex"): Promise<RuntimeCheck>;
  /** Runs `walkie seats setup-user --apply` (its sudo prompt on this terminal); true when it succeeded. */
  installSeatUsers(): Promise<boolean>;
}

export type TeamAgentsOutcome = "unsupported" | "declined" | "refused" | "allowed" | "incomplete";

/** --allow-team-agents / --no-team-agents, or neither. */
export function teamAgentsFlag(ctx: Pick<Ctx, "args">): "yes" | "no" | undefined {
  // --allow-seats / --no-seats are the same answer (the seats lane's first spelling).
  const yes = bool(ctx.args, "allow-team-agents") || bool(ctx.args, "allow-seats");
  const no = bool(ctx.args, "no-team-agents") || bool(ctx.args, "no-seats");
  if (yes && no) throw new UsageError("--allow-team-agents and --no-team-agents are exclusive");
  return yes ? "yes" : no ? "no" : undefined;
}

/** Whether this daemon hosts seats: GET /v1/seats answers (a build without them has no such route). */
export async function seatsSupported(client: WalkieClient): Promise<boolean> {
  try {
    await client.request<{ local: SeatsLocal }>("GET", "/v1/seats");
    return true;
  } catch (e) {
    // No such route (an older build), seats off in this daemon, or not ours to read: not available here.
    if (e instanceof WalkieError && [401, 403, 404, 405, 503].includes(e.status)) return false;
    throw e;
  }
}

function isYes(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * The step itself. Prints under the setup heading `heading()` (called only when there is something to say) and
 * returns what happened. Never turns seats on unless the person said yes, here, in their own terminal.
 */
export async function teamAgentsStep(ctx: Ctx, client: WalkieClient, deps: TeamAgentsDeps, heading: () => void): Promise<TeamAgentsOutcome> {
  const flag = teamAgentsFlag(ctx);
  if (!(await seatsSupported(client))) {
    if (flag === "yes") { heading(); ctx.out(c.dim("   this version of Walkie can't host team agents yet: --allow-team-agents ignored")); }
    return "unsupported";
  }
  heading();
  const me = await client.me();
  if (!me.team) { ctx.out(c.dim("   not on a team yet: team agents stay off")); return "declined"; }
  if (me.role === "observer") { ctx.out(c.dim("   observers can't host team agents (they can't post the results)")); return "refused"; }
  // AGENT-ADMIN-1: under an agent, setup applies the flag it was given (--allow-team-agents / --no-team-agents) and
  // never asks; without a flag, team agents stay off. Its requests are marked, so the daemon audits the change.
  const agent = ctx.agentMarker();
  if (agent && flag === "yes" && !agentAdminOn()) {
    ctx.out(c.yellow("   --allow-team-agents not applied: agent admin is off on this machine (its person turns it back on: walkie agents admin on)"));
    return "refused";
  }
  const answer = flag ?? (deps.interactive && !agent ? (isYes(await deps.ask(`${TEAM_AGENTS_QUESTION} (y/N)`)) ? "yes" : "no") : "no");
  if (answer === "no") {
    ctx.out(`   ${c.dim(`team agents off${flag || deps.interactive ? "" : " (no terminal to ask; --allow-team-agents turns them on)"}. Later: walkie seats enable`)}`);
    return "declined";
  }

  // 1. The runtimes seats use: this machine's own Claude Code / Codex, signed in by this person.
  let usable = 0;
  for (const name of ["claude", "codex"] as const) {
    const r = await deps.checkRuntime(name);
    if (!r.installed) {
      if (name === "claude") ctx.out(c.yellow("   claude: not installed. Install Claude Code (https://claude.com/claude-code), then run: claude auth login"));
      continue;
    }
    if (r.loggedIn === false) { ctx.out(c.yellow(`   ${name}: not signed in. Run: ${name === "claude" ? "claude auth login" : "codex login"}`)); continue; }
    usable++;
    ctx.out(`   ${name}: ${c.green(r.loggedIn ? "installed and signed in" : "installed")}${r.loggedIn === null ? c.dim(" (sign-in not checked)") : ""}`);
  }

  // 2 + 3. The seats lane's one flow (`walkie seats enable`): a fresh OS user per seat set up if it isn't yet (one
  // sudo prompt, explained), a Claude token for seats stored first when one is given, then seats allowed here.
  ctx.out("   Next, one password prompt (sudo): it lets each agent run as a fresh user of its own, never as you. It adds a");
  ctx.out("   walkie-seats group, root-owned copies of walkie in /usr/local/libexec/walkie and a sudo rule that lets Walkie");
  ctx.out("   create and remove those users. Nothing else gets admin rights.");
  let setUp = false;
  let local: SeatsLocal | null;
  try {
    local = await enableSeats(ctx, {
      client, askClaudeToken: deps.interactive,
      setupSeatUsers: async () => { const ok = await deps.installSeatUsers(); setUp = ok; return ok ? { ok, applied: true } : { ok, applied: false, why: "seat users weren't set up" }; },
    });
  } catch (e) {
    // Seat users are set up; only the switch failed. Setup carries on (hooks, dashboard) with the way to finish.
    ctx.out(c.yellow(`   seat users are set up, but team agents couldn't be turned on (${e instanceof Error ? e.message : String(e)}). Finish it: walkie seats enable`));
    return "incomplete";
  }
  if (!local) {
    ctx.out(c.yellow(`   ${setUp ? "team agents" : "seat users weren't set up, so team agents"} stay off. Finish it any time: walkie seats enable`));
    return "incomplete";
  }
  if (!local.allow) {
    ctx.out(c.yellow("   the daemon didn't turn team agents on; check: walkie seats"));
    return "incomplete";
  }
  ctx.out(`   ${c.green("team agents on")}: owners can start agents here, each as a fresh user. Off any time: ${c.bold(OFF_COMMAND)}`);
  if (local.disabled_reason) ctx.out(c.yellow(`   they don't run yet: ${local.disabled_reason}`));
  if (local.claude_login === "unavailable") {
    ctx.out(c.yellow("   Claude agents need a sign-in of their own here (this Mac keeps yours in its Keychain, which their users can't open):"));
    ctx.out(`   ${c.bold("claude setup-token")}, then ${c.bold("walkie seats token set")} (paste the token)`);
  }
  if (usable === 0) ctx.out(c.yellow("   no signed-in Claude Code or Codex yet: agents start once one is (see above)"));
  return "allowed";
}

// ---- the real dependencies ---------------------------------------------------------------------------------------

async function run(argv: string[], opts: { inherit?: boolean } = {}): Promise<{ code: number; out: string }> {
  try {
    const p = Bun.spawn(argv, opts.inherit ? { stdio: ["inherit", "inherit", "inherit"] } : { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const out = opts.inherit ? "" : await new Response(p.stdout as ReadableStream).text();
    return { code: await p.exited, out };
  } catch {
    return { code: 127, out: "" };
  }
}

/** `claude auth status --json` (loggedIn) / `codex login status` (exit 0), found on this person's PATH. */
export async function checkRuntime(name: "claude" | "codex"): Promise<RuntimeCheck> {
  if (!Bun.which(name)) return { installed: false, loggedIn: null };
  if (name === "claude") {
    const r = await run(["claude", "auth", "status", "--json"]);
    try { return { installed: true, loggedIn: (JSON.parse(r.out) as { loggedIn?: unknown }).loggedIn === true }; } catch { return { installed: true, loggedIn: null }; }
  }
  const r = await run(["codex", "login", "status"]);
  return { installed: true, loggedIn: r.code === 0 };
}

/** This walkie (the installed binary, or bun + the CLI entry from source) running `seats setup-user --apply` here. */
export async function installSeatUsers(): Promise<boolean> {
  const self = import.meta.dir.startsWith("/$bunfs") || basename(process.execPath).startsWith("walkie")
    ? [process.execPath] : [process.execPath, join(import.meta.dir, "..", "main.ts")];
  return (await run([...self, "seats", "setup-user", "--apply"], { inherit: true })).code === 0;
}
