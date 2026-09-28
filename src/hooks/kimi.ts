// Kimi's installed hook runner writes snake_case JSON on stdin. Status only: no hook output/injection.
import { z } from "zod";
import { WalkieClient, walkieHome } from "../client/index.ts";
import { repoContext, resolveAgentName } from "../agent/identity.ts";
import { readSharePolicy, type SharePolicy } from "../agent/share-policy.ts";
import { kimiSessionUuid } from "../daemon/kimi-sessions.ts";
import { isSeatAgent } from "../protocol/seats.ts";
import type { BodyOf } from "../protocol/schemas.ts";
import { transition } from "./claude.ts";
import { loadState, saveState, shareableTitle, shareableTask, stateProvenance, type HookState } from "./state.ts";

const Input = z.object({
  hook_event_name: z.string().max(40), session_id: z.string().max(80), cwd: z.string().max(4096).optional(),
  prompt: z.union([z.string().max(64000), z.array(z.object({ type: z.string(), text: z.string().max(64000).optional() })).max(100)]).optional(),
  tool_name: z.string().max(100).optional(), tool_input: z.record(z.unknown()).optional(),
});

export function kimiUpdate(raw: string, env: NodeJS.ProcessEnv, prev: HookState, share: SharePolicy, now: number) {
  if (raw.length > 128 * 1024) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  const parsed = Input.safeParse(value);
  if (!parsed.success) return null;
  const input = parsed.data;
  const session = kimiSessionUuid(input.session_id);
  if (!session) return null;
  const agent = resolveAgentName({ WALKIE_AGENT: env.WALKIE_AGENT, KIMI_SESSION_ID: session });
  if (!agent || isSeatAgent(agent)) return null;
  const prompt = typeof input.prompt === "string" ? input.prompt : input.prompt?.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
  const event = input.hook_event_name === "Interrupt" ? "Stop" : input.hook_event_name === "PermissionRequest" ? "Notification" : input.hook_event_name;
  const tr = transition({ ...input, prompt, hook_event_name: event,
    ...(input.hook_event_name === "PermissionRequest" ? { notification_type: "permission_prompt" } : {}) }, prev, now, share);
  if (!tr) return null;
  const ctx = repoContext(input.cwd ?? process.cwd());
  const body: BodyOf<"agent.status"> = { agent, state: tr.state, runtime: "kimi", session,
    repo: ctx.repo, branch: ctx.branch, cwd: ctx.cwd, started_at: tr.next.started_at,
    title: shareableTitle(tr.next, share.prompts), task: shareableTask(tr.next, share.prompts), activity: tr.activity };
  return { body, next: tr.next, provenance: { ...stateProvenance(tr.next), activity: tr.activityKind } };
}

export async function runKimiHook(raw: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const share = readSharePolicy(walkieHome(), env);
  const probe = kimiUpdate(raw, env, { injected: [] }, share, Date.now());
  if (!probe) return;
  const update = kimiUpdate(raw, env, loadState(probe.body.agent), share, Date.now());
  if (!update) return;
  saveState(update.body.agent, update.next);
  await new WalkieClient({ agent: update.body.agent, timeoutMs: 1500 }).status(update.body, update.provenance).catch(() => undefined);
}
