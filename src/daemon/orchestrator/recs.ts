// TALKIE-OPS-1 in the daemon: reading and writing WalkieTalkie's recommendations (protocol/talkie-recs.ts has the records and
// the fold). Nothing is stored beside the signed log: a list is read from the channels this member can see (a project's own
// channel for a team recommendation, the owner-only schedule channel for an owners-only one), folded, and cut to what is
// still relevant. `reconcile` is what the poll and the curation do each run: make what is new, keep what still holds, retire
// what no longer does, never repeat a pending, a recently dismissed or a recently approved one, and stay within the caps. A seat
// recommendation is about a card and a role, not a machine: the machine is chosen again when a person approves it (rec-act.ts), so a
// poll that would now pick another machine keeps the open one instead of retiring and remaking it. A recommendation being approved
// on this daemon is left alone by every run until the answer is recorded.
import { ORCHESTRATOR_AGENT } from "../../protocol/orchestrator.ts";
import { shortId } from "../../protocol/projects/short.ts";
import type { BodyOf } from "../../protocol/schemas.ts";
import {
  APPROVED_COOLDOWN_MS, DISMISS_COOLDOWN_MS, MAX_CONTEXT, MAX_NEW_PER_RUN, MAX_OPEN_PER_PROJECT, MAX_OPEN_TOTAL, ONBOARDING_ARGV, READ_WINDOW_MS, askMessage, cardDataTitle,
  createText, foldRecs, isOpen, recTitle, resolveText, summaryWithTitle, titleRef, titleRefId, type NewRec, type Rec, type RecEvent, type RecResolution, type RecResolveT, type RecSource,
} from "../../protocol/talkie-recs.ts";
import { isConfidential, safeText } from "../../protocol/projects/status-report.ts";
import { SCHEDULE_CHANNEL } from "../../protocol/talkie-schedule.ts";
import type { Core } from "../core.ts";
import type { Logger } from "../logger.ts";
import type { ProjectsIndex } from "../projects/index.ts";
import { visibleProjects } from "../projects/service.ts";
import { canSeeChannel } from "../roster.ts";

export interface RecDeps {
  readonly core: Core; readonly idx: ProjectsIndex; readonly log?: Logger;
  /** The clock recommendations are judged by; default the core's. */
  readonly now?: () => number;
}

const MAX_ROWS = 2_000;
const CACHE_MS = 2_000;

const nowOf = (d: RecDeps): number => (d.now ?? d.core.clock)();

/** What a person-visible list needs besides the record: its short id, its project's name and whether this person may answer it. */
export interface RecView extends Rec {
  short: string; project_name: string | null;
  can_approve: boolean; can_dismiss: boolean; why_not?: string;
  /** What approving it sends or makes in this machine's person's name, word for word (an ask's message, a new card's title); null when the card is gone. */
  outgoing?: string | null;
}

interface Row { id: string; origin: string; seq: number; ts: number; received_at: number; author_handle: string; author_agent: string | null; rec: string }

/** The channels this member can read recommendations in: every active project they can see, and the owner-only schedule channel when they are in it. */
export function recChannels(d: RecDeps): string[] {
  const projects = visibleProjects({ core: d.core, idx: d.idx }).filter((p) => p.state === "active").map((p) => p.channel);
  const owners = d.core.roster.channels.has(SCHEDULE_CHANNEL) && d.core.visible({ channel: SCHEDULE_CHANNEL }) ? [SCHEDULE_CHANNEL] : [];
  return [...projects, ...owners];
}

function ownersOf(core: Core): Set<string> {
  return new Set([...core.roster.members.values()].filter((m) => m.role === "owner").map((m) => m.handle));
}

/** The posts of one channel that carry a recommendation record, as events for the fold: the earlier of their stamp and their receipt (a wrong clock cannot keep one open). */
function eventsOf(d: RecDeps, channel: string, since: number): RecEvent[] {
  const rows = d.core.store.db.query<Row, [string, number, number]>(
    `SELECT id, origin, seq, ts, received_at, author_handle, author_agent, json_extract(body, '$.talkie_rec') AS rec FROM events
     WHERE channel = ? AND ts > ? AND +kind = 'msg.post' AND redacted = 0 AND status = 'ok' AND json_extract(body, '$.talkie_rec.v') = 1
     ORDER BY ts DESC LIMIT ?`).all(channel, since, MAX_ROWS);
  const out: RecEvent[] = [];
  for (const r of rows) {
    try {
      out.push({
        id: r.id, ts: Math.min(r.ts, r.received_at), channel, origin: r.origin, seq: r.seq,
        author: { handle: r.author_handle, ...(r.author_agent ? { agent: r.author_agent } : {}) },
        rec: JSON.parse(r.rec),
      });
    } catch { /* a record that does not parse is not one */ }
  }
  return out;
}

/** Open recommendations that share a key are one: the oldest stands, the others read as superseded (a race between two leads made them). */
function collapse(recs: readonly Rec[]): Rec[] {
  const seen = new Map<string, Rec>();
  for (const r of [...recs].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))) {
    if (r.status === "pending" && !seen.has(r.key)) seen.set(r.key, r);
  }
  return recs.map((r) => (r.status === "pending" && seen.get(r.key) !== r
    ? { ...r, status: "superseded" as const, resolved: { status: "superseded" as const, by: r.resolved?.by ?? "walkietalkie", at: r.created_at } } : r));
}

const caches = new WeakMap<Core, { at: number; recs: Rec[] }>();

/** Every recommendation this member can see, folded and newest first. Cached for two seconds (and by this daemon's own writes). */
export function readRecs(d: RecDeps): Rec[] {
  const now = nowOf(d);
  const hit = caches.get(d.core);
  if (hit && Math.abs(now - hit.at) < CACHE_MS) return hit.recs;
  const since = now - READ_WINDOW_MS;
  const events = recChannels(d).flatMap((channel) => eventsOf(d, channel, since));
  const recs = collapse(foldRecs(events, {
    owners: ownersOf(d.core), now,
    canAnswer: (handle, rec, e) => !answerBlind(d, handle, rec.audience, rec.project, rec.action, e),
  }));
  caches.set(d.core, { at: now, recs });
  return recs;
}

