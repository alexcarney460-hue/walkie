// TALKIE-OPS-1 local API for WalkieTalkie's recommendations (PROTOCOL §9):
//   GET  /v1/talkie/recs[?status=open|all]   what this member can see, each with its short id and what they may do about it:
//                                            every open one first (up to MAX_OPEN_LIST, `more_open` counts the rest), then
//                                            with status=all the answered and expired ones, newest first (up to MAX_LIST)
//   POST /v1/talkie/recs/:id/approve         a person approves it: the action is performed (rec-act.ts), then the answer is signed
//   POST /v1/talkie/recs/:id/dismiss         a person says not now
//   POST /v1/talkie/recs                     WalkieTalkie's own child records one (rec-input.ts)
// Approving and dismissing are a person's alone (no agent, WalkieTalkie included, and no paired phone): the same gate the status
// report switch has. `:id` is the 8-hex short id the lists show, or the full event id.
import { z } from "zod";
import { personOnly } from "../admin/gate.ts";
import { HttpError, json, parseWith, readJson } from "../http.ts";
import { LOCAL_BODY_MAX, limitWrite, refuseAgentJoinContent, requireTeam, route, type RouteCtx } from "../local-routes.ts";
import { ORCHESTRATOR_AGENT } from "../../protocol/orchestrator.ts";
import { shortId } from "../../protocol/projects/short.ts";
import { MAX_LIST, MAX_OPEN_LIST, MAX_TURN_RECS, isOpen, titleRefId, type Rec } from "../../protocol/talkie-recs.ts";
import { hostFor } from "./host.ts";
import { fleetReader, outgoingNow, performRec, type FleetNow } from "./rec-act.ts";
import { RecommendInput, buildRec } from "./rec-input.ts";
import { answerRec, cardHiddenFrom, forgetRecs, holdWhileAnswering, mayAnswer, readRecs, recordRec, TITLE_UNREADABLE, viewOf, viewsOf, type RecDeps, type Recorded } from "./recs.ts";

function deps(c: RouteCtx): RecDeps {
  requireTeam(c);
  if (c.via === "phone") throw new HttpError(403, "forbidden", "recommendations are approved at this machine's dashboard or terminal, not from a phone");
  if (!c.projects) throw new HttpError(404, "not_found", "projects are not available on this daemon");
  return { core: c.core, idx: c.projects, log: c.core.log };
}

route("GET", "/v1/talkie/recs", (c) => {
  const d = deps(c);
  const status = c.url.searchParams.get("status") ?? "open";
  if (status !== "open" && status !== "all") throw new HttpError(400, "invalid", "status is open or all");
  // Open ones are never pushed out by history: all of them come first (up to their own cap), the answered and expired after.
  const all = readRecs(d);
  const open = all.filter(isOpen);
  const history = status === "all" ? all.filter((r) => !isOpen(r)).slice(0, MAX_LIST) : [];
  const fleet = fleetReader(d, c);
  const by = d.core.myHandle() ?? "you";
  const dashboard = fromDashboard(c);
  const recs = viewsOf(d, [...open.slice(0, MAX_OPEN_LIST), ...history], (r) => ({ outgoing: shownOf(d, r, by, fleet), dashboard }));
  return json({ recs, now: (d.now ?? d.core.clock)(), more_open: Math.max(0, open.length - MAX_OPEN_LIST) });
});

/** The recommendation a reference names among those this member can see (a short id, or an event id). */
function findRec(d: RecDeps, ref: string): Rec {
  const hits = readRecs(d).filter((r) => r.id === ref || shortId(r.id) === ref);
  if (!hits.length) throw new HttpError(404, "not_found", "no such recommendation (it may be old, or not for you)");
  if (hits.length > 1) throw new HttpError(409, "ambiguous", "that short id names more than one recommendation: use its full id");
  return hits[0] as Rec;
}

/** One answer at a time per recommendation on this daemon: a second tap waits, then finds it answered. */
const chains = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  chains.set(key, tail);
  try { return await run; } finally { if (chains.get(key) === tail) chains.delete(key); }
}

/** The request came from a dashboard session (a person at the dashboard), not a terminal. */
const fromDashboard = (c: RouteCtx): boolean => !!c.dashboard || c.via === "dashboard";

/** What a list shows as `outgoing`; a pending recommendation's only (an answered one sends nothing more). */
function shownOf(d: RecDeps, rec: Rec, by: string, fleet: () => FleetNow): string | null | undefined {
  if (!isOpen(rec)) return undefined;
  try { return outgoingNow(d, rec, by, fleet); }
  catch (err) { d.log?.warn("talkie_rec_outgoing_failed", { rec: rec.id, err: String(err).slice(0, 200) }); return undefined; }
}

/**
 * An answer's body. `seen` is the `outgoing` text the person was shown: approving a recommendation that sends or does something
 * in their name must echo it, and is refused when what it would do now differs (the card renamed, another machine chosen).
 */
const Note = z.object({ note: z.string().max(200).optional(), seen: z.string().max(4_100).optional() }).strict();
const ID = "([0-9a-f]{8}|[0-9a-f]{16}(?::|%3[Aa])[1-9][0-9]*)";

