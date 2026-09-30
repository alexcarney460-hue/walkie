// Walkie's fixed status phrases (split out of status-projection.ts so the dashboard can import them without Node).
import type { AgentState } from "./schemas.ts";

export const STATE_PHRASE: Readonly<Record<AgentState, string>> = {
  working: "Working", idle: "Idle", waiting: "Waiting for you", blocked: "Stuck", offline: "Offline",
};

/** Every fixed activity phrase Walkie writes (hooks, discovery, MCP): shareable whatever the policy. */
export const ACTIVITY_PHRASES: ReadonlySet<string> = new Set([
  ...Object.values(STATE_PHRASE),
  // hooks (src/hooks/claude.ts, codex.ts) and the MCP server
  "Thinking", "Finished turn", "Session started", "Resumed session", "Session ended", "Connected to Walkie", "Updated status",
  "Needs your permission", "Needs your answer", "Waiting for input",
  // tool calls without share_activity (src/hooks/activity.ts activityPhrase) and Codex steps (src/daemon/activity.ts)
  "Running a command", "Editing files", "Reading files", "Searching", "Fetching a web page", "Waiting on a subagent",
  "Planning", "Using a tool", "Edit files", "Waiting on a command's output", "Waiting",
  // the seats host's own status (src/daemon/seats/host.ts)
  ...Object.values({ off: "Seats off", allowed: "Seats allowed", running: "Seats running", busy: "Busy: its person is using it" }),
  "Seat running", "Seat paused", "Seat finished",
  // discovery (src/daemon/discovery.ts)
  "Idle (no activity seen in the last minute)", "Working (seen from the process)", "Working (details pending)", "Process exited",
  "Running (no hooks yet — restart to see live activity)",
  // sub-agents (src/hooks/subagents.ts)
  "Sub-agent started", "Sub-agent finished", "Parent session ended",
]);
