// When owner SSH is READY on an enrolled machine, in one place: the terminal setup, `walkie ssh status` (which the
// desktop app and the Windows bootstrap run) and anything else that reports it.
//
// Ready means exactly what `GET /v1/ssh/status` says: Walkie's SSH service answers on 127.0.0.1 (on macOS its own launchd
// service on 22022, never Remote Login; on Linux and WSL the loopback sshd on 22), the owner's key is installed, and the
// tunnel gate is open. The gate stays closed (`ssh_team_waiting`) until this daemon has pulled the roster authority's log since it
// started; a daemon that can't (the authority is offline, or it shares no transport with it) never gets there, so a
// wait that outlasts the startup window is a failed enrollment with a reason, not a slow one.
import type { SshStatus } from "./commands/doctor.ts";
import { REVOCATION_UNSAVED_MESSAGE } from "../daemon/ssh/state.ts";

export type SshWaitCode = "ssh_server_off" | "ssh_pending" | "ssh_team_waiting" | "status_unavailable";

export type SshVerdict =
  | { state: "ready" }
  /** Not yet, and it can still change by itself (or by the person's next click). */
  | { state: "waiting"; code: SshWaitCode; why: string; fix: string }
  /** Won't fix itself. */
  | { state: "failed"; code: string; why: string; fix: string };

/** The verdict once the wait is over: nothing is left for a person to flip by hand, so a wait that ran out is a failure. */
export type SshFinal = { state: "ready" } | { state: "failed"; code: string; why: string; fix: string };

/** What the caller knows about this machine that a fix may need to be true: only then is Walkie's own Linux unit named. */
export interface SshHints {
  /** Linux and WSL: Walkie's own SSH unit (walkie-sshd) exists here. Unknown reads as absent: a fix never names a unit that may not exist. */
  walkieUnit?: boolean;
}

const NEW_LINK = "ask the owner for a new add-machine link";

const REFUSALS: Record<string, { why: string; fix: string }> = {
  grant_absent: { why: "no owner SSH authorization is recorded on this machine", fix: NEW_LINK },
  grant_invalid: { why: "the enrollment grant on this machine can't be read", fix: "run walkie doctor" },
  grant_revoked: { why: "the enrollment grant was revoked or has expired", fix: NEW_LINK },
  ssh_gate_invalid: { why: "the SSH gate record on this machine is unreadable or not armed", fix: "run walkie doctor" },
  ssh_denied: { why: "SSH access was revoked or denied on this machine", fix: NEW_LINK },
  remote_admin_off: { why: "remote admin is off on this machine and owner SSH needs it", fix: "run walkie admin remote on" },
  wrong_machine: { why: "the enrollment grant is for another machine", fix: NEW_LINK },
  owner_changed: { why: "the owner who issued the grant is no longer a team owner", fix: NEW_LINK },
  owner_key_absent: { why: "the owner's key is not installed in authorized_keys", fix: NEW_LINK },
  owner_key_invalid: { why: "the owner's key line in authorized_keys is not valid", fix: "run walkie doctor" },
};

const ENABLE = "run walkie ssh enable (one administrator step), then run walkie ssh status";

/** What fixes a server that is not answering, per platform; Walkie's own Linux unit is named only when it exists here. */
function serverFix(platform: NodeJS.Platform, hints: SshHints): string {
  if (platform === "darwin") return `start Walkie's SSH service: ${ENABLE}`;
  return hints.walkieUnit
    ? "Walkie's SSH service (walkie-sshd) is installed but not answering: sudo systemctl enable --now walkie-sshd (sudo systemctl status walkie-sshd says why it stopped), then run walkie ssh status"
    : `no SSH service of Walkie's answers on this machine: ${ENABLE}`;
}

