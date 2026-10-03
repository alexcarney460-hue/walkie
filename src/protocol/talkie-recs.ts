// TALKIE-OPS-1: WalkieTalkie's recommendations. Pure (no I/O): the daemon writes and reads them (daemon/orchestrator/recs.ts),
// the dashboard and the CLI show them, and everything decided here is tested without a daemon. docs/plans/TALKIE-OPS-1.md has
// the design.
//
// No new event kind: a recommendation is an ordinary `msg.post` that carries `talkie_rec` next to its human-readable `text`.
//   create   written by an owner's WalkieTalkie (agent `orchestrator`, which `core.emit` fences by the leadership lease): the
//            structured action, a plain-English summary and reason, the evidence, a dedup key and a time to live.
//   resolve  approved or dismissed by a PERSON (never an agent), or superseded by an owner's WalkieTalkie when what it was
//            about no longer holds.
// A team project's recommendations are posted in the project's channel (its members get exactly them); owners-only ones (a
// private project, a card labelled `confidential`, a machine) in the owner-only schedule channel. Older peers show the posts as
// ordinary messages and ignore the field.
import { createHmac } from "node:crypto";
import { z } from "zod";
import { scrubPhrases } from "./phrase-scrub.ts";
import { Address, EventId, NodeId } from "./schemas.ts";
import { ORCHESTRATOR_AGENT } from "./orchestrator.ts";
import { SEAT_RUNTIMES } from "./seats.ts";
import { PROJECT_CHANNEL_RE } from "./projects/schema.ts";
import { shortId } from "./projects/short.ts";
import { plainTitle } from "./projects/status-report.ts";
import { SCHEDULE_CHANNEL } from "./talkie-schedule.ts";

// ---- constants ----------------------------------------------------------------------------------------------------

const H = 3_600_000;
/** A recommendation stays open this long; one still true then is made again. A setup step waits longer. */
export const REC_TTL_MS = 24 * H;
export const SETUP_TTL_MS = 72 * H;
/** A dismissed recommendation is not made again for this long; an approved one (its action takes a while to show) for this. */
export const DISMISS_COOLDOWN_MS = 24 * H;
export const APPROVED_COOLDOWN_MS = 6 * H;
/** At most this many open per project, open in all, created by one run, and recorded by one model turn. */
export const MAX_OPEN_PER_PROJECT = 20;
export const MAX_OPEN_TOTAL = 150;
export const MAX_NEW_PER_RUN = 25;
export const MAX_TURN_RECS = 10;
/** Recommendations older than this are history: they are not read. */
export const READ_WINDOW_MS = 7 * 24 * H;
/** The most a list answers with. */
export const MAX_LIST = 100;
/** The most open ones a list answers with (every open one up to this, before any history); more is said as a count. */
export const MAX_OPEN_LIST = 200;
/** The most a model-driven duty's own words take on a record. */
export const MAX_CONTEXT = 600;