/** Drops the cached list (this daemon's own writes do it; tests and ingest hooks may too). */
export function forgetRecs(core: Core): void { caches.delete(core); }

export const openRecs = (d: RecDeps): Rec[] => readRecs(d).filter(isOpen);

// ---- who may answer -----------------------------------------------------------------------------------------------

/** Whether this member may answer the recommendation, and if not why (the dashboard says it in words). */
export function mayAnswer(core: Core, rec: Rec): { ok: boolean; why?: string } {
  const me = core.me();
  if (!me || me.role === "removed") return { ok: false, why: "this machine is not an admitted member" };
  if (!isOpen(rec)) return { ok: false, why: rec.status === "expired" ? "it has expired" : `it was ${rec.status}` };
  if (me.role === "observer") return { ok: false, why: "observers can read recommendations but not act on them" };
  if (rec.audience === "owners" && me.role !== "owner") return { ok: false, why: "only an owner can act on this one" };
  if (rec.kind === "onboarding_step" && me.role !== "owner") return { ok: false, why: "only an owner can set up another machine" };
  return { ok: true };
}

/** The project channel a schedule-channel recommendation is about, when it is about a card. A machine or a card-less ask has none. */
function cardChannel(rec: Rec): string | null {
  const a = rec.action;
  if (a.kind === "create_card") return a.project;
  if (a.kind === "move_card" || a.kind === "start_seat") return rec.project;
  if (a.kind === "ask_orchestrator" && a.card) return rec.project;
  return null;
}

/**
 * An owners-only recommendation about a card, read by someone who cannot see that card's channel. The schedule channel
 * admits a new owner before the private project's own channel does, so this person is shown a fixed sentence and cannot
 * approve or dismiss it.
 */
export function cardHiddenFrom(d: RecDeps, rec: Rec, handle: string | null): boolean {
  if (rec.audience !== "owners" || rec.channel !== SCHEDULE_CHANNEL) return false;
  const channel = cardChannel(rec);
  return channel !== null && !canSeeChannel(d.core.roster, channel, handle);
}

/** What a viewer who cannot see the project is told. No title, project name, evidence or model text. */
export const HIDDEN_SUMMARY = "A recommendation about a project you cannot see";
const HIDDEN_KEY = "hidden";
/** The schedules record says this until the project post can be read. It does not tell the person to dismiss it. */
export const TITLE_UNREADABLE = "the title for this recommendation cannot be read yet; try again shortly";
export const BLOCK_UNREADABLE = "the block reason for this recommendation cannot be read yet; try again shortly";

const STORED_CARD = /card [0-9a-f]{16}:[1-9][0-9]*|card [A-Z][A-Z0-9]{1,9}-\d{1,7}(?:-[0-9a-fA-F]{8})? \(p-[0-9a-f]{8}\)/;
const CREATE_IN_SUMMARY = /^Create a card in p-[0-9a-f]{8}$/;

function prefixesOf(d: RecDeps, channel: string): string[] {
  const project = d.idx.project(channel);
  return project ? [project.prefix, ...(project.prior_prefixes ?? [])] : [];
}

interface Held { title?: string; evidence?: string[]; blocked_reason?: string; context?: string }
interface AuthRow { origin: string; author_agent: string | null }

/** The node and agent that wrote an event, or null when this daemon has no such row. */
function eventAuth(d: RecDeps, id: string): AuthRow | null {
  return d.core.store.db.query<AuthRow, [string]>("SELECT origin, author_agent FROM events WHERE id = ?").get(id) ?? null;
}

/** What a project-channel post may contribute. A title is kept even when it looks like `card-title:<id>`: that string is the title, not a pointer. */
function parseHeld(body: string | null): Held | null {
  if (!body) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const held = (parsed as { talkie_title?: unknown }).talkie_title;
  if (!held || typeof held !== "object") return null;
  const h = held as { v?: unknown; title?: unknown; evidence?: unknown; blocked_reason?: unknown; context?: unknown };
  if (h.v !== 1) return null;
  const out: Held = {};
  if (typeof h.title === "string") {
    const text = h.title.trim();
    if (text.length > 0 && text.length <= 200) out.title = text;
  }
  if (Array.isArray(h.evidence)) {
    const lines = h.evidence.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200).slice(0, 6);
    if (lines.length) out.evidence = lines;
  }
  if (typeof h.blocked_reason === "string" && h.blocked_reason.length > 0 && h.blocked_reason.length <= 300) out.blocked_reason = h.blocked_reason;
  if (typeof h.context === "string") {
    const text = h.context.trim();
    if (text.length > 0 && text.length <= MAX_CONTEXT) out.context = text;
  }
  return out;
}

/**
 * The project-channel post for this recommendation, written by the same node and by WalkieTalkie. A create is read by the
 * id in `action.title` (older posts have no `for`). Anything else is read by `talkie_title.for`, the recommendation's key.
 * A post a person wrote, or one from another node, is not it.
 */
function heldForRec(d: RecDeps, rec: Rec): Held | null {
  const auth = eventAuth(d, rec.id);
  if (!auth || auth.author_agent !== ORCHESTRATOR_AGENT) return null;
  const channel = rec.action.kind === "create_card" ? rec.action.project : rec.project;
  if (!channel) return null;
  if (rec.action.kind === "create_card") {
    const id = titleRefId(rec.action.title);
    if (!id) return null;
    const row = d.core.store.db.query<{ body: string | null; channel: string | null; redacted: number; status: string; origin: string; author_agent: string | null }, [string]>(
      "SELECT body, channel, redacted, status, origin, author_agent FROM events WHERE id = ?").get(id);
    if (!row || row.redacted !== 0 || row.status !== "ok" || row.channel !== channel || !row.body) return null;
    if (row.author_agent !== ORCHESTRATOR_AGENT || row.origin !== auth.origin) return null;
    return parseHeld(row.body);
  }
  const row = d.core.store.db.query<{ body: string | null }, [string, string, string, string]>(
    // `+author_agent`: keep SQLite on the channel's index instead of walking every WalkieTalkie post (WALK-108 r5 review).
    `SELECT body FROM events WHERE channel = ? AND origin = ? AND +author_agent = ? AND +kind = 'msg.post' AND redacted = 0 AND status = 'ok'
       AND json_extract(body, '$.talkie_title.v') = 1 AND json_extract(body, '$.talkie_title.for') = ?
     ORDER BY ts DESC LIMIT 1`).get(channel, auth.origin, ORCHESTRATOR_AGENT, rec.key);
  return row ? parseHeld(row.body) : null;
}

