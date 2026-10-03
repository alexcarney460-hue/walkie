// The "team agents" step of `walkie setup` (WALKIE-ADD-MACHINE-1, Alex 2026-09-26: "this should all be handled by the
// sign up link"). Joining through an owner's add-machine link is the only thing the person does; setup then asks ONE
// question: may the team start agents (seats, PROTOCOL §11) on this machine? Yes turns on seat hosting the way
// `walkie seats enable` does (the seats lane's own commands and routes, not a copy):
// same-user company seats by default, this machine's own Claude/Codex login, off any time
// with `walkie seats deny`. No SSH, no Tailscale share, no user accounts made by hand.
//
//   --allow-team-agents / --no-team-agents   the answer for a non-interactive install (no terminal: default no)
//
// The machine's person decides, at their terminal; an agent of theirs (its environment, or --for-agent) never gets
// asked and applies only the flag it was given, while this machine's agent admin is on (AGENT-ADMIN-1: its requests are
// marked, so the daemon audits the change). Only for this machine (the daemon's local socket). The company-machine
// consent (--company-machine) is the person's alone: a flag or an agent cannot give it. A build without seats (the
// daemon has no /v1/seats) skips the step without asking.
//
// Owner SSH (WALK-67 lane 8): the add-machine command's `--owner-ssh <packet>` rides in that SAME consent. The packet
// is decoded and checked against the invite before the question is shown (a damaged one is dropped, said plainly, and
// the consent shown leaves SSH out; so is one on a Linux or WSL machine whose own SSH server already answers on 22, which
// Walkie never uses: src/cli/ssh-foreign.ts), the text asked is `consentText(..., owner_ssh)`, and the packet goes into the one
// POST /v1/provision/grant that records the person's typed yes. The seats-only question above never carries it.
// SSH is reported ready only from GET /v1/ssh/status (src/cli/ssh-ready.ts), never from having asked for it.
import { agentAdminOn } from "../admin-gate.ts";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { WalkieError, walkieHome, type WalkieClient } from "../../client/index.ts";
import type { MeView } from "../../protocol/schemas.ts";
import { decodeInvite } from "../../daemon/invite.ts";
import { consentText } from "../../daemon/provision/consent.ts";
import { PROFILES } from "../../daemon/provision/profiles.ts";
import type { OwnerSshGrant } from "../../daemon/ssh/grant.ts";
import { bool, str, UsageError } from "../args.ts";
import type { Ctx } from "../context.ts";
import { c } from "../format.ts";
import { runAdministratorStep, type RootBatchDeps } from "../root-batch.ts";
import { finishOwnerSsh, type SshStepDeps } from "../ssh-enroll.ts";
import { checkOwnerSsh, grantRefusalLine, isLocalRefusal, OWNER_SSH_DAMAGED, readOwnerSsh } from "../ssh-packet.ts";
import { FOREIGN_SSH_AFTER_CONSENT, FOREIGN_SSH_NOTE, ownerSshUnlessForeign, walkieSshAnswers } from "../ssh-foreign.ts";
import type { SshFinal } from "../ssh-ready.ts";
import { enableSeats } from "./seats-enable.ts";

export const TEAM_AGENTS_QUESTION = "Let your team start agents on this company machine as your OS user? They can read and change your files and keys, reach your Walkie daemon, and use this machine's "
  + "own Claude/Codex login. "
  + "You can turn it off any time with walkie seats deny.";
export function teamAgentsQuestion(claudeLogin: SeatsLocal["claude_login"], seatUsers = false): string {
  if (seatUsers) return "Let your team start agents on this machine as separate OS users? They use this machine's Claude/Codex login. You can turn seats off any time with walkie seats deny.";
  return claudeLogin === "dedicated"
    ? "Let your team start agents on this company machine as your OS user? They can read and change your files and keys and reach your Walkie daemon. Claude seats use the token set for seats only; a running seat can read it. You can turn seats off any time with walkie seats deny."
    : TEAM_AGENTS_QUESTION;
}

export const OFF_COMMAND = "walkie seats deny";

/** The profile the company consent selects, at the version THIS build's daemon has built in: the grant route refuses any other. */
const DEVELOPER_PROFILE = { id: "developer-worker" as const, version: PROFILES["developer-worker"].version };

