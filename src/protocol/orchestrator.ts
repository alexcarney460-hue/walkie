// Orchestrator conventions (PROTOCOL §8), shared by the daemon, CLI and dashboard. Pure: no I/O.
//
// A person's orchestrator is one long-lived Claude Code session supervised by the daemon of the machine they are at
// (the host). The conversation is LOCAL (ORCH-FIX-11/12): the person talks to this machine's host from this machine's
// dashboard or CLI; it is stored in this machine's database only (orch_messages) and is never an event, never
// replicated and never served to a peer, so no channel name is involved or reserved.
/** Agent name of the orchestrator (its team-wide `agent.status`: a generic state, never the conversation). */
export const ORCHESTRATOR_AGENT = "orchestrator";
/**
 * ORCH-2: what people see it called. The agent name ("orchestrator", reserved), the API routes (/v1/orchestrator/*)
 * and the stored data keep their names, so older peers and existing data keep working.
 */
export const ORCHESTRATOR_DISPLAY = "WalkieTalkie";
/** The name shown for an agent: WalkieTalkie for the orchestrator, else its own name. */
export function agentDisplayName(agent: string): string {
  return agent === ORCHESTRATOR_AGENT ? ORCHESTRATOR_DISPLAY : agent;
}
/**
 * The host's own Claude proves it is the orchestrator with a per-run secret (ORCH-FIX-13): the host puts it in its
 * child's environment only, the Walkie client sends it with `X-Walkie-Agent: orchestrator`, and the daemon accepts a
 * write under that name only with the live child's secret (anyone else writing as `orchestrator` is refused).
 */
export const ORCHESTRATOR_TOKEN_ENV = "WALKIE_ORCHESTRATOR_TOKEN";
export const ORCHESTRATOR_TOKEN_HEADER = "X-Walkie-Orchestrator-Token";
/** Tool entries a reply lists. */
export const MAX_TOOL_ENTRIES = 12;
/** A message the person sends is at most this long (characters). */
export const MAX_MESSAGE_CHARS = 32_000;
/** A stored reply is at most this many bytes (UTF-8); a longer one is cut and marked (ORCH-FIX-12). */
export const MAX_REPLY_BYTES = 256 * 1024;
/** Appended to a reply cut at MAX_REPLY_BYTES. */
export const REPLY_TRUNCATED_MARKER = "\n\n_(reply truncated: it was longer than 256 KiB)_";

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";
export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];

/**
 * What the orchestrator's Claude may do without asking (ORCH-2). It runs with nobody to answer a permission prompt, so
 * without an allow-list every tool that needs approval is denied, the Walkie tools included. `platform` (the default):
 * the Walkie MCP tools and the `walkie` CLI are always allowed, other tools follow the permission mode; `full`: every
 * tool is allowed (Claude's bypassPermissions), for a person who wants it to act on the whole machine for them.
 */
export type OrchestratorAccess = "platform" | "full";
export const ORCHESTRATOR_ACCESS: readonly OrchestratorAccess[] = ["platform", "full"];
export const DEFAULT_ACCESS: OrchestratorAccess = "platform";
/**
 * Claude permission rules the orchestrator always gets: every tool of the `walkie` MCP server, whose walkie_cli runs
 * walkie commands with no shell (src/mcp/walkie-cli.ts). No Bash rule: `Bash(walkie:*)` let shell chaining
 * (`walkie … | python3 …`, `; ls ~/keys`) run more than walkie (ORCH-2 smoke).
 */
export const PLATFORM_TOOLS: readonly string[] = ["mcp__walkie"];
/**
 * The orchestrator's model (ORCH-2): `default` (no --model: Claude's own default), one of the aliases the installed
 * claude documents for --model (`claude --help`, 2.1.283: "an alias for the latest model (e.g. 'fable', 'opus', or
 * 'sonnet')"; haiku too), or a full model id. Always one argv element (never a shell), never starting with "-".
 */
export const DEFAULT_MODEL = "default";
export const MODEL_ALIASES: readonly string[] = ["opus", "sonnet", "haiku", "fable"];
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\[\]:-]{0,99}$/;
/** Whether `m` may be sent as --model (or is `default`). */
export function validModel(m: unknown): m is string {
  return typeof m === "string" && MODEL_PATTERN.test(m);
}
/** The model to pass to Claude: undefined for `default` (and for nothing). */
export function modelArg(m: string | undefined): string | undefined {
  return !m || m === DEFAULT_MODEL ? undefined : m;
}

/** The permission mode Claude runs with: `full` is bypassPermissions whatever mode was asked. */
export function effectiveMode(access: OrchestratorAccess, mode: PermissionMode): PermissionMode {
  return access === "full" ? "bypassPermissions" : mode;
}

/**
 * One message of the local conversation (GET /v1/orchestrator/messages, SSE `orchestrator_message`). `person` = typed
 * by the person on this machine (`via` the dashboard or the CLI); `orchestrator` = the host's reply (`tools` it used).
 * A person's message is `queued` until the host sends it to Claude (`sent`); `refused` when the credential that sent it
 * ended first (a dashboard session signed out or expired, the local token rotated: ORCH-FIX-11) or this machine no
 * longer counts as its person; `dropped` when a stop, the age limit or a restart took it off the queue.
 */
export interface OrchMessage {
  id: string; thread: string; role: "person" | "orchestrator"; text: string; ts: number;
  via?: "dashboard" | "cli";
  state?: "queued" | "sent" | "refused" | "dropped";
  tools?: string[];
  /** For `orchestrator`: the id of the person's message it answers (ORCH-FIX-13: a reply is matched by it, never by order). */
  reply_to?: string;
}

/** GET /v1/orchestrator: the host on THIS machine (the conversation is local, ORCH-FIX-11). */
export interface OrchestratorView {
  local: {
    running: boolean;
    /**
     * ORCH-2: "standby" = another machine of the team is the lead (`lead`); "needs_login" = no Claude login here yet
     * (`needs` says how to add one). Older daemons never send them.
     */
    state: "stopped" | "starting" | "idle" | "working" | "restarting" | "failed" | "standby" | "needs_login";
    /** ORCH-2: it starts on its own (the team's lead with a model login); false after a stop by hand. */
    auto?: boolean;
    /** Stopped by hand (sticky until started again by hand). */
    stopped_by_hand?: boolean;
    /** The machine that runs the team's WalkieTalkie (while this one stands by). */
    lead?: string;
    /** Providers with a model login on this machine (names only). */
    logins?: string[];
    /** What to do when state is "needs_login". */
    needs?: string;
    model?: string; cwd?: string; permission_mode?: PermissionMode;
    /** ORCH-2: what it may do without asking (older daemons don't send it: treat as `platform`). */
    access?: OrchestratorAccess;
    /** ORCH-2: the model setting (`default`, an alias or a full id); `model` is what Claude reports it runs. */
    model_setting?: string;
    /** A model switch waiting for the reply in progress to end. */
    model_pending?: string;
    started_at?: number;
    /** The Claude session of the current conversation. */
    session?: string;
    restarts: number;
    /** The claude binary this host runs. */
    claude?: string;
    last_error?: string;
    /** The conversation whose reply is in progress, if any (the tab's "thinking" state and stop button). */
    working_thread?: string;
  };
}