export const ACTION_KINDS = ["move_card", "start_seat", "ask_orchestrator", "onboarding_step", "create_card"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
/** What a model-driven duty may recommend through the daemon (moves and seats come from the daemon's own duties only). */
export const TURN_ACTION_KINDS: readonly ActionKind[] = ["create_card", "ask_orchestrator", "onboarding_step"];

export const REC_GROUPS = ["work", "moves", "reviews", "stalled", "setup"] as const;
export type RecGroup = (typeof REC_GROUPS)[number];
export const REC_GROUP_LABELS: Readonly<Record<RecGroup, string>> = {
  work: "Work to start", moves: "Cards to move", reviews: "Reviews waiting", stalled: "Stalled", setup: "Machines to set up",
};
export const REC_SOURCES = ["poll", "curation", "turn"] as const;
export type RecSource = (typeof REC_SOURCES)[number];
export const REC_STATUSES = ["pending", "approved", "dismissed", "expired", "superseded"] as const;
export type RecStatus = (typeof REC_STATUSES)[number];

/** The two setup steps, each one fixed `walkie` command run on the machine through remote admin (nothing is free text). */
export const ONBOARDING_STEPS = ["seats_doctor", "seats_enable"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export const ONBOARDING_ARGV: Readonly<Record<OnboardingStep, readonly string[]>> = {
  seats_doctor: ["seats", "doctor"],
  seats_enable: ["seats", "enable"],
};

// ---- the action ---------------------------------------------------------------------------------------------------

const ColumnRef = z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/);
const ProjectRef = z.string().regex(PROJECT_CHANNEL_RE);

export const MoveCardAction = z.object({
  kind: z.literal("move_card"),
  card: EventId,
  /** Where the card was when the recommendation was made: approving it after a person moved it is refused. */
  from: ColumnRef,
  /** The column to move it to; absent when it is only to be marked blocked. */
  to: ColumnRef.optional(),
  blocked_reason: z.string().min(1).max(300).optional(),
  /**
   * Set on an owners-only block (no `to`). A pre.12 action is strict and has no such field, so it does not fold the
   * record and does not mark the card blocked with the placeholder. A move that names a column omits it, and an older
   * peer still folds that move.
   */
  seal: z.literal(1).optional(),
}).strict();
export const StartSeatAction = z.object({
  kind: z.literal("start_seat"),
  machine: NodeId,
  runtime: z.enum(SEAT_RUNTIMES),
  role: z.enum(["builder", "reviewer"]),
  card: EventId,
}).strict();
/**
 * An ask carries no text: the message an approval sends in the approver's name is written by `askMessage` from these fields and
 * the card as it is then, so nothing a model wrote is ever sent as a person's own words (a duty's own words go in `context`).
 */
export const ASK_TOPICS = ["review", "status", "record", "take", "setup"] as const;
export type AskTopic = (typeof ASK_TOPICS)[number];
/** What a machine's person is asked to do so team agents can run there (machine onboarding's ask): each one fixed sentence. */
export const ASK_SETUP_STEPS = ["seats_enable", "seat_helper", "runtime_login", "update"] as const;
export type AskSetupStep = (typeof ASK_SETUP_STEPS)[number];
export const ASK_SETUP_SENTENCES: Readonly<Record<AskSetupStep, string>> = {
  seats_enable: "turn on seats there by running walkie seats enable on it.",
  seat_helper: "install or update its seat helper by running walkie seats setup-user --apply on it.",
  runtime_login: "sign in to Claude or Codex on it (run claude or codex there and log in).",
  update: "update Walkie on it by running walkie update.",
};
export const AskOrchestratorAction = z.object({
  kind: z.literal("ask_orchestrator"),
  to: Address,
  topic: z.enum(ASK_TOPICS),
  card: EventId.optional(),
  /** A setup ask only: the machine and the one step its person is asked to take. */
  machine: NodeId.optional(),
  step: z.enum(ASK_SETUP_STEPS).optional(),
}).strict();
export const OnboardingStepAction = z.object({
  kind: z.literal("onboarding_step"),
  machine: NodeId,
  step: z.enum(ONBOARDING_STEPS),
}).strict();
export const CreateCardAction = z.object({
  kind: z.literal("create_card"),
  project: ProjectRef,
  title: z.string().min(1).max(200),
  column: ColumnRef.optional(),
  /**
   * Set on an owners-only create. A pre.12 peer's action is strict and has no such field, so it does not fold the
   * record and cannot approve it. Absent on a team create, which an older peer still folds.
   */
  seal: z.literal(1).optional(),
}).strict();

export const RecAction = z.discriminatedUnion("kind", [MoveCardAction, StartSeatAction, AskOrchestratorAction, OnboardingStepAction, CreateCardAction])
  .refine((a) => a.kind !== "move_card" || a.to !== undefined || a.blocked_reason !== undefined, { message: "a move names a column or a block reason" })
  .refine((a) => a.kind !== "ask_orchestrator" || (a.topic === "setup"
    ? a.machine !== undefined && a.step !== undefined && a.card === undefined
    : a.machine === undefined && a.step === undefined), { message: "a setup ask names a machine and a step, and only a setup ask does" });
export type RecActionT = z.infer<typeof RecAction>;

// ---- the records --------------------------------------------------------------------------------------------------

const Line = (max: number) => z.string().min(1).max(max);

export const RecCreate = z.object({
  v: z.literal(1),
  op: z.literal("create"),
  /** What it is about (recKey): the same open recommendation is not made twice. */
  key: Line(320),
  group: z.enum(REC_GROUPS),
  source: z.enum(REC_SOURCES),
  /** The project it concerns (for an owners-only one; a team one is the channel it is posted in). */
  project: ProjectRef.optional(),
  audience: z.enum(["team", "owners"]),
  action: RecAction,
  /** One plain-English sentence, and one line of why. */
  summary: Line(200),
  reason: Line(200),
  evidence: z.array(Line(200)).max(6),
  /**
   * What a model-driven duty wrote itself (its reason, note and evidence): shown to the person who answers, quoted and marked as
   * WalkieTalkie's, and never sent, posted or commented in anyone's name.
   */
  context: Line(MAX_CONTEXT).optional(),
  ttl_ms: z.number().int().min(60_000).max(7 * 24 * H),
}).strict();
export type RecCreateT = z.infer<typeof RecCreate>;
/** What a duty hands the store: a create without its envelope. */
export type NewRec = Omit<RecCreateT, "v" | "op">;

export const RecResolve = z.object({
  v: z.literal(1),
  op: z.literal("resolve"),
  rec: EventId,
  status: z.enum(["approved", "dismissed", "superseded"]),
  note: z.string().max(200).optional(),
  /** The answered recommendation's key, so a cooldown is read from the answers alone, however many records came since. */
  key: Line(320).optional(),
}).strict();
export type RecResolveT = z.infer<typeof RecResolve>;

// ---- keys and titles ----------------------------------------------------------------------------------------------

const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);

