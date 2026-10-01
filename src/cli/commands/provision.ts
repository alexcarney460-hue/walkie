import { profile } from "../../daemon/provision/profiles.ts";
import { defaultHome, pathsFor } from "../../daemon/paths.ts";
import { loadConfig } from "../../daemon/config.ts";
import { enrollmentMode, legacyEnrollmentEvidence, readGrant, unenrollGrant } from "../../daemon/provision/grant.ts";
import { removeRootMarker, rootMarkerPresent, writeRootMarker } from "../../daemon/provision/root-marker.ts";
import { walkieArgv } from "../../hooks/install.ts";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Journal } from "../../daemon/provision/runner.ts";
import { UsageError } from "../args.ts";
import { EXIT, readStdin, requirePerson, type Ctx } from "../context.ts";
import { c } from "../format.ts";

/** A fixed built-in profile; grant creation is a separate local consent transaction. */
export async function provision(ctx: Ctx): Promise<number> {
  const sub = ctx.args.pos[0];
  if (sub === "grant") return grantFromCli(ctx);
  if (sub === "grant-bootstrap") {
    return grantFromBootstrap(ctx, await readStdin(), realBootstrapDeps(() => { try { return rootMarkerPresent(defaultHome()); } catch { return false; } }, realSshStepDeps(ctx.client())));
  }
  if (sub === "revoke") {
    await ctx.client().provisionRevoke();
    ctx.out(ctx.json ? JSON.stringify({ revoked: true }) : "enrollment provisioning grant revoked");
    return EXIT.ok;
  }
  if (sub === "unenroll") {
    await requirePerson(ctx, "un-enroll this machine", "yes");
    const home = defaultHome();
    if (loadConfig(pathsFor(home).config).seats?.allow) throw new UsageError("turn seats off before un-enrolling");
    const grant = readGrant(home);
    if (grant && !grant.revoked_at) throw new UsageError("revoke the enrollment grant before un-enrolling");
    if (!enrollmentMode(home)) throw new UsageError("this machine is not enrolled");
    if (rootMarkerPresent(home)) {
      const note = unenrollServiceNote(process.platform, existsSync(MAC_SSH_PLIST));
      if (note) ctx.err(note);
      elevateUnenroll(home);
    }
    unenrollGrant(home);
    ctx.out(ctx.json ? JSON.stringify({ unenrolled: true }) : "machine un-enrolled");
    return EXIT.ok;
  }
  if (sub === "unenroll-root") {
    const home = ctx.args.pos[1] ?? "";
    const problem = rootUnenrollProblem(home, Number(process.env.SUDO_UID), process.geteuid?.(), process.stdin.isTTY === true);
    if (problem) throw new UsageError(problem);
    await requirePerson(ctx, "remove the root enrollment marker", "yes");
    // The root process checks again after confirmation: a concurrent enable or new grant must win.
    const changed = rootUnenrollProblem(home, Number(process.env.SUDO_UID), process.geteuid?.(), process.stdin.isTTY === true);
    if (changed) throw new UsageError(changed);
    removeRootMarker(home);
    // macOS: Walkie's own SSH service goes in this same administrator step. A failure to remove it is said, but does not
    // undo the un-enrollment: with the grant revoked it holds no owner key.
    const said = unenrollMacService(process.platform, () => removeMacSshService(undefined, Number(process.env.SUDO_UID)));
    if (said) ctx.err(said);
    return EXIT.ok;
  }
  if (sub === "root-marker") return rootMarkerCommand(ctx);
  if (sub === "prepare-enrollment") {
    await requirePerson(ctx, "prepare this machine for company enrollment", "yes");
    elevateMarker(defaultHome());
    ctx.out("root-owned enrollment marker installed; complete local consent on this machine");
    return EXIT.ok;
  }
  if (sub === "migrate-enrollment") {
    await requirePerson(ctx, "migrate this machine's enrollment marker", "yes");
    const home = defaultHome();
    if (!legacyEnrollmentEvidence(home)) throw new UsageError("this machine has no enrollment evidence");
    elevateMarker(home);
    ctx.out("root-owned enrollment marker installed");
    return EXIT.ok;
  }
  const id = ctx.args.flags.get("profile");
  const selected = typeof id === "string" ? profile(id) : null;
  if (!selected) throw new UsageError("name --profile developer-worker|freight-worker");
  if (sub === "reset") {
    const result = await ctx.client().provisionReset(selected.id);
    ctx.out(ctx.json ? JSON.stringify(result) : `provision ${selected.id} receipt reset; previous receipt ${result.archived ? "archived" : "absent"}`);
    return EXIT.ok;
  }
  if (sub === "status") {
    const j = await ctx.client().provisionStatus(selected.id);
    if (ctx.json) ctx.out(JSON.stringify(j)); else printJournal(ctx, j);
    return EXIT.ok;
  }
  if (sub === "apply") {
    const result = await ctx.client().provisionApply(selected.id);
    if (ctx.json) ctx.out(JSON.stringify(result)); else { printJournal(ctx, result.journal); ctx.out(`provision ${id}: ${result.state}${result.reason ? ` (${result.reason})` : ""}`); }
    return result.state === "done" ? EXIT.ok : EXIT.error;
  }
  throw new UsageError("provision status|apply --profile developer-worker|freight-worker; provision revoke|unenroll (local person only; disable seats before unenroll)");
}