/** The recommendation with the project post's evidence and block reason put back, for someone who can see the project. */
export function overlayHeld(d: RecDeps, rec: Rec): Rec {
  if (rec.audience !== "owners" || rec.channel !== SCHEDULE_CHANNEL) return rec;
  const held = heldForRec(d, rec);
  if (!held) return rec;
  let action = rec.action;
  if (held.blocked_reason && action.kind === "move_card") action = { ...action, blocked_reason: held.blocked_reason };
  const evidence = held.evidence?.length ? held.evidence : rec.evidence;
  const context = held.context ?? rec.context;
  if (action === rec.action && evidence === rec.evidence && context === rec.context) return rec;
  return { ...rec, action, evidence, ...(context ? { context } : {}) };
}

/**
 * An owners-only block whose schedules record only says "blocked" (the placeholder) and whose project post cannot be read.
 * Approving it must wait, not mark the card blocked with that placeholder.
 */
export function blockReasonUnread(d: RecDeps, rec: Rec): boolean {
  if (rec.audience !== "owners" || rec.action.kind !== "move_card") return false;
  if (rec.action.to !== undefined || rec.action.blocked_reason !== "blocked") return false;
  return !heldForRec(d, rec)?.blocked_reason;
}

/**
 * The title an owners-only create would give the card, for someone who can see the project. A team create's title is the
 * one stored on the action. A sealed one is read from the project-channel post; null when that post cannot be read.
 * Once that post checks out, its title is returned as written, even when the text itself looks like `card-title:<id>`.
 * An older owners create whose action still carries the title returns that title.
 */
export function createTitleFor(d: RecDeps, rec: Rec, by: string | null): string | null {
  if (rec.action.kind !== "create_card") return null;
  if (cardHiddenFrom(d, rec, by)) return null;
  if (rec.audience !== "owners") return rec.action.title;
  if (!canSeeChannel(d.core.roster, rec.action.project, by)) return null;
  if (!titleRefId(rec.action.title)) return rec.action.title;
  return heldForRec(d, rec)?.title ?? null;
}

/** The title and human key to show in a summary, or null when this viewer must not see one (or the card is gone). */
function cardDisplay(d: RecDeps, rec: Rec, by: string | null): { title: string; key: string | null } | null {
  if (cardHiddenFrom(d, rec, by)) return null;
  const a = rec.action;
  if (a.kind === "create_card") {
    const raw = createTitleFor(d, rec, by);
    return raw ? { title: recTitle(raw, prefixesOf(d, a.project)), key: null } : null;
  }
  const id = a.kind === "move_card" || a.kind === "start_seat" ? a.card : a.kind === "ask_orchestrator" ? a.card : undefined;
  if (!id || !rec.project || !canSeeChannel(d.core.roster, rec.project, by)) return null;
  const card = d.idx.db.card(id);
  if (!card || card.state !== "open" || card.channel !== rec.project) return null;
  return { title: recTitle(card.title, prefixesOf(d, rec.project)), key: card.key };
}

function projectLabel(d: RecDeps, channel: string | null, by: string | null): string | null {
  if (!channel || !canSeeChannel(d.core.roster, channel, by)) return null;
  return d.idx.project(channel)?.name ?? null;
}

/** A create's title, and a move's block reason, are not part of what a viewer who cannot see the project is given. */
function hiddenAction(action: Rec["action"]): Rec["action"] {
  if (action.kind === "create_card") {
    const { seal: _seal, ...rest } = action;
    return { ...rest, title: "a card" };
  }
  if (action.kind === "move_card" && (action.blocked_reason !== undefined || action.seal !== undefined)) {
    const { blocked_reason: _blocked, seal: _seal, ...rest } = action;
    return rest;
  }
  return action;
}

/**
 * A stored owners-only record as this viewer may read it. Someone who cannot see the card gets one fixed sentence, no
 * evidence, no block reason, no model text and an opaque key, whether the record is new or was stored with the title in it.
 * Someone who can see the card gets the title, the human key and the project post's evidence and block reason.
 */
function present(d: RecDeps, rec: Rec, by: string | null, answers?: ReadonlyMap<string, HeldAnswer>): Rec {
  if (rec.audience !== "owners" || rec.channel !== SCHEDULE_CHANNEL) return rec;
  if (cardHiddenFrom(d, rec, by)) {
    const { context: _context, resolved, ...rest } = rec;
    const cleaned = resolved ? { ...resolved } : undefined;
    if (cleaned) delete cleaned.note;
    return {
      ...rest, ...(cleaned ? { resolved: cleaned } : {}),
      action: hiddenAction(rec.action), summary: HIDDEN_SUMMARY, evidence: [], key: HIDDEN_KEY,
    };
  }
  const filled = overlayHeld(d, rec);
  const display = cardDisplay(d, filled, by);
  const channel = filled.action.kind === "create_card" ? filled.action.project : filled.project;
  let summary = filled.summary;
  if (display && (STORED_CARD.test(filled.summary) || CREATE_IN_SUMMARY.test(filled.summary))) {
    summary = summaryWithTitle(filled.summary, display.title, projectLabel(d, channel, by), display.key);
  }
  let action = filled.action;
  if (filled.action.kind === "create_card") {
    const raw = createTitleFor(d, filled, by);
    if (raw) action = { ...filled.action, title: raw };
  }
  const shownNote = answerNote(d, filled, answers);
  const resolved = shownNote && filled.resolved ? { ...filled.resolved, note: shownNote } : filled.resolved;
  if (summary === rec.summary && action === rec.action && filled.evidence === rec.evidence && filled.context === rec.context && resolved === filled.resolved) return rec;
  return { ...filled, summary, action, ...(resolved ? { resolved } : {}) };
}

