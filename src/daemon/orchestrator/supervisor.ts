import { readFileSync } from "node:fs";
import { z } from "zod";
import { killMarkedProcesses, rememberDescendants, type ProcessLedger } from "./marked-processes.ts";

export const SUPERVISOR_POLL_MS = 250;
export const HEARTBEAT_MS = 250;
export const HEARTBEAT_TIMEOUT_MS = 1_000; // allowed wall-clock skew for a newly written lease
export const ChildLease = z.object({
  expires: z.number().finite(), renewed: z.number().finite(), serial: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(), run: z.string().regex(/^[0-9]+\.[0-9a-f-]{36}$/),
}).strict();

/** Internal subprocess entry. Claude's tools may create separate sessions and process groups.
 * It does no daemon work, and ends marked descendants if the daemon parent dies or the lease is unreadable or expired.
 * A delayed daemon heartbeat cannot revoke an otherwise valid authority lease. A suspended machine is checked against
 * wall time immediately on wake, independently of the daemon.
 */
export function validChildLease(file: string, run: string, now = Date.now()): boolean {
  try {
    const lease = ChildLease.parse(JSON.parse(readFileSync(file, "utf8")));
    return lease.run === run && run.startsWith(`${lease.epoch}.`) && now < lease.expires
      && now >= lease.renewed - HEARTBEAT_TIMEOUT_MS;
  } catch { return false; }
}

export async function superviseChild(file: string, daemonPid: number, command: string[]): Promise<number> {
  if (!file || !Number.isSafeInteger(daemonPid) || daemonPid <= 0 || !command.length) return 2;
  let run = "";
  const ledger: ProcessLedger = new Map();
  const valid = (): boolean => {
    try {
      const lease = ChildLease.parse(JSON.parse(readFileSync(file, "utf8")));
      if (!run) run = lease.run; // a rewrite may advance serial and expiry, never the child identity
      return process.ppid === daemonPid && validChildLease(file, run);
    } catch { return false; }
  };
  const kill = (): void => {
    try { killMarkedProcesses(process.pid, run, ledger); } catch { /* fall back to the supervisor group */ }
    try { process.kill(-process.pid, "SIGKILL"); } catch { process.kill(process.pid, "SIGKILL"); }
  };
  if (!valid()) return 1;
  // Keep the supervisor alive until the child and its marked tools have been ended.
  process.on("SIGTERM", () => {});
  const timer = setInterval(() => {
    if (!valid()) { kill(); return; }
    try { rememberDescendants(process.pid, run, ledger); } catch { kill(); }
  }, SUPERVISOR_POLL_MS);
  try {
    const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, WALKIE_TALKIE_RUN: run } });
    const code = await child.exited;
    killMarkedProcesses(process.pid, run, ledger);
    return code;
  } finally { clearInterval(timer); }
}
