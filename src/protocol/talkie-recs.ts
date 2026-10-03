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
import { z } from "zod";
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

/** One event of a channel that carries a `talkie_rec` field: `rec` is the field as signed, `ts` the earlier of its stamp and its receipt. */
export interface RecEvent {
  id: string; ts: number; channel: string;
  author: { handle: string; agent?: string };
  rec: unknown;
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

export interface FoldContext { owners: ReadonlySet<string>; now: number }

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
