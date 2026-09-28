// WALKIE-PROJECTS-1 (ALE-5291): Projects with native kanban boards. Wire contract and views.
//
// No new event kind (a daemon that doesn't know one would stall its replication): a board op is an ordinary
// `msg.post` in the project's channel whose body carries `board` (below) next to the human-readable `text`. Old
// daemons accept and show such posts as channel messages; this version folds them into boards (fold.ts).
//
//   project = channel `p-<8 hex>` + a root post {board: {op: "project", …}}; settings changes reply in its thread
//   board   = a root post {board: {op: "board", …}} in the project's channel; changes reply in its thread
//   card    = a root post {board: {op: "card", board: <board root id>, …}}; changes reply in its thread;
//             a reply WITHOUT `board` in a card's thread is a comment
import { z } from "zod";
import { Address, BlobHash, EventId, type Author } from "../schemas.ts";

/** The reserved channel prefix of projects; the rest is 8 random hex characters (opaque: names reach every member). */
export const PROJECT_CHANNEL_PREFIX = "p-";
export const PROJECT_CHANNEL_RE = /^p-[0-9a-f]{8}$/;
export function isProjectChannel(name: string | null | undefined): boolean {
  return !!name && PROJECT_CHANNEL_RE.test(name);
}

/** A rev beyond this is refused by the schema; the fold clamps every rev anyway (fold.ts "effective rev"). */
export const MAX_REV = 1_000_000_000;

// ---- bounds (soft, enforced where this node creates things; the fold accepts what valid peers sent) ----------------
export const MAX_PROJECTS = 200;
export const MAX_LIVE_CARDS_PER_BOARD = 2_000;
export const MAX_CARDS_PER_PROJECT = 20_000;
export const MAX_COLUMNS = 12;
export const MAX_PATHS = 20;
export const MAX_LABELS = 10;
/** Boards included per project (Alex 2026-09-26); each board beyond them is a paid add-on (license `extra_boards`). */
export const BOARDS_INCLUDED = 3;
/** Projects on the Free plan (Alex 2026-09-26); paid plans and the trial: unlimited (up to MAX_PROJECTS). */
export const FREE_PROJECTS = 1;
/** Fractional position keys: base-36 digits, never ending in "0" (position.ts). */
export const POS_RE = /^[0-9a-z]{0,127}[1-9a-z]$/;

export const ColumnRole = z.enum(["backlog", "todo", "active", "review", "done", "cancelled"]);
export type ColumnRole = z.infer<typeof ColumnRole>;
export const ColumnId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/);
export const Column = z.object({
  id: ColumnId,
  name: z.string().min(1).max(40),
  role: ColumnRole,
  /** Work-in-progress limit: shown, never enforced against a teammate's op. */
  wip: z.number().int().min(1).max(999).optional(),
});
export type Column = z.infer<typeof Column>;
const Columns = z.array(Column).min(1).max(MAX_COLUMNS)
  .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, { message: "column ids must be unique" });

/** Where a project's work happens: a path prefix of an agent's working directory, or a repository name. */
export const PathRule = z.union([
  z.object({ path: z.string().min(1).max(300) }).strict(),
  z.object({ repo: z.string().min(1).max(120) }).strict(),
]);
export type PathRule = z.infer<typeof PathRule>;

export const Automations = z.object({
  /** An agent's `gh pr create` moves its card to the first review column. */
  pr_opened: z.boolean().optional(),
  /** An agent's `gh pr merge` moves its card to the first done column (only with agents_can_close). */
  pr_merged: z.boolean().optional(),
  /** Agents may move cards into done columns (default true); people always may. */
  agents_can_close: z.boolean().optional(),
}).strict();
export type Automations = z.infer<typeof Automations>;

