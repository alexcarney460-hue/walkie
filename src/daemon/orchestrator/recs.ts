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
  APPROVED_COOLDOWN_MS, DISMISS_COOLDOWN_MS, MAX_NEW_PER_RUN, MAX_OPEN_PER_PROJECT, MAX_OPEN_TOTAL, ONBOARDING_ARGV, READ_WINDOW_MS, askMessage, cardDataTitle,
  createText, foldRecs, isOpen, resolveText, type NewRec, type Rec, type RecEvent, type RecResolveT, type RecSource,
} from "../../protocol/talkie-recs.ts";
import { isConfidential, safeText } from "../../protocol/projects/status-report.ts";
import { SCHEDULE_CHANNEL } from "../../protocol/talkie-schedule.ts";
import type { Core } from "../core.ts";
import type { Logger } from "../logger.ts";
import type { ProjectsIndex } from "../projects/index.ts";
import { visibleProjects } from "../projects/service.ts";

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

interface Row { id: string; ts: number; received_at: number; author_handle: string; author_agent: string | null; rec: string }

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
    `SELECT id, ts, received_at, author_handle, author_agent, json_extract(body, '$.talkie_rec') AS rec FROM events
     WHERE channel = ? AND ts > ? AND +kind = 'msg.post' AND redacted = 0 AND status = 'ok' AND json_extract(body, '$.talkie_rec.v') = 1
     ORDER BY ts DESC LIMIT ?`).all(channel, since, MAX_ROWS);
  const out: RecEvent[] = [];
  for (const r of rows) {
    try {
      out.push({ id: r.id, ts: Math.min(r.ts, r.received_at), channel, author: { handle: r.author_handle, ...(r.author_agent ? { agent: r.author_agent } : {}) }, rec: JSON.parse(r.rec) });
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
  const recs = collapse(foldRecs(events, { owners: ownersOf(d.core), now }));
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
  const a = rec.action;
  if (a.kind === "create_card") return `Creates a card titled: ${a.title}`;
  if (a.kind === "onboarding_step") return `Runs walkie ${ONBOARDING_ARGV[a.step].join(" ")} on ${machineName(d, a.machine)}`;
  if (a.kind !== "ask_orchestrator") return undefined;
  const card = a.card ? cardNow(d, a.card) : null;
  if (a.card && !card) return null;
  return askMessage({ id: rec.id, topic: a.topic, card, by, reason: rec.source === "turn" ? null : rec.reason,
    ...(a.topic === "setup" && a.machine && a.step ? { setup: { machine: machineName(d, a.machine), step: a.step } } : {}) });
}

/** What one person's list shows of a recommendation. `outgoing` is passed in when it needs more than the record (a seat's machine). */
export function viewOf(d: RecDeps, rec: Rec, o: { outgoing?: string | null; dashboard?: boolean } = {}): RecView {
  const may = mayAnswer(d.core, rec);
  const project = rec.project ? d.idx.project(rec.project) : null;
  const outgoing = "outgoing" in o ? o.outgoing : outgoingOf(d, rec, d.core.myHandle() ?? "you");
  // A setup step runs a command on another machine: it is approved at a terminal, never from a dashboard session.
  const terminalOnly = o.dashboard && rec.kind === "onboarding_step";
  const why = may.why ?? (terminalOnly ? `setup steps are approved in a terminal: walkie talkie approve ${shortId(rec.id)}` : undefined);
  return { ...rec, short: shortId(rec.id), project_name: project?.name ?? null, can_approve: may.ok && !terminalOnly, can_dismiss: may.ok,
    ...(why ? { why_not: why } : {}), ...(outgoing !== undefined ? { outgoing } : {}) };
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

export function createRec(d: RecDeps, rec: NewRec, channel: string | null): string {
  const place = placeOf(rec, channel);
  if (rec.audience === "team" && !channel) throw new Error("a team recommendation needs its project's channel");
  const event = emitRec(d, place, createText(rec.summary), { v: 1, op: "create", ...rec }, ORCHESTRATOR_AGENT);
  d.log?.info("talkie_rec_created", { rec: event.id, kind: rec.action.kind, group: rec.group, audience: rec.audience, source: rec.source });
  return event.id;
}

/** WalkieTalkie retires a recommendation whose condition no longer holds (a person's answer is `answerRec`). */
export function supersedeRec(d: RecDeps, rec: Rec): void {
  emitRec(d, rec.channel, resolveText("superseded", rec.summary, d.core.myHandle() ?? "walkietalkie"), { v: 1, op: "resolve", rec: rec.id, status: "superseded", key: rec.key } satisfies RecResolveT, ORCHESTRATOR_AGENT);
  d.log?.info("talkie_rec_superseded", { rec: rec.id, kind: rec.kind });
}

/** A person approves or dismisses one: a signed post in its channel, as that person (never as an agent). */
export function answerRec(d: RecDeps, rec: Rec, status: "approved" | "dismissed", note?: string): void {
  const by = d.core.myHandle();
  if (!by) throw new Error("this node is not an admitted member");
  emitRec(d, rec.channel, resolveText(status, rec.summary, by), { v: 1, op: "resolve", rec: rec.id, status, ...(note ? { note: note.slice(0, 200) } : {}), key: rec.key } satisfies RecResolveT);
  d.log?.info(`talkie_rec_${status}`, { rec: rec.id, kind: rec.kind, by });
}

// ---- reconciling --------------------------------------------------------------------------------------------------

export interface Desired { rec: NewRec; /** The project channel it is about (null: a machine). */ channel: string | null }

export interface ReconcileResult { created: number; kept: number; replaced: number; superseded: number; suppressed: number; capped: number }

/** Whether an open recommendation already says what a run wants. A seat is the same card and role on whatever machine: the machine is chosen when it is approved. */
const sameAction = (a: Rec["action"], b: Rec["action"]): boolean => a.kind === "start_seat" && b.kind === "start_seat"
  ? a.card === b.card && a.role === b.role : JSON.stringify(a) === JSON.stringify(b);

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

interface AnswerRow { ts: number; received_at: number; key: string; status: string; maker: string }

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
      `SELECT r.ts AS ts, r.received_at AS received_at, json_extract(r.body, '$.talkie_rec.key') AS key,
              json_extract(r.body, '$.talkie_rec.status') AS status, c.author_handle AS maker
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
    if (w && !sameAction(r.action, w.rec.action)) { retire(r); s.openByKey.delete(r.key); result.replaced += 1; }
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
