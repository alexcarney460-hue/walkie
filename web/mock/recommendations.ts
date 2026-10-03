import { z } from "zod";
import { errorResponse, parseWith, readJson } from "../../src/daemon/http.ts";
import type { Recommendation } from "../src/api/types.ts";

// Match rec-routes.ts and LOCAL_BODY_MAX without loading the live route registry.
const Note = z.object({ note: z.string().max(200).optional(), seen: z.string().max(4_100).optional() }).strict();
const BODY_MAX = 256 * 1024;
const fixtureResult = "Fixture only; no real action performed.";

/** Synthetic records only: no daemon, accounts, models or machine actions. */
export function recommendationFixtures(): Recommendation[] {
  return [
    ["work", "Start the accessibility update", "The design is ready and a builder is available."],
    ["moves", "Move the finished navigation update to review", "The builder reported that its checks passed."],
    ["reviews", "Ask for a review of the search improvements", "The changes are ready for another pair of eyes."],
    ["stalled", "Ask for an update on the import task", "There has been no progress update today."],
    ["setup", "Check whether the demo machine is ready", "Its setup check has not been recorded."],
  ].map(([group, summary, reason], i) => ({
    id: `0000000000000001:${i + 1}`, short: `0000000${i + 1}`,
    group: group as Recommendation["group"], summary: summary!, reason: reason!,
    project_name: group === "setup" ? null : "Demo project", evidence: ["Fictional fixture for dashboard previews."],
    status: "pending", can_approve: true, can_dismiss: true,
    // The two asks show word for word what approving sends; the stalled one also quotes what WalkieTalkie wrote (never sent).
    ...(group === "reviews" ? { outgoing: `[WalkieTalkie recommendation 0000000${i + 1}]\nPlease take the review of card DEMO-3.\nCard DEMO-3: Search improvements\n(Sent by @demo-person on WalkieTalkie's recommendation: ${reason})` } : {}),
    ...(group === "stalled" ? { context: "Fictional fixture: the import task's agent stopped reporting.",
      outgoing: `[WalkieTalkie recommendation 0000000${i + 1}]\nHow is card DEMO-4 going? Please post an update on the card.\nCard DEMO-4: Import task\n(Sent by @demo-person on WalkieTalkie's recommendation.)` } : {}),
  }));
}

export class MockRecommendations {
  private recs = recommendationFixtures();

  async handle(req: Request, allowed: boolean, now = Date.now()): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/v1/talkie/recs")) return null;
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
    const view = (r: Recommendation): Recommendation => ({ ...r,
      can_approve: allowed && r.status === "pending", can_dismiss: allowed && r.status === "pending",
      ...(!allowed ? { why_not: "This preview is read-only for this person." } : {}),
    });
    if (req.method === "GET" && url.pathname === "/v1/talkie/recs") {
      const status = url.searchParams.get("status") ?? "open";
      if (status !== "all" && status !== "open") return fail(400, "invalid", "status is open or all");
      const open = this.recs.filter((r) => r.status === "pending");
      return json({ recs: [...open, ...(status === "all" ? this.recs.filter((r) => r.status !== "pending") : [])].map(view), now, more_open: 0 });
    }
    const match = /^\/v1\/talkie\/recs\/([^/]+)\/(approve|dismiss)$/.exec(url.pathname);
    if (req.method !== "POST" || !match) return fail(404, "not_found", "No such recommendation route.");
    if (!allowed || req.headers.has("x-walkie-agent") || req.headers.has("x-walkie-under-agent")) {
      return fail(403, "forbidden", "A person with permission must answer this recommendation.");
    }
    let id: string;
    try { id = decodeURIComponent(match[1]!); } catch { return fail(400, "invalid", "Invalid recommendation id."); }
    let body: z.infer<typeof Note>;
    try { body = parseWith(Note, await readJson(req, BODY_MAX)); }
    catch (err) { return errorResponse(err); }
    const rec = this.recs.find((r) => r.id === id || r.short === id);
    if (!rec) return fail(404, "not_found", "No such recommendation.");
    if (rec.status !== "pending") return fail(409, "rec_not_pending", `This recommendation was already ${rec.status}.`);
    const status = match[2] === "approve" ? "approved" : "dismissed";
    // Like rec-routes.ts: approving one that sends or does something in the person's name must echo the text they were shown.
    if (status === "approved" && typeof rec.outgoing === "string" && body.seen !== rec.outgoing) {
      return fail(409, "rec_changed", "This recommendation changed since you saw it: review it again.");
    }
    // Approval falls back to its synthetic result; dismissal has no default note.
    // Like answerRec, omit an explicitly empty note instead of substituting a result.
    const note = body.note ?? (status === "approved" ? fixtureResult : undefined);
    const resolved: Recommendation = { ...rec, status, can_approve: false, can_dismiss: false,
      resolved: { status, by: "demo-person", at: now, ...(note ? { note } : {}) } };
    this.recs = this.recs.map((r) => r.id === id || r.id === rec.id ? resolved : r);
    return json({ rec: view(resolved) });
  }
}