/** One reading of `GET /v1/ssh/status`, judged. `platform` and `hints` only decide what fixes a server that is not answering. */
export function sshVerdict(s: SshStatus, platform: NodeJS.Platform, hints: SshHints = {}): SshVerdict {
  if (s.revocation_unsaved) return { state: "failed", code: "ssh_revocation_unsaved", why: REVOCATION_UNSAVED_MESSAGE, fix: "run walkie ssh revoke again once the disk is writable" };
  if (s.owner_key_error) {
    return { state: "failed", code: "owner_key_error", why: "the owner's key can't be checked: authorized_keys or Walkie's record of it can't be read", fix: "fix that file's permissions or contents, then run walkie ssh status" };
  }
  const reason = s.reason;
  if (reason && reason !== "ssh_team_waiting" && reason !== "ssh_pending") {
    const known = REFUSALS[reason];
    return { state: "failed", code: reason, why: known?.why ?? `owner SSH is refused (${reason})`, fix: known?.fix ?? "run walkie doctor" };
  }
  if (!s.server.enabled) return { state: "waiting", code: "ssh_server_off", why: s.server.detail, fix: serverFix(platform, hints) };
  if (reason === "ssh_pending") {
    return { state: "waiting", code: "ssh_pending", why: "owner SSH was still being installed", fix: "run walkie ssh status again; if it stays like this, revoke with walkie provision revoke and enroll again" };
  }
  if (reason === "ssh_team_waiting") {
    return { state: "waiting", code: "ssh_team_waiting", ...(s.is_authority
      ? { why: "this machine is the team's roster authority and has not yet synced with every team machine it can reach", fix: "bring the team's other machines online, then run walkie ssh status" }
      : { why: "this machine has not synced with the team's roster authority since it started, so it can't yet rule out a revocation", fix: "make sure the roster authority machine is online and shares Walkie Direct or Tailscale with this one (walkie doctor shows both), then run walkie ssh status" }) };
  }
  if (!s.owner_key_present) return { state: "failed", code: "owner_key_absent", ...REFUSALS.owner_key_absent! };
  if (!s.tunnel_allowed) return { state: "failed", code: "ssh_tunnel_closed", why: "the SSH tunnel gate is closed", fix: "run walkie doctor" };
  return { state: "ready" };
}

/** One reading, as `walkie ssh status` shows it without waiting: a state that can still resolve by itself is `waiting`. */
export type SshReport = { state: "ready" } | { state: "waiting" | "failed"; code: string; why: string; fix: string };

export function sshReport(v: SshVerdict): SshReport {
  return v;
}

export function sshFinal(v: SshVerdict): SshFinal {
  return v.state === "waiting" ? { state: "failed", code: v.code, why: v.why, fix: v.fix } : v;
}

export interface SshWaitDeps {
  read(): Promise<SshStatus>;
  sleep(ms: number): Promise<void>;
  now(): number;
  platform: NodeJS.Platform;
  /** Linux and WSL: whether Walkie's own SSH unit exists here (see SshHints). */
  walkieUnit?(): boolean;
  /** How long a wait that can still resolve by itself is given. */
  timeoutMs: number;
  pollMs: number;
  /** Called once for each distinct thing the wait is on (never for the packet: there is nothing secret in a verdict). */
  onWaiting?(v: Extract<SshVerdict, { state: "waiting" }>): void;
}

/** Defaults for the setup and `walkie ssh status --wait`: the startup gate settles in seconds on a healthy team. */
export const SSH_WAIT_MS = 60_000;
export const SSH_POLL_MS = 2_000;

/** Reads the status until it is ready, can't get ready, or the wait is over. Ready only ever comes from a reading. */
export async function waitForOwnerSsh(d: SshWaitDeps): Promise<SshFinal> {
  const deadline = d.now() + d.timeoutMs;
  let noted: string | null = null;
  for (;;) {
    let verdict: SshVerdict;
    try { verdict = sshVerdict(await d.read(), d.platform, { walkieUnit: d.walkieUnit?.() === true }); }
    catch { verdict = { state: "waiting", code: "status_unavailable", why: "this machine's Walkie did not answer the SSH status request", fix: "run walkie doctor, then walkie ssh status" }; }
    if (verdict.state === "ready" || verdict.state === "failed") return verdict;
    if (noted !== verdict.code) { noted = verdict.code; d.onWaiting?.(verdict); }
    if (d.now() >= deadline) return sshFinal(verdict);
    await d.sleep(d.pollMs);
  }
}

/** The plain lines for a verdict (no colours: the caller decorates). */
export function sshFinalLines(f: SshFinal | SshReport): string[] {
  if (f.state === "ready") return ["owner SSH is ready: Walkie's SSH service answers on 127.0.0.1, the owner's key is installed and the tunnel is open through Walkie"];
  const head = f.state === "waiting" ? "owner SSH is not ready yet" : "owner SSH is NOT ready";
  return [`${head} (${f.code}): ${f.why}`, `what fixes it: ${f.fix}`];
}