export function cliConsentAccepted(tty: boolean, typed: string): boolean {
  return tty && typed === CLI_CONSENT_PHRASE;
}

/** The terminal, the administrator step and the SSH status, injectable so the consent flow is testable without a person or a sudo. */
export interface GrantCliSeams {
  /** Whether stdin is a terminal: the consent is typed there. */
  tty?: boolean;
  /** Asks the question and returns what was typed. */
  type?(question: string): Promise<string>;
  /** The one administrator step (root marker, and Walkie's SSH service when the link carries owner SSH). */
  root?: RootBatchDeps;
  /** The SSH status, the unit hints and the wait: where "is an SSH server answering" and "is it ready" come from. */
  ssh?: SshStepDeps;
}

async function typeAtTerminal(question: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try { return await prompt.question(question); }
  finally { prompt.close(); }
}

export async function grantFromCli(ctx: Ctx, seams: GrantCliSeams = {}): Promise<number> {
  const flag = (name: string): string | null => {
    const value = ctx.args.flags.get(name);
    return typeof value === "string" ? value : null;
  };
  const ownerNode = flag("owner-node");
  const owner = flag("owner-handle")?.replace(/^@/, "");
  const launchers = flag("launchers")?.split(",").map((s) => s.trim()).filter(Boolean);
  const capText = flag("seat-cap");
  const cap = capText && /^\d+$/.test(capText) ? Number(capText) : NaN;
  const selected = profile(flag("profile") ?? "");
  if (!ownerNode || !owner || !launchers?.length || !Number.isInteger(cap) || cap < 1 || cap > 100 || !selected) {
    throw new UsageError("provision grant --owner-node ID --owner-handle HANDLE --launchers @handle[,..] --seat-cap N --profile developer-worker|freight-worker [--claude-account owner:id] [--codex-account owner:id]");
  }
  const tty = seams.tty ?? process.stdin.isTTY === true;
  if (!tty) throw new UsageError("enrollment consent requires an interactive terminal");
  const profiles = [{ id: selected.id, version: selected.version }];
  const claude = flag("claude-account");
  const codex = flag("codex-account");
  for (const account of [claude, codex]) {
    if (account && (!SeatAccountKey.safeParse(account).success || !account.startsWith(`${owner}:`))) {
      throw new UsageError("worker accounts must be named owner vault keys (<owner>:<24 hex id>)");
    }
  }
  const worker_accounts = claude || codex ? { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) } : undefined;
  const ssh = seams.ssh ?? realSshStepDeps(ctx.client());
  // Linux and WSL: an SSH server that is not Walkie's already answers on 22. Walkie does not use it: owner SSH stays off in
  // this release, said now, and the disclosure, the grant and the administrator step all leave SSH out.
  const owner_ssh = await ownerSshUnlessForeign(flag("owner-ssh") ? readPacket(flag("owner-ssh") as string) : undefined, ssh, (line) => ctx.err(c.yellow(line)), FOREIGN_SSH_NOTE);
  // Before the question and any administrator step: would this machine's daemon accept the packet? (Nothing is spent.)
  if (owner_ssh) {
    const refused = await checkOwnerSsh(ctx.client(), owner_ssh);
    if (refused) throw new UsageError(refused);
  }
  const disclosure = consentText(owner, launchers, cap, profiles, worker_accounts, owner_ssh);
  ctx.out(disclosure);
  const typed = await (seams.type ?? typeAtTerminal)(`Type exactly "${CLI_CONSENT_PHRASE}" to approve: `);
  if (!cliConsentAccepted(tty, typed)) throw new UsageError("enrollment consent was not confirmed");
  // A server can start while the person reads the question and types: look again now, before anything runs as root or is
  // recorded. One that answers drops the packet here, and what is recorded is the consent without SSH (less than what was shown).
  const carried = await ownerSshUnlessForeign(owner_ssh, ssh, (line) => ctx.err(c.yellow(line)), FOREIGN_SSH_AFTER_CONSENT);
  const consent = carried === owner_ssh ? disclosure : consentText(owner, launchers, cap, profiles, worker_accounts, carried);
  // The one sudo, after the typed consent and before anything is recorded: a failure stops here, so the same link still works.
  const stepped = await runAdministratorStep((line) => ctx.err(line), seams.root ?? realRootBatch(defaultHome()), {
    carriesSsh: carried !== undefined, platform: ssh.platform,
    serverAnswers: () => walkieSshAnswers(ssh),
  });
  if (!stepped.ok) throw new UsageError(stepped.why);
  let grant;
  try {
    grant = await ctx.client().provisionGrant({ owner_node: ownerNode, launchers, seat_cap: cap, profiles,
      ...(worker_accounts ? { worker_accounts } : {}),
      ...(carried ? { owner_ssh: carried } : {}),
      company_mode: true, consent_version: CONSENT_VERSION, consent_text: consent, consented: true,
      confirmation: { surface: "cli", typed_phrase: CLI_CONSENT_PHRASE } });
  } catch (error) {
    // A problem with the link needs a new one; a problem on this machine is fixed and the same command run again.
    const line = error instanceof WalkieError ? grantRefusalLine(error.code, error.message) : null;
    if (line) throw new UsageError(line);
    throw error;
  }
  ctx.out(ctx.json ? JSON.stringify(grant) : `enrollment grant for @${owner} recorded; expires ${new Date(grant.expires_at).toISOString()}`);
  if (!carried) return EXIT.ok;
  // Ready only from the daemon's own status, never from having asked for SSH.
  const final = await finishOwnerSsh((line) => ctx.err(line), ssh);
  return final.state === "failed" ? EXIT.error : EXIT.ok;
}

