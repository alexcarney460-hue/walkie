// Hermes shell hooks observe a profile's lifecycle. They never return a directive to Hermes.
import { createHash } from "node:crypto";
import { z } from "zod";
import { WalkieClient, walkieHome } from "../client/index.ts";
import { readHermesActivityProfiles, readSharePolicy, type SharePolicy } from "../agent/share-policy.ts";
import { HERMES_PROFILE as PROFILE } from "../protocol/hermes-activity.ts";
import type { BodyOf } from "../protocol/schemas.ts";
import type { StatusProvenance } from "../protocol/status-projection.ts";
import type { HermesStatus } from "../daemon/hermes-status.ts";

const Input = z.object({
  hook_event_name: z.string().max(40), session_id: z.string().min(1).max(80),
  profile: z.string().regex(PROFILE), tool_name: z.string().max(100).regex(/^[A-Za-z0-9_.:/-]+$/).nullish(),
  timestamp: z.union([z.number().int().positive(), z.string().max(40)]).optional(),
  event_sequence: z.number().int().nonnegative().safe().optional(),
  pid: z.unknown().optional(), // read by pidOf: a malformed one is dropped, not a reason to lose the status
}).passthrough();
const STATES = {
  on_session_start: "idle", pre_llm_call: "working", pre_tool_call: "working", post_tool_call: "working",
  post_llm_call: "idle", on_session_end: "idle", on_session_finalize: "offline",
} as const;
type HermesUpdate = { body: BodyOf<"agent.status">; provenance: StatusProvenance };
const HOOK_DEADLINE_MS = 25_000; // Installed Hermes hook timeout is 30 seconds.

/** The process id a hook payload names: a positive safe integer. Anything else is ignored (the installed Hermes sends none). */
function pidOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseHook(raw: string): z.infer<typeof Input> | null {
  if (raw.length > 128 * 1024) return null;
  try { return Input.safeParse(JSON.parse(raw)).data ?? null; } catch { return null; }
}

/**
 * A hook event as a status. A profile shows its state only: it gets an activity line, of any kind, only when `activityProfiles`
 * (config.json hermes_activity_profiles) lists it. The daemon enforces the same list again, so this is not the only guard.
 */
function updateOf(input: z.infer<typeof Input>, activityProfiles: readonly string[], share: SharePolicy): HermesUpdate | null {
  const event = input.hook_event_name;
  const state = STATES[event as keyof typeof STATES];
  if (!state) return null;
  const shown = activityProfiles.includes(input.profile);
  const activity = shown && state === "working"
    ? share.activity && input.tool_name ? `Using ${input.tool_name}`.slice(0, 200) : event === "pre_llm_call" ? "Thinking" : "Using a tool"
    : shown && state === "idle" ? "Finished turn" : undefined;
  return { body: { agent: `hermes-${input.profile}`, state, runtime: "other", runtime_name: "hermes",
    ...(activity ? { activity } : {}) },
    provenance: activity ? { activity: share.activity && input.tool_name ? "tool" : "phrase" } : {} };
}

export function hermesUpdate(raw: string, activityProfiles: readonly string[] = [],
  share: SharePolicy = { prompts: false, activity: false }): HermesUpdate | null {
  const input = parseHook(raw);
  return input ? updateOf(input, activityProfiles, share) : null;
}

function eventTime(value: string | number | undefined): number | null {
  if (value === undefined) return Date.now();
  const at = typeof value === "number" ? value : /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isSafeInteger(at) && at > 0 ? at : null;
}

/** A hook observation carries no prompt, tool input, raw session id, or client-side ledger. */
export function hermesObservation(raw: string, activityProfiles: readonly string[] = [],
  share: SharePolicy = { prompts: false, activity: false }): HermesStatus | null {
  const input = parseHook(raw);
  if (!input) return null;
  const update = updateOf(input, activityProfiles, share);
  const at = eventTime(input.timestamp);
  if (!update || at === null) return null;
  const fallback = update.body.state === "working" ? "working" : update.body.state === "offline" ? "offline" : "idle";
  const state = input.hook_event_name === "on_session_end" || input.hook_event_name === "on_session_finalize" ? "offline" : fallback;
  const pid = pidOf(input.pid);
  return { profile: input.profile, session: createHash("sha256").update(input.session_id).digest("hex"), at,
    sequence: input.event_sequence ?? Number(process.hrtime.bigint() / 1_000n), state,
    fallback, ...(pid ? { pid } : {}),
    ...(update.body.activity ? { activity: update.body.activity, source: update.provenance.activity } : {}) };
}

/** One bounded daemon request per invocation. A later Hermes event carries current state after an outage. */
export async function recordHermesUpdate(raw: string, activityProfiles: readonly string[] = [],
  share: SharePolicy = { prompts: false, activity: false },
  publish?: (event: HermesStatus) => Promise<unknown>, deadlineMs = HOOK_DEADLINE_MS): Promise<HermesStatus | null> {
  const event = hermesObservation(raw, activityProfiles, share);
  if (!event) return null;
  if (!publish) return event;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([publish(event), new Promise<void>((resolve) => { timer = setTimeout(resolve, deadlineMs); })]);
  } finally { if (timer) clearTimeout(timer); }
  return event;
}

/** The hook as Hermes runs it: the allow list and the share policy are read from config.json on every call. */
export async function runHermesHook(raw: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const home = walkieHome();
    await recordHermesUpdate(raw, readHermesActivityProfiles(home), readSharePolicy(home, env), async (event) => {
      await new WalkieClient({ agent: `hermes-${event.profile}`, timeoutMs: 1500 }).hermesStatus(event);
    });
  } catch { /* The next event is a fresh observation; hooks never block Hermes on Walkie availability. */ }
}
