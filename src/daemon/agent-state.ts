// What an agent row's state means NOW (views.ts and the agent view cache share these): the status as the machine says
// it, then gone stale or the machine offline.
import type { AgentState } from "../protocol/schemas.ts";

export const STALE_STATUS_MS = 30 * 60_000;

export function effectiveState(state: AgentState, updatedAt: number, machineOnline: boolean, now = Date.now()): AgentState {
  if (!machineOnline) return "offline";
  if (state !== "idle" && now - updatedAt > STALE_STATUS_MS) return "offline";
  return state;
}

/** When a status was observed: its signing time, or an earlier `observed_at` of a re-signed copy (never later). */
export function observedAt(status: { observed_at?: number }, ts: number): number {
  return typeof status.observed_at === "number" ? Math.min(status.observed_at, ts) : ts;
}
