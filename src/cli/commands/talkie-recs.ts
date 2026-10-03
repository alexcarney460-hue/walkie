// Recommendations use the injected client; the daemon retains authority over who may record or answer one.
import { bool, str, UsageError } from "../args.ts";
import { EXIT, requirePerson, type Ctx } from "../context.ts";
import { safeTerm } from "../format.ts";
import { REC_GROUPS, REC_GROUP_LABELS } from "../../protocol/talkie-recs.ts";
import type { RecommendInputT } from "../../daemon/orchestrator/rec-input.ts";

const line = (s: string): string => safeTerm(s).replace(/[\r\n\t]/g, " ");

export async function talkieRecs(ctx: Ctx, agent: boolean): Promise<number> {
  const sub = ctx.args.pos[0];
  if (sub === "recs") {
    if (ctx.args.pos.length !== 1) throw new UsageError("talkie recs [--all] [--json]");
    const { recs, now, more_open: more = 0 } = await ctx.client({ underAgent: agent }).talkieRecs(bool(ctx.args, "all") ? "all" : "open");
    // `{ recs }` as before; `more_open` is added only when the daemon left open ones out.
    if (ctx.json) ctx.out(JSON.stringify(more > 0 ? { recs, more_open: more } : { recs }));
    else if (!recs.length) ctx.out(bool(ctx.args, "all") ? "No recommendations" : "No open recommendations");
    else {
      for (const group of REC_GROUPS) {
        const rows = recs.filter((r) => r.group === group);
        if (!rows.length) continue;
        ctx.out(REC_GROUP_LABELS[group]);
        for (const r of rows) {
          const remaining = Math.max(0, r.expires_at - now);
          const time = remaining >= 3_600_000 ? `${Math.ceil(remaining / 3_600_000)} h left` : `${Math.ceil(remaining / 60_000)} min left`;
          ctx.out(`  ${line(r.short)}  ${line(r.summary)}`);
          ctx.out(`    ${line(r.reason)}`);
          // A model-driven duty's own words: quoted, marked as WalkieTalkie's, never sent in anyone's name.
          if (r.context) ctx.out(`    WalkieTalkie wrote (not sent): “${line(r.context)}”`);
          // Word for word what approving it sends or makes in this person's name.
          if (r.outgoing) {
            ctx.out("    Approving does this in your name:");
            for (const l of r.outgoing.split("\n")) ctx.out(`      ${line(l)}`);
          } else if (r.outgoing === null) ctx.out("    Its card is gone: approving it will be refused.");
          ctx.out(`    ${[r.project_name ? line(r.project_name) : null, line(r.status), r.status === "pending" ? time : null].filter(Boolean).join(" · ")}`);
          for (const evidence of r.evidence) ctx.out(`    ${line(evidence)}`);
          if (r.why_not) ctx.out(`    ${line(r.why_not)}`);
        }
      }
      ctx.out("walkie talkie approve <id>  |  walkie talkie dismiss <id>");
    }
    if (!ctx.json && more > 0) ctx.out(`${more} more open recommendation${more === 1 ? " is" : "s are"} not listed: answer some first.`);
    return EXIT.ok;
  }
  if (sub === "approve" || sub === "dismiss") {
    if (agent || ctx.forAgent) {
      ctx.err(`walkie: talkie ${sub} is for people; use your own terminal or the dashboard.`);
      return EXIT.error;
    }
    const id = ctx.args.pos[1];
    if (!id || ctx.args.pos.length !== 2) throw new UsageError(`talkie ${sub} <id> [--note <text>]`);
    const note = str(ctx.args, "note");
    if (ctx.args.flags.has("note") && note === undefined) throw new UsageError("--note needs text");
    if (note !== undefined && note.length > 200) throw new UsageError("--note must be at most 200 characters");
    const client = ctx.client();
    let seen: string | undefined;
    if (sub === "approve") {
      // What approving sends or does in this person's name is shown, and confirmed, before it goes; the daemon refuses the
      // approval if what it would do then differs from this text.
      const { recs } = await client.talkieRecs("open");
      const shown = recs.find((r) => r.short === id || r.id === id)?.outgoing;
      if (typeof shown === "string") {
        ctx.err("Approving does this in your name:");
        for (const l of shown.split("\n")) ctx.err(`  ${line(l)}`);
        await requirePerson(ctx, "approve it", "yes");
        seen = shown;
      }
    }
    const result: Awaited<ReturnType<typeof client.talkieApprove>> = sub === "approve" ? await client.talkieApprove(id, note, seen) : await client.talkieDismiss(id, note);
    if (ctx.json) ctx.out(JSON.stringify(result));
    else {
      ctx.out(`${sub === "approve" ? "approved" : "dismissed"}: ${line(result.rec.summary)}`);
      if (result.result !== undefined) ctx.out(line(result.result));
    }
    return EXIT.ok;
  }
  if (sub !== "recommend" || ctx.args.pos.length !== 2) throw new UsageError("talkie recommend '<JSON object>'");
  let body: unknown;
  try { body = JSON.parse(ctx.args.pos[1]!); }
  catch { throw new UsageError("talkie recommend requires valid JSON"); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new UsageError("talkie recommend requires a JSON object");
  // The daemon validates the full input and authenticates WalkieTalkie's duty token. Never manufacture that identity here.
  const result = await ctx.client({ underAgent: agent }).talkieRecommend(body as RecommendInputT);
  ctx.out(ctx.json ? JSON.stringify(result) : "duplicate" in result ? "already recorded"
    : "suppressed" in result ? "not recorded: it was dismissed lately" : `recorded ${line(result.short)}`);
  return EXIT.ok;
}
