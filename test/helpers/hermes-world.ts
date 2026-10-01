// Helpers of the Hermes discovery tests: a hook as the daemon route applies it, and the rows and events it leaves behind.
import { createHash } from "node:crypto";
import { applyHermesStatus, submitHermesUpdate } from "../../src/daemon/hermes-status.ts";
import { hermesObservation } from "../../src/hooks/hermes.ts";
import type { world } from "./discovery-world.ts";

export type World = ReturnType<typeof world>;

/** The session key the daemon stores for a Hermes session id (the hooks send its sha-256). */
export const session = (name: string) => createHash("sha256").update(name).digest("hex");
export const launchd = (w: World) => ({ pid: 1, ppid: 0, uid: 0, startedAt: w.clock.t - 100_000, command: "/sbin/launchd" });
let hookSequence = 0;

/** A hook as the daemon route applies it: the session row, then the cards through the status coalescer. */
export function hermesHook(w: World, profile: string, name: string, state: "working" | "idle" = "working", pid?: number) {
  submitHermesUpdate(w.core.statuses, applyHermesStatus(w.core.store, { profile, session: session(name), at: w.clock.t, sequence: ++hookSequence,
    state, fallback: state, ...(pid ? { pid } : {}) }, w.clock.t), w.core.hermesActivityProfiles());
}

/**
 * One hook of the installed Hermes as the daemon route applies it: the payload Hermes sends, as an observation, as a
 * row, and the cards. Hermes fires `on_session_end` after EVERY turn (a row that is state offline, fallback idle), so a
 * session at its prompt is never a state=idle row; only `on_session_finalize` ends a session for good.
 */
export function hermesEvent(w: World, profile: string, name: string, event: string, tool?: string) {
  const observation = hermesObservation(JSON.stringify({ session_id: name, profile, hook_event_name: event, cwd: "/x",
    ...(tool ? { tool_name: tool } : {}), timestamp: w.clock.t, event_sequence: ++hookSequence }), w.core.hermesActivityProfiles(), { prompts: false, activity: true });
  if (!observation) throw new Error(`hook ${event} produced no observation`);
  submitHermesUpdate(w.core.statuses, applyHermesStatus(w.core.store, observation, w.clock.t), w.core.hermesActivityProfiles());
}

/** The state of the row of a session, undefined once the row is gone. */
export const rowState = (w: World, name: string) => w.core.store.db.query<{ state: string }, [string]>(
  "SELECT state FROM hermes_sessions WHERE session = ?").get(session(name))?.state;
/** How many offline statuses the agent was sent. */
export const offlineEvents = (w: World, agent: string) => w.core.store.db.query<{ n: number }, [string]>(
  "SELECT COUNT(*) AS n FROM events WHERE kind = 'agent.status' AND author_agent = ? AND json_extract(body, '$.state') = 'offline'").get(agent)!.n;
