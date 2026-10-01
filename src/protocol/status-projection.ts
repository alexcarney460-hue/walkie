// What an agent.status may carry (WALKIE-MISSION-1 fix round 2): ONE projection, applied where this daemon signs every
// agent.status (Core.emit), whoever wrote it: the Claude / Codex hooks and walkie_set_status through the local API,
// the MCP server's startup announcement, `walkie status`, and discovery. The outgoing body is REBUILT from an
// allow-list; nothing else leaves the machine.
//
// Always: agent, state, runtime, repo (a name, never a path), branch, started_at, and the functional fields model,
//         session (an opaque id) and ask_policy.
// title:    with share_prompts; without it only when a person typed it (`walkie status`, provenance `person`), an agent
//           set it on purpose with walkie_set_status (`agent`: an intentional publication, whose tool description
//           warns that the whole team sees it), or it is the fixed placeholder. Unknown provenance: dropped.
// task:     with share_prompts; without it only `person` / `agent`, or the key of the current branch. Else dropped.
// activity: a phrase of the closed ACTIVITY_PHRASES set always; a tool call's or a notification's text only with
//           share_activity; a reply's text only with share_prompts. Anything else becomes the state's fixed phrase.
// cwd:      only with share_paths.
// parent:   a sub-agent's session when named under it, or a host-owned seat's `seats` card.
// subagent_type: a built-in type always; a custom agent's name only with share_prompts, else "custom".
// Allowed text is redacted again here (discovery's statuses don't pass the local API's redaction).
import { detectTask } from "../agent/identity.ts";
import { SEATS_AGENT, SEAT_AGENT_PREFIX } from "./seats.ts";
import { redactSecrets } from "./safety.ts";
import { BUILTIN_SUBAGENT_TYPES, cleanSubagentType, namedUnder, shareableSubagentType } from "./subagents.ts";
import type { BodyOf } from "./schemas.ts";

type Status = BodyOf<"agent.status">;

/**
 * `person`: typed by a person (`walkie status`). `agent`: set on purpose by an agent through walkie_set_status (a
 * deliberate publication, see the tool's warning). `explicit` (fix round 2) is read as `agent`.
 */
export type TitleSource = "prompt" | "person" | "agent" | "placeholder";
export type TaskSource = "prompt" | "person" | "agent" | "branch";
export type ActivitySource = "phrase" | "tool" | "notification" | "reply";

/** Where a status's free-text fields came from, as its writer knows it. Never signed; absent = unknown. */
export interface StatusProvenance {
  readonly title?: TitleSource;
  readonly task?: TaskSource;
  readonly activity?: ActivitySource;
}

export interface ProjectionPolicy {
  /** share_prompts: titles (and task keys) from prompts, Codex's reply line. */
  readonly prompts: boolean;
  /** share_activity: tool calls' and notifications' text. */
  readonly activity: boolean;
  /** share_paths: the working directory. */
  readonly paths?: boolean;
}

/** The title a prompt gets when prompts are private. */
export const PRIVATE_TITLE = "Working on a task";

/** The state's own phrase: what an activity line says when its text may not be shared. */
// The fixed phrases live in activity-phrases.ts (no Node imports: the dashboard reads them too).
export { ACTIVITY_PHRASES, STATE_PHRASE } from "./activity-phrases.ts";
import { ACTIVITY_PHRASES, STATE_PHRASE } from "./activity-phrases.ts";

/** The seats host's status phrases (src/daemon/seats/host.ts): fixed, so shareable (in ACTIVITY_PHRASES above). */
export const SEATS_PHRASES = {
  off: "Seats off", allowed: "Seats allowed", running: "Seats running", busy: "Busy: its person is using it",
  enrollmentMigration: "Seats blocked: enrollment migration", enrollmentUnreadable: "Seats blocked: enrollment state unreadable",
} as const;

/** The fields a projected status can have at all. */
export const STATUS_FIELDS: ReadonlySet<string> = new Set([
  "agent", "state", "runtime", "repo", "branch", "started_at", "model", "session", "ask_policy", "title", "task", "activity", "cwd",
  "observed_at", // only on a status re-signed later (Core.reprojectOwnStatuses)
  "parent", "subagent_type", // sub-agents (WALKIE-MISSION-SUB-1)
  "launcher", // host-owned seats
  "launch", "runtime_name", // how it runs, and a runtime without a wire value (AGENT-SEE-1)
]);

const LAUNCH_RE = /^[a-z][a-z0-9-]{0,15}$/;
const RUNTIME_NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;

const SESSION_RE = /^[A-Za-z0-9._:-]{1,80}$/;

/** A name (ref, repo, model): control characters and a URL's user:password@ removed, cut to `max`. */
function cleanRef(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/(\b[a-z][a-z0-9+.-]{0,20}:\/\/)[^\s@/]{1,256}@/gi, "$1").slice(0, max);
}

/** At most `max` characters, never cutting a redaction marker in half. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const open = head.lastIndexOf("[REDACTED:");
  return open >= 0 && head.indexOf("]", open) < 0 ? head.slice(0, open) : head;
}

/**
 * Redacted, then cut to `max`, repeated to a fixed point: projecting a projected status changes nothing (Opus r4 #6),
 * so a re-signed status is never different from the one it replaces for this reason alone.
 */
function clean(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  let t = s.replace(/[\u0000-\u001f\u007f]/g, " ");
  for (let k = 0; k < 8; k++) {
    const next = cut(redactSecrets(t).text, max);
    if (next === t) return t;
    t = next;
  }
  return t;
}

