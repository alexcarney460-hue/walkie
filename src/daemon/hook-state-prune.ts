// The hooks' state under <walkie home>/agents of sessions that ended without a clean SessionEnd (a crash, a kill) is
// pruned here, at daemon start and every hour (WALKIE-MISSION-SUB-1; Opus mission-sub r1, r2):
//   - a sub-agent's state file (<session>.<id>.json) or a session's pending launches (<session>.subq/): older than
//     HOOK_STATE_TTL_MS, or older than ABSENT_GRACE_MS when the session is gone;
//   - a session's own state file (<session>.json: its title and the asks it was shown): older than SESSION_STATE_TTL_MS
//     when the session is gone;
//   - a writer's temp file older than an hour.
// "Gone": its latest status on this node is offline, or it has none, and discovery's last complete scan didn't see
// it running. When discovery can't say (off, or an incomplete scan), a session without a status counts as running.
// Every entry is visited, a batch at a time with a pause between batches (the daemon keeps answering); never throws.
import { readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Core } from "./core.ts";
import type { Logger } from "./logger.ts";

export const HOOK_STATE_TTL_MS = 86_400_000;
export const SESSION_STATE_TTL_MS = 7 * 86_400_000;
export const ABSENT_GRACE_MS = 10 * 60_000;
export const HOOK_PRUNE_INTERVAL_MS = 3_600_000;
const TMP_TTL_MS = 3_600_000;
export const PRUNE_BATCH = 1_000;

/** The session names discovery saw running in its last complete scan; null when it can't say. */
export type RunningAgents = () => ReadonlySet<string> | null;

function sessionGone(core: Core, agent: string, running: ReadonlySet<string> | null): boolean {
  if (running?.has(agent)) return false;
  const row = core.store.agent(core.nodeId, agent);
  if (row) return (JSON.parse(row.body) as { state?: string }).state === "offline";
  return running !== null; // no status: gone only when a complete scan didn't see it
}

/** One entry: whether it was removed. */
function pruneEntry(dir: string, name: string, core: Core, running: ReadonlySet<string> | null, now: number): boolean {
  const path = join(dir, name);
  const age = now - statSync(path).mtimeMs;
  if (name.endsWith(".tmp")) {
    if (age < TMP_TTL_MS) return false;
    unlinkSync(path);
    return true;
  }
  if (name.endsWith(".subq")) {
    const parent = name.slice(0, -".subq".length);
    if (age < HOOK_STATE_TTL_MS && (age < ABSENT_GRACE_MS || !sessionGone(core, parent, running))) return false;
    rmSync(path, { recursive: true, force: true });
    return true;
  }
  if (!name.endsWith(".json")) return false;
  const st = JSON.parse(readFileSync(path, "utf8")) as { agent_id?: unknown; parent?: unknown };
  if (typeof st.agent_id === "string" && typeof st.parent === "string") {
    if (age < HOOK_STATE_TTL_MS && (age < ABSENT_GRACE_MS || !sessionGone(core, st.parent, running))) return false;
  } else if (age < SESSION_STATE_TTL_MS || !sessionGone(core, name.slice(0, -".json".length), running)) {
    return false;
  }
  unlinkSync(path);
  return true;
}

/** Every entry of `<home>/agents`, PRUNE_BATCH at a time. Returns how many were removed. */
export async function pruneHookState(home: string, core: Core, opts: { now?: number; running?: RunningAgents; pause?: () => Promise<void> } = {}): Promise<number> {
  const dir = join(home, "agents");
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  const now = opts.now ?? Date.now();
  const running = opts.running?.() ?? null;
  const pause = opts.pause ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  let removed = 0;
  for (let i = 0; i < names.length; i += PRUNE_BATCH) {
    if (i) await pause();
    for (const name of names.slice(i, i + PRUNE_BATCH)) {
      try { if (pruneEntry(dir, name, core, running, now)) removed++; } catch { /* unreadable or gone: next */ }
    }
  }
  return removed;
}

/** At start and hourly; the timer never keeps the process alive. */
export function startHookStatePrune(home: string, core: Core, log: Logger, running?: RunningAgents): () => void {
  let busy = false;
  const run = () => {
    if (busy) return;
    busy = true;
    void pruneHookState(home, core, running ? { running } : {})
      .then((n) => { if (n) log.info("hook_state_pruned", { removed: n }); })
      .catch((err: unknown) => log.warn("hook_state_prune_failed", { err: (err as Error).message }))
      .finally(() => { busy = false; });
  };
  run();
  const timer = setInterval(run, HOOK_PRUNE_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
