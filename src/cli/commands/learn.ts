import { bool, str, UsageError, AgentWrappedUsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import type { Learning } from "../../daemon/memory/learning.ts";
import { learningForAgent } from "../../daemon/memory/learning-output.ts";
import { memoryAgentText } from "../../daemon/memory/agent-output.ts";

export interface LearnReply { entry: Learning }
export interface LearnListReply { entries: Learning[] }

async function learnCommand(ctx: Ctx): Promise<number> {
  const [action, ...rest] = ctx.args.pos;
  if (action === "list") {
    if (rest.length) throw new UsageError("learn list takes no text");
    const path = `/v1/learn${bool(ctx.args, "all") ? "?all=1" : ""}`;
    const answer = await ctx.client().request<LearnListReply>("GET", path);
    const entries = ctx.forAgent ? answer.entries.map(learningForAgent) : answer.entries;
    ctx.out(ctx.json ? JSON.stringify({ entries }) : entries.length
      ? entries.map((entry) => `${entry.id} ${entry.status} [${entry.category}] ${entry.rule}${ctx.forAgent ? `\n${entry.evidence}` : ""}`).join("\n") : "no active learnings");
    return EXIT.ok;
  }
  if (action === "retract") {
    if (rest.length !== 1) throw new UsageError("learn retract needs one learning id");
    const answer = await ctx.client().request<LearnReply>("POST", "/v1/learn", {
      action, id: rest[0], requestId: str(ctx.args, "request-id") ?? `retract:${rest[0]}`,
    });
    const entry = ctx.forAgent ? learningForAgent(answer.entry) : answer.entry;
    ctx.out(ctx.json ? JSON.stringify({ entry }) : `${entry.id} ${entry.status}`);
    return EXIT.ok;
  }
  if (action !== "add" && action !== "correct") throw new UsageError("learn command must be add, correct, retract or list");
  const rule = rest.join(" ");
  const category = str(ctx.args, "category") ?? "general";
  const evidence = str(ctx.args, "evidence");
  const confidence = Number(str(ctx.args, "confidence") ?? "0.7");
  const supersedes = str(ctx.args, "supersedes");
  if (!rule || !evidence) throw new UsageError(`learn ${action} needs a rule and --evidence text`);
  if (action === "correct" && !supersedes) throw new UsageError("learn correct needs --supersedes ID");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new UsageError("confidence must be 0..1");
  const answer = await ctx.client().request<LearnReply>("POST", "/v1/learn", {
    action, rule, category, evidence, confidence,
    ...(str(ctx.args, "request-id") ? { requestId: str(ctx.args, "request-id") } : {}),
    ...(supersedes ? { supersedes } : {}),
  });
  const entry = ctx.forAgent ? learningForAgent(answer.entry) : answer.entry;
  ctx.out(ctx.json ? JSON.stringify({ entry }) : `${entry.id} ${entry.status}: ${entry.rule}${ctx.forAgent ? `\n${entry.evidence}` : ""}`);
  return EXIT.ok;
}

export async function learn(ctx: Ctx): Promise<number> {
  try { return await learnCommand(ctx); }
  catch (error) {
    if (!ctx.forAgent) throw error;
    throw new AgentWrappedUsageError(memoryAgentText("learning:error", "learning.error", error instanceof Error ? error.message : String(error)));
  }
}