/** The card an ask is about as the board has it now (its reference, its title as data, whether it is confidential), or null when it is gone. */
function cardNow(d: RecDeps, id: string): { ref: string; title: string; confidential: boolean } | null {
  const card = d.idx.db.card(id);
  if (!card || card.state !== "open") return null;
  const project = d.idx.project(card.channel);
  return { ref: card.ref, title: cardDataTitle(card.title, project ? [project.prefix, ...(project.prior_prefixes ?? [])] : []), confidential: isConfidential(card.labels) };
}

/** A machine's name as people read it. */
const machineName = (d: RecDeps, node: string): string => safeText(d.core.roster.nodes.get(node)?.hostname ?? node, 63);

/**
 * Word for word what approving `rec` as `by` sends or makes in their name: an ask's message (askMessage, from its topic and the
 * card as it is now) or a new card's title. rec-act.ts sends exactly this; the dashboard and the CLI show it before anyone approves.
 * undefined for the kinds that send no words of their own; null when the card it is about is gone (approving it is refused).
 */
export function outgoingOf(d: RecDeps, rec: Rec, by: string): string | null | undefined {
  if (cardHiddenFrom(d, rec, by)) return undefined;
  const a = rec.action;
  if (a.kind === "create_card") {
    const title = createTitleFor(d, rec, by);
    if (!title) return null;
    return `Creates a card titled: ${title}`;
  }
  if (a.kind === "onboarding_step") return `Runs walkie ${ONBOARDING_ARGV[a.step].join(" ")} on ${machineName(d, a.machine)}`;
  if (a.kind !== "ask_orchestrator") return undefined;
  const card = a.card ? cardNow(d, a.card) : null;
  if (a.card && !card) return null;
  return askMessage({ id: rec.id, topic: a.topic, card, by, reason: rec.source === "turn" ? null : rec.reason,
    ...(a.topic === "setup" && a.machine && a.step ? { setup: { machine: machineName(d, a.machine), step: a.step } } : {}) });
}

export interface ViewOptions { outgoing?: string | null; dashboard?: boolean }

/** What one person's list shows of a recommendation. `outgoing` is passed in when it needs more than the record (a seat's machine). */
export function viewOf(d: RecDeps, rec: Rec, o: ViewOptions & { answers?: ReadonlyMap<string, HeldAnswer> } = {}): RecView {
  const viewer = d.core.myHandle();
  const hidden = cardHiddenFrom(d, rec, viewer);
  const shown = present(d, rec, viewer, o.answers);
  const may = mayAnswer(d.core, rec);
  const seeProject = !shown.project || canSeeChannel(d.core.roster, shown.project, viewer);
  const project = seeProject && shown.project ? d.idx.project(shown.project) : null;
  const outgoing = hidden ? undefined : ("outgoing" in o ? o.outgoing : outgoingOf(d, rec, viewer ?? "you"));
  // A setup step runs a command on another machine: it is approved at a terminal, never from a dashboard session.
  const terminalOnly = o.dashboard && rec.kind === "onboarding_step";
  const why = !may.ok ? may.why : hidden ? "you cannot see this card's channel"
    : terminalOnly ? `setup steps are approved in a terminal: walkie talkie approve ${shortId(rec.id)}` : undefined;
  return { ...shown, short: shortId(rec.id), project_name: project?.name ?? null, can_approve: may.ok && !terminalOnly && !hidden, can_dismiss: may.ok && !hidden,
    ...(why ? { why_not: why } : {}), ...(outgoing !== undefined ? { outgoing } : {}) };
}

/**
 * The views of a whole list. The notes sealed for its answered owners-only recommendations are read together, in two queries
 * bounded by the oldest of those answers, not by one scan of the schedules channel per recommendation. A viewer who cannot see
 * a card's project is not given its note, so its answer is not read at all.
 */
export function viewsOf(d: RecDeps, recs: readonly Rec[], optionsFor: (rec: Rec) => ViewOptions): RecView[] {
  const viewer = d.core.myHandle();
  const answers = sealedAnswers(d, recs.filter((r) => !cardHiddenFrom(d, r, viewer)));
  return recs.map((r) => viewOf(d, r, { ...optionsFor(r), answers }));
}

// ---- writing ------------------------------------------------------------------------------------------------------

function emitRec(d: RecDeps, channel: string, text: string, rec: unknown, agent?: string): ReturnType<Core["emit"]> {
  const event = d.core.emit("msg.post", { text, talkie_rec: rec } as unknown as BodyOf<"msg.post">, { channel, ...(agent ? { agent } : {}) });
  forgetRecs(d.core);
  return event;
}

/** Where a new recommendation is posted: its project's channel for the team, the owner-only schedule channel for the owners. */
function placeOf(rec: NewRec, channel: string | null): string {
  return rec.audience === "owners" || !channel ? SCHEDULE_CHANNEL : channel;
}

const HOLDER_TEXT = "A recommendation's private detail is held in this project.";
/** What a schedules record says for a block when the real reason is on the project post. The move schema requires a reason. */
const BLOCK_PLACEHOLDER = "blocked";

/**
 * An owners-only recommendation keeps its title, evidence, block reason and model text off the schedules record when it
 * has a project channel. They are posted in that channel, which only members receive. The input is not changed (a later
 * reconcile still has the real block reason). A create is always sealed, even when the title already looks like
 * `card-title:<id>`: that text is stored as the title and is not followed. A block that names no column carries `seal: 1`
 * so a pre.12 peer does not fold it. The project post is written first. If the schedules post then fails, the project
 * post stays behind with nothing pointing at it. A card-less ask has no project post, so its scrubbed model text stays
 * on the schedules record.
 */