/** The packet from the owner's add-machine link, or a plain refusal (never the decoder's own text). */
function readPacket(encoded: string): OwnerSshGrant {
  try { return decodeOwnerSshGrant(encoded); } catch { throw new UsageError(OWNER_SSH_DAMAGED.replace(/ The consent below leaves SSH out\.$/, "")); }
}

function rootMarkerCommand(ctx: Ctx): Promise<number> {
  return rootMarkerHelper(ctx.args.pos, {
    euid: process.geteuid?.(), sudoUid: Number(process.env.SUDO_UID), ownerOf: (path) => statSync(path).uid,
    writeMarker: writeRootMarker, err: (line) => ctx.err(line),
    runSsh: (kind, uid) => (kind === "ssh-macos" ? installMacSshService(uid) : runSshLinuxScript()),
  });
}

/** Which SSH service the one root batch installs after the marker: Linux/WSL's loopback sshd, or macOS's launchd one. */
export type SshInstallKind = "ssh-linux" | "ssh-macos";

export interface RootHelperDeps {
  euid: number | undefined; sudoUid: number; ownerOf(path: string): number;
  writeMarker(home: string): void;
  /** Installs the SSH service for the person whose uid ran sudo. */
  runSsh(kind: SshInstallKind, sudoUid: number): Promise<SshInstallResult> | SshInstallResult;
  err(line: string): void;
}

/**
 * `provision root-marker install <home> [ssh-linux|ssh-macos]`, as root: the marker first, then, when asked, the SSH
 * service from the SAME root process, so the person is not asked for a password twice. The marker is in place whatever
 * happens to the SSH install, which says so with its own exit status.
 */
export async function rootMarkerHelper(pos: readonly string[], d: RootHelperDeps): Promise<number> {
  const [, action, home, withSsh] = pos;
  if (d.euid !== 0 || !Number.isInteger(d.sudoUid) || !home || !home.startsWith("/") ||
    d.ownerOf(home) !== d.sudoUid || action !== "install" || (withSsh !== undefined && withSsh !== "ssh-linux" && withSsh !== "ssh-macos")) {
    throw new UsageError("root marker helper requires sudo for the machine person's home");
  }
  d.writeMarker(home);
  if (withSsh !== undefined) {
    const result = await d.runSsh(withSsh, d.sudoUid);
    if (!result.ok) { d.err(c.red(`walkie: ${result.why}`)); return SSH_INSTALL_EXIT; }
  }
  return EXIT.ok;
}

