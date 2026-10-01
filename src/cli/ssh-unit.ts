// Linux and WSL: what systemd says about Walkie's own SSH service, asked as the unprivileged person.
//
// Walkie's service is the `walkie-sshd` unit the enrollment's root step installs (scripts/enroll-ssh-linux.sh). Whether a server
// that answers on 127.0.0.1:22 is Walkie's (src/cli/ssh-foreign.ts) is decided from systemd's own answer, never from looking for the
// unit FILE: that file lives under /etc/systemd/system, which a person may be unable to search, and a stat that fails there reads as
// "no such unit". `systemctl show` answers for any user, over the system bus. The unit counts as Walkie's only when it is LOADED from
// the one file Walkie's root step writes (a unit of the same name from /usr/lib or /run is someone else's) and, to be running,
// ACTIVE. Whatever cannot be established (no systemctl, systemd not running, an answer that is not that) reads as not Walkie's.
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { WALKIE_SSH_UNIT_PATH } from "../daemon/ssh/enroll-linux.ts";
import type { SshStepDeps } from "./ssh-enroll.ts";

/** Runs systemctl with these arguments: its standard output when it ran and succeeded, null when it could not run or failed. */
export type SystemctlRun = (args: readonly string[]) => string | null;

export interface WalkieSshUnit {
  /** systemd has Walkie's own unit loaded, from the file Walkie's root step wrote. */
  installed: boolean;
  /** ...and it is active. */
  running: boolean;
}

const UNIT = basename(WALKIE_SSH_UNIT_PATH);
const SHOW = ["show", UNIT, "-p", "LoadState", "-p", "ActiveState", "-p", "FragmentPath"] as const;
const NOT_WALKIES: WalkieSshUnit = { installed: false, running: false };

/** systemctl's own absolute path: this runs as the person, so a `systemctl` earlier on their PATH must not decide it. */
const SYSTEMCTL = ["/usr/bin/systemctl", "/bin/systemctl"];

/** The real systemctl, with a time limit so a stuck systemd cannot hang an enrollment's question. */
export const realSystemctl: SystemctlRun = (args) => {
  const systemctl = SYSTEMCTL.find((path) => existsSync(path));
  if (!systemctl) return null;
  try {
    const child = Bun.spawnSync([systemctl, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5_000 });
    return child.exitCode === 0 ? child.stdout.toString() : null;
  } catch { return null; }
};

/** The `Key=value` lines of `systemctl show` (a value is everything after the first `=`). */
function properties(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) found.set(line.slice(0, at), line.slice(at + 1));
  }
  return found;
}

/** What `systemctl show walkie-sshd.service -p LoadState -p ActiveState -p FragmentPath` printed, judged. */
export function walkieSshUnitFrom(text: string): WalkieSshUnit {
  const found = properties(text);
  const installed = found.get("LoadState") === "loaded" && found.get("FragmentPath") === WALKIE_SSH_UNIT_PATH;
  return { installed, running: installed && found.get("ActiveState") === "active" };
}

/** Asks systemd about Walkie's unit: installed and running, or neither when systemd cannot say. */
export function readWalkieSshUnit(run: SystemctlRun = realSystemctl): WalkieSshUnit {
  try {
    const answer = run(SHOW);
    return answer === null ? NOT_WALKIES : walkieSshUnitFrom(answer);
  } catch { return NOT_WALKIES; }
}

/** The two unit hints of a step's deps: Walkie's unit is installed, and it is running. Only Linux (and so WSL) has such a unit. */
export function walkieUnitHints(platform: NodeJS.Platform, run: SystemctlRun = realSystemctl): Required<Pick<SshStepDeps, "walkieUnit" | "walkieActive">> {
  if (platform !== "linux") return { walkieUnit: () => false, walkieActive: () => false };
  return { walkieUnit: () => readWalkieSshUnit(run).installed, walkieActive: () => readWalkieSshUnit(run).running };
}
