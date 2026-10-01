// The Linux/WSL half of owner-SSH enrollment: scripts/enroll-ssh-linux.sh, run as root, inside the ONE root batch
// the enrollment already has (`walkie provision root-marker install <home> ssh-linux`, reached by the person's single
// sudo on a Linux terminal, or by the Windows bootstrap's elevated WSL root commands). The script is embedded in the
// walkie binary, so it is exactly the one in the signed release and no second download or prompt exists.
//
// The script is staged under the enrollment's own root-owned directory (/var/lib/walkie), never under TMPDIR: a
// sudoers that keeps the caller's environment must not let the person's own processes choose where root writes and
// then runs a script (SSH install review, finding 7).
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { systemEnrollmentRoot } from "../provision/root-marker.ts";
import sshLinuxScript from "../../../scripts/enroll-ssh-linux.sh" with { type: "text" };

export const SSH_LINUX_SCRIPT: string = sshLinuxScript;

/** The systemd unit the script writes: Walkie's own loopback sshd. It exists only once the script has run. */
export const WALKIE_SSH_UNIT_PATH = "/etc/systemd/system/walkie-sshd.service";

export interface SshLinuxIo {
  platform: NodeJS.Platform;
  euid: number | undefined;
  spawn: typeof Bun.spawnSync;
  /** The directory the script is staged under: root-owned and not writable by anyone else. */
  stageRoot: string;
  /** The uid that must own `stageRoot` (0: root). */
  owner: number;
}

export function realSshLinuxIo(): SshLinuxIo {
  return { platform: process.platform, euid: process.geteuid?.(), spawn: Bun.spawnSync, stageRoot: systemEnrollmentRoot(), owner: 0 };
}

export type SshLinuxResult = { ok: true } | { ok: false; why: string };

/** A staging root is the enrollment's own directory: created 0755 when missing, otherwise only used if it is a plain directory root owns and nobody else can write to. */
function stageRootProblem(io: SshLinuxIo): string | null {
  let created = false;
  try { lstatSync(io.stageRoot); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return `${io.stageRoot} cannot be inspected: ${(error as Error).message}`;
    mkdirSync(io.stageRoot, { recursive: true, mode: 0o755 });
    created = true;
  }
  if (created) chmodSync(io.stageRoot, 0o755);
  const st = lstatSync(io.stageRoot);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== io.owner || (st.mode & 0o022) !== 0) {
    return `${io.stageRoot} is not a root-owned directory that others cannot write to`;
  }
  return null;
}

/** Runs the embedded script from a private root-only staging directory and removes it again. Never prompts. */
export function runSshLinuxScript(io: SshLinuxIo = realSshLinuxIo()): SshLinuxResult {
  if (io.platform !== "linux") return { ok: false, why: "the loopback SSH service is installed on Linux and WSL only" };
  if (io.euid !== 0) return { ok: false, why: "the SSH service install must run inside the root batch" };
  const problem = stageRootProblem(io);
  if (problem) return { ok: false, why: `the SSH service install was not started: ${problem}` };
  const dir = mkdtempSync(join(io.stageRoot, ".stage-"));
  try {
    const file = join(dir, "enroll-ssh-linux.sh");
    writeFileSync(file, SSH_LINUX_SCRIPT, { mode: 0o700, flag: "wx" });
    // The script's own `fail` messages go to this terminal; its package-manager output is not shown.
    const child = io.spawn(["/bin/bash", file], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    return child.exitCode === 0 ? { ok: true } : { ok: false, why: `the SSH service install stopped (exit ${child.exitCode}); the script's own messages are above` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
