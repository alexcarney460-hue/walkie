// WALK-73 Phase 0: raise, show and resolve one dispute on a card. The dispute is a board op in the card's thread
// (protocol/projects/dispute.ts folds it). The resolver is asked with the ordinary ask route's checks. The ask's
// expiry is only how long that ask stays open: it does not close the dispute and it does not escalate it.
import { z } from "zod";
import { namesHermesAgent, parseAddress } from "../asks.ts";
import { HttpError, json, parseWith, readJson } from "../http.ts";
import { LOCAL_BODY_MAX, limitWrite, refuseAgentJoinContent, requireTeam, route, type RouteCtx } from "../local-routes.ts";
import { canSeeChannel, memberByHandle } from "../roster.ts";
import {
  DISPUTE_ASK_TTL_S, DISPUTE_RERAISE_AFTER_MS, chooseResolvers, disputeAskText, disputeText, resolveText, resolverHandle, settingsHeadState,
  type DisputeView,
} from "../../protocol/projects/dispute.ts";
import { PLAIN_LINE, DisputeOp } from "../../protocol/projects/schema.ts";
import { clean, findCard, isAgentCaller, post, requirePerson, type WriteCtx } from "./service.ts";

function caller(w: WriteCtx): { handle: string; role: string } {
  const m = w.core.me();
  if (!m || m.role === "removed") throw new HttpError(403, "forbidden", "this node is not an admitted member");
  return m;
}

/** One plain line, secrets redacted the same way as any other post. Empty after that is refused. */
function oneLine(w: WriteCtx, raw: string, max: number, what: string): string {
  const line = clean(w, raw).trim();
  if (!line || line.length > max || !PLAIN_LINE.test(line)) {
    throw new HttpError(400, "invalid", `a dispute ${what} is one plain line of at most ${max} characters`);
  }
  return line;
}

/** One write-limit token per signed post or ask, the same bucket as `POST /v1/ask`. Nothing is taken when there are not enough. */
function chargeWrites(w: WriteCtx, n: number): void {
  const spec = w.agent ? w.core.limits.agentWrite : w.core.limits.humanWrite;
  if (!w.core.limiter.take(`write:${w.rateKey ?? w.agent ?? "human"}`, spec, Date.now(), n)) {
    throw new HttpError(429, "rate_limited", "too many writes; slow down");
  }
}

/** Puts tokens back when the transaction that was going to spend them did not commit. */
function refundWrites(w: WriteCtx, n: number): void {
  const spec = w.agent ? w.core.limits.agentWrite : w.core.limits.humanWrite;
  w.core.limiter.refund(`write:${w.rateKey ?? w.agent ?? "human"}`, spec, n, Date.now());
}

/**
 * How far a stored receipt time may sit from this daemon's clock and still be that clock. Receipt is `Date.now()`
 * at insert; production's clock is the same. A test clock, or a receipt that cannot be this machine's clock, is not.
 */
const RERAISE_CLOCK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve id → the local clock at which a future-dated resolve first counted, used only when the stored receipt
 * time is not on this daemon's clock. Checking again must not start the 10 minutes over. Capped so a long run
 * cannot grow it; dropping one starts that wait from the next check, which is still 10 minutes and not a day.
 */
const futureResolveAnchor = new Map<string, number>();

/**
 * The instant the 10-minute wait runs from. The earlier of the time on the resolve and when this machine received
 * it, so a timestamp ahead cannot stretch the wait past 10 minutes after arrival and a timestamp behind can shorten
 * it. The time shown on the dispute stays the signed one. A later check uses the same instant.
 */
function reraiseBasis(w: WriteCtx, id: string, resolvedAt: number): number {
  const clock = w.core.clock();
  const received = w.core.store.receivedAt(id);
  if (received !== null && received <= clock + RERAISE_CLOCK_WINDOW_MS && received >= clock - RERAISE_CLOCK_WINDOW_MS) {
    futureResolveAnchor.delete(id);
    return Math.min(resolvedAt, received);
  }
  if (resolvedAt <= clock) {
    futureResolveAnchor.delete(id);
    return resolvedAt;
  }
  let anchor = futureResolveAnchor.get(id);
  if (anchor === undefined || anchor > clock) {
    if (futureResolveAnchor.size > 64) {
      const oldest = futureResolveAnchor.keys().next().value;
      if (oldest !== undefined) futureResolveAnchor.delete(oldest);
    }
    anchor = clock;
    futureResolveAnchor.set(id, anchor);
  }
  return anchor;
}

function reraiseTooSoon(w: WriteCtx, current: DisputeView): boolean {
  const basis = reraiseBasis(w, current.id, current.resolved_at ?? 0);
  return w.core.clock() < basis + DISPUTE_RERAISE_AFTER_MS;
}

