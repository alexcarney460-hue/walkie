// What `systemctl show walkie-sshd.service -p LoadState -p ActiveState -p FragmentPath` prints, and a stand-in systemctl that
// prints it (the CLI's SystemctlRun seam, src/cli/ssh-unit.ts). Nothing here starts systemd.
import type { SystemctlRun } from "../../src/cli/ssh-unit.ts";
import { WALKIE_SSH_UNIT_PATH } from "../../src/daemon/ssh/enroll-linux.ts";

export const showOf = (load: string, active: string, fragment: string): string => `LoadState=${load}\nActiveState=${active}\nFragmentPath=${fragment}\n`;

/** The shapes of "is there a Walkie SSH service here": Walkie's own and running, Walkie's own and stopped, a unit of that name from somewhere else, and none. */
export const SERVICES = {
  walkies: showOf("loaded", "active", WALKIE_SSH_UNIT_PATH),
  stopped: showOf("loaded", "inactive", WALKIE_SSH_UNIT_PATH),
  foreign: showOf("loaded", "active", "/usr/lib/systemd/system/walkie-sshd.service"),
  missing: showOf("not-found", "inactive", ""),
} as const;

/** A systemctl that answers `text` (null: it could not run or failed), recording the arguments it was given. */
export function systemctlSays(text: string | null, seen: string[][] = []): SystemctlRun {
  return (args) => { seen.push([...args]); return text; };
}
