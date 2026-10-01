// The enrollment's ONE root batch on a Linux or macOS terminal: a single `sudo` of this walkie running
// `provision root-marker install <home> [ssh-linux|ssh-macos]`. The person has already typed the one consent; this is
// the only place the enrollment asks for the machine's password. The root-owned marker comes first (the daemon records
// no grant without it); when the link carries owner SSH and Walkie's SSH service does not answer yet, the same sudo
// then installs it (Linux and WSL: src/daemon/ssh/enroll-linux.ts, a loopback-only sshd on 22; macOS:
// src/daemon/ssh/macos-service.ts, a launchd daemon on 22022), so there is no second prompt. macOS never asks for Remote
// Login. A machine that needs neither runs no sudo at all. (The Windows bootstrap's WSL root commands call the same helper.)
import { resolve } from "node:path";
import { walkieArgv } from "../hooks/install.ts";
import { rootMarkerPresent } from "../daemon/provision/root-marker.ts";

/** The root helper's exit status when the marker is in place but the SSH service install stopped. */
export const SSH_INSTALL_EXIT = 5;

export interface RootBatchNeed { marker: boolean; sshLinux: boolean; sshMacos: boolean }
export interface RootBatchResult {
  marker: boolean; ssh: "skipped" | "installed" | "failed"; why?: string;
  /** For a failed SSH half: the exact command that repeats just that step, quoted so it can be pasted. */
  rerun?: string;
}

export interface RootBatchDeps {
  markerPresent(): boolean;
  run(need: RootBatchNeed): Promise<RootBatchResult>;
}

type Spawn = typeof Bun.spawnSync;

/** What the one batch must do: nothing at all when the marker is there and no SSH service has to be installed. */
export function planRootBatch(o: { markerPresent: boolean; carriesSsh: boolean; platform: NodeJS.Platform; serverAnswers: boolean }): RootBatchNeed {
  const wanted = o.carriesSsh && !o.serverAnswers;
  return { marker: !o.markerPresent, sshLinux: wanted && o.platform === "linux", sshMacos: wanted && o.platform === "darwin" };
}

/** What the person is told before the sudo prompt. */
export function describeRootBatch(need: RootBatchNeed): string {
  const service = need.sshMacos
    ? "Walkie's SSH service for the owner's key (it listens only on this Mac and accepts only key logins; Remote Login is not used)"
    : need.sshLinux ? "Walkie's SSH service for the owner's key (it listens only on this machine and accepts only key logins)" : "";
  return [need.marker ? "the root-owned company-machine marker" : "", service].filter(Boolean).join(", then ");
}

/** One argument quoted for a POSIX shell, so a printed command can be pasted whatever the path holds. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

function markerPresent(home: string): boolean {
  try { return rootMarkerPresent(home); } catch { return false; }
}

/** The single sudo, synchronously. Exit 0: all it was asked; SSH_INSTALL_EXIT: marker in place, SSH service not. */
export function runRootBatchSync(home: string, need: RootBatchNeed, spawn: Spawn = Bun.spawnSync, argv: string[] = walkieArgv(),
  present: (home: string) => boolean = markerPresent): RootBatchResult {
  const kind = need.sshLinux ? "ssh-linux" : need.sshMacos ? "ssh-macos" : null;
  if (!need.marker && !kind) return { marker: true, ssh: "skipped" };
  const command = ["sudo", ...argv, "provision", "root-marker", "install", resolve(home), ...(kind ? [kind] : [])];
  const child = spawn(command, { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  const marker = present(home);
  if (child.exitCode === 0) return { marker, ssh: kind ? "installed" : "skipped" };
  const why = child.exitCode === SSH_INSTALL_EXIT ? "the SSH service install stopped; its messages are above" : "the administrator step was not completed";
  return { marker, ssh: kind ? "failed" : "skipped", why, ...(kind ? { rerun: command.map(shellQuote).join(" ") } : {}) };
}

export function realRootBatch(home: string, spawn: Spawn = Bun.spawnSync, argv: string[] = walkieArgv()): RootBatchDeps {
  return {
    markerPresent: () => markerPresent(home),
    run: async (need) => runRootBatchSync(home, need, spawn, argv),
  };
}

/**
 * The company flows' administrator step, run after the person's typed yes and BEFORE the consent is recorded: the root
 * marker the daemon requires before it records any grant and, when owner SSH is carried and Walkie's SSH service does
 * not answer yet, that service, all from one sudo. A machine that needs neither runs nothing. A step that did not finish
 * returns the plain sentence to show; one whose SSH half failed names what repeats just that step, and nothing has
 * been recorded, so the same link still works.
 */
export async function runAdministratorStep(say: (line: string) => void, root: RootBatchDeps,
  o: { carriesSsh: boolean; platform: NodeJS.Platform; serverAnswers(): Promise<boolean>; /** What the person does after fixing the problem; the default is for the enrollment flows. */ again?: string }): Promise<{ ok: true } | { ok: false; why: string }> {
  let serverAnswers = false;
  if (o.carriesSsh && (o.platform === "linux" || o.platform === "darwin")) {
    try { serverAnswers = await o.serverAnswers(); } catch { serverAnswers = false; }
  }
  const need = planRootBatch({ markerPresent: root.markerPresent(), carriesSsh: o.carriesSsh, platform: o.platform, serverAnswers });
  if (!need.marker && !need.sshLinux && !need.sshMacos) return { ok: true };
  say(`one administrator step (sudo asks for your password once): ${describeRootBatch(need)}`);
  const result = await root.run(need);
  if (!result.marker) return { ok: false, why: result.why ?? "the administrator step was not completed" };
  if (result.ssh === "failed") {
    const repeat = result.rerun ? ` To repeat only the administrator step: ${result.rerun}` : "";
    const again = o.again ?? "run the same command again: the same link still works";
    return { ok: false, why: `the SSH service was not installed (${result.why ?? "see above"}). Fix what is named above, then ${again}.${repeat}` };
  }
  return { ok: true };
}