/** What a recommendation is about, as a string: the same thing, however many polls see it, is one key. */
export const recKey = {
  move: (card: string, to: string | undefined): string => `move|${card}|${to ?? "block"}`,
  seat: (card: string, role: "builder" | "reviewer"): string => `seat|${card}|${role}`,
  ask: (to: string, card: string | undefined, topic: string): string => `ask|${to}|${card ?? "-"}|${topic}`,
  step: (node: string, step: OnboardingStep): string => `step|${node}|${step}`,
  create: (project: string, title: string): string => `card|${project}|${norm(title)}`,
};

/**
 * Dedup key for a card that does not exist yet when the recommendation is owners-only. An HMAC of the channel id and
 * the normalized title, keyed by this daemon's local secret, so the schedule record does not carry the title and the
 * same title in another project is a different key. `secret` is 32 random bytes from the daemon's home, not a hash of
 * the title.
 */
export function sealedCreateKey(project: string, title: string, secret: Uint8Array): string {
  const digest = createHmac("sha256", secret).update(`${project}\0${norm(title)}`).digest("hex").slice(0, 32);
  return `card|${project}|h:${digest}`;
}

/** `action.title` of an owners-only create points at the project-channel post that holds the real title. */
export const TITLE_REF_PREFIX = "card-title:";
const TITLE_REF_ID = /^[0-9a-f]{16}:[1-9][0-9]*$/;
export function titleRef(eventId: string): string { return `${TITLE_REF_PREFIX}${eventId}`; }
export function titleRefId(title: string): string | null {
  if (!title.startsWith(TITLE_REF_PREFIX)) return null;
  const id = title.slice(TITLE_REF_PREFIX.length);
  return TITLE_REF_ID.test(id) ? id : null;
}

/** How an owners-only recommendation names a card that already exists: its id, never its key or its title. */
export function cardScheduleRef(cardId: string): string {
  return `card ${cardId}`;
}

function sentenceForm(title: string, prefixes: readonly string[]): string[] {
  // A form this function itself shortened ends in "…". That shortening is not a stored title, and using it would match
  // a fragment. A stored title that already ends in "…" is added by the caller and is not skipped here.
  const forms = [recTitle(title, prefixes), cardDataTitle(title, prefixes)];
  return forms.filter((s) => s.length > 0 && s !== "(untitled)" && !s.endsWith("…"));
}

/**
 * Removes each phrase only where it stands as a whole phrase after the same normalisation on both sides (NFKC, marks
 * and format characters dropped, Cyrillic and Greek look-alikes mapped to Latin, a run of punctuation, underscores or
 * whitespace read as one gap, and the phrase with those gaps removed). A shorter piece of a phrase is left, and so is
 * a fragment inside a longer token ("seeding", "keys2"). One matcher is built for the phrase set and reused.
 */
export function withoutPhrases(text: string, phrases: readonly string[]): string {
  return scrubPhrases(text, phrases);
}

/**
 * Takes a card's title, and the sentence forms of that whole title, out of text. Only the whole phrase, at a word
 * boundary: a fragment of the title, however long, is left. A truncated sentence form is not used (it would be a fragment).
 */
