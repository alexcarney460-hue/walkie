// AGENT-ADMIN-1: remote admin runs in progress on this machine. The peer route hands the walkie CLI it runs a random
// token (WALKIE_ADMIN_TOKEN); the CLI sends it back (X-Walkie-Admin-Token) and the gate then names the remote actor
// instead of the local one, and leaves the team post to the peer route (one line per remote command).
import { randomBytes } from "node:crypto";
import type { Core } from "../core.ts";

export interface RemoteRun {
  readonly actor: string; readonly notify: string | null; readonly callerNode?: string; readonly callerHandle?: string;
  /** Whether the remote caller may still administer this machine: asked again at each admin step (WALK-74). */
  readonly authorized?: () => boolean;
}

const runs = new WeakMap<Core, Map<string, RemoteRun>>();

export function beginRun(core: Core, run: RemoteRun): { token: string; end: () => void } {
  const token = randomBytes(24).toString("hex");
  const m = runs.get(core) ?? new Map<string, RemoteRun>();
  runs.set(core, m);
  m.set(token, run);
  return { token, end: () => { m.delete(token); } };
}

/** Remote admin runs at once on one machine, and from one calling machine (fix round 2, Opus MEDIUM). */
export const MAX_RUNS = 4;
export const MAX_RUNS_PER_CALLER = 2;

const slots = new WeakMap<Core, Map<string, number>>();

/** A run slot for a command from `caller` (a node id), or null when this machine or that caller is at its cap. */
export function claimSlot(core: Core, caller: string): (() => void) | null {
  const m = slots.get(core) ?? new Map<string, number>();
  slots.set(core, m);
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  const mine = m.get(caller) ?? 0;
  if (total >= MAX_RUNS || mine >= MAX_RUNS_PER_CALLER) return null;
  m.set(caller, mine + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (m.get(caller) ?? 1) - 1;
    if (n > 0) m.set(caller, n); else m.delete(caller);
  };
}

/** The run a token names, or null (unknown, or finished). */
export function runFor(core: Core, token: string | null): RemoteRun | null {
  if (!token || !/^[0-9a-f]{48}$/.test(token)) return null;
  return runs.get(core)?.get(token) ?? null;
}
