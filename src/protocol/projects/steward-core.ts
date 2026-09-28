// FO-6 board steward: types, constants and the helpers the rules share (steward.ts, steward-dup.ts). Pure.
import type { Author } from "../schemas.ts";
import type { Column, ColumnRole, TimelineEntry } from "./schema.ts";

/** The daemon agent that signs steward moves; the local API refuses the name from every client. */
export const STEWARD_AGENT = "steward";
/**
 * The fleet orchestrator's desk agent (FLEET-ORCH-1 §3.1), reserved like `steward`: the local API refuses it from every
 * client, so a run it triggers is the daemon's own (in process), never a request's.
 */
export const FLEET_AGENT = "fleet";
/** A person's move (or restore) pins the card against the steward this long. */
export const PIN_MS = 24 * 3_600_000;
/** Another agent's move is left alone this long (it just decided). */
export const AGENT_GRACE_MS = 3_600_000;
/**
 * The steward doesn't move a card again this soon after a steward move (from any machine): two machines running it
 * with different evidence (one has the repository, one hasn't) can't flip a card back and forth.
 */
export const STEWARD_COOLDOWN_MS = 6 * 3_600_000;
export const DEFAULT_STALE_HOURS = 24;
/** Moves one run makes at most per project (the rest wait for the next run). */
export const MAX_MOVES_PER_RUN = 20;

export type StewardSetting = "on" | "off";

export interface StewardCard {
  readonly id: string; readonly key: string; readonly ref: string; readonly title: string;
  readonly board: string; readonly column: string; readonly state: "open" | "archived" | "deleted";
  readonly assignee: string | null; readonly blocked: boolean; readonly blocked_reason: string | null;
  readonly created_at: number; readonly created_by: Author; readonly updated_at: number;
}

export interface LiveAgent {
  /** `@handle/machine/agent`. */
  readonly address: string;
  readonly handle: string; readonly agent: string;
  /** Its status task, branch and title, as one line (what named the card). */
  readonly text: string;
  readonly auditor: boolean;
}

export interface BranchEvidence {
  readonly repo: string; readonly branch: string;
  /** Commits since the branch was created (its reflog's first entry), or outside every release ref. */
  readonly own_commits: number;
  /** Its tip's commit time when it has its own commits. */
  readonly last_commit_at: number | null;
  /** The release branch or tag its tip is in, or null. */
  readonly merged_into: string | null;
}

export interface CardEvidence {
  readonly agents: readonly LiveAgent[];
  /** null: no repository was scanned for this project, so commits are unknown (the stale rule never fires). */
  readonly branches: readonly BranchEvidence[] | null;
  /**
   * false: a scan failed, timed out or hit a cap, so a branch may be missing (fix round 2, Codex MED 7): no stale
   * decision and no "merged, nothing newer unmerged" done decision rest on it. Absent: complete.
   */
  readonly branchesComplete?: boolean;
  /** The card's Linear issue as the integration last read it, or null. */
  readonly linear: { readonly key: string; readonly state: string; readonly state_type: string } | null;
  readonly timeline: readonly TimelineEntry[];
}

export interface StewardInput {
  readonly now: number;
  readonly prefix: string;
  readonly steward: StewardSetting;
  readonly boards: ReadonlyArray<{ readonly id: string; readonly columns: readonly Column[] }>;
  readonly cards: readonly StewardCard[];
  readonly evidence: ReadonlyMap<string, CardEvidence>;
  readonly staleHours: number;
  /** The team's owners (their agents' text counts as evidence on any card). */
  readonly owners: readonly string[];
  /** The project's automations.agents_can_close: off = a done move on text evidence alone is left to a person. */
  readonly agentsCanClose: boolean;
  readonly maxMoves?: number;
}

export type StewardRule = "done" | "review" | "doing" | "stale" | "duplicate";

export interface StewardMove {
  readonly card: string; readonly key: string; readonly ref: string; readonly title: string;
  readonly rule: StewardRule;
  readonly from: string;
  /** The column it moves to (absent: it stays: blocked in place, or only commented, e.g. a duplicate flag). */
  readonly to?: string;
  readonly blocked_reason?: string;
  /** A done move whose only evidence is a comment: re-checked against agents_can_close right before it is written. */
  readonly text_only?: true;
  /** The card a duplicate is linked to. */
  readonly duplicate_of?: string;
  readonly evidence: readonly string[];
  /** Handles mentioned in the comment (the owner, when the steward asks them to look). */
  readonly ping: readonly string[];
  readonly comment: string;
}

export interface StewardSkip { readonly card: string; readonly key: string; readonly reason: string }

export interface StewardPlan {
  readonly steward: StewardSetting;
  readonly moves: readonly StewardMove[];
  /** Conflicting evidence: left for the fleet agent (or a person). */
  readonly ambiguous: readonly StewardSkip[];
  /** Cards with evidence the steward left alone (pinned by a person, a recent agent move, agents_can_close off). */
  readonly held: readonly StewardSkip[];
  /** Moves beyond the per-run cap, made on a later run. */
  readonly deferred: number;
}

// ---- columns ------------------------------------------------------------------------------------------------------

export function roleOf(cols: readonly Column[], id: string): ColumnRole {
  return cols.find((c) => c.id === id)?.role ?? "todo";
}
export function firstOf(cols: readonly Column[], role: ColumnRole): Column | null {
  return cols.find((c) => c.role === role) ?? null;
}
export function colName(cols: readonly Column[], id: string): string {
  return cols.find((c) => c.id === id)?.name ?? id;
}

// ---- whose word counts --------------------------------------------------------------------------------------------