export function withoutCardTitle(text: string, title: string, prefixes: readonly string[]): string {
  return withoutPhrases(text, [title, ...sentenceForm(title, prefixes)]);
}

/** A card key standing in a title. Not global: callers test many titles. */
const KEY_IN_TITLE = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,9}-\d{1,7}(?:-[0-9a-fA-F]{8})?(?![A-Za-z0-9])/;
/** The whole phrase is only a card key, so its sentence form is empty and is not a phrase of its own. */
const KEY_ONLY = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}(?:-[0-9a-fA-F]{8})?$/;
const MARKUP_ASCII = new Uint8Array(128);
for (const code of [34, 39, 96, 42, 95, 91, 93, 123, 125, 60, 62, 92, 64]) MARKUP_ASCII[code] = 1;

/**
 * Sentence forms of a phrase, when they are not the phrase itself. A plain title at most 80 characters long, and a
 * longer title with no card key (its shortened form would end in an ellipsis and is not used), add nothing. A phrase
 * that is only a card key adds nothing either: stripping the key leaves no words.
 */
function extraForms(phrase: string, prefixes: readonly string[]): string[] {
  let markup = false;
  let hyphen = false;
  for (let i = 0; i < phrase.length; i++) {
    const c = phrase.charCodeAt(i);
    if (c === 45) hyphen = true;
    else if (c < 128 && MARKUP_ASCII[c] === 1) markup = true;
  }
  if (!hyphen && !markup) return [];
  const keyed = hyphen && KEY_IN_TITLE.test(phrase);
  if (!keyed && (phrase.length > 80 || !markup)) return [];
  if (keyed && KEY_ONLY.test(phrase)) return [];
  return sentenceForm(phrase, prefixes);
}

/**
 * The same, for every private phrase the caller passes: a private project's name, and the title and the key of an
 * open or archived card on a private project or of a confidential card. A truncated sentence form this code produced
 * is not used. A stored title is, including one that already ends in an ellipsis. An underscore is a gap.
 */
export function withoutPrivatePhrases(text: string, phrases: readonly string[], prefixes: readonly string[]): string {
  const forms: string[] = [];
  for (const phrase of phrases) {
    forms.push(phrase);
    for (const extra of extraForms(phrase, prefixes)) forms.push(extra);
  }
  return withoutPhrases(text, forms);
}

/** Puts the title a viewer may see back into a stored owners-only summary. A `$` in the title stays a `$`. */
export function summaryWithTitle(summary: string, displayTitle: string, projectName: string | null, cardKey?: string | null): string {
  const created = /^Create a card in (p-[0-9a-f]{8})$/.exec(summary);
  if (created) return `Create a card “${displayTitle}” in ${projectName ?? created[1]}`;
  const shown = cardKey ? `card ${cardKey} “${displayTitle}”` : `“${displayTitle}”`;
  return summary
    .replace(/card [0-9a-f]{16}:[1-9][0-9]*/g, () => shown)
    .replace(/card [A-Z][A-Z0-9]{1,9}-\d{1,7}(?:-[0-9a-fA-F]{8})? \(p-[0-9a-f]{8}\)/g, () => shown);
}

/** A card key from anywhere (cards imported from other tools carry their old ids): capitals, a hyphen and digits, so an agent's name like `cc-9` is not one. */
const KEY_SHAPE = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,9}-\d{1,7}(?:-[0-9a-fA-F]{8})?(?![A-Za-z0-9])/g;

/**
 * A card's title as a sentence for people may say it: no key of the project, no key-shaped token from anywhere else (cards
 * imported from other tools carry their old ids), defanged and short.
 */
export function recTitle(title: string, prefixes: readonly string[], max = 80): string {
  return plainTitle(title.replace(KEY_SHAPE, ""), prefixes, max);
}