/** The card's current dispute, or null. Fold only: no ask ids. `ref` is the card's reference now. */
export function showDispute(w: WriteCtx, ref: string): DisputeView | null {
  const { card } = findCard(w, ref);
  const current = w.idx.disputeOf(card.channel, card.id).current;
  return current ? { ...current, card: card.id, ref: card.ref } : null;
}

export interface RaisedDispute { dispute: DisputeView; asks: { id: string; to: string }[] }

/**
 * Post an open dispute on the card and ask each recorded resolver. One open dispute at a time. Nothing is signed
 * when the card, the project or the summary cannot take one, or when nobody can resolve it.
 */
export async function raiseDispute(w: WriteCtx, ref: string, summary: string): Promise<RaisedDispute> {
  const m = caller(w);
  if (m.role !== "owner" && m.role !== "member") throw new HttpError(403, "forbidden", "observers can't raise a dispute");
  w.idx.flushAll();
  const { project: p, card } = findCard(w, ref);
  if (p.state !== "active") throw new HttpError(409, "conflict", `project ${p.name} is ${p.state}`);
  if (card.state !== "open") throw new HttpError(409, "conflict", `${card.key} is ${card.state}`);
  const line = oneLine(w, summary, 500, "summary");
  const folded = w.idx.disputeOf(p.channel, card.id);
  if (folded.current?.state === "open") throw new HttpError(409, "conflict", "this card already has an open dispute");
  if (folded.current?.state === "resolved" && reraiseTooSoon(w, folded.current)) {
    throw new HttpError(409, "conflict", "a dispute on this card was resolved less than 10 minutes ago");
  }
  const owners = [...w.core.roster.members.values()].filter((x) => x.role === "owner").map((x) => x.handle);
  const chosen = chooseResolvers({
    contact: p.escalation_contact ?? "",
    creator: p.creator,
    owners,
    raiser: m.handle,
    roleOf: (handle) => memberByHandle(w.core.roster, handle)?.role ?? null,
    canSee: (handle) => canSeeChannel(w.core.roster, p.channel, handle),
  });
  if ("error" in chosen) throw new HttpError(409, "conflict", chosen.error);
  // The same checks POST /v1/ask makes, before anything is signed. A contact the fold still holds but who can no
  // longer be asked has already been skipped by chooseResolvers.
  for (const to of chosen.resolvers) {
    const target = parseAddress(to);
    if (target.machine === "cloud") throw new HttpError(403, "forbidden", "cloud guests receive assigned card work, not direct asks");
    const member = memberByHandle(w.core.roster, target.handle);
    if (!member || member.role === "removed") throw new HttpError(404, "not_found", `no member @${target.handle}`);
    if (namesHermesAgent(w.core, target)) throw new HttpError(403, "forbidden", "Hermes agents are view only: they cannot answer asks");
    if (!canSeeChannel(w.core.roster, p.channel, target.handle)) throw new HttpError(400, "invalid", `@${target.handle} can't see #${p.channel}`);
  }
  const askText = clean(w, disputeAskText(card.key, p.name, line, card.ref));
  if (!askText.trim()) throw new HttpError(400, "invalid", "a dispute summary is one plain line of at most 500 characters");
  const settings = w.idx.settingsOf(p.channel).project?.head;
  const board = {
    v: 1, rev: folded.rev + 1, op: "dispute" as const, state: "open" as const, summary: line,
    resolvers: chosen.resolvers, routed: chosen.routed, ...(folded.head ? { after: folded.head } : {}),
    ...(settings ? { settings } : {}),
  };
  if (!DisputeOp.safeParse(board).success) throw new HttpError(400, "invalid", "this dispute can't be recorded");
  const expires = w.core.clock() + DISPUTE_ASK_TTL_S * 1000;
  const asks: { id: string; to: string }[] = [];
  // One token for the post and one for each ask, before anything is signed. A failed transaction puts them back.
  const tokens = 1 + chosen.resolvers.length;
  chargeWrites(w, tokens);
  try {
    w.core.store.transaction(() => {
      post(w, p.channel, disputeText(card.key, line), board, { thread: card.id });
      for (const to of chosen.resolvers) {
        const ev = w.core.emit("ask", { to, text: askText, expires_at: expires }, { channel: p.channel, agent: w.agent });
        asks.push({ id: ev.id, to });
      }
    }, { durable: true });
  } catch (err) {
    refundWrites(w, tokens);
    throw err;
  }
  w.idx.flushAll();
  const dispute = showDispute(w, ref);
  if (!dispute) throw new HttpError(500, "internal", "the dispute wasn't folded");
  return { dispute, asks };
}

