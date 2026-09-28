// FO-6 board steward: duplicate cards. Pure.
//
// Open cards ON THE SAME BOARD, outside done and cancelled columns, that share a title or a Linear key are duplicates.
// The steward never archives one (fix round 3, Opus r2 MED: flag-only in every case; round 2: text alone must never
// archive anything). It FLAGS them: a comment on both cards (once) naming the other and how to archive, and an entry
// in its report. Archiving is a person's action (`walkie task archive <KEY>`, or the dashboard). The same holds as
// every other rule apply (steward-core.ts holdReason: a person's 24 h pin, a person undoing the steward, another
// agent's hour); a card a person restored, or one with a live agent, is left alone.
import type { Column } from "./schema.ts";
import { linearKeyOf } from "./steward-match.ts";
import {
  commentText, history, holdReason, hoursAgo, roleOf, type StewardCard, type StewardInput, type StewardMove, type StewardSkip,
} from "./steward-core.ts";

function normTitle(t: string): string {
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface Duplicates { moves: StewardMove[]; ambiguous: StewardSkip[]; held: StewardSkip[] }

export function duplicates(input: StewardInput, columnsOf: (c: StewardCard) => readonly Column[]): Duplicates {
  const groups = new Map<string, StewardCard[]>();
  for (const c of input.cards) {
    const role = roleOf(columnsOf(c), c.column);
    if (c.state !== "open" || role === "done" || role === "cancelled") continue;
    const lk = linearKeyOf(c.title);
    for (const k of [`t:${normTitle(c.title)}`, ...(lk ? [`l:${lk}`] : [])]) {
      const key = `${c.board}|${k}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
  }
  const out: Duplicates = { moves: [], ambiguous: [], held: [] };
  const seen = new Set<string>();
  for (const [k, cards] of groups) {
    if (cards.length < 2) continue;
    const sorted = [...cards].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
    const keep = sorted[0] as StewardCard;
    for (const dup of sorted.slice(1)) {
      if (seen.has(dup.id)) continue;
      seen.add(dup.id);
      const h = history(input.evidence.get(dup.id)?.timeline ?? [], dup, input.owners);
      if (h.stewardNotes.some((t) => t.includes(keep.ref))) continue; // flagged already
      if (input.evidence.get(dup.id)?.agents.length) { out.ambiguous.push({ card: dup.id, key: dup.key, reason: `duplicate of ${keep.key} but an agent is working on it` }); continue; }
      if (h.restoredByPerson) { out.held.push({ card: dup.id, key: dup.key, reason: `duplicate of ${keep.key}, but a person restored it` }); continue; }
      const hold = holdReason(h, input.now);
      if (hold) { out.held.push({ card: dup.id, key: dup.key, reason: `duplicate of ${keep.key}; ${hold}` }); continue; }
      const same = k.includes("|l:") ? `the same Linear issue ${k.slice(k.indexOf("|l:") + 3)}` : "the same title";
      const evidence = [
        `${dup.key} and ${keep.key} are on the same board and have ${same}`,
        `${keep.key} is older (created ${hoursAgo(input.now, keep.created_at)})`,
        `flagged, not archived: a person archives one (walkie task archive ${dup.key})`,
      ];
      const ping = [...new Set([dup.created_by.handle, keep.created_by.handle])];
      out.moves.push({
        card: dup.id, key: dup.key, ref: dup.ref, title: dup.title, rule: "duplicate", from: dup.column, duplicate_of: keep.ref,
        evidence, ping, comment: commentText(dup, `${dup.key} looks like a duplicate of ${keep.ref}`, evidence, ping),
      });
    }
  }
  return out;
}
