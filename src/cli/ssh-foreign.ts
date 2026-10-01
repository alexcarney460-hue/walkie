// Linux and WSL only. Walkie's owner SSH rides on Walkie's OWN loopback SSH service (the walkie-sshd unit,
// scripts/enroll-ssh-linux.sh): the one consent describes exactly that door. When some other SSH server already answers on
// 127.0.0.1:22 (a stock sshd on a server or a WSL distribution, typically listening on every interface with passwords),
// Walkie does not use it: the owner's key would go into the person's authorized_keys, the tunnel would reach a server the
// consent never described, and SSH would be called ready through it. So in this release owner SSH stays OFF on that machine:
// it is found out BEFORE the consent question, the consent leaves SSH out and says plainly why, the grant carries no
// owner_ssh, no administrator step installs anything for it, and nothing reports SSH ready. A server can also start while the
// person reads and types, so the terminal flows look AGAIN after the typed yes, right before the administrator step and the
// grant (what is then recorded is the consent without SSH, which is less than the one shown), and the administrator step skips
// the SSH install only for a service that is Walkie's (walkieSshAnswers). A later release adds Walkie's own service alongside
// the machine's (another port) so that such a machine can have owner SSH too.
import type { OwnerSshGrant } from "../daemon/ssh/grant.ts";
import type { SshStepDeps } from "./ssh-enroll.ts";

/** Why owner SSH stays off, said before the consent and by `walkie ssh enable`. */
export const FOREIGN_SSH_WHY = "This machine already runs its own SSH server; Walkie's owner SSH needs its own service, which a later release adds alongside it; owner SSH stays off.";

/** The same, for the flows that show a consent next: what that consent does about it. */
export const FOREIGN_SSH_NOTE = `${FOREIGN_SSH_WHY} The consent below leaves SSH out.`;

/** The same, for the Windows enrollment, whose consent was shown in PowerShell before this machine could be looked at. */
export const FOREIGN_SSH_CONTINUES = `${FOREIGN_SSH_WHY} The enrollment continues without SSH.`;

/** The same, for a server found AFTER the consent was shown and typed: that consent included SSH, the one recorded does not. */
export const FOREIGN_SSH_AFTER_CONSENT = `${FOREIGN_SSH_WHY} The consent recorded leaves SSH out, though the one shown above included it.`;

type Looking = Pick<SshStepDeps, "platform" | "read" | "walkieUnit" | "walkieActive">;

/** Whether what answers on 22 would be Walkie's own service: its unit is installed and not known to be stopped. A hint the caller cannot give reads as "not Walkie's". */
function walkiesUnit(step: Looking): boolean {
  return step.walkieUnit?.() === true && step.walkieActive?.() !== false;
}

/**
 * Whether an SSH server that is not Walkie's answers on this machine's 127.0.0.1:22. Only on Linux and WSL (macOS has
 * Walkie's own service on its own port, and Windows runs WSL). Walkie's own server is the walkie-sshd unit: when it is
 * installed, and not known to be stopped, what answers is Walkie's; anything else that answers is not, and a hint the caller
 * cannot give reads as "not Walkie's". A status that cannot be read says nothing here: the install's own script refuses a
 * port 22 that is already taken, so SSH is not forced onto a server for want of a reading.
 */
export async function foreignSshServer(step: Looking): Promise<boolean> {
  if (step.platform !== "linux") return false;
  let answers: boolean;
  try { answers = (await step.read()).server.enabled; } catch { return false; }
  return answers && !walkiesUnit(step);
}

/**
 * Whether WALKIE's own SSH service already answers, for the administrator step that skips an install the service does not need.
 * A server that answers on 22 and is not Walkie's does not count: the install is then planned, and its script refuses a port 22
 * that is taken, so a server that started after the looks is never mistaken for Walkie's service. (macOS: the status is Walkie's
 * own service on its own port, so an answer is Walkie's.) A status that cannot be read throws: the caller treats that as "does not answer".
 */
export async function walkieSshAnswers(step: Looking): Promise<boolean> {
  const answers = (await step.read()).server.enabled;
  return answers && (step.platform !== "linux" || walkiesUnit(step));
}

/**
 * The packet an enrollment may carry: the packet itself, or undefined (with `note` said through `say`) when an SSH server
 * that is not Walkie's already answers here. With no packet, or no way to look, nothing is read.
 */
export async function ownerSshUnlessForeign(packet: OwnerSshGrant | undefined, step: Looking | undefined, say: (line: string) => void, note: string): Promise<OwnerSshGrant | undefined> {
  if (!packet || !step || !(await foreignSshServer(step))) return packet;
  say(note);
  return undefined;
}