function sealOwners(d: RecDeps, rec: NewRec): NewRec {
  if (rec.audience !== "owners") return rec;
  const isCreate = rec.action.kind === "create_card";
  const channel = rec.action.kind === "create_card" ? rec.action.project : rec.project ?? null;
  const blocked = rec.action.kind === "move_card" ? rec.action.blocked_reason : undefined;
  const modelContext = rec.context;
  const hasContext = typeof modelContext === "string" && modelContext.length > 0;
  if (!channel || (!isCreate && rec.evidence.length === 0 && !blocked && !hasContext)) return rec;
  const held: { v: 1; for: string; title?: string; evidence?: string[]; blocked_reason?: string; context?: string } = { v: 1, for: rec.key };
  // Over-long lines are dropped whole. Cutting them would leave a fragment of a title on the project post.
  if (isCreate && rec.action.kind === "create_card") {
    const title = rec.action.title.trim();
    if (title.length > 0 && title.length <= 200) held.title = title;
  }
  const lines = rec.evidence.filter((line) => line.length > 0 && line.length <= 200).slice(0, 6);
  if (lines.length) held.evidence = lines;
  if (blocked && blocked.length > 0 && blocked.length <= 300) held.blocked_reason = blocked;
  if (hasContext && modelContext.length <= MAX_CONTEXT) held.context = modelContext;
  const event = d.core.emit("msg.post", { text: HOLDER_TEXT, talkie_title: held } as unknown as BodyOf<"msg.post">, { channel, agent: ORCHESTRATOR_AGENT });
  let action = rec.action;
  if (isCreate && rec.action.kind === "create_card") action = { ...rec.action, title: titleRef(event.id), seal: 1 };
  else if (rec.action.kind === "move_card" && blocked) {
    if (rec.action.to !== undefined) {
      const { blocked_reason: _blocked, seal: _seal, ...rest } = rec.action;
      action = rest;
    } else action = { kind: "move_card", card: rec.action.card, from: rec.action.from, blocked_reason: BLOCK_PLACEHOLDER, seal: 1 };
  }
  const { context: _context, ...rest } = rec;
  return { ...rest, action, evidence: [] };
}

export function createRec(d: RecDeps, rec: NewRec, channel: string | null): string {
  const sealed = sealOwners(d, rec);
  const place = placeOf(sealed, channel);
  if (sealed.audience === "team" && !channel) throw new Error("a team recommendation needs its project's channel");
  const event = emitRec(d, place, createText(sealed.summary), { v: 1, op: "create", ...sealed }, ORCHESTRATOR_AGENT);
  d.log?.info("talkie_rec_created", { rec: event.id, kind: rec.action.kind, group: rec.group, audience: rec.audience, source: rec.source });
  return event.id;
}

/** WalkieTalkie retires a recommendation whose condition no longer holds (a person's answer is `answerRec`). */
export function supersedeRec(d: RecDeps, rec: Rec): void {
  emitRec(d, rec.channel, resolveText("superseded", rec.summary, d.core.myHandle() ?? "walkietalkie"), { v: 1, op: "resolve", rec: rec.id, status: "superseded", key: rec.key } satisfies RecResolveT, ORCHESTRATOR_AGENT);
  d.log?.info("talkie_rec_superseded", { rec: rec.id, kind: rec.kind });
}

const ANSWER_TEXT = "A recommendation's answer is held in this project.";

function clipLine(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.slice(0, 200);
  return t.length > 0 ? t : undefined;
}

/**
 * The person's note and the action's result, on the project channel, as that person (no agent). The text is fixed and
 * carries neither. A failure here does not put them on the schedules record.
 */
function sealAnswer(d: RecDeps, channel: string, recId: string, note?: string, result?: string): void {
  const held: { v: 1; for: string; note?: string; result?: string } = { v: 1, for: recId };
  const n = clipLine(note);
  const r = clipLine(result);
  if (n) held.note = n;
  if (r) held.result = r;
  if (!held.note && !held.result) return;
  try {
    d.core.emit("msg.post", { text: ANSWER_TEXT, talkie_answer: held } as unknown as BodyOf<"msg.post">, { channel });
  } catch (err) {
    d.log?.warn("talkie_rec_answer_seal_failed", { rec: recId, err: err instanceof Error ? err.message.slice(0, 200) : "failed" });
  }
}

/** A person approves or dismisses one: a signed post in its channel, as that person (never as an agent). */
export function answerRec(d: RecDeps, rec: Rec, status: "approved" | "dismissed", note?: string, result?: string): void {
  const by = d.core.myHandle();
  if (!by) throw new Error("this node is not an admitted member");
  const project = rec.audience === "owners" && rec.channel === SCHEDULE_CHANNEL
    ? (rec.action.kind === "create_card" ? rec.action.project : rec.project ?? null)
    : null;
  // Owners-only detail stays off the schedules record. The note there is a fixed phrase. Team records, and an
  // owners-only record with no project, keep the person's note, or the result line when they wrote none.
  const stored = project ? (status === "approved" ? "Approved." : "Dismissed.") : clipLine(note ?? result);
  if (project) sealAnswer(d, project, rec.id, note, result);
  const resolve = { v: 1, op: "resolve", rec: rec.id, status, ...(stored ? { note: stored } : {}), key: rec.key } satisfies RecResolveT;
  d.core.emit("msg.post", { text: resolveText(status, rec.summary, by), talkie_rec: resolve } as unknown as BodyOf<"msg.post">, { channel: rec.channel });
  forgetRecs(d.core);
  d.log?.info(`talkie_rec_${status}`, { rec: rec.id, kind: rec.kind, by });
}

// ---- reconciling --------------------------------------------------------------------------------------------------

export interface Desired { rec: NewRec; /** The project channel it is about (null: a machine). */ channel: string | null }

