// Board ops batch (LINEAR-IMPORT-1): the request of `POST /v1/projects/:channel/batch`, many card writes signed in one
// store transaction as ordinary board ops (PROTOCOL §10 "Bulk writes"). Nothing here is a new wire format between
// daemons: each op becomes the same card root / card op / comment post a person makes by hand, so the fold and
// validity are unchanged and every build that folds boards shows the result.
//
// `ext` (on a card root or a project root) names where the entity came from (`{src: "linear", id, key}`). The fold
// ignores it (zod strips unknown keys; CardOp / ProjectOp are not strict), validity ignores it, and no replica's
// decision depends on it: only the importing person's daemon reads it back, to find what it imported before.
import { z } from "zod";
import { Address, EventId } from "../schemas.ts";
import { MAX_LABELS } from "./schema.ts";

/** Ops per batch request (each is one signed post). */
export const MAX_BATCH_OPS = 250;

export const Ext = z.object({
  src: z.literal("linear"),
  /** The source's own id (a Linear issue or project UUID). */
  id: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/),
  /** Its human key (a Linear identifier such as ALE-12). */
  key: z.string().max(40).regex(/^[A-Za-z0-9-]*$/).optional(),
}).strict();
export type Ext = z.infer<typeof Ext>;

/** The `ext` of a signed board op, when it is well formed (anything else is no ext at all). */
export function extOf(board: unknown): Ext | null {
  const raw = (board as { ext?: unknown } | null)?.ext;
  if (raw === undefined) return null;
  const r = Ext.safeParse(raw);
  return r.success ? r.data : null;
}

const Line = (max: number) => z.string().trim().min(1).max(max);
const Label = z.string().trim().min(1).max(32).regex(/^[^\n\r\t]+$/);
const Due = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Estimate = z.number().int().min(0).max(1_000);
/** A card of the project by root id, or one created earlier in the same batch: "#<its index>". */
export const BatchCardRef = z.union([EventId, z.string().regex(/^#\d{1,3}$/)]);

export const BatchCreate = z.object({
  op: z.literal("create"),
  board: EventId.optional(),
  title: Line(200),
  body: z.string().max(16_000).optional(),
  /** Column id, name or 1-based number on the card's board. */
  column: z.string().min(1).max(40),
  assignee: Address.nullable().optional(),
  labels: z.array(Label).max(MAX_LABELS).optional(),
  estimate: Estimate.nullable().optional(),
  due: Due.nullable().optional(),
  state: z.enum(["open", "archived"]).optional(),
  ext: Ext.optional(),
}).strict();

export const BatchUpdate = z.object({
  op: z.literal("update"),
  card: EventId,
  title: Line(200).optional(),
  body: z.string().max(16_000).optional(),
  column: z.string().min(1).max(40).optional(),
  assignee: Address.nullable().optional(),
  labels: z.array(Label).max(MAX_LABELS).optional(),
  estimate: Estimate.nullable().optional(),
  due: Due.nullable().optional(),
  state: z.enum(["open", "archived"]).optional(),
}).strict();

export const BatchComment = z.object({
  op: z.literal("comment"),
  card: BatchCardRef,
  text: z.string().min(1).max(16_000),
}).strict();

export const BatchOp = z.discriminatedUnion("op", [BatchCreate, BatchUpdate, BatchComment]);
export type BatchOpT = z.infer<typeof BatchOp>;
export const BatchReq = z.object({ ops: z.array(BatchOp).min(1).max(MAX_BATCH_OPS) }).strict();
export type BatchReqT = z.infer<typeof BatchReq>;

/** What a batch did, op by op (index = the op's index in the request). */
export interface BatchResult {
  created: Array<{ i: number; id: string; key: string }>;
  updated: Array<{ i: number; id: string; key: string }>;
  /** Updates that changed nothing (not signed). */
  unchanged: Array<{ i: number; id: string; key: string }>;
  comments: Array<{ i: number; id: string; card: string }>;
  /** Signed posts (= ops). */
  events: number;
}