/** Finds the recommendation, refuses what cannot be answered (answered already, expired, not this person's), and runs `then` under its lock. */
async function answering(c: RouteCtx, ref: string, what: string, then: (d: RecDeps, rec: Rec, by: string, body: z.infer<typeof Note>) => Promise<{ status: "approved" | "dismissed"; result?: string }>): Promise<Response> {
  personOnly(c, `${what} a WalkieTalkie recommendation`);
  const d = deps(c);
  const body = parseWith(Note, await readJson(c.req, LOCAL_BODY_MAX));
  limitWrite(c);
  forgetRecs(d.core);
  const first = findRec(d, ref);
  return serial(`${d.core.nodeId}:${first.id}`, async () => {
    forgetRecs(d.core);
    const rec = findRec(d, ref);
    if (!isOpen(rec)) throw new HttpError(409, "rec_not_pending", rec.status === "expired" ? "this recommendation has expired" : `this recommendation was already ${rec.status}`);
    const may = mayAnswer(d.core, rec);
    if (!may.ok) throw new HttpError(403, "forbidden", `you cannot ${what} this one: ${may.why}`);
    const by = d.core.myHandle() as string;
    // No poll or curation run retires, replaces or remakes it while its action runs here (a second seat for one card).
    const done = await holdWhileAnswering(d.core, rec.key, () => then(d, rec, by, body));
    forgetRecs(d.core);
    const view = viewOf(d, findRec(d, rec.id), { dashboard: fromDashboard(c) });
    d.log?.info("talkie_rec_answered", { rec: rec.id, kind: rec.kind, by, status: done.status });
    return json({ rec: view, ...(done.result !== undefined ? { result: done.result } : {}) });
  });
}

route("POST", new RegExp(`^/v1/talkie/recs/${ID}/approve$`), (c, [ref]) =>
  answering(c, ref as string, "approve", async (d, rec, by, body) => {
    // A setup step runs a command on another machine through remote admin, a route a dashboard session may not call itself.
    if (rec.kind === "onboarding_step" && fromDashboard(c)) {
      throw new HttpError(403, "forbidden", `setup steps are approved in a terminal: walkie talkie approve ${shortId(rec.id)}`);
    }
    // Before the echo: someone who cannot see the card must not learn its title by being told the text changed, and must not approve it.
    if (cardHiddenFrom(d, rec, by)) throw new HttpError(403, "forbidden", "you cannot approve this one: you cannot see this card's channel");
    // What it would do now, read from the same fleet the action uses, must be what the person was shown.
    const fleet = fleetReader(d, c);
    const now = outgoingNow(d, rec, by, fleet);
    // A sealed create whose project post is not readable yet is not a gone card: say so, and do not tell them to dismiss it.
    if (now === null && rec.action.kind === "create_card" && titleRefId(rec.action.title)) throw new HttpError(409, "rec_stale", TITLE_UNREADABLE);
    if (now === null) throw new HttpError(409, "rec_stale", "the card it is about is no longer open; dismiss this recommendation");
    if (now !== undefined && body.seen !== now) {
      throw new HttpError(409, "rec_changed", body.seen === undefined
        ? "approving this one needs the text you were shown (what it sends or does in your name): list it again and approve from there"
        : "this recommendation changed since you saw it (what it would send or do in your name is different now): review it again");
    }
    const result = await performRec(d, c, rec, by, fleet);
    answerRec(d, rec, "approved", body.note, result);
    return { status: "approved", result };
  }));

route("POST", new RegExp(`^/v1/talkie/recs/${ID}/dismiss$`), (c, [ref]) =>
  answering(c, ref as string, "dismiss", async (d, rec, by, body) => {
    // The same refusal as approve, in the same place: before any answer is written, and the same words for a card that exists and one that does not.
    if (cardHiddenFrom(d, rec, by)) throw new HttpError(403, "forbidden", "you cannot dismiss this one: you cannot see this card's channel");
    answerRec(d, rec, "dismissed", body.note);
    return { status: "dismissed" };
  }));

/** Recommendations recorded by each turn of WalkieTalkie (a turn is a message's id) on this daemon: at most MAX_TURN_RECS. */
const recordedBy = new WeakMap<object, Map<string, number>>();

/**
 * WalkieTalkie's own child records a recommendation (its scheduled project sync and machine onboarding do, in place of acting):
 * the daemon validates the fields, writes the sentence, picks the audience, drops a repeat and keeps the caps. Nobody else may: a
 * person approves or dismisses; another agent has no business writing in WalkieTalkie's name.
 */
route("POST", "/v1/talkie/recs", async (c) => {
  const d = deps(c);
  if (c.agent !== ORCHESTRATOR_AGENT) throw new HttpError(403, "forbidden", "only WalkieTalkie records recommendations; a person approves or dismisses them");
  const input = parseWith(RecommendInput, await readJson(c.req, LOCAL_BODY_MAX));
  refuseAgentJoinContent(c, input);
  limitWrite(c);
  const turn = hostFor(c.core)?.currentTurnId?.() ?? "none";
  const recorded = recordedBy.get(c.core) ?? new Map<string, number>();
  recordedBy.set(c.core, recorded);
  if ((recorded.get(turn) ?? 0) >= MAX_TURN_RECS) throw new HttpError(429, "too_many_recs", `at most ${MAX_TURN_RECS} recommendations a turn`);
  const built = buildRec(d, input);
  if (built.skip) return json({ duplicate: true, reason: built.skip });
  let result: Recorded;
  try { result = recordRec(d, built.rec, built.channel); }
  catch (err) {
    if (err instanceof Error && /lease expired/.test(err.message)) throw new HttpError(409, "leadership_unavailable", "WalkieTalkie's lease has ended: nothing was recorded");
    throw err;
  }
  if (result.outcome === "created") {
    if (recorded.size > 200) recorded.clear();
    recorded.set(turn, (recorded.get(turn) ?? 0) + 1);
    return json({ id: result.id, short: shortId(result.id) }, 201);
  }
  if (result.outcome === "capped") throw new HttpError(409, "rec_limit", "there are too many open recommendations here; a person clears some first");
  return json(result.outcome === "duplicate" ? { duplicate: true } : { suppressed: true });
});