export interface ReconcileResult { created: number; kept: number; replaced: number; superseded: number; suppressed: number; capped: number }

/**
 * The action as the schedules record stores an owners-only move: a block reason is the placeholder (or dropped when the
 * move also names a column). Reconcile compares this, so the real reason living only on the project post does not make
 * every run retire and rewrite the recommendation. A team recommendation is compared as stored.
 */
function wireAction(a: Rec["action"]): Rec["action"] {
  if (a.kind !== "move_card" || !a.blocked_reason) return a;
  if (a.to !== undefined) return { kind: "move_card", card: a.card, from: a.from, to: a.to };
  // The same object for a stored placeholder and for the plan's real reason, so a run does not retire every block.
  // A legacy block without `seal` compares equal too, and is not rewritten.
  return { kind: "move_card", card: a.card, from: a.from, blocked_reason: BLOCK_PLACEHOLDER, seal: 1 };
}

/** Whether an open recommendation already says what a run wants. A seat is the same card and role on whatever machine: the machine is chosen when it is approved. */
const sameAction = (stored: Rec["action"], desired: Rec["action"], owners: boolean): boolean =>
  stored.kind === "start_seat" && desired.kind === "start_seat" ? stored.card === desired.card && stored.role === desired.role
    : JSON.stringify(owners ? wireAction(stored) : stored) === JSON.stringify(owners ? wireAction(desired) : desired);

// ---- answers in flight and lately ---------------------------------------------------------------------------------

const inFlight = new WeakMap<Core, Map<string, number>>();

/** While a person's approval of a recommendation runs on this daemon, no run retires, replaces or remakes one with its key. */
export function holdWhileAnswering<T>(core: Core, key: string, fn: () => Promise<T>): Promise<T> {
  const held = inFlight.get(core) ?? new Map<string, number>();
  inFlight.set(core, held);
  held.set(key, (held.get(key) ?? 0) + 1);
  const release = (): void => { const n = (held.get(key) ?? 1) - 1; if (n > 0) held.set(key, n); else held.delete(key); };
  return fn().finally(release);
}
const answering = (core: Core, key: string): boolean => (inFlight.get(core)?.get(key) ?? 0) > 0;

interface AnswerRow {
  origin: string; seq: number; ts: number; received_at: number; key: string; status: string; maker: string; resolver: string;
  audience: string | null; project: string | null; action: string | null;
}

/**
 * An owners-only answer about a card, signed by someone who cannot see that card's project. It does not resolve the
 * recommendation and it does not start a cooldown. A card-less ask and a machine recommendation have no such project.
 */
function projectOf(audience: string, project: string | null, action: { kind?: string; project?: string; card?: string } | null): string | null {
  if (audience !== "owners") return null;
  if (action?.kind === "create_card") return typeof action.project === "string" ? action.project : project;
  if (action?.kind === "move_card" || action?.kind === "start_seat") return project;
  if (action?.kind === "ask_orchestrator") return action.card ? project : null;
  if (action?.kind === "onboarding_step") return null;
  return project;
}

/** Where an answer stands in the log: the node that wrote it and its sequence number there. */
interface Place { origin?: string; seq?: number }

/**
 * Whether the answer's author could not see the project the recommendation is about, judged where the answer stands in the log.
 * The roster chain anchors every event by its node's sequence number: the roster in force is the one just before the first
 * authority entry that had seen the event (PROTOCOL §2 "Anchoring"), the same on every replica that holds the same events. So a
 * person who left the project is blind to an answer anchored after they left, whatever clock that answer carries, and an answer
 * anchored before they left stays counted. An event no entry covers yet is judged by the roster now. A channel that roster has
 * never heard of is judged by the roster now too. Nothing the author wrote on the answer is read.
 */
function answerBlind(
  d: RecDeps, handle: string, audience: string, project: string | null, action: { kind?: string; project?: string; card?: string } | null,
  at: Place = {},
): boolean {
  const channel = projectOf(audience, project, action);
  if (!channel) return false;
  const head = d.core.roster;
  if (at.origin === undefined || at.seq === undefined) return !canSeeChannel(head, channel, handle);
  const then = d.core.rosterAt(at.origin, at.seq);
  return !canSeeChannel(then.channels.has(channel) ? then : head, channel, handle);
}

interface HeldAnswer { note?: string; result?: string }

function parseAnswer(body: string | null): HeldAnswer | null {
  if (!body) return null;
  try {
    const raw = JSON.parse(body) as { talkie_answer?: { v?: unknown; note?: unknown; result?: unknown } };
    const h = raw.talkie_answer;
    if (!h || h.v !== 1) return null;
    const out: HeldAnswer = {};
    if (typeof h.note === "string" && h.note.length > 0 && h.note.length <= 200) out.note = h.note;
    if (typeof h.result === "string" && h.result.length > 0 && h.result.length <= 200) out.result = h.result;
    return out.note || out.result ? out : null;
  } catch {
    return null;
  }
}

/**
 * The project an answered owners-only recommendation's sealed note is on, or null when it has none to show: the answer must be
 * a person's approve or dismiss on the schedules record, about a card in a project.
 */
function sealedChannel(rec: Rec): string | null {
  if (rec.audience !== "owners" || rec.channel !== SCHEDULE_CHANNEL || !rec.resolved || rec.resolved.agent) return null;
  if (rec.resolved.status !== "approved" && rec.resolved.status !== "dismissed") return null;
  return (rec.action.kind === "create_card" ? rec.action.project : rec.project) ?? null;
}

/** The note post is written just before the resolve by the same node, so it may stamp a little earlier than the answer's time. */
const SEAL_SLACK_MS = 60_000;

interface SealedResolve { origin: string; author_handle: string; recId: string }
interface SealedPost { origin: string; author_handle: string; forId: string; body: string | null }