function addressParts(a: string): { handle: string; agent: string | null } {
  const [h, , agent] = a.replace(/^@/, "").split("/");
  return { handle: h ?? "", agent: agent ?? null };
}

/**
 * Whether text an author wrote (a comment, an agent's status) counts as evidence about this card (fix round 2, Opus
 * HIGH 2: a member's agent must not close or move someone else's card by saying so): a person; an owner's agent; the
 * card's assignee (a person assignee: any of that person's agents; an agent assignee: that agent); the card's creator.
 * Git merges and Linear state are not text and count whoever the card belongs to.
 */
export function trustedAuthor(author: { handle: string; agent?: string | null }, card: StewardCard, owners: readonly string[]): boolean {
  const agent = author.agent ?? null;
  if (agent === STEWARD_AGENT) return false;
  if (agent === null || owners.includes(author.handle)) return true;
  if (card.assignee) {
    const a = addressParts(card.assignee);
    if (a.handle === author.handle && (a.agent === null || a.agent === agent)) return true;
  }
  return card.created_by.handle === author.handle && (card.created_by.agent ?? null) === agent;
}

// ---- a card's history ---------------------------------------------------------------------------------------------

const MOVE_FIELDS = ["column", "board", "pos"];
function isMove(e: TimelineEntry): boolean {
  return e.kind === "op" && !e.ignored && !!e.changes && MOVE_FIELDS.some((f) => f in (e.changes as object));
}
function isRestore(e: TimelineEntry): boolean {
  return e.kind === "op" && !e.ignored && !e.author.agent && (e.changes as { state?: unknown } | undefined)?.state === "open";
}

export interface History {
  /** The latest applied move op. */
  readonly last: TimelineEntry | null;
  readonly inColumnSince: number;
  /** The latest comment whose author's word counts on this card (trustedAuthor). */
  readonly lastComment: TimelineEntry | null;
  readonly lastActivity: number;
  /** A person's move is the latest one and it came after a steward move: the person overrode the steward. */
  readonly overridden: boolean;
  /** A person restored the card (from archived): the steward never flags it as a duplicate again. */
  readonly restoredByPerson: boolean;
  /** Steward comments (it links a duplicate once). */
  readonly stewardNotes: readonly string[];
  /**
   * The card's current title was written by a person or an owner's agent (its create, or the latest op that set it),
   * so the associations read from it (its Linear key, its lane code naming branches) are trusted (fix round 2, Codex
   * HIGH 1: anyone's agent can edit a card's title, and must not point it at a Done issue or a merged branch).
   */
  readonly titleTrusted: boolean;
}

function titleWriterTrusted(sorted: readonly TimelineEntry[], card: StewardCard, owners: readonly string[]): boolean {
  const writes = sorted.filter((e) => (e.kind === "create" || e.kind === "op") && !e.ignored && (e.changes as { title?: unknown } | undefined)?.title !== undefined);
  const w = writes[writes.length - 1];
  const author = w?.author ?? card.created_by;
  return !author.agent || owners.includes(author.handle);
}

export function history(tl: readonly TimelineEntry[], card: StewardCard, owners: readonly string[]): History {
  const sorted = [...tl].sort((a, b) => a.ts - b.ts);
  const moves = sorted.filter(isMove);
  const last = moves[moves.length - 1] ?? null;
  const comments = sorted.filter((e) => e.kind === "comment" && typeof e.text === "string" && trustedAuthor(e.author, card, owners));
  return {
    last, inColumnSince: last?.ts ?? card.created_at, lastComment: comments[comments.length - 1] ?? null,
    lastActivity: Math.max(card.created_at, ...sorted.map((e) => e.ts)),
    overridden: !!last && !last.author.agent && moves.some((m) => m.author.agent === STEWARD_AGENT),
    restoredByPerson: sorted.some(isRestore),
    stewardNotes: sorted.filter((e) => e.kind === "comment" && e.author.agent === STEWARD_AGENT).map((e) => e.text ?? ""),
    titleTrusted: titleWriterTrusted(sorted, card, owners),
  };
}

/** Why the steward leaves a card alone now, whoever moved it last: null = it may act. */
export function holdReason(h: History, now: number): string | null {
  const last = h.last;
  if (!last) return null;
  if (h.overridden) return `a person moved it after the steward did (${hoursAgo(now, last.ts)}); the steward leaves it`;
  if (!last.author.agent && now - last.ts < PIN_MS) return `pinned: @${last.author.handle} moved it ${hoursAgo(now, last.ts)}`;
  if (last.author.agent === STEWARD_AGENT && now - last.ts < STEWARD_COOLDOWN_MS) return `the steward moved it ${hoursAgo(now, last.ts)}`;
  if (last.author.agent && last.author.agent !== STEWARD_AGENT && now - last.ts < AGENT_GRACE_MS) return `agent ${last.author.agent} moved it ${hoursAgo(now, last.ts)}`;
  return null;
}

// ---- text ---------------------------------------------------------------------------------------------------------

export function ownerHandle(card: StewardCard): string {
  return card.assignee ? addressParts(card.assignee).handle || card.created_by.handle : card.created_by.handle;
}

export function hoursAgo(now: number, ts: number): string {
  if (now - ts < 3_600_000) return "under an hour ago";
  return `${Math.round((now - ts) / 3_600_000)} h ago`;
}

export function commentText(card: StewardCard, what: string, evidence: readonly string[], ping: readonly string[]): string {
  return [
    `Board steward: ${what}.`,
    `Evidence: ${evidence.join("; ")}.`,
    ...(ping.length ? [`${ping.map((h) => `@${h}`).join(" ")}: please check ${card.key}.`] : []),
    "A person's move overrides this and pins the card for 24 h.",
  ].join("\n");
}