async function resolveNow(w: WriteCtx, ref: string, reason: string): Promise<DisputeView> {
  const { project: p, card } = findCard(w, ref);
  const line = oneLine(w, reason, 200, "reason");
  w.idx.flushAll();
  const folded = w.idx.disputeOf(p.channel, card.id);
  if (!folded.current) throw new HttpError(404, "not_found", "no dispute on this card");
  if (folded.current.state !== "open") throw new HttpError(409, "conflict", "this dispute is already resolved");
  const who = caller(w);
  // A non-owner's resolve is judged by the contact at the settings head the open names. Say why it would not count, before
  // anything is signed. An owner does not need that head. An open that omitted it is a different case (no contact
  // authority) and is not "not received".
  const openEv = w.idx.db.opEvent(folded.current.id, p.channel);
  const openParsed = openEv ? DisputeOp.safeParse(openEv.board) : null;
  const openSettings = openParsed?.success ? openParsed.data.settings : undefined;
  // An open that names no settings head carries no contact authority: in a project with a settings log only an owner's
  // resolve counts, so a non-owner is told so instead of getting a 200 the fold then ignores (WALK-73 r5 review).
  if (!openSettings && who.role !== "owner" && w.idx.db.settingsPosts(p.channel).length > 0) {
    throw new HttpError(403, "forbidden", "this dispute names no project settings, so only an owner can resolve it");
  }
  if (openSettings && who.role !== "owner") {
    const head = settingsHeadState(w.idx.db.settingsPosts(p.channel), openSettings, w.idx.env(p.channel));
    // Sync may bring a head or an ancestor this machine lacks. A head that is here and unusable (hidden, ignored, forged)
    // never will count, so waiting would be a lie: an owner has to resolve it.
    if (head === "unknown") {
      throw new HttpError(409, "conflict", "this machine has not received the project settings this dispute was raised under yet; try again after sync");
    }
    if (head === "invalid") {
      throw new HttpError(403, "forbidden", "this dispute names project settings that cannot be used (hidden or invalid), so only an owner can resolve it");
    }
  }
  if (!folded.current.resolvers.some((a) => resolverHandle(a) === who.handle)) {
    throw new HttpError(403, "forbidden", "only a resolver can resolve this dispute");
  }
  const settings = w.idx.settingsOf(p.channel).project?.head;
  const board = {
    v: 1, rev: folded.rev + 1, op: "dispute" as const, state: "resolved" as const, reason: line,
    ...(folded.head ? { after: folded.head } : {}),
    ...(settings ? { settings } : {}),
  };
  if (!DisputeOp.safeParse(board).success) throw new HttpError(400, "invalid", "this dispute can't be recorded");
  w.core.store.transaction(() => {
    post(w, p.channel, resolveText(card.key, line), board, { thread: card.id });
  }, { durable: true });
  w.idx.flushAll();
  const dispute = showDispute(w, ref);
  if (!dispute) throw new HttpError(500, "internal", "the dispute wasn't folded");
  return dispute;
}

/** The recorded resolver, as a person (any of their machines), closes the dispute with one line. An agent throws before this returns a promise. */
export function resolveDispute(w: WriteCtx, ref: string, reason: string): Promise<DisputeView> {
  requirePerson(w, "resolving a dispute");
  return resolveNow(w, ref, reason);
}

function ctxOf(c: RouteCtx): WriteCtx {
  if (!c.projects) throw new HttpError(404, "not_found", "projects are not available on this daemon");
  requireTeam(c);
  return {
    core: c.core, idx: c.projects, client: c.client, catchUp: c.sync.requestCatchUp,
    ...(c.agent ? { agent: c.agent } : {}), ...(c.underAgent ? { underAgent: true } : {}),
    ...(c.rateKey ? { rateKey: c.rateKey } : {}),
  };
}

const RaiseReq = z.object({ summary: z.string().min(1).max(500) }).strict();
const ResolveReq = z.object({ reason: z.string().min(1).max(200) }).strict();

route("GET", /^\/v1\/tasks\/([^/]+)\/dispute$/, (c, [ref]) => {
  return json({ dispute: showDispute(ctxOf(c), ref as string) });
});

route("POST", /^\/v1\/tasks\/([^/]+)\/dispute$/, async (c, [ref]) => {
  const b = parseWith(RaiseReq, await readJson(c.req, LOCAL_BODY_MAX));
  refuseAgentJoinContent(c, b.summary);
  // raiseDispute charges one token for the post and one per ask. A second limitWrite here would charge the post twice.
  c.noTimeout();
  return json(await raiseDispute(ctxOf(c), ref as string, b.summary));
});

route("POST", /^\/v1\/tasks\/([^/]+)\/dispute\/resolve$/, async (c, [ref]) => {
  const b = parseWith(ResolveReq, await readJson(c.req, LOCAL_BODY_MAX));
  refuseAgentJoinContent(c, b.reason);
  // People only, and before the write limit: an agent must not be signed through as the person.
  if (isAgentCaller(c)) requirePerson(ctxOf(c), "resolving a dispute");
  limitWrite(c);
  c.noTimeout();
  return json({ dispute: await resolveDispute(ctxOf(c), ref as string, b.reason) });
});
