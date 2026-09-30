import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { adminCall } from "../seats/runner-child.ts";
import { DEFAULT_ADMIN } from "../seats/seat-user.ts";
import { selfOp } from "../seats/admin-ledger.ts";
import { redactSecrets } from "../../protocol/safety.ts";
import { CleanupObligation, cleanupDelay, newerGenerationOwnsCleanup } from "./cleanup-obligation.ts";

export const UID_MONITOR_POLL_MS = 250;
export const UID_MONITOR_LEASE_MS = 1_000;
const CLEANUP_OWNER_INTERVAL_MS = 3_000;
const CLEANUP_OWNER_RENEW_MS = 2_000;
export const uidMonitorFailureFile = (file: string): string => `${file}.monitor-error`;

interface UidLease { run: string; expires: number; renewed: number; serial: number }

export function writeUidLease(file: string, lease: UidLease): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(lease), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export function uidLeaseValid(file: string, run: string, previous: number, now: number, _monotonicElapsed: number): { valid: boolean; serial: number } {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object") return { valid: false, serial: previous };
    const lease = value as Partial<UidLease>;
    const valid = lease.run === run && typeof lease.expires === "number" && Number.isFinite(lease.expires)
      && typeof lease.renewed === "number" && Number.isFinite(lease.renewed)
      && Number.isSafeInteger(lease.serial) && (lease.serial as number) >= 0
      && now < lease.expires && now >= lease.renewed - UID_MONITOR_LEASE_MS;
    return { valid, serial: lease.serial ?? previous };
  } catch { return { valid: false, serial: previous }; }
}

/** Runs as the daemon's person, independently of the daemon and dedicated uid. */
export async function monitorUid(file: string, run: string, cleanupFile: string, deps: {
  now?: () => number; monotonic?: () => number; sleep?: (ms: number) => Promise<void>;
  destroy?: () => Promise<boolean | "newer">;
  report?: (line: string) => void;
  random?: () => number;
  helperPresent?: () => boolean;
  daemonPid?: number; parentPid?: () => number;
} = {}): Promise<number> {
  const now = deps.now ?? Date.now;
  const daemonPid = deps.daemonPid ?? process.ppid;
  const parentPid = deps.parentPid ?? (() => process.ppid);
  const monotonic = deps.monotonic ?? (() => performance.now());
  const obligation = new CleanupObligation(cleanupFile);
  const helperPresent = deps.helperPresent ?? (() => !!deps.destroy || existsSync(DEFAULT_ADMIN));
  const wait = async (ms: number): Promise<void> => {
    if (deps.sleep) { await deps.sleep(ms); return; }
    for (let left = ms; left > 0 && helperPresent(); left -= UID_MONITOR_LEASE_MS)
      await Bun.sleep(Math.min(left, UID_MONITOR_LEASE_MS));
  };
  let serial = -1;
  let changed = monotonic();
  let cleaning = false;
  let registered = false;
  let attempts = 0;
  const monitor = (() => { try { return selfOp(); } catch { return undefined; } })();
  let ownerRenewal: ReturnType<typeof setInterval> | null = null;
  const stopOwnerRenewal = () => { if (ownerRenewal) clearInterval(ownerRenewal); ownerRenewal = null; };
  const renewOwner = () => {
    if (!registered || !monitor) return;
    try { if (obligation.record(run, monitor, CLEANUP_OWNER_INTERVAL_MS)) return; }
    catch { /* expiry permits another owner to take over */ }
    registered = false;
    stopOwnerRenewal();
  };
  const startOwnerRenewal = () => {
    if (ownerRenewal || !monitor) return;
    ownerRenewal = setInterval(renewOwner, CLEANUP_OWNER_RENEW_MS);
    ownerRenewal.unref?.();
  };
  const refused = (): "retry" | 0 | 3 => {
    try {
      if (obligation.read()?.generation !== run) return 0;
      const owner = obligation.monitorOwner(run);
      // The daemon can release its row between our refused record and this read.
      // A dead parent can also leave an owner row whose liveness probe is uncertain.
      if (!owner || owner.pid === daemonPid || !obligation.ownerActive(run)) return "retry";
      return 3;
    } catch { return "retry"; }
  };
  try { for (;;) {
    if (!helperPresent()) {
      try {
        if (!obligation.record(run, monitor, CLEANUP_OWNER_INTERVAL_MS)) {
          const outcome = refused();
          if (outcome === "retry") { await (deps.sleep ?? Bun.sleep)(UID_MONITOR_POLL_MS); continue; }
          return outcome;
        }
        return 2; // the daemon takes over retries; no long-lived monitor without its helper
      } catch { await (deps.sleep ?? Bun.sleep)(300_000); continue; }
    }
    const checked = cleaning ? null : uidLeaseValid(file, run, serial, now(), monotonic() - changed);
    if (!checked?.valid || !Number.isSafeInteger(daemonPid) || daemonPid <= 0 || parentPid() !== daemonPid) {
      cleaning = true;
      try {
        if (!obligation.record(run, monitor, CLEANUP_OWNER_INTERVAL_MS)) {
          const outcome = refused();
          if (outcome === "retry") { await wait(UID_MONITOR_POLL_MS); continue; }
          return outcome;
        }
        registered = true;
        startOwnerRenewal();
      } catch { registered = false; /* destroy remains required even if storage is unavailable */ }
      let pending;
      try { pending = obligation.read(); }
      catch { pending = null; }
      if (pending && pending.generation !== run) return 0;
      if (!pending && registered) {
        try { if (!obligation.record(run)) return 0; }
        catch { /* proceed with generation-qualified destroy */ }
      }
      let detail = "the helper did not answer";
      let ok = false;
      let newer = false;
      try {
        if (deps.destroy) {
          const result = await deps.destroy();
          ok = result === true;
          newer = result === "newer";
        }
        else {
          let stderr = "";
          const result = await adminCall(["sudo", "-n", DEFAULT_ADMIN, "seat-admin", "talkie-destroy", run], 180_000,
            (line) => { stderr = line; });
          ok = result?.ok === true;
          newer = newerGenerationOwnsCleanup(result?.why);
          detail = result?.why ?? (stderr || detail);
        }
      } catch (err) { detail = err instanceof Error ? err.message : String(err); }
      if (ok || newer) {
        try { if (registered) obligation.clear(run); return 0; }
        catch { await wait(300_000); continue; }
      }
      attempts++;
      try {
        if (registered) obligation.failure(run, detail);
      } catch { registered = false; }
      const line = redactSecrets(registered ? `uid cleanup attempt ${attempts} failed: ${detail}`
        : `cleanup pending (could not record): uid cleanup attempt ${attempts} failed: ${detail}`)
        .text.replace(/\s+/g, " ").slice(0, 240);
      try {
        if (deps.report) deps.report(line);
        else writeFileSync(uidMonitorFailureFile(file), line, { mode: 0o600 });
      } catch { /* diagnostics must not stop cleanup retries */ }
      const delay = cleanupDelay(attempts, deps.random?.());
      try { if (registered && monitor) renewOwner(); }
      catch { registered = false; }
      await wait(delay);
      continue;
    }
    if (checked.serial !== serial) { serial = checked.serial; changed = monotonic(); }
    await wait(UID_MONITOR_POLL_MS);
  } } finally { stopOwnerRenewal(); }
}
