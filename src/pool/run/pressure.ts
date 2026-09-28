// Memory-pressure policy for every pool job (POOL-REAL-1 fix round, Codex p8 MEDIUM 9): a served model, a split run's
// head and a stage of someone else's run all follow the same rules, from this machine's own machine stats (the OS's
// signal: macOS kern.memorystatus_vm_pressure_level, Linux PSI):
//   - a job does not START while the machine reports "warn" or "critical" pressure;
//   - a running job STOPS at "critical", or at "warn" once swap has grown by SWAP_GROWTH_BYTES since it started (it is
//     pushing its owner's machine into swapping).
// These are product guarantees. The alex-mac experiment's stricter guard (stop at the first "warn" sample) was a test
// harness choice, not this policy.
import type { MachineMem } from "../../protocol/machine-stats.ts";

export const SWAP_GROWTH_BYTES = 512 * 1024 * 1024;

export type MemNow = Pick<MachineMem, "pressure" | "swap_used"> | null | undefined;

/** Why a new job may not start now, or null. */
export function startBlocked(m: MemNow): string | null {
  if (m?.pressure === "critical" || m?.pressure === "warn") {
    return `this machine is under ${m.pressure} memory pressure now; try again when it has settled`;
  }
  return null;
}

/** Watches one running job against the policy above (the swap baseline is taken when it starts). */
export class PressureWatch {
  private readonly swap0: number | null;
  constructor(private readonly read: () => MemNow) {
    const m = read();
    this.swap0 = typeof m?.swap_used === "number" ? m.swap_used : null;
  }

  /** Why the job must stop now, or null. */
  check(): string | null {
    const m = this.read();
    if (m?.pressure === "critical") return "memory_pressure_critical";
    if (m?.pressure === "warn" && this.swap0 !== null && typeof m.swap_used === "number" && m.swap_used - this.swap0 > SWAP_GROWTH_BYTES) {
      return "memory_pressure_swap_growth";
    }
    return null;
  }
}