/**
 * The note and the result line sealed for each of these recommendations, by recommendation id. A note counts when the resolve
 * the fold counted (that person's, with no agent) and the project post came from the same person on the same node. A post from
 * another node, or one with an agent, is not it. Everything is read in one query on the schedules channel and one per project,
 * each bounded below by the oldest answer's time in the list, so the cost does not grow with the older posts of a busy channel or
 * with the number of recommendations. A note stamped more than a minute before the oldest answer in the list is not found, and the
 * list shows none for it.
 */
function sealedAnswers(d: RecDeps, recs: readonly Rec[]): Map<string, HeldAnswer> {
  const out = new Map<string, HeldAnswer>();
  const asked: { rec: Rec; channel: string }[] = [];
  for (const rec of recs) {
    const channel = sealedChannel(rec);
    if (channel) asked.push({ rec, channel });
  }
  if (!asked.length) return out;
  const since = Math.min(...asked.map((a) => (a.rec.resolved as RecResolution).at));
  const ids = JSON.stringify(asked.map((a) => a.rec.id));
  const resolves = new Map<string, SealedResolve[]>();
  for (const r of d.core.store.db.query<SealedResolve, [string, number, string]>(
    `SELECT origin, author_handle, json_extract(body, '$.talkie_rec.rec') AS recId FROM events
     WHERE channel = ? AND ts >= ? AND author_agent IS NULL AND +kind = 'msg.post' AND redacted = 0 AND status = 'ok'
       AND json_extract(body, '$.talkie_rec.op') = 'resolve'
       AND json_extract(body, '$.talkie_rec.rec') IN (SELECT value FROM json_each(?))
     ORDER BY ts ASC, id ASC`).all(SCHEDULE_CHANNEL, since, ids)) {
    resolves.set(r.recId, [...(resolves.get(r.recId) ?? []), r]);
  }
  const posts = new Map<string, SealedPost[]>();
  for (const channel of new Set(asked.map((a) => a.channel))) {
    const forChannel = JSON.stringify(asked.filter((a) => a.channel === channel).map((a) => a.rec.id));
    for (const r of d.core.store.db.query<SealedPost, [string, number, string]>(
      `SELECT origin, author_handle, json_extract(body, '$.talkie_answer.for') AS forId, body FROM events
       WHERE channel = ? AND ts >= ? AND author_agent IS NULL AND +kind = 'msg.post' AND redacted = 0 AND status = 'ok'
         AND json_extract(body, '$.talkie_answer.v') = 1 AND json_extract(body, '$.talkie_answer.for') IN (SELECT value FROM json_each(?))
       ORDER BY ts DESC, id DESC`).all(channel, since - SEAL_SLACK_MS, forChannel)) {
      posts.set(r.forId, [...(posts.get(r.forId) ?? []), r]);
    }
  }
  for (const { rec } of asked) {
    const resolve = (resolves.get(rec.id) ?? []).find((r) => r.author_handle === (rec.resolved as RecResolution).by);
    if (!resolve) continue;
    const post = (posts.get(rec.id) ?? []).find((p) => p.origin === resolve.origin && p.author_handle === resolve.author_handle);
    const held = post ? parseAnswer(post.body) : null;
    if (held) out.set(rec.id, held);
  }
  return out;
}

/** The person's note, or the result line when they wrote none. Undefined when this answer was not sealed. `answers` is the list's, read once. */
function answerNote(d: RecDeps, rec: Rec, answers?: ReadonlyMap<string, HeldAnswer>): string | undefined {
  const held = (answers ?? sealedAnswers(d, [rec])).get(rec.id);
  return held?.note ?? held?.result;
}

function actionRecord(raw: string | null): { kind?: string; project?: string; card?: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as { kind?: string; project?: string; card?: string } : null;
  } catch {
    return null;
  }
}

/**
 * The approvals and dismissals of the last day, by recommendation key, read from the answers (each carries its
 * recommendation's key) and their recommendations alone, so a cooldown holds however many other records a busy channel has
 * seen since. A person's answer only, and only for the key its own recommendation has (a create in the same channel by an
 * owner's WalkieTalkie): an answer cannot name another recommendation's key to hold that one back.
 */
function recentAnswers(d: RecDeps, now: number): Map<string, { status: "approved" | "dismissed"; at: number }> {
  const out = new Map<string, { status: "approved" | "dismissed"; at: number }>();
  const since = now - Math.max(DISMISS_COOLDOWN_MS, APPROVED_COOLDOWN_MS);
  for (const channel of recChannels(d)) {
    const rows = d.core.store.db.query<AnswerRow, [string, number, number]>(
      `SELECT r.origin AS origin, r.seq AS seq, r.ts AS ts, r.received_at AS received_at, json_extract(r.body, '$.talkie_rec.key') AS key,
              json_extract(r.body, '$.talkie_rec.status') AS status, c.author_handle AS maker, r.author_handle AS resolver,
              json_extract(c.body, '$.talkie_rec.audience') AS audience, json_extract(c.body, '$.talkie_rec.project') AS project,
              json_extract(c.body, '$.talkie_rec.action') AS action
       FROM events r JOIN events c ON c.id = json_extract(r.body, '$.talkie_rec.rec')
       WHERE r.channel = ? AND r.ts > ? AND +r.kind = 'msg.post' AND r.redacted = 0 AND r.status = 'ok' AND r.author_agent IS NULL
         AND json_extract(r.body, '$.talkie_rec.v') = 1 AND json_extract(r.body, '$.talkie_rec.op') = 'resolve'
         AND json_extract(r.body, '$.talkie_rec.status') IN ('approved', 'dismissed') AND typeof(json_extract(r.body, '$.talkie_rec.key')) = 'text'
         AND c.channel = r.channel AND +c.kind = 'msg.post' AND c.redacted = 0 AND c.status = 'ok' AND c.author_agent = '${ORCHESTRATOR_AGENT}'
         AND json_extract(c.body, '$.talkie_rec.op') = 'create' AND json_extract(c.body, '$.talkie_rec.key') = json_extract(r.body, '$.talkie_rec.key')
       ORDER BY r.ts DESC LIMIT ?`).all(channel, since, MAX_ROWS);
    const owners = ownersOf(d.core);
    for (const r of rows) {
      if (!owners.has(r.maker)) continue;
      const at = Math.min(r.ts, r.received_at);
      // Every answer is judged by who could see the project where it stands in the log. Nothing on it vouches for itself.
      const action = typeof r.action === "string" ? actionRecord(r.action) : (r.action && typeof r.action === "object" ? r.action as { kind?: string; project?: string; card?: string } : null);
      if (answerBlind(d, r.resolver, r.audience ?? "", typeof r.project === "string" ? r.project : null, action, { origin: r.origin, seq: r.seq })) continue;
      const had = out.get(r.key);
      if (!had || at > had.at) out.set(r.key, { status: r.status === "approved" ? "approved" : "dismissed", at });
    }
  }
  return out;
}

