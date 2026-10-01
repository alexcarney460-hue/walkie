// Grok hook handler: `walkie hook grok` (the native path) and, when Grok runs Walkie's Claude hook through its
// Claude-compatibility scan, `walkie hook claude` (claude.ts hands the event here). Grok's event names are PascalCase
// but its payload fields are camelCase. Which path reports which event is grok-events.ts. Report state only; hook
// output never controls Grok's permission or stop gates.
import { z } from "zod";
import { WalkieClient, walkieHome } from "../client/index.ts";
import { detectTask, repoContext, resolveAgentName } from "../agent/identity.ts";
import { readSharePolicy, type SharePolicy } from "../agent/share-policy.ts";
import { isSeatAgent } from "../protocol/seats.ts";
import type { BodyOf } from "../protocol/schemas.ts";
import type { HookDelivery } from "../protocol/hook-delivery.ts";
import { SESSION_ID_RE } from "../daemon/activity.ts";
import { transition } from "./claude.ts";
import { grokEvent, type GrokPath } from "./grok-events.ts";
import { loadState, saveState, shareableTask, shareableTitle, stateProvenance, type HookState } from "./state.ts";

const Input = z.object({
  hook_event_name: z.string().max(40).optional(), hookEventName: z.string().max(40).optional(),
  sessionId: z.string().max(80).optional(), session_id: z.string().max(80).optional(),
  cwd: z.string().max(4096).optional(), prompt: z.string().max(64_000).optional(),
  toolName: z.string().max(100).optional(), tool_name: z.string().max(100).optional(),
  toolInput: z.record(z.unknown()).optional(), tool_input: z.record(z.unknown()).optional(),
  message: z.string().max(1000).optional(), notificationType: z.string().max(80).optional(),
  source: z.string().max(80).optional(), model: z.string().max(80).optional(),
  promptId: z.string().max(160).optional(), stopHookActive: z.boolean().optional(),
  subagentType: z.string().max(100).optional(),
  // The event's identity for the daemon's repeat check (hook-delivery.ts). A field of an unexpected shape costs the
  // identity, never the report.
  timestamp: z.string().max(64).optional().catch(undefined), toolUseId: z.string().max(200).optional().catch(undefined),
});

/**
 * One Grok event as a status update. `path` is the hook path the event arrived on ("claude": `walkie hook claude`,
 * "native": `walkie hook grok`): an event the other path owns is not reported here (grok-events.ts), whatever any Grok
 * hook file says. It has no default, so no caller skips the check by accident; `null` asks for the transition alone.
 */
export function grokUpdate(raw: string, env: NodeJS.ProcessEnv, prev: HookState, share: SharePolicy, now: number, path: GrokPath | null) {
  if (raw.length > 128 * 1024) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  const parsed = Input.safeParse(value);
  if (!parsed.success) return null;
  const input = parsed.data;
  if (input.subagentType) return null;
  const session = env.GROK_SESSION_ID ?? input.sessionId ?? input.session_id;
  if (!session || !SESSION_ID_RE.test(session) || (env.GROK_SESSION_ID && input.sessionId && env.GROK_SESSION_ID !== input.sessionId)) return null;
  const agent = resolveAgentName({ WALKIE_AGENT: env.WALKIE_AGENT, GROK_SESSION_ID: session });
  if (!agent || isSeatAgent(agent)) return null;
  const event = grokEvent(input);
  if (!event || (path !== null && event.path !== path)) return null;
  const normalizedEvent = event.walkie;
  if (normalizedEvent === "Stop" && (input.stopHookActive || (input.promptId && prev.grok_turn_id && input.promptId !== prev.grok_turn_id))) return null;
  const step = transition({ hook_event_name: normalizedEvent, session_id: session, cwd: input.cwd,
    prompt: input.prompt, tool_name: input.toolName ?? input.tool_name,
    tool_input: input.toolInput ?? input.tool_input, message: input.message,
    notification_type: input.notificationType, source: input.source, model: input.model }, prev, now, share);
  if (!step) return null;
  const next = normalizedEvent === "UserPromptSubmit" && input.promptId ? { ...step.next, grok_turn_id: input.promptId } : step.next;
  const ctx = repoContext(input.cwd ?? process.cwd());
  const cachedTask = shareableTask(next, share.prompts);
  const body: BodyOf<"agent.status"> = { agent, state: step.state, runtime: "other", runtime_name: "grok",
    session, repo: ctx.repo, branch: ctx.branch, cwd: ctx.cwd, started_at: next.started_at,
    title: shareableTitle(next, share.prompts), task: cachedTask ?? detectTask(ctx.branch?.toUpperCase()),
    activity: step.activity };
  const provenance = stateProvenance(next);
  // Whichever hook delivers this event, it names the same session, event, time, tool call, turn and notification type:
  // the daemon applies it once. A session-scoped notification has no call or turn, so its type is what tells two apart.
  const delivery: HookDelivery | undefined = input.timestamp
    ? { session, event: event.name, at: input.timestamp, ...(input.toolUseId ? { call: input.toolUseId } : {}), ...(input.promptId ? { turn: input.promptId } : {}),
        ...(normalizedEvent === "Notification" && input.notificationType ? { kind: input.notificationType } : {}) }
    : undefined;
  return { body, next, provenance: { ...provenance, task: cachedTask ? provenance.task : "branch" as const, activity: step.activityKind }, delivery };
}

export async function runGrokHook(raw: string, env: NodeJS.ProcessEnv = process.env, path: GrokPath = "native"): Promise<void> {
  const share = readSharePolicy(walkieHome(), env);
  const probe = grokUpdate(raw, env, { injected: [] }, share, Date.now(), path);
  if (!probe) return;
  const update = grokUpdate(raw, env, loadState(probe.body.agent), share, Date.now(), path);
  if (!update) return;
  saveState(update.body.agent, update.next);
  await new WalkieClient({ agent: update.body.agent, timeoutMs: 1200 }).status(update.body, update.provenance, update.delivery).catch(() => undefined);
}