export const Prefix = z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/);
const Line = (max: number) => z.string().min(1).max(max);
const Label = z.string().min(1).max(32).regex(/^[^\n\r\t]+$/);
const DueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const Base = {
  v: z.literal(1),
  /** Informational: the author's rank + 1. The fold ranks ops by `after`, never by this number. */
  rev: z.number().int().min(0).max(MAX_REV),
  /** The op's causal parent: "<event id>#<first 16 hex of sha256(its signature)>" (fold.ts "Convergence"). */
  after: z.string().regex(/^[0-9a-f]{16}:[1-9][0-9]*#[0-9a-f]{16}$/).optional(),
};

export const ProjectOp = z.object({
  ...Base, op: z.literal("project"),
  name: Line(60).optional(),
  folder: z.string().max(40).optional(),
  description: z.string().max(2_000).optional(),
  prefix: Prefix.optional(),
  paths: z.array(PathRule).max(MAX_PATHS).optional(),
  meter: z.enum(["count", "points"]).optional(),
  automations: Automations.optional(),
  state: z.enum(["active", "archived", "deleted"]).optional(),
});
export const BoardOp = z.object({
  ...Base, op: z.literal("board"),
  name: Line(40).optional(),
  columns: Columns.optional(),
  state: z.enum(["active", "archived"]).optional(),
});
export const CardOp = z.object({
  ...Base, op: z.literal("card"),
  board: EventId.optional(),
  title: Line(200).optional(),
  body: z.string().max(16_000).optional(),
  column: ColumnId.optional(),
  pos: z.string().regex(POS_RE).optional(),
  assignee: Address.nullable().optional(),
  reviewer: Address.nullable().optional(),
  labels: z.array(Label).max(MAX_LABELS).optional(),
  estimate: z.number().int().min(0).max(1_000).nullable().optional(),
  due: DueDate.nullable().optional(),
  blocked: z.boolean().optional(),
  blocked_reason: z.string().max(300).nullable().optional(),
  state: z.enum(["open", "archived", "deleted"]).optional(),
  /** The key number the creator proposes (root only); collisions: the earliest create keeps it (fold.ts). */
  n: z.number().int().min(1).max(1_000_000).optional(),
});
/**
 * A Data Room file op (DATA-ROOM-1): the root adds a file (name + its first version), replies in the root's thread add
 * versions (`hash`, `size`, `mime` and `share` together: the accepted `artifact.share` of the bytes in this channel),
 * rename, pin, remove / restore, and attach / detach cards (room.ts has the fold and its rules).
 */
/** A file's type: printable ASCII, no leading space (it is served back in a header). */
export const MIME_RE = /^[\x21-\x7e][\x20-\x7e]{0,99}$/;
export const FileName = z.string().min(1).max(200).regex(/^[^\/\\\u0000-\u001f\u007f]+$/).refine((s) => s !== "." && s !== ".." && s.trim() === s, { message: "not a file name" });
export const FileOp = z.object({
  ...Base, op: z.literal("file"),
  name: FileName.optional(),
  hash: BlobHash.optional(),
  size: z.number().int().min(1).max(25 * 1024 * 1024).optional(),
  mime: z.string().max(100).regex(MIME_RE).optional(),
  /** The artifact.share event carrying these bytes in this channel. */
  share: EventId.optional(),
  pin: z.boolean().optional(),
  state: z.enum(["active", "removed"]).optional(),
  attach: z.array(EventId).min(1).max(20).optional(),
  detach: z.array(EventId).min(1).max(20).optional(),
});
export const BoardOpSchema = z.discriminatedUnion("op", [ProjectOp, BoardOp, CardOp, FileOp]);

/**
 * The largest post body (text + board op, as serialised JSON) that counts as a board op (round-6 audit, Opus M3): a
 * larger one is an ordinary post (the fold ignores it; the general hidden cap bounds it).
 */
export const MAX_BOARD_OP_BYTES = 16_384;
const enc = new TextEncoder();

/**
 * Whether an event is a board op: a `msg.post` in a project-shaped channel whose body is at most MAX_BOARD_OP_BYTES and
 * carries a schema-valid `board`. A pure function of the event (the same on every replica, whatever it has received):
 * it decides which hidden-row bound applies (PROTOCOL §10) and which posts the fold reads.
 */
export function isBoardOp(ev: { kind: string; channel?: string | null; body: unknown }): boolean {
  if (ev.kind !== "msg.post" || !isProjectChannel(ev.channel)) return false;
  const board = (ev.body as { board?: unknown } | null)?.board;
  return board !== undefined && boardBodyFits(ev.body) && BoardOpSchema.safeParse(board).success;
}
export function boardBodyFits(body: unknown): boolean {
  return enc.encode(JSON.stringify(body)).length <= MAX_BOARD_OP_BYTES;
}
export type ProjectOpT = z.infer<typeof ProjectOp>;
export type BoardOpT = z.infer<typeof BoardOp>;
export type CardOpT = z.infer<typeof CardOp>;
export type AnyOp = z.infer<typeof BoardOpSchema>;
export type FileOpT = z.infer<typeof FileOp>;

/** Fields a card op may set, in the order the timeline lists them. */
export const CARD_FIELDS = [
  "title", "body", "board", "column", "pos", "assignee", "reviewer", "labels", "estimate", "due", "blocked", "blocked_reason", "state",
] as const;
export const PROJECT_FIELDS = ["name", "folder", "description", "prefix", "paths", "meter", "automations", "state"] as const;
export const BOARD_FIELDS = ["name", "columns", "state"] as const;

export const DEFAULT_COLUMNS: readonly Column[] = [
  { id: "backlog", name: "Backlog", role: "backlog" },
  { id: "todo", name: "To do", role: "todo" },
  { id: "doing", name: "In progress", role: "active", wip: 5 },
  { id: "review", name: "In review", role: "review" },
  { id: "done", name: "Done", role: "done" },
];

// ---- views (local API / SSE / dashboard) -------------------------------------------------------------------------

export interface Meter {
  /** "count": cards; "points": estimates (a card without one counts 1). */
  mode: "count" | "points";
  /** Cards (or points) in done-role columns. */
  done: number;
  /** Live and archived cards (or points) outside cancelled-role columns: the meter's denominator. */
  counted: number;
  /** Per column role, for the stacked bar. */
  by_role: Record<ColumnRole, number>;
}

export interface BoardView {
  id: string; name: string; columns: Column[]; state: "active" | "archived";
  created_at: number; created_by: Author;
  meter: Meter;
  /** Live (open) cards on the board. */
  live_cards: number;
}

export interface ProjectView {
  channel: string;
  /** The project's root post. */
  id: string;
  name: string; folder: string; description: string; prefix: string;
  /** Prefixes the project had before (its old keys are still masked in statuses when it is private). */
  prior_prefixes?: string[];
  paths: PathRule[]; meter_mode: "count" | "points"; automations: Required<Automations>;
  state: "active" | "archived" | "deleted";
  /** Restricted channel: the team's owners only (Alex 2026-09-26). */
  private: boolean;
  /** Owners and the creator: who may change settings. */
  admins: string[];
  creator: string;
  created_at: number;
  boards: BoardView[];
  /** Sum over the active boards (counts summed, never an average of percentages). */
  meter: Meter;
  cards: number;
  last_activity: number;
  /** The project's Data Room at a glance (DATA-ROOM-1): live files, pinned ones, bytes of their current versions. */
  room?: { files: number; pinned: number; bytes: number };
}

/** A private project the local member can't see: the channel exists (the roster says so), nothing else does. */
export interface ProjectStub { channel: string; private: true; stub: true; members: string[] }

export interface CardView {
  id: string; channel: string; board: string;
  /** "<PREFIX>-<n>": a human label that can change (concurrent or offline creation); `id` never does. */
  key: string; n: number;
  /** 8 hex that never change (short.ts shortId); `ref` = current key + short, what tools, branches and PRs carry. */
  short: string; ref: string;
  title: string; body: string;
  column: string; pos: string;
  assignee: string | null; reviewer: string | null;
  labels: string[]; estimate: number | null; due: string | null;
  blocked: boolean; blocked_reason: string | null;
  state: "open" | "archived" | "deleted";
  created_at: number; created_by: Author;
  updated_at: number; updated_by: Author;
  comments: number;
  /** Highest effective rev among its ops (the next op writes this + 1). */
  rev: number;
}

/** One entry of a card's (or a project's) signed history. */
export interface TimelineEntry {
  id: string; ts: number; author: Author;
  kind: "create" | "op" | "comment";
  /** The fields this op set, as signed. */
  changes?: Record<string, unknown>;
  /** Why the fold ignored this op (it stays in the signed log). */
  ignored?: string;
  /** A comment's text. */
  text?: string;
  /** Rev as signed and as the fold used it. */
  rev?: number; effective_rev?: number;
}

export interface CardDetail { card: CardView; project: ProjectView; timeline: TimelineEntry[] }

/** GET /v1/projects. */
export interface ProjectsPayload { projects: ProjectView[]; stubs: ProjectStub[] }

/** SSE `board` message: what changed in one project (cards changed, cards gone, the project itself). */
export interface BoardDelta {
  channel: string; project?: ProjectView | null; cards?: CardView[]; removed?: string[];
  /** Too much changed to list (a full re-fold): refetch the project. */
  reset?: boolean;
  /** The project's Data Room changed (DATA-ROOM-1): refetch the room. Older dashboards ignore it. */
  room?: boolean;
}

// ---- Data Room views (DATA-ROOM-1; the fold is room.ts) ----------------------------------------------------------

export interface RoomVersion {
  /** 1-based, in fold order (the root is 1). */
  v: number;
  /** The room op that added it. */
  id: string;
  hash: string; size: number; mime: string;
  /** The artifact.share carrying the bytes in this channel. */
  share: string;
  /** The file's name when this version was added. */
  name: string;
  ts: number; by: Author;
  /** Whether the share is an accepted artifact.share of this hash in this channel (the daemon fills it in). */
  available?: boolean;
  /** Set while the file is pinned on an agent's version no person pin descends from: kept, but not the pinned document. */
  ignored?: "person_pinned";
}

/** A file as the API lists it: its current version inline. */
export interface RoomFileView {
  id: string; channel: string; name: string; pinned: boolean; state: "active" | "removed";
  hash: string; size: number; mime: string;
  /** Current version number and how many versions there are. */
  version: number; versions: number;
  /** Who added the current version, and when. */
  updated_at: number; updated_by: Author;
  created_at: number; created_by: Author;
  /** Attached cards of this project (ids). */
  cards: string[];
  /** The current version's bytes can be served (its share is accepted here). */
  available: boolean;
  /** Head the next op names as its parent (informational for clients; the daemon re-reads it). */
  rev: number;
}

export interface RoomFileDetail { file: RoomFileView; versions: RoomVersion[]; timeline: TimelineEntry[] }

/** A pinned document or an attached file for an agent's context (GET /v1/tasks/:ref/context). */
export interface ContextFile {
  id: string; name: string; size: number; mime: string; version: number; hash: string; pinned: boolean;
  by: Author;
  /** Text inlined for the model (redacted copy, capped); absent for binary or too-large files, or bytes not here. */
  text?: string;
  truncated?: boolean;
  /** Why the text isn't inline. */
  omitted?: "binary" | "unavailable" | "budget" | "large";
}
export interface TaskContext {
  card: { id: string; ref: string; key: string; channel: string; title: string };
  project: { channel: string; name: string; prefix: string };
  pinned: ContextFile[];
  files: ContextFile[];
}

