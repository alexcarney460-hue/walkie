// The backlink of a Linear issue created from a Walkie thread, when it couldn't be posted at creation
// time (FINAL Codex 6): the issue exists, so the create answers a partial success and the backlink is a
// persisted job in `integration_retries` that the connector's runs post when the channel allows.
import type { RunCtx } from "./types.ts";

/** External id prefix of a queued backlink post in `integration_retries`. */
export const BACKLINK_PREFIX = "backlink:";
/** First retry after this long; each later attempt doubles it, up to a day; given up after BACKLINK_MAX_ATTEMPTS. */
export const BACKLINK_RETRY_MS = 30_000;
export const BACKLINK_MAX_ATTEMPTS = 12;

export interface BacklinkJob { channel: string; thread: string; identifier: string; title: string; url: string }

export function backlinkText(b: BacklinkJob): string {
  return `Created Linear issue **${b.identifier}**: ${b.title}\n${b.url}`;
}

/** Posts the due backlinks (the connector's run calls this first). Returns how many were posted. */
export async function drainBacklinks(ctx: Pick<RunCtx, "state" | "poster" | "now" | "log" | "scrub">, limit = 10): Promise<number> {
  let posted = 0;
  for (const job of ctx.state.dueRetries("linear", ctx.now(), limit)) {
    if (!job.external_id.startsWith(BACKLINK_PREFIX)) continue;
    let b: BacklinkJob;
    try { b = JSON.parse(job.payload) as BacklinkJob; } catch { ctx.state.dropRetry("linear", job.external_id); continue; }
    try {
      await ctx.poster.post("linear", b.channel, backlinkText(b), { thread: b.thread });
      ctx.state.dropRetry("linear", job.external_id);
      posted++;
    } catch (err) {
      const n = job.attempts + 1;
      if (n >= BACKLINK_MAX_ATTEMPTS) {
        ctx.state.dropRetry("linear", job.external_id);
        ctx.log.warn("linear_backlink_gave_up", { issue: b.identifier, attempts: n, err: ctx.scrub(err instanceof Error ? err.message : String(err)).slice(0, 200) });
      } else {
        ctx.state.rescheduleRetry("linear", job.external_id, n, ctx.now() + Math.min(24 * 60 * 60_000, BACKLINK_RETRY_MS * 2 ** n));
      }
    }
  }
  return posted;
}
