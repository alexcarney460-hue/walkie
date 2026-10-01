// The last step of owner-SSH enrollment on a terminal, after the person's consent recorded the grant with the packet:
// watch `GET /v1/ssh/status` until it says ready, can't become ready, or the wait is over. Walkie's SSH service came
// with the enrollment's one root batch (macOS, Linux and WSL alike), so there is nothing for the person to switch on and
// nothing is opened: this only watches, and says why and what fixes it when it can't get ready.
import type { WalkieClient } from "../client/index.ts";
import type { SshStatus } from "./commands/doctor.ts";
import { c } from "./format.ts";
import { SSH_POLL_MS, SSH_WAIT_MS, sshFinalLines, waitForOwnerSsh, type SshFinal } from "./ssh-ready.ts";
import { walkieUnitHints } from "./ssh-unit.ts";

export interface SshStepDeps {
  platform: NodeJS.Platform;
  /** One `GET /v1/ssh/status`. */
  read(): Promise<SshStatus>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Linux and WSL: whether Walkie's own SSH unit (walkie-sshd) is installed on this machine, so a fix may name it. Asked of systemd (src/cli/ssh-unit.ts). */
  walkieUnit?(): boolean;
  /**
   * Linux and WSL: whether that unit is running. A server that answers on 127.0.0.1:22 is Walkie's only when its unit is
   * installed and, when this says, running (src/cli/ssh-foreign.ts). Absent: not known, and a unit that exists is taken as running.
   */
  walkieActive?(): boolean;
  timeoutMs?: number;
  pollMs?: number;
}

export function realSshStepDeps(client: WalkieClient): SshStepDeps {
  return {
    platform: process.platform,
    read: () => client.request<SshStatus>("GET", "/v1/ssh/status"),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    ...walkieUnitHints(process.platform),
  };
}

/** The status read for `walkie ssh status`, and the wait both it and setup run. */
export function waitFor(deps: SshStepDeps, onWaiting?: Parameters<typeof waitForOwnerSsh>[0]["onWaiting"]): Promise<SshFinal> {
  return waitForOwnerSsh({
    read: deps.read, sleep: deps.sleep, now: deps.now, platform: deps.platform,
    ...(deps.walkieUnit ? { walkieUnit: deps.walkieUnit } : {}),
    timeoutMs: deps.timeoutMs ?? SSH_WAIT_MS, pollMs: deps.pollMs ?? SSH_POLL_MS, ...(onWaiting ? { onWaiting } : {}),
  });
}

/** Prints what is being waited on and what was found; returns the final verdict. Nothing here prints the packet: there is none. */
export async function finishOwnerSsh(out: (line: string) => void, deps: SshStepDeps): Promise<SshFinal> {
  const final = await waitFor(deps, (waiting) => out(c.dim(`   waiting: ${waiting.why}`)));
  const [headline, fix] = sshFinalLines(final);
  out(`   ${final.state === "ready" ? c.green(headline as string) : c.red(headline as string)}`);
  if (fix) out(`   ${fix}`);
  return final;
}