/** Said before the un-enroll's sudo: on macOS with Walkie's SSH service installed, it goes in the same administrator step. */
export function unenrollServiceNote(platform: NodeJS.Platform, installed: boolean): string | null {
  return platform === "darwin" && installed
    ? "this also removes Walkie's SSH service (dev.walkie.sshd) and its files, in the same administrator step" : null;
}

/** What the un-enroll's root step says after it tried to remove Walkie's macOS SSH service. Null: other platforms, or nothing was installed. */
export function unenrollMacService(platform: NodeJS.Platform, remove: () => MacSshRemoval): string | null {
  if (platform !== "darwin") return null;
  const result = remove();
  if (result.kept) return `Walkie's SSH service (dev.walkie.sshd) was left in place: ${result.kept}`;
  if (result.why) {
    return `Walkie's SSH service (dev.walkie.sshd) could not be removed: ${result.why}. It holds no owner key now; to remove it by hand: `
      + `sudo launchctl bootout system/${MAC_SSH_LABEL}; sudo rm ${MAC_SSH_PLIST}; sudo rm -r '${MAC_SSH_DIR}'`;
  }
  return result.removed ? "removed Walkie's SSH service (dev.walkie.sshd) and its files" : null;
}

/** The privileged boundary, checked independently of the outer CLI's prompt. */
export function rootUnenrollProblem(home: string, sudoUid: number, euid: number | undefined, tty: boolean): string | null {
  if (!tty) return "root un-enrollment requires an interactive terminal";
  if (euid !== 0 || !Number.isInteger(sudoUid) || sudoUid < 0 || !home.startsWith("/"))
    return "root un-enrollment requires sudo for the machine person's home";
  try { if (statSync(home).uid !== sudoUid) return "root un-enrollment requires sudo for the machine person's home"; }
  catch { return "root un-enrollment requires the machine person's home"; }
  if (loadConfig(pathsFor(home).config, false).seats?.allow) return "turn seats off before un-enrolling";
  const grant = readGrant(home);
  if (grant && !grant.revoked_at) return "revoke the enrollment grant before un-enrolling";
  if (!rootMarkerPresent(home)) return "root enrollment marker is missing";
  return null;
}

function elevateMarker(home: string): void {
  if (!runRootBatchSync(home, { marker: true, sshLinux: false, sshMacos: false }).marker) throw new UsageError("root enrollment marker change was not completed");
}

function elevateUnenroll(home: string): void {
  // -k invalidates a cached sudo timestamp for this command, so the normal password policy is exercised.
  const child = Bun.spawnSync(["sudo", "-k", ...walkieArgv(), "provision", "unenroll-root", resolve(home)],
    { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  if (child.exitCode !== 0) throw new UsageError("root un-enrollment was not completed");
}

function printJournal(ctx: Ctx, j: Journal): void {
  ctx.out(`${c.bold(j.profile)} v${j.version}`);
  for (const s of j.steps) ctx.out(`  ${s.id}: ${s.state}${s.reason ? ` (${s.reason})` : ""}${s.attempts ? ` (attempts ${s.attempts})` : ""}`);
}
import { createInterface } from "node:readline/promises";
import { CLI_CONSENT_PHRASE, CONSENT_VERSION, consentText } from "../../daemon/provision/consent.ts";
import { SeatAccountKey } from "../../protocol/seats.ts";
import { decodeOwnerSshGrant, type OwnerSshGrant } from "../../daemon/ssh/grant.ts";
import { runSshLinuxScript } from "../../daemon/ssh/enroll-linux.ts";
import { installMacSshService, MAC_SSH_DIR, MAC_SSH_LABEL, MAC_SSH_PLIST, removeMacSshService, type MacSshRemoval, type SshInstallResult } from "../../daemon/ssh/macos-service.ts";
import { realSshStepDeps, finishOwnerSsh, type SshStepDeps } from "../ssh-enroll.ts";
import { FOREIGN_SSH_AFTER_CONSENT, FOREIGN_SSH_NOTE, ownerSshUnlessForeign, walkieSshAnswers } from "../ssh-foreign.ts";
import { WalkieError } from "../../client/index.ts";
import { checkOwnerSsh, grantRefusalLine, OWNER_SSH_DAMAGED } from "../ssh-packet.ts";
import { realRootBatch, runAdministratorStep, runRootBatchSync, SSH_INSTALL_EXIT, type RootBatchDeps } from "../root-batch.ts";
import { grantFromBootstrap, realBootstrapDeps } from "./provision-bootstrap.ts";
