// `walkie hook codex '<json>'` — Codex `notify` handler (Codex passes the JSON as
// the last argv). Codex only notifies at turn end, so this reports "idle". The turn's first input as the title and
// the reply's first line as the activity only with share_prompts (src/agent/share-policy.ts). Never fails the caller.
import { WalkieClient, walkieHome } from "../client/index.ts";
import { detectTask, repoContext, resolveAgentName } from "../agent/identity.ts";
import { titleFromPrompt } from "./activity.ts";
import { redactSecrets } from "../protocol/safety.ts";
import { isSeatAgent } from "../protocol/seats.ts";
import { PRIVATE_TITLE, readSharePolicy } from "../agent/share-policy.ts";

interface CodexNotify {
  type?: string;
  "thread-id"?: string;
  "turn-id"?: string;
  cwd?: string;
  "input-messages"?: string[];
  "last-assistant-message"?: string;
}

/**
 * This Codex session's agent name. A Codex started from inside a Claude Code session inherits that session's
 * CLAUDE_CODE_SESSION_ID, which would name it after (and overwrite) the Claude session's card.
 */
export function codexAgentName(env: NodeJS.ProcessEnv, threadId?: string): string | null {
  const { CLAUDE_CODE_SESSION_ID: _session, CLAUDECODE: _cc, ...own } = env;
  return resolveAgentName({ ...own, CODEX_THREAD_ID: own.CODEX_THREAD_ID ?? threadId }, threadId);
}

export async function runCodexHook(raw: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let n: CodexNotify;
  try {
    n = JSON.parse(raw) as CodexNotify;
  } catch {
    return;
  }
  if (n.type !== "agent-turn-complete") return;
  const agent = codexAgentName(env, n["thread-id"]);
  if (!agent || isSeatAgent(agent)) return; // a remote seat's status is its host daemon's (PROTOCOL §11)
  const ctx = repoContext(n.cwd ?? process.cwd());
  const share = readSharePolicy(walkieHome(), env);
  const prompt = share.prompts ? n["input-messages"]?.[0] ?? "" : "";
  // The reply's first line, redacted WHOLE before it is shortened; too long to redact whole: not shown (Codex r2 #3).
  const line = share.prompts ? (n["last-assistant-message"] ?? "").split("\n").find((l) => l.trim()) ?? "" : "";
  const last = line.length <= 4_096 ? redactSecrets(line).text.replace(/\s+/g, " ").trim() : "";
  const task = detectTask(prompt);
  const client = new WalkieClient({ agent, timeoutMs: 1500 });
  await client.status({
    agent,
    state: "idle",
    runtime: "codex",
    title: share.prompts ? titleFromPrompt(prompt) || undefined : PRIVATE_TITLE,
    task: task ?? detectTask(ctx.branch?.toUpperCase()),
    repo: ctx.repo,
    branch: ctx.branch,
    cwd: ctx.cwd,
    activity: last ? `Done: ${last.slice(0, 170)}` : "Finished turn",
    session: n["thread-id"]?.slice(0, 80),
  }, { title: share.prompts ? "prompt" : "placeholder", task: task ? "prompt" : "branch", activity: last ? "reply" : "phrase" }).catch(() => undefined);
}