function titleOk(title: string, prov: StatusProvenance, p: ProjectionPolicy): boolean {
  if (p.prompts || prov.title === "person" || prov.title === "agent") return true; // share_prompts: any source
  return prov.title === "placeholder" && title === PRIVATE_TITLE;
}

function taskOk(task: string, branch: string | undefined, prov: StatusProvenance, p: ProjectionPolicy): boolean {
  if (p.prompts || prov.task === "person" || prov.task === "agent") return true;
  return !!branch && detectTask(branch.toUpperCase()) === task; // the current branch's key, whatever the writer said
}

/** "Subagent: <x>": a launch's line. Only a built-in type is not prompt text (Codex mission-sub r1 #1). */
const LAUNCH_LINE = /^Subagent: (.*)$/s;

function activityOk(activity: string, prov: StatusProvenance, p: ProjectionPolicy): boolean {
  if (ACTIVITY_PHRASES.has(activity)) return true;
  // Whoever wrote it (an older hook, discovery): a launch line naming anything but a built-in type is prompt text.
  const launch = LAUNCH_LINE.exec(activity);
  if (launch && !p.prompts && !BUILTIN_SUBAGENT_TYPES.has(launch[1] as string)) return false;
  if (prov.activity === "tool" || prov.activity === "notification") return p.activity;
  if (prov.activity === "reply") return p.prompts;
  return false;
}

/** The status this daemon may sign for `body` under the policy: rebuilt from the allow-list above. */
export function projectStatus(body: Status, prov: StatusProvenance | undefined, p: ProjectionPolicy): Status {
  const pv = parseProvenance(prov); // only known values (an older writer's "explicit" = agent)
  // Ref names (repo, branch) and the model are names, not free text: never scanned for random-looking tokens (they
  // read like one, round 6 / Opus r5 #1); only credentials in a URL's userinfo are stripped. The task is checked
  // against the branch as published (whole-status idempotence, Codex r5 #8).
  const repoName = body.repo ? body.repo.split(/[\\/]/).filter(Boolean).pop() : undefined;
  const repo = repoName ? cleanRef(repoName, 120) : undefined;
  const branch = body.branch ? cleanRef(body.branch, 120) : undefined;
  const title = body.title && titleOk(body.title, pv, p) ? clean(body.title, 200) : undefined;
  const task = body.task && taskOk(body.task, branch, pv, p) ? clean(body.task, 80) : undefined;
  const activity = body.activity === undefined ? undefined
    : activityOk(body.activity, pv, p) ? clean(body.activity, 200) : STATE_PHRASE[body.state];
  const session = body.session && SESSION_RE.test(body.session) ? body.session : undefined;
  const seat = body.agent.startsWith(SEAT_AGENT_PREFIX);
  const parent = body.parent && (namedUnder(body.agent, body.parent) || (seat && body.parent === SEATS_AGENT)) ? body.parent : undefined;
  const rawType = parent ? cleanSubagentType(body.subagent_type) : undefined;
  const subType = rawType ? shareableSubagentType(rawType, p.prompts) : undefined;
  return {
    agent: body.agent, state: body.state, runtime: body.runtime,
    ...(repo ? { repo } : {}),
    ...(branch ? { branch } : {}),
    ...(body.started_at !== undefined ? { started_at: body.started_at } : {}),
    ...(body.model ? { model: cleanRef(body.model, 60) } : {}),
    ...(session ? { session } : {}),
    ...(body.ask_policy ? { ask_policy: body.ask_policy } : {}),
    ...(title ? { title } : {}),
    ...(task ? { task } : {}),
    ...(activity !== undefined ? { activity } : {}),
    ...(p.paths && body.cwd ? { cwd: clean(body.cwd, 300) } : {}),
    ...(parent ? { parent } : {}),
    ...(seat && parent === SEATS_AGENT && body.launcher ? { launcher: body.launcher } : {}),
    ...(subType ? { subagent_type: subType } : {}),
    // Fixed words (a mode, a runtime's name), never text from a prompt or a command line.
    ...(body.launch && LAUNCH_RE.test(body.launch) ? { launch: body.launch } : {}),
    ...(body.runtime === "other" && body.runtime_name && RUNTIME_NAME_RE.test(body.runtime_name) ? { runtime_name: body.runtime_name } : {}),
  };
}

const TITLE_SOURCES = new Set(["prompt", "person", "agent", "placeholder"]);
const TASK_SOURCES = new Set(["prompt", "person", "agent", "branch"]);
/** Round 2's `explicit` (an older CLI / MCP binary) = set on purpose by an agent. */
const legacy = (v: unknown) => (v === "explicit" ? "agent" : v);
const ACTIVITY_SOURCES = new Set(["phrase", "tool", "notification", "reply"]);

/** A provenance object from the local API's request body (anything unrecognised is dropped: unknown). */
export function parseProvenance(v: unknown): StatusProvenance {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    ...(typeof legacy(o.title) === "string" && TITLE_SOURCES.has(legacy(o.title) as string) ? { title: legacy(o.title) as TitleSource } : {}),
    ...(typeof legacy(o.task) === "string" && TASK_SOURCES.has(legacy(o.task) as string) ? { task: legacy(o.task) as TaskSource } : {}),
    ...(typeof o.activity === "string" && ACTIVITY_SOURCES.has(o.activity) ? { activity: o.activity as ActivitySource } : {}),
  };
}
