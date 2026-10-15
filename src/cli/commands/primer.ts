import { str, UsageError, AgentWrappedUsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { recallForAgent, type RecallResult } from "../../daemon/memory/primer.ts";
import { memoryAgentOutput, memoryAgentText, primerForAgent, type PrimerReply } from "../../daemon/memory/agent-output.ts";
import { safeTerm } from "../format.ts";

export type { PrimerReply } from "../../daemon/memory/agent-output.ts";

async function recallCommand(ctx: Ctx): Promise<number> {
  const query = ctx.args.pos.join(" ").trim();
  if (!query || query.length > 200) throw new UsageError("recall needs a query of 1..200 characters");
  const project = str(ctx.args, "project");
  const path = `/v1/recall?q=${encodeURIComponent(query)}${project ? `&project=${encodeURIComponent(project)}` : ""}`;
  const answer = await ctx.client().request<RecallResult>("GET", path);
  const shown = ctx.forAgent ? recallForAgent(answer) : answer;
  const body = shown.status === "ok"
    ? shown.items.map((item) => `${item.source} ${item.id}${item.slug && /^sq-[0-9a-f]{64}$/.test(item.slug) ? ` gbrain:${item.slug}` : ""}: ${item.text}${item.entityHits?.length
      ? `\nfound by: ${item.entityHits.map((hit) => `${safeTerm(hit.name)} (${safeTerm(hit.id)})${hit.stale ? " stale" : ""}`).join(", ")}` : ""}`).join("\n\n")
    : answer.status === "unavailable" ? "personal recall unavailable on this machine" : "no matching personal records";
  const semantic = shown.semantic?.status === "withheld" ? `semantic withheld: ${safeTerm(shown.semantic.reason ?? "unavailable")}`
    : shown.semantic?.status === "ready" ? "semantic ready" : "semantic status unavailable";
  const gbrain = shown.gbrain ? `gbrain: ${shown.gbrain.state}${shown.gbrain.reason ? ` (${safeTerm(shown.gbrain.reason)})` : ""}` : "gbrain status unavailable";
  ctx.out(ctx.json ? JSON.stringify(shown) : `${body}\n${gbrain}\n${semantic}\n${shown.sourceStatus ? safeTerm(shown.sourceStatus) : "claude-mem status unavailable"}`);
  return EXIT.ok;
}

export async function recall(ctx: Ctx): Promise<number> {
  try { return await recallCommand(ctx); }
  catch (error) {
    if (!ctx.forAgent) throw error;
    throw new AgentWrappedUsageError(memoryAgentText("recall:error", "recall.error", error instanceof Error ? error.message : String(error)));
  }
}

async function primerCommand(ctx: Ctx): Promise<number> {
  const action = ctx.args.pos[0] ?? "show";
  if (action === "status") {
    const answer = await ctx.client().request<Record<string, unknown>>("GET", "/v1/memory/capabilities");
    ctx.out(ctx.json ? JSON.stringify(ctx.forAgent ? memoryAgentOutput(answer, "primer.capabilities") : answer)
      : ctx.forAgent ? memoryAgentText("primer:capabilities", "primer.capabilities", JSON.stringify(answer))
        : "Claude Code: SessionStart hook injection requires a verified session; Codex and Kimi: native injection unsupported, recall available through CLI/MCP; owned v2 seats: primer in brief.");
    return EXIT.ok;
  }
  const project = str(ctx.args, "project") ?? "global";
  let answer: PrimerReply;
  if (action === "show") {
    answer = await ctx.client().request<PrimerReply>("GET", `/v1/primer?project=${encodeURIComponent(project)}`);
  } else if (action === "set") {
    const inProgress = str(ctx.args, "in-progress");
    const nextStep = str(ctx.args, "next-step");
    if (!inProgress || !nextStep) throw new UsageError("primer set needs --in-progress and --next-step");
    const blockers = (str(ctx.args, "blockers") ?? "").split("|").map((x) => x.trim()).filter(Boolean);
    answer = await ctx.client().request<PrimerReply>("POST", "/v1/primer", { project, inProgress, nextStep, blockers });
  } else throw new UsageError("primer command must be show or set");
  const shown = ctx.forAgent ? primerForAgent(answer) : answer;
  ctx.out(ctx.json ? JSON.stringify(shown) : shown.primer
    ? `In progress: ${shown.primer.inProgress}\nNext step: ${shown.primer.nextStep}${shown.primer.blockers.map((b) => `\nBlocker: ${b}`).join("")}`
    : answer.status === "unavailable" ? "personal primer unavailable on this machine" : "personal primer is empty");
  return EXIT.ok;
}

export async function primer(ctx: Ctx): Promise<number> {
  try { return await primerCommand(ctx); }
  catch (error) {
    if (!ctx.forAgent) throw error;
    throw new AgentWrappedUsageError(memoryAgentText("primer:error", "primer.error", error instanceof Error ? error.message : String(error)));
  }
}