/** What the seats lane's local view says after a change (the fields this step reads; the rest is ignored). */
export interface SeatsLocal {
  allow: boolean;
  same_user?: boolean;
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
  /**
   * Runs `walkie seats setup-user --apply` (its sudo prompt on this terminal); true when it succeeded. `codexRelease`: the person
   * gave --codex-release, so the child gets it too (OpenAI's standalone Codex for the seat users, checksum-verified).
   */
  installSeatUsers(o?: { codexRelease?: boolean }): Promise<boolean>;
  /** Read the daemon's private local receipt after grant_exists; overridden by isolated tests. */
  readGrant?: () => Promise<unknown>;
  /** The company flow's ONE administrator step (root marker, and Walkie's SSH service when owner SSH is carried). Absent: no elevation is attempted. */
  root?: RootBatchDeps;
  /** Owner SSH after the grant: the status read and the wait. Absent: SSH is carried but never watched or reported. */
  ssh?: SshStepDeps;
  /** Told how owner SSH ended, when the link carried it (setup turns a failure into a non-zero exit after its other steps). */
  onSsh?: (result: SshFinal) => void;
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

export async function readSavedGrant(home = walkieHome()): Promise<unknown> {
  const file = await open(join(home, "provision-grant.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 32_768 || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) return null;
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } finally { await file.close(); }
}

function sameCurrentGrant(saved: unknown, request: Record<string, unknown>, me: MeView): boolean {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return false;
  const grant = saved as Record<string, unknown>;
  const now = Date.now();
  if (!me.team?.id || !me.node.id || !me.handle || grant.team_id !== me.team.id ||
    grant.target_node !== me.node.id || grant.recipient !== me.handle ||
    Object.hasOwn(grant, "revoked_at") || typeof grant.created_at !== "number" ||
    typeof grant.expires_at !== "number" || !Number.isSafeInteger(grant.created_at) ||
    !Number.isSafeInteger(grant.expires_at) || grant.created_at <= 0 ||
    grant.created_at > now || grant.expires_at <= now || grant.expires_at <= grant.created_at) return false;
  // owner_ssh too: the saved grant carries this run's packet, or neither carries one.
  return ["owner_node", "launchers", "seat_cap", "profiles", "company_mode", "consent_version", "consent_text", "owner_ssh"]
    .every((field) => JSON.stringify(grant[field]) === JSON.stringify(request[field]));
}

async function companyTeamAgentsStep(ctx: Ctx, client: WalkieClient, deps: TeamAgentsDeps, me: MeView, flag: "yes" | "no" | undefined): Promise<TeamAgentsOutcome> {
  if (flag === "no") { ctx.out("   company seats declined"); return "declined"; }
  if (flag === "yes" || !deps.interactive || ctx.agentMarker()) {
    ctx.out(c.yellow("   company seats stay off: type yes at this machine's terminal; a flag or agent cannot grant consent"));
    return "refused";
  }
  const previous = (await client.seats()).local;
  if (previous.ephemeral && !previous.same_user) {
    ctx.out(c.yellow("   company seats stay unchanged: existing seat users require a verified migration preflight"));
    return "refused";
  }
  const team = await client.team();
  const encoded = str(ctx.args, "invite");
  const invite = encoded ? decodeInvite(encoded) : null;
  const issuer = invite && !("error" in invite) ? invite.issuer : team.authority;
  const ownerNode = team.nodes.find((n) => n.node_id === issuer);
  const owner = ownerNode && team.members.find((m) => m.handle === ownerNode.handle && m.role === "owner");
  if (!ownerNode || !owner) { ctx.out(c.yellow("   company seats stay off: the invite owner is not current in the roster")); return "refused"; }
  const launchers = [`@${owner.handle}`];
  // Owner SSH rides in this consent only when the link's packet is for this very enrollment; otherwise it is dropped
  // here, before anything is shown, and the consent below leaves SSH out.
  const ssh = readOwnerSsh(str(ctx.args, "owner-ssh"), {
    teamId: me.team?.id ?? "", handle: me.handle ?? "", ownerNode: ownerNode.node_id, ownerHandle: owner.handle,
    inviteId: invite && !("error" in invite) ? invite.id : null, now: Date.now(),
  });
  let ownerSsh = ssh.state === "carried" ? ssh.packet : undefined;
  if (ssh.state === "damaged") ctx.out(c.yellow(`   ${OWNER_SSH_DAMAGED}`));
  // Linux and WSL: an SSH server that is not Walkie's already answers on 22. Walkie does not use it: owner SSH stays off in
  // this release, the reason is said now, and the consent below, the grant and the administrator step all leave SSH out.
  ownerSsh = await ownerSshUnlessForeign(ownerSsh, deps.ssh, (line) => ctx.out(c.yellow(`   ${line}`)), FOREIGN_SSH_NOTE);
  // The daemon checks the packet (without spending it) BEFORE the question and before any administrator step: one it would
  // refuse is caught here, so nothing is asked of the person and no root work runs for it.
  if (ownerSsh) {
    const refused = await checkOwnerSsh(client, ownerSsh);
    if (refused) { ctx.out(c.yellow(`   company seats stay off: ${refused}`)); return "refused"; }
  }
  const question = companyConsentText(owner.handle, launchers, 4, ownerSsh);
  if ((await deps.ask(`${question} (type yes/N)`)).trim().toLowerCase() !== "yes") {
    ctx.out("   company seats declined");
    return "declined";
  }
  // A server can start while the person reads the question and types: look again now, before anything runs as root or is
  // recorded. One that answers drops the packet here, and what is recorded is the consent without SSH (less than what was shown).
  const carried = await ownerSshUnlessForeign(ownerSsh, deps.ssh, (line) => ctx.out(c.yellow(`   ${line}`)), FOREIGN_SSH_AFTER_CONSENT);
  const consent = carried === ownerSsh ? question : companyConsentText(owner.handle, launchers, 4, carried);
  if (deps.root) {
    const done = await runAdministratorStep((line) => ctx.out(`   ${line}`), deps.root, {
      carriesSsh: carried !== undefined, platform: deps.ssh?.platform ?? process.platform,
      serverAnswers: async () => (deps.ssh ? walkieSshAnswers(deps.ssh) : false),
    });
    if (!done.ok) {
      ctx.out(c.yellow(`   company seats stay off: ${done.why}`));
      return "incomplete";
    }
  }
  const grantRequest = { owner_node: ownerNode.node_id, launchers, seat_cap: 4,
    profiles: [DEVELOPER_PROFILE], company_mode: true, consent_version: 1,
    consent_text: consent, ...(carried ? { owner_ssh: carried } : {}),
    consented: true, confirmation: { surface: "cli", typed_phrase: "yes" } };
  try { await client.request("POST", "/v1/provision/grant", grantRequest); }
  catch (error) {
    if (error instanceof WalkieError && error.status === 409 && error.code === "grant_exists") {
      let saved: unknown;
      try { saved = await (deps.readGrant ?? readSavedGrant)(); } catch { saved = null; }
      if (!sameCurrentGrant(saved, grantRequest, me)) {
        ctx.out(c.yellow("   a different or expired provisioning grant is already recorded; company seats stay off. Revoke it locally, then review the new consent"));
        return "refused";
      }
    } else if (error instanceof WalkieError && grantRefusalLine(error.code, error.message)) {
      // A problem with the link needs a new one; a problem on this machine is fixed and the same command run again.
      ctx.out(c.yellow(`   company seats stay off: ${grantRefusalLine(error.code, error.message)}`));
      return isLocalRefusal(error.code) ? "incomplete" : "refused";
    } else {
      ctx.out(c.yellow("   local provisioning grant is pending; company seats stay off until Walkie supports the grant"));
      return "incomplete";
    }
  }
  const local = await enableSeats(ctx, { client, sameUser: true, launchers, max: 4 });
  if (!local?.allow || !local.same_user) {
    ctx.out(c.yellow("   company seats are not enabled; check walkie seats doctor"));
    return "incomplete";
  }
  ctx.out("   same-user seats configured; owner provisioning, subscription lease and smoke launch remain pending");
  if (carried && deps.ssh) deps.onSsh?.(await finishOwnerSsh((line) => ctx.out(line), deps.ssh));
  return "allowed";
}

export function companyConsentText(owner: string, launchers: readonly string[], cap: number, ownerSsh?: OwnerSshGrant): string {
  return consentText(owner, launchers, cap, [DEVELOPER_PROFILE], undefined, ownerSsh);
}

/**
 * The step itself. Prints under the setup heading `heading()` (called only when there is something to say) and
 * returns what happened. Never turns seats on unless the person said yes, here, in their own terminal.
 */
export async function teamAgentsStep(ctx: Ctx, client: WalkieClient, deps: TeamAgentsDeps, heading: () => void): Promise<TeamAgentsOutcome> {
  const flag = teamAgentsFlag(ctx);
  const seatUsers = bool(ctx.args, "seat-users");
  if (str(ctx.args, "owner-ssh") !== undefined && !bool(ctx.args, "company-machine")) {
    throw new UsageError("--owner-ssh is part of the company-machine consent: add --company-machine (the seats-only question never authorizes SSH)");
  }
  if (seatUsers && flag !== "yes") throw new UsageError("--seat-users requires --allow-team-agents (or --allow-seats)");
  if (seatUsers && bool(ctx.args, "same-user")) throw new UsageError("choose --same-user or --seat-users");
  if (!(await seatsSupported(client))) {
    if (flag === "yes") { heading(); ctx.out(c.dim("   this version of Walkie can't host team agents yet: --allow-team-agents ignored")); }
    return "unsupported";
  }
  heading();
  const me = await client.me();
  if (!me.team) { ctx.out(c.dim("   not on a team yet: team agents stay off")); return "declined"; }
  if (me.role === "observer") { ctx.out(c.dim("   observers can't host team agents (they can't post the results)")); return "refused"; }
  if (bool(ctx.args, "company-machine")) return companyTeamAgentsStep(ctx, client, deps, me, flag);
  // AGENT-ADMIN-1: under an agent, setup applies the flag it was given (--allow-team-agents / --no-team-agents) and
  // never asks; without a flag, team agents stay off. Its requests are marked, so the daemon audits the change.
  const agent = ctx.agentMarker();
  if (agent && flag === "yes" && !agentAdminOn()) {
    ctx.out(c.yellow("   --allow-team-agents not applied: agent admin is off on this machine (its person turns it back on: walkie agents admin on)"));
    return "refused";
  }
  const before = (await client.seats()).local;
  const question = flag === undefined && deps.interactive && !agent
    ? teamAgentsQuestion(before.claude_login, seatUsers || before.ephemeral === true) : TEAM_AGENTS_QUESTION;
  const answer = flag ?? (deps.interactive && !agent ? (isYes(await deps.ask(`${question} (y/N)`)) ? "yes" : "no") : "no");
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

  // 2 + 3. Company mode needs no sudo; an existing seat-user machine retains its hardening mode.
  ctx.out(before.ephemeral ? "   Existing seat-user mode is retained without another sudo step."
    : seatUsers ? "   Seat-user hardening selected; setup may ask for sudo once."
    : "   Company seats run as your OS user without a sudo step.");
  let local: SeatsLocal | null;
  try {
    local = await enableSeats(ctx, {
      client, sameUser: bool(ctx.args, "same-user"), seatUsers, askClaudeToken: deps.interactive,
      setupSeatUsers: async () => {
        const ok = await deps.installSeatUsers({ codexRelease: bool(ctx.args, "codex-release") });
        return ok ? { ok, applied: true } : { ok, applied: false, why: "seat users weren't set up" };
      },
    });
  } catch (e) {
    ctx.out(c.yellow(`   team agents couldn't be turned on (${e instanceof Error ? e.message : String(e)}). Finish it: walkie seats enable`));
    return "incomplete";
  }
  if (!local) {
    ctx.out(c.yellow("   team agents stay off. Finish it any time: walkie seats enable"));
    return "incomplete";
  }
  if (!local.allow) {
    ctx.out(c.yellow("   the daemon didn't turn team agents on; check: walkie seats"));
    return "incomplete";
  }
  ctx.out(`   ${c.green("team agents on")}: owners can start agents here, ${local.ephemeral ? "each as a fresh seat user" : "as your OS user"}. Off any time: ${c.bold(OFF_COMMAND)}`);
  if (local.disabled_reason) ctx.out(c.yellow(`   they don't run yet: ${local.disabled_reason}`));
  if (local.claude_login === "unavailable") {
    ctx.out(c.yellow("   Claude agents need a usable access token from this machine's login. Use Claude Code here to refresh it."));
    ctx.out(`   Optional override: ${c.bold("claude setup-token")}, then ${c.bold("walkie seats token set")} (paste the token)`);
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

/** The command that sets seat users up: `self` (this walkie) running `seats setup-user --apply`, and --codex-release when asked for. */
export function setupUserArgv(self: string[], codexRelease: boolean): string[] {
  return [...self, "seats", "setup-user", "--apply", ...(codexRelease ? ["--codex-release"] : [])];
}

/** This walkie (the installed binary, or bun + the CLI entry from source) running `seats setup-user --apply` here. */
export async function installSeatUsers(o: { codexRelease?: boolean } = {}): Promise<boolean> {
  const self = import.meta.dir.startsWith("/$bunfs") || basename(process.execPath).startsWith("walkie")
    ? [process.execPath] : [process.execPath, join(import.meta.dir, "..", "main.ts")];
  return (await run(setupUserArgv(self, o.codexRelease === true), { inherit: true })).code === 0;
}
