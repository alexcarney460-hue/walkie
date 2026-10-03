// `walkie dispute raise|show|resolve` (WALK-73). The dispute is a post on the card; the daemon asks the resolver.
// Under an agent, the summary is wrapped for the model. An agent may raise; only a person may resolve.
import type { DisputeView } from "../../protocol/projects/dispute.ts";
import { defang, wrapForModel } from "../../protocol/safety.ts";
import { need, UsageError } from "../args.ts";
import { EXIT, readStdin, type Ctx } from "../context.ts";
import { client } from "./projects.ts";

/** The summary or reason: the remaining words, or stdin for `-`. One trailing newline is allowed; a second line is not. */
async function sentence(ctx: Ctx, from: number, what: string): Promise<string> {
  const words = ctx.args.pos.slice(from);
  const text = words.length === 1 && words[0] === "-" ? (await readStdin()).replace(/\n$/, "") : words.join(" ");
  if (!text.trim() || /[\r\n]/.test(text)) throw new UsageError(`a dispute ${what} is one plain line`);
  return text.trim();
}

/** One field, wrapped the way `projects show --json` wraps a card for a model. The summary is the raiser's; a reason is the resolver's. */
function modelText(d: DisputeView, text: string, max: number, author: { handle: string; agent?: string }): string {
  return wrapForModel({ id: d.id, kind: "dispute", author }, defang(text, max));
}

/** The dispute an agent is allowed to read: summary and reason wrapped, with the trust label. */
function forAgentDispute(d: DisputeView): DisputeView & { trust: "team-member" } {
  const resolver = { handle: d.resolved_by?.handle ?? d.by.handle };
  return {
    ...d,
    summary: modelText(d, d.summary, 500, d.by),
    ...(d.reason !== undefined ? { reason: modelText(d, d.reason, 200, resolver) } : {}),
    trust: "team-member",
  };
}

function render(ctx: Ctx, d: DisputeView): void {
  if (ctx.json) {
    ctx.out(JSON.stringify({ dispute: ctx.forAgent ? forAgentDispute(d) : d }));
    return;
  }
  ctx.out(`${d.state} ${d.ref}`);
  ctx.out(ctx.forAgent ? modelText(d, d.summary, 500, d.by) : d.summary);
  ctx.out(d.resolvers.join(" "));
  if (d.reason) ctx.out(ctx.forAgent ? modelText(d, d.reason, 200, { handle: d.resolved_by?.handle ?? d.by.handle }) : d.reason);
}

export async function disputeCmd(ctx: Ctx): Promise<number> {
  const sub = ctx.args.pos[0];
  const ref = need(ctx.args, 1, "card");
  if (sub === "show") {
    const { dispute } = await client(ctx).dispute(ref);
    if (!dispute) {
      ctx.out(ctx.json ? JSON.stringify({ dispute: null }) : `no dispute on ${ref}`);
      return EXIT.ok;
    }
    render(ctx, dispute);
    return EXIT.ok;
  }
  if (sub === "raise") {
    const summary = await sentence(ctx, 2, "summary");
    const res = await client(ctx).raiseDispute(ref, summary);
    if (ctx.json) ctx.out(JSON.stringify(ctx.forAgent ? { ...res, dispute: forAgentDispute(res.dispute) } : res));
    else render(ctx, res.dispute);
    return EXIT.ok;
  }
  if (sub === "resolve") {
    const reason = await sentence(ctx, 2, "reason");
    const { dispute } = await client(ctx).resolveDispute(ref, reason);
    render(ctx, dispute);
    return EXIT.ok;
  }
  throw new UsageError("usage: walkie dispute raise|show|resolve <card> …");
}
