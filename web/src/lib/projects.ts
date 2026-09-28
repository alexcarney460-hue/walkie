// Pure helpers for the Projects views (WALKIE-PROJECTS-1): columns with filters, agent presence, positions for a drop,
// keyboard movement. No React, no fetch: unit-tested in web/test/projects.test.tsx.
import type { AgentView, BoardView, CardView, Column, ProjectView } from "../api/types.ts";
import { associate } from "../../../src/protocol/projects/assoc.ts";

export interface Filters { q: string; assignee: string; label: string; mine: boolean }
export const NO_FILTERS: Filters = { q: "", assignee: "", label: "", mine: false };

/** Whether an address is this person (any of their machines or agents). */
export function isMe(addr: string | null, handle: string | null): boolean {
  return !!addr && !!handle && (addr === `@${handle}` || addr.startsWith(`@${handle}/`));
}

export function matches(card: CardView, f: Filters, me: string | null): boolean {
  if (f.mine && !isMe(card.assignee, me)) return false;
  if (f.assignee === "none" ? card.assignee !== null : f.assignee && card.assignee !== f.assignee) return false;
  if (f.label && !card.labels.includes(f.label)) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!`${card.key} ${card.title} ${card.labels.join(" ")} ${card.assignee ?? ""}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

export function byPos(a: CardView, b: CardView): number {
  return a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.n - b.n;
}

/** The board's open cards per column, in position order, filtered. */
export function columnsOf(board: BoardView, cards: readonly CardView[], f: Filters, me: string | null): Array<{ column: Column; cards: CardView[]; total: number }> {
  const mine = cards.filter((c) => c.board === board.id && c.state === "open");
  return board.columns.map((column) => {
    const all = mine.filter((c) => c.column === column.id).sort(byPos);
    return { column, cards: all.filter((c) => matches(c, f, me)), total: all.length };
  });
}

/** Where a card dropped at `index` of a column lands: the card it goes before, or after (ids), excluding itself. */
export function dropTarget(columnCards: readonly CardView[], index: number, self: string): { before?: string; after?: string } {
  const rest = columnCards.filter((c) => c.id !== self);
  const at = Math.max(0, Math.min(index, rest.length));
  const next = rest[at];
  if (next) return { before: next.id };
  const prev = rest[rest.length - 1];
  return prev ? { after: prev.id } : {};
}

/** Agents working on each card (by key) and on each project (by channel), from their statuses. */
export function presence(agents: readonly AgentView[], projects: readonly ProjectView[], hasCard: (channel: string, n: number) => boolean): {
  byCard: Map<string, AgentView[]>; byProject: Map<string, AgentView[]>;
} {
  const byCard = new Map<string, AgentView[]>();
  const byProject = new Map<string, AgentView[]>();
  for (const a of agents) {
    if (a.effective_state === "offline" || a.archived) continue;
    const hit = associate(a.status, projects, hasCard);
    if (!hit) continue;
    byProject.set(hit.channel, [...(byProject.get(hit.channel) ?? []), a]);
    if (hit.key) byCard.set(hit.key, [...(byCard.get(hit.key) ?? []), a]);
  }
  return { byCard, byProject };
}

/** Stuck: the card is marked blocked, or an agent on it is stuck (blocked) or waiting on a person. */
export function stuck(card: CardView, agentsOnIt: readonly AgentView[] | undefined): boolean {
  return card.blocked || !!agentsOnIt?.some((a) => a.effective_state === "blocked" || a.effective_state === "waiting");
}

/** Keyboard focus on the board: column index and card index. */
export interface Focus { col: number; row: number }

/** j/k move within a column, h/l across columns (clamped to what exists). */
export function moveFocus(f: Focus, key: "j" | "k" | "h" | "l", sizes: readonly number[]): Focus {
  if (!sizes.length) return { col: 0, row: 0 };
  let col = Math.max(0, Math.min(f.col, sizes.length - 1));
  let row = f.row;
  if (key === "h") col = Math.max(0, col - 1);
  if (key === "l") col = Math.min(sizes.length - 1, col + 1);
  if (key === "j") row += 1;
  if (key === "k") row -= 1;
  const n = sizes[col] ?? 0;
  return { col, row: n ? Math.max(0, Math.min(row, n - 1)) : 0 };
}

export function pct(done: number, counted: number): number {
  return counted ? Math.round((done / counted) * 100) : 0;
}

/** Projects grouped by folder (folders A–Z, "" last), projects by name. */
export function byFolder(projects: readonly ProjectView[]): Array<{ folder: string; projects: ProjectView[] }> {
  const folders = [...new Set(projects.map((p) => p.folder))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  return folders.map((folder) => ({ folder, projects: projects.filter((p) => p.folder === folder).sort((a, b) => a.name.localeCompare(b.name)) }));
}

/** Everyone a card could be assigned to: members, and the live agents (by address). */
export function assignees(members: ReadonlyArray<{ handle: string }>, agents: readonly AgentView[]): string[] {
  const people = members.map((m) => `@${m.handle}`);
  const bots = agents.filter((a) => !a.archived).map((a) => `@${a.handle}/${a.hostname}/${a.agent}`);
  return [...new Set([...people, ...bots])];
}