/** Quote marks of every kind (and the letters and signs that look like them), and the characters Markdown and chat formatting read. */
const QUOTE_MARKS = /["'`\u00AB\u00BB\u02B9-\u02BC\u02BA\u02EE\u05F3\u05F4\u2018-\u201F\u2032-\u2037\u2039\u203A\u2E42\u275B-\u275E\u276E\u276F\u3003\u300C-\u300F\u301D-\u301F\uFF02\uFF07\u{1F676}-\u{1F678}]/gu;
const MARKUP = /[*_~#>|\[\]{}<>\\]/g;

/**
 * A card's title as data inside a message sent in a person's name: what recTitle leaves (no keys, links or secrets), on one
 * line, with no quote mark (so it cannot close a quote and read as the sender's own sentence), no Markdown, and no @ that could
 * mention anyone; at most 80 characters.
 */
export function cardDataTitle(title: string, prefixes: readonly string[]): string {
  const t = recTitle(title, prefixes, 200).replace(QUOTE_MARKS, "").replace(MARKUP, " ").replace(/@/g, "(at)").replace(/\s+/g, " ").trim();
  return (t.length > 80 ? `${t.slice(0, 79).trimEnd()}…` : t) || "(untitled)";
}

/** What a card, a seat prompt and an ask carry so a recommendation can be found again. */
export function recMarker(id: string): string { return `[WalkieTalkie recommendation ${shortId(id)}]`; }

/**
 * The message an approved ask sends, in the approver's name: a fixed sentence for its topic, the card as the board has it now,
 * and the recommendation's reason when the daemon wrote it (a model-driven duty's own words are its `context`, never sent: its
 * recommendations pass null).
 * The dashboard and the CLI show exactly this before anyone approves.
 */
export function askMessage(o: {
  id: string; topic: AskTopic; by: string; reason: string | null;
  /** The card as it is now: its title already cardDataTitle's; a confidential card's title is never said. */
  card: { ref: string; title: string; confidential: boolean } | null;
  /** A setup ask: the machine's name and the step. */
  setup?: { machine: string; step: AskSetupStep };
}): string {
  const card = o.card ? `card ${o.card.ref}` : null;
  const sentence = o.topic === "setup" && o.setup ? `Please set up ${o.setup.machine} for team agents: ${ASK_SETUP_SENTENCES[o.setup.step]}`
    : o.topic === "review" ? `Please take the review of ${card ?? "the card"}.`
    : o.topic === "take" ? `Could you take on ${card ?? "the card"}?`
    : o.topic === "status" ? (card ? `How is ${card} going? Please post an update on the card.` : "Could you post an update on what you are working on?")
    : card ? `Please record your work on ${card} on the board.` : "Please record the work you are doing on the Walkie board: a card for it, kept current.";
  // The title is data on a line of its own, never part of the sender's sentence; a confidential card's is left out.
  const data = o.card ? (o.card.confidential ? `Card ${o.card.ref} is labelled confidential: its title is not repeated here.` : `Card ${o.card.ref}: ${o.card.title}`) : null;
  return [recMarker(o.id), sentence, ...(data ? [data] : []), `(Sent by @${o.by} on WalkieTalkie's recommendation${o.reason ? `: ${o.reason}` : "."})`].join("\n").slice(0, 4_000);
}

/** The text of the post that carries a recommendation, and of its answers (what an older peer shows as an ordinary message). */
export function createText(summary: string): string { return `WalkieTalkie recommends: ${summary}`.slice(0, 400); }
export function resolveText(status: RecResolveT["status"], summary: string, by: string): string {
  const verb = status === "approved" ? "approved" : status === "dismissed" ? "dismissed" : "retired";
  return `@${by} ${verb} WalkieTalkie's recommendation: ${summary}`.slice(0, 400);
}

// ---- folding ------------------------------------------------------------------------------------------------------

/**
 * One event of a channel that carries a `talkie_rec` field: `rec` is the field as signed, `ts` the earlier of its stamp and its receipt.
 * `origin` and `seq` are the event's place in its node's log: they are what the roster chain anchors an event by, so a caller
 * judging who could see a project when it was answered reads the membership in force at that anchor, never the author's clock.
 */
export interface RecEvent {
  id: string; ts: number; channel: string;
  author: { handle: string; agent?: string };
  rec: unknown;
  origin?: string; seq?: number;
}

export interface RecResolution { status: RecResolveT["status"]; by: string; at: number; agent?: string; note?: string }
export interface Rec {
  id: string; key: string; kind: ActionKind; group: RecGroup; source: RecSource;
  /** The project it concerns, or null (a machine). */
  project: string | null;
  /** The channel it is stored in. */
  channel: string;
  audience: "team" | "owners";
  action: RecActionT; summary: string; reason: string; evidence: readonly string[];
  /** A model-driven duty's own words (RecCreate.context). */
  context?: string;
  created_at: number; expires_at: number;
  status: RecStatus;
  resolved?: RecResolution;
}

export interface FoldContext {
  owners: ReadonlySet<string>;
  now: number;
  /**
   * A person's approve or dismiss counts only when this returns true. Absent: every person's answer counts.
   * An owner's WalkieTalkie supersede is not asked. Every person's answer is asked, however it is marked: nothing
   * the author wrote on it is believed. `e` is the answer, so the callback can judge it where it stands in the log.
   */
  canAnswer?: (handle: string, rec: Rec, e: RecEvent) => boolean;
}

export function scheduleChannelRec(channel: string): boolean { return channel === SCHEDULE_CHANNEL; }

/** An owner's WalkieTalkie wrote it. */
function ownersWalkieTalkie(e: RecEvent, owners: ReadonlySet<string>): boolean {
  return e.author.agent === ORCHESTRATOR_AGENT && owners.has(e.author.handle);
}

/** The channel a create may be in: a team recommendation in a project's channel, an owners-only one in the owner-only schedule channel. */
function placeOk(audience: "team" | "owners", channel: string): boolean {
  return audience === "team" ? PROJECT_CHANNEL_RE.test(channel) : scheduleChannelRec(channel);
}

const earlier = (a: { at: number; id: string }, b: { at: number; id: string }): boolean => a.at < b.at || (a.at === b.at && a.id < b.id);

/**
 * The recommendations these events make, newest first. A create counts only from an owner's WalkieTalkie and only in the channel
 * its audience says; an answer counts only in its recommendation's channel: approved or dismissed by a person (no agent),
 * superseded by an owner's WalkieTalkie. The first answer by time, then id, wins, whatever order the events arrive in. A
 * recommendation nobody answered is expired once its time is up. Events that do not parse are not recommendations.
 */
export function foldRecs(events: readonly RecEvent[], ctx: FoldContext): Rec[] {
  const unique = new Map<string, RecEvent>();
  for (const e of events) unique.set(e.id, e);
  const made = new Map<string, Rec>();
  for (const e of unique.values()) {
    const parsed = RecCreate.safeParse(e.rec);
    if (!parsed.success || !ownersWalkieTalkie(e, ctx.owners) || !placeOk(parsed.data.audience, e.channel)) continue;
    const r = parsed.data;
    made.set(e.id, {
      id: e.id, key: r.key, kind: r.action.kind, group: r.group, source: r.source,
      project: r.audience === "team" ? e.channel : r.project ?? null, channel: e.channel, audience: r.audience,
      action: r.action, summary: r.summary, reason: r.reason, evidence: r.evidence, ...(r.context ? { context: r.context } : {}),
      created_at: e.ts, expires_at: e.ts + r.ttl_ms, status: "pending",
    });
  }
  const answers = new Map<string, RecResolution & { id: string }>();
  for (const e of unique.values()) {
    const parsed = RecResolve.safeParse(e.rec);
    if (!parsed.success) continue;
    const target = made.get(parsed.data.rec);
    if (!target || target.channel !== e.channel) continue;
    const byWalkieTalkie = ownersWalkieTalkie(e, ctx.owners);
    const byPerson = !e.author.agent;
    if (parsed.data.status === "superseded" ? !byWalkieTalkie : !byPerson) continue;
    if (parsed.data.status !== "superseded" && ctx.canAnswer && !ctx.canAnswer(e.author.handle, target, e)) continue;
    const answer = { id: e.id, status: parsed.data.status, by: e.author.handle, at: e.ts,
      ...(e.author.agent ? { agent: e.author.agent } : {}), ...(parsed.data.note ? { note: parsed.data.note } : {}) };
    const first = answers.get(target.id);
    if (!first || earlier(answer, first)) answers.set(target.id, answer);
  }
  const out: Rec[] = [];
  for (const rec of made.values()) {
    const answer = answers.get(rec.id);
    if (answer) {
      const { id: _id, ...resolved } = answer;
      out.push({ ...rec, status: answer.status, resolved });
    } else out.push({ ...rec, status: ctx.now >= rec.expires_at ? "expired" : "pending" });
  }
  return out.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Whether the recommendation is still open for a person to answer. */
export function isOpen(rec: Pick<Rec, "status">): boolean { return rec.status === "pending"; }
