// A Hermes card of this machine shows an activity line only for a profile on the allow list (config.json `hermes_activity_profiles`,
// src/protocol/hermes-activity.ts). A profile taken off the list, or a list that turned invalid, must lose the line from its card
// without waiting for a hook: a session at its prompt hooks no more, so its last line ("Finished turn", or the tool's name under
// share_activity) would stay on the roster and on every teammate for good.
//
// The scrub runs from two places: every discovery scan (where discovery runs), and the timer below, at daemon start and every
// HERMES_SCRUB_INTERVAL_MS whether or not discovery runs (`discover_agents` can be off, and a Windows daemon has no discovery). A pass
// is one stat of config.json and a key-range read of this node's `hermes-*` rows (Store.agentsWithPrefix): it reads no other agent.
import type { BodyOf } from "../protocol/schemas.ts";
import type { Core } from "./core.ts";
import { isHermesStatus } from "./hermes-status.ts";
import type { Logger } from "./logger.ts";
import { observedAt } from "./views.ts";
import { trackOp } from "./watchdog.ts";

export const HERMES_SCRUB_INTERVAL_MS = 15_000;

/**
 * A Hermes card of this node that shows an activity line for a profile outside `allowed` is posted again with its state only: state
 * only means no line, whatever the card showed before. Returns how many cards it posted. Does nothing before this node is in a team.
 *
 * Posting a card again is not observing it again. The copy carries the time the card was really observed (`observed_at`, as every
 * re-signed status does: Core.reprojectOwnStatuses), so a session that died hours ago is not made to look alive by it: where no
 * discovery runs, nothing else would say it is gone. A card whose status bucket is empty waits for the next pass.
 */
export function scrubHermesActivity(core: Core, allowed: readonly string[]): number {
  if (!core.teamId || !core.me()) return 0;
  let posted = 0;
  for (const row of core.store.agentsWithPrefix(core.nodeId, "hermes-")) {
    if (allowed.includes(row.agent.slice("hermes-".length))) continue;
    let body: BodyOf<"agent.status">;
    try { body = JSON.parse(row.body) as BodyOf<"agent.status">; } catch { continue; }
    if (!isHermesStatus(body) || body.activity === undefined) continue;
    if (!core.limiter.take(`status:${row.agent}`, core.limits.status)) continue;
    core.emit("agent.status", { agent: row.agent, state: body.state, runtime: "other", runtime_name: "hermes" },
      { agent: row.agent, observedAt: observedAt(body, row.ts) });
    posted++;
  }
  return posted;
}

/**
 * Scrubs at start and every `intervalMs`, against the list config.json holds at that moment (the daemon re-reads the file when it
 * changes). Never throws; the timer never keeps the process alive. Returns the function that stops it.
 */
export function startHermesActivityScrub(core: Core, log: Logger, opts: { intervalMs?: number } = {}): () => void {
  const run = (): void => {
    try {
      const posted = trackOp("hermes_scrub", () => scrubHermesActivity(core, core.hermesActivityProfiles()));
      if (posted) log.info("hermes_activity_scrubbed", { cards: posted });
    } catch (err) {
      log.warn("hermes_activity_scrub_failed", { err: (err as Error).message });
    }
  };
  run();
  const timer = setInterval(run, opts.intervalMs ?? HERMES_SCRUB_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
