// walkie history: this machine's admin audit and guest audit, merged oldest first. Reads only.
import { str, UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { safeTerm } from "../format.ts";
import { HistoryQueryError, parseHistoryQuery, type HistoryView } from "../../history/facade.ts";

const FLAGS = new Set(["since", "tool", "q", "limit", "json", "for-agent"]);
const HEADER = "this machine only — admin audit tail and guest audit, oldest first";

export function formatHistory(view: HistoryView): string[] {
  const lines = [HEADER];
  if (!view.entries.length) lines.push("no matching history on this machine");
  for (const entry of view.entries) lines.push(`${new Date(entry.ts).toISOString()}  ${entry.source}  ${safeTerm(entry.summary)}`);
  for (const omitted of view.omitted) lines.push(`guest audit not included (${omitted.reason})`);
  if (view.truncated) lines.push(`showing the newest ${view.entries.length} matching rows; more matched`);
  return lines;
}

export async function historyCommand(ctx: Ctx): Promise<number> {
  if (ctx.args.pos.length) throw new UsageError("walkie history takes only --since, --tool, --q, --limit and --json");
  for (const name of ctx.args.flags.keys()) {
    if (FLAGS.has(name)) continue;
    throw new UsageError(`unknown flag --${name.replace(/[^\x21-\x7e]/g, "").slice(0, 40)}`);
  }
  let query;
  try {
    query = parseHistoryQuery({
      since: str(ctx.args, "since"), tool: str(ctx.args, "tool"), q: str(ctx.args, "q"), limit: str(ctx.args, "limit"),
    });
  } catch (err) {
    if (err instanceof HistoryQueryError) throw new UsageError(err.message);
    throw err;
  }
  const view = await ctx.client().history(query);
  if (ctx.json) { ctx.out(JSON.stringify(view)); return EXIT.ok; }
  for (const line of formatHistory(view)) ctx.out(line);
  return EXIT.ok;
}
