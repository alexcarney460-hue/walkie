// Sync decisions (pure, LINEAR-IMPORT-1): for one imported card, what Linear says now, what the card says now and what
// the last sync recorded ("snap") decide, field by field, which side moves. Latest change wins a conflict (Linear's
// issue `updatedAt` against the card's `updated_at`), and the loser gets a note. Only the card's place (its column's
// role, archived non-done = canceled) is ever written back to Linear, and only in two-way mode.
import type { ColumnRole } from "../../protocol/projects/schema.ts";

export interface Fields {
  title: string;
  /** Column role; a Walkie card archived outside a done column counts as "cancelled" (how the team skips work). */
  place: ColumnRole;
  labels: string[];
  estimate: number | null;
  due: string | null;
  /** "@handle" or null. */
  assignee: string | null;
}
export const FIELD_NAMES = ["title", "place", "labels", "estimate", "due", "assignee"] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

export interface Snap { l: Fields; w: Fields }

export interface Conflict { field: FieldName; linear: string; walkie: string; winner: "linear" | "walkie" }

export interface Decision {
  /** Fields to write on the card (Linear's values). */
  toWalkie: Partial<Fields>;
  /** The place to write back to Linear (two-way only). */
  toLinear: ColumnRole | null;
  conflicts: Conflict[];
  /** The snap to record once the writes succeeded. */
  next: Snap;
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
  return a === b;
}
const show = (v: unknown): string => (Array.isArray(v) ? v.join(", ") || "none" : v === null || v === undefined ? "none" : String(v));

/**
 * `linearAt` = the issue's updatedAt (ms), `walkieAt` = the card's updated_at (ms): record timestamps, not field clocks.
 * First adoption is read-only toward Linear: reconcile from Linear, retaining the person's existing card title.
 */
export function decide(o: { snap: Snap | null; linear: Fields; linearAt: number; walkie: Fields; walkieAt: number; twoWay: boolean }): Decision {
  const toWalkie: Partial<Fields> = {};
  let toLinear: ColumnRole | null = null;
  const conflicts: Conflict[] = [];
  if (!o.snap) {
    for (const f of FIELD_NAMES) {
      if (f !== "title" && !same(o.linear[f], o.walkie[f])) (toWalkie as Record<string, unknown>)[f] = o.linear[f];
    }
    return { toWalkie, toLinear: null, conflicts, next: { l: { ...o.linear }, w: { ...o.linear, title: o.walkie.title } } };
  }
  const nl = { ...o.linear } as Record<FieldName, unknown>;
  const nw = { ...o.walkie } as Record<FieldName, unknown>;
  const linearWins = o.linearAt >= o.walkieAt;
  for (const f of FIELD_NAMES) {
    const lv = o.linear[f];
    const wv = o.walkie[f];
    if (same(lv, wv)) continue;
    const lc = o.snap ? !same(lv, o.snap.l[f]) : true;
    const wc = o.snap ? !same(wv, o.snap.w[f]) : true;
    const writeWalkie = () => { (toWalkie as Record<string, unknown>)[f] = lv; nw[f] = lv; };
    const writeLinear = () => { if (f === "place" && o.twoWay) { toLinear = wv as ColumnRole; nl[f] = wv; } else if (o.snap) nw[f] = o.snap.w[f]; };
    if (lc && !wc) { writeWalkie(); continue; }
    if (!lc && wc) { writeLinear(); continue; }
    if (!lc && !wc) continue; // unreachable: same snap values would make lv == wv
    const winner = linearWins ? "linear" : "walkie";
    conflicts.push({ field: f, linear: show(lv), walkie: show(wv), winner });
    if (winner === "linear") writeWalkie();
    else if (f === "place" && o.twoWay) writeLinear();
    // one-way and Walkie won: the card keeps its value; the snap records it as agreed so it isn't noted again
  }
  return { toWalkie, toLinear, conflicts, next: { l: nl as unknown as Fields, w: nw as unknown as Fields } };
}

/** The note a conflict leaves on the card. */
export function conflictNote(key: string, conflicts: readonly Conflict[], at: { linear: number; walkie: number }): string {
  const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
  return `Linear sync: ${key} changed on both sides (Linear ${when(at.linear)} UTC, Walkie ${when(at.walkie)} UTC); the latest change wins.\n` +
    conflicts.map((c) => `- ${c.field}: Linear "${c.linear}", Walkie "${c.walkie}" → kept ${c.winner === "linear" ? "Linear's" : "Walkie's"}`).join("\n");
}