/** Where a recommendation counts against the per-project cap: its project, else its channel. */
const scopeOf = (r: Pick<Rec, "project" | "channel">): string => r.project ?? r.channel;

/** The scope a new recommendation will count in: its project (its channel for a team one, its own `project` for an owners-only one), else where it is posted. */
function newScope(rec: NewRec, channel: string | null): string {
  return rec.audience === "owners" ? rec.project ?? placeOf(rec, channel) : channel ?? placeOf(rec, channel);
}

/** What is open and what was answered lately, counted once for the checks a new recommendation passes. */
interface Standing {
  all: readonly Rec[]; open: readonly Rec[]; openByKey: Map<string, Rec>; perScope: Map<string, number>; total: number; now: number;
  answers: Map<string, { status: "approved" | "dismissed"; at: number }>;
}

function standing(d: RecDeps): Standing {
  const all = readRecs(d);
  const open = all.filter(isOpen);
  const perScope = new Map<string, number>();
  for (const r of open) perScope.set(scopeOf(r), (perScope.get(scopeOf(r)) ?? 0) + 1);
  const now = nowOf(d);
  return { all, open, openByKey: new Map(open.map((r) => [r.key, r])), perScope, total: open.length, now, answers: recentAnswers(d, now) };
}

/** Whether a recommendation with this key was dismissed within a day or approved within six hours. */
const cooling = (status: string, at: number, now: number): boolean =>
  (status === "dismissed" && now - at < DISMISS_COOLDOWN_MS) || (status === "approved" && now - at < APPROVED_COOLDOWN_MS);
const lately = (s: Standing, key: string): boolean => {
  const answer = s.answers.get(key);
  if (answer && cooling(answer.status, answer.at, s.now)) return true;
  return s.all.some((r) => r.key === key && !!r.resolved && cooling(r.status, r.resolved.at, s.now));
};

/** The caps a new recommendation meets: open in its project, and open in all. */
const overCaps = (s: Standing, scope: string): boolean => s.total >= MAX_OPEN_TOTAL || (s.perScope.get(scope) ?? 0) >= MAX_OPEN_PER_PROJECT;

export type Recorded = { outcome: "created"; id: string } | { outcome: "duplicate" | "suppressed" | "capped" };

/** One recommendation on its own (a model-driven duty's): made unless an open one has its key, one was answered lately, or the caps are met. */
export function recordRec(d: RecDeps, rec: NewRec, channel: string | null): Recorded {
  const s = standing(d);
  if (s.openByKey.has(rec.key) || answering(d.core, rec.key)) return { outcome: "duplicate" };
  if (lately(s, rec.key)) return { outcome: "suppressed" };
  if (overCaps(s, newScope(rec, channel))) return { outcome: "capped" };
  return { outcome: "created", id: createRec(d, rec, channel) };
}

/**
 * One run's decision. `scope` is what the run looked at completely (project channels, plus the schedule channel's own scope
 * for machine-level ones): an open recommendation of this source in that scope that is no longer wanted is retired, one outside it
 * is left alone (the run did not look). A wanted one that is open and unchanged is kept, one that is open with another action (a
 * seat now on another machine) is replaced, one that was dismissed lately or approved lately is not made again, a new one is
 * made within the caps.
 */
export function reconcile(d: RecDeps, o: { source: RecSource; scope: ReadonlySet<string>; desired: readonly Desired[]; canAct?: () => boolean }): ReconcileResult {
  const fence = () => { if (o.canAct && !o.canAct()) throw new Error("WalkieTalkie lease expired"); };
  const s = standing(d);
  const result: ReconcileResult = { created: 0, kept: 0, replaced: 0, superseded: 0, suppressed: 0, capped: 0 };
  const wanted = new Map<string, Desired>();
  for (const x of o.desired) if (!wanted.has(x.rec.key)) wanted.set(x.rec.key, x);

  const retire = (r: Rec): void => {
    fence();
    supersedeRec(d, r);
    s.perScope.set(scopeOf(r), Math.max(0, (s.perScope.get(scopeOf(r)) ?? 1) - 1));
    s.total -= 1;
  };

  // Retire first, so what it frees counts for what is made: a wanted one that changed, and an unwanted one inside the scope.
  for (const r of s.open) {
    const w = wanted.get(r.key);
    if (r.source !== o.source || answering(d.core, r.key)) continue;
    if (w && !sameAction(r.action, w.rec.action, r.audience === "owners")) { retire(r); s.openByKey.delete(r.key); result.replaced += 1; }
    else if (!w && o.scope.has(scopeOf(r))) { retire(r); result.superseded += 1; }
  }
  for (const [key, w] of wanted) {
    if (s.openByKey.has(key) || answering(d.core, key)) { result.kept += 1; continue; }
    if (lately(s, key)) { result.suppressed += 1; continue; }
    const scope = newScope(w.rec, w.channel);
    if (result.created >= MAX_NEW_PER_RUN || overCaps(s, scope)) { result.capped += 1; continue; }
    fence();
    createRec(d, w.rec, w.channel);
    s.perScope.set(scope, (s.perScope.get(scope) ?? 0) + 1);
    s.total += 1;
    result.created += 1;
  }
  return result;
}
