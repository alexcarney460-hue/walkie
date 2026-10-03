// PROJECT-PAGES-1, the pure parts of a project's status page: the facts people and agents set (a fold of `page` ops in the
// project root's thread, per-label last-writer-wins like every other board register), and the screens (Data Room files whose
// register says they are one) grouped, ordered and capped for the page. No I/O: the daemon reads the log and the room, the
// dashboard and the CLI share the types (status-page.ts). docs/plans/PROJECT-PAGES-1.md has the design.
import { order, refOf, type FoldEnv, type OpEvent } from "./fold.ts";
import { shownScreen, shownText } from "./page-text.ts";
import {
  MAX_FACTS, MAX_SCREEN_GROUPS, MAX_SCREENS, PageOp, SCREEN_IMAGE_TYPES, SCREEN_MAX_BYTES,
  type PageOpT, type RoomFileView, type ScreenMetaT,
} from "./schema.ts";
import type { ScreenGroupView, ScreensView, ScreenView, WhoView } from "./status-page.ts";

// ---- texts --------------------------------------------------------------------------------------------------------------

/** A label or value as it is stored: composed (NFC), one line, no runs of spaces. */
export function cleanFactText(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** What makes two labels the same fact: case, spacing and compatibility forms (fullwidth letters) aside. */
export function factKey(label: string): string {
  return label.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** What makes two screens the same screen: their group and title, compared as labels are. */
export function screenKey(group: string, title: string): string {
  return `${factKey(group)}\u0000${factKey(title)}`;
}

/** The readable text a page op carries (what an older daemon shows as a channel message). */
export function pageOpText(fact: { label: string; value: string | null }): string {
  return fact.value === null ? `Status page: "${fact.label}" removed` : `Status page: "${fact.label}" set to "${fact.value}"`;
}

// ---- facts --------------------------------------------------------------------------------------------------------------

export interface PageFact { label: string; value: string; by: WhoView; at: number }
export interface PageState {
  /** In the order each label was first set (a label set again keeps its place; one removed and set again goes last). */
  facts: PageFact[];
  /** Latest applied fact mutation, including removals; absent before the first mutation. */
  updated_at?: number;
  /** Ops that applied nothing, with why. */
  ignored: Array<{ id: string; reason: "not_member" | "fact_limit" | "waiting_for_parent" | "withheld" }>;
  /** The op the next one names as its parent (the project root's ref when there is none), and the rank it will have. */
  head: string;
  rev: number;
}

const whoOf = (a: { handle: string; agent?: string | undefined }): WhoView => ({ handle: a.handle, ...(a.agent ? { agent: a.agent } : {}) });

/**
 * The facts of a project's status page: the page ops in the thread of the project root `root`, applied in the board fold's
 * order (ranks from the parent chain, then origin and seq), each by a member or owner (a person or their agent; an observer,
 * a removed member and a stranger are `not_member`). A label is one register: a `value` sets it, `null` removes it; a label
 * not there yet needs a free place (`fact_limit` past MAX_FACTS); a fact the page would withhold (page-text.ts) is `withheld`
 * and takes none. Pure: any arrival order folds to the same page.
 */
export function foldPage(posts: readonly OpEvent[], root: OpEvent, env: Pick<FoldEnv, "roleOf">): PageState {
  const replies: Array<{ ev: OpEvent; op: PageOpT }> = [];
  for (const ev of posts) {
    if (ev.thread !== root.id) continue;
    const parsed = PageOp.safeParse(ev.board);
    if (parsed.success) replies.push({ ev, op: parsed.data });
  }
  const { applied, waiting } = order<PageOpT>({ ev: root, op: { v: 1, rev: 0, op: "page" } }, replies);
  const facts = new Map<string, PageFact>();
  const ignored: PageState["ignored"] = waiting.map((x) => ({ id: x.ev.id, reason: "waiting_for_parent" as const }));
  let head = refOf(root);
  let rev = 0;
  let updatedAt: number | undefined;
  for (const o of applied) {
    if (o.root) continue;
    const role = env.roleOf(o.ev);
    if (role !== "owner" && role !== "member") { ignored.push({ id: o.ev.id, reason: "not_member" }); continue; }
    const fact = o.op.fact;
    if (fact) {
      const key = factKey(fact.label);
      const before = facts.get(key);
      // A fact the page would not show (its label or value is a join code, or nothing readable is left once a link is taken out)
      // is not a fact: it takes no place of the six, and an honest value it would have replaced stays.
      if (fact.value !== null && (shownText(cleanFactText(fact.label)) === null || shownText(cleanFactText(fact.value)) === null)) { ignored.push({ id: o.ev.id, reason: "withheld" }); continue; }
      if (fact.value === null) facts.delete(key);
      else if (!facts.has(key) && facts.size >= MAX_FACTS) { ignored.push({ id: o.ev.id, reason: "fact_limit" }); continue; }
      else facts.set(key, { label: cleanFactText(fact.label), value: cleanFactText(fact.value), by: whoOf(o.ev.author), at: o.ev.ts });
      const after = facts.get(key);
      if (before !== after) updatedAt = Math.max(updatedAt ?? o.ev.ts, o.ev.ts);
    }
    head = refOf(o.ev);
    rev = o.rank;
  }
  return { facts: [...facts.values()], ignored, head, rev, ...(updatedAt === undefined ? {} : { updated_at: updatedAt }) };
}

// ---- screens ------------------------------------------------------------------------------------------------------------

/** Whether two screen registers say the same thing (a missing optional field and an absent one are the same). */
export function sameScreen(a: ScreenMetaT | null | undefined, b: ScreenMetaT | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.title === b.title && a.group === b.group && a.status === b.status && a.about === b.about
    && (a.route ?? null) === (b.route ?? null) && (a.note ?? null) === (b.note ?? null) && (a.w ?? null) === (b.w ?? null) && (a.h ?? null) === (b.h ?? null);
}

/** A page whose newest screen is older than this (while the project changed) is out of date. */
export const SCREENS_STALE_MS = 7 * 24 * 3_600_000;

/** Whether WalkieTalkie should say the screens are out of date: there are none, or the newest is more than a week old. */
export function screensWanted(s: { count: number; newest: number | null }, now: number): boolean {
  return s.count === 0 || s.newest === null || now - s.newest > SCREENS_STALE_MS;
}

/** A group's anchor on the page: lower-case words joined by hyphens, "group" when nothing of it is ASCII, numbered when taken. */
export function slugGroup(name: string, used: ReadonlySet<string>): string {
  const base = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
  let slug = base;
  for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

const IMAGE_TYPES: ReadonlySet<string> = new Set(SCREEN_IMAGE_TYPES);

/** Event ids are "<origin>:<seq>": ordered by origin, then by seq as a number (":10" comes after ":9"), as the board fold orders ops. */
export function compareIds(a: string, b: string): number {
  const i = a.lastIndexOf(":");
  const j = b.lastIndexOf(":");
  const [origin, other] = [a.slice(0, i), b.slice(0, j)];
  return origin !== other ? (origin < other ? -1 : 1) : Number(a.slice(i + 1)) - Number(b.slice(j + 1));
}

/** Newer among files claiming one screen (added on two machines at once): by the current version's time, then by creation, then by id. */
export function compareScreens(
  a: Pick<RoomFileView, "updated_at" | "created_at" | "id">,
  b: Pick<RoomFileView, "updated_at" | "created_at" | "id">,
): number {
  return a.updated_at - b.updated_at || a.created_at - b.created_at || compareIds(a.id, b.id);
}

/**
 * The screens of a page from the project's Data Room files: active files whose screen register is set and whose current
 * version is an image of a type and size the page shows, one per (group, title) (the newest), grouped by the order each
 * group's first screen was added and listed in the order they were added (so a replaced screen keeps its place), at most
 * MAX_SCREENS in MAX_SCREEN_GROUPS groups, the earliest first. Pure: the order never depends on how the room lists its files.
 */
export function composeScreens(files: readonly RoomFileView[]): ScreensView {
  const best = new Map<string, RoomFileView>();
  for (const f of files) {
    if (f.state !== "active" || !f.screen || !IMAGE_TYPES.has(f.mime) || f.size < 1 || f.size > SCREEN_MAX_BYTES) continue;
    const key = screenKey(f.screen.group, f.screen.title);
    const have = best.get(key);
    if (!have || compareScreens(f, have) > 0) best.set(key, f);
  }
  const inOrder = [...best.values()].sort((a, b) => a.created_at - b.created_at || compareIds(a.id, b.id));
  const groups = new Map<string, ScreenGroupView>();
  const taken = new Set<string>();
  let total = 0;
  let newest: number | null = null;
  for (const f of inOrder) {
    if (total >= MAX_SCREENS) break;
    const meta = shownScreen(f.screen as NonNullable<RoomFileView["screen"]>);
    if (!meta) continue;
    const key = factKey(meta.group);
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= MAX_SCREEN_GROUPS) continue;
      const id = slugGroup(meta.group, taken);
      taken.add(id);
      group = { id, name: meta.group, screens: [] };
      groups.set(key, group);
    }
    const screen: ScreenView = {
      ...meta, id: f.id, version: f.version, size: f.size, mime: f.mime as ScreenView["mime"], at: f.updated_at, by: whoOf(f.updated_by), available: f.available,
    };
    group.screens.push(screen);
    total++;
    newest = newest === null ? f.updated_at : Math.max(newest, f.updated_at);
  }
  return { total, newest_at: newest, groups: [...groups.values()] };
}
