// The Data Room fold (DATA-ROOM-1, ALE-5389): a PURE function of the set of accepted room ops in a project's channel,
// like the board fold (fold.ts), so every replica holding the same posts shows the same room.
//
// A file = a root room op (`board: {op: "file", name, hash, size, mime, share}`) + the room ops replying in its thread.
// Ops are ranked by their causal parent and applied in (rank, origin, seq) order with per-field last-writer-wins
// (fold.ts `order`). Registers: content (hash + size + mime + share, written together: each write is a VERSION), name,
// pin, state (active / removed), and one attached-or-not register per card. Rules, judged per op in fold order:
//   - rename, pin / unpin, remove / restore, detach: a person (`person_only`); a root's `pin` counts from a person only
//   - a new version of a file that is pinned at that point: a person (`person_pinned`: pinned text reaches other agents)
//   - a content op must carry all four content fields (`bad_version`)
//   - a file keeps at most ROOM_LIMITS.versions versions by people and as many by agents (`version_limit`), counted
//     apart so agent versions (crafted ones included) never push a person's version out
//   - attach: anyone who can post in the channel (validity already refuses observers and non-members)
// An op that fails stays in the signed log and is listed in the file's history as ignored; the fold skips it.
// The pinned document is judged causally, not by fold order (round-2 audit MEDIUM): an agent's version whose parent is
// older than the pin (its machine hadn't seen the pin, or a crafted `after`) ranks before the pin and passes the rule
// above. While a file is pinned, a version counts only if a PERSON added it or a person's pin descends from it (the
// pinner had it in view); any other agent version is kept in the history, flagged `ignored: "person_pinned"`, and the
// current version is the last one that counts. A room shows at most ROOM_LIMITS.files live files an agent created
// and nobody pinned (create order, which the signer chooses); pinned files and files a person created always show.
import type { Author } from "../schemas.ts";
import { isPerson, order, refOf, type OpEvent } from "./fold.ts";
import { shownScreen } from "./page-text.ts";
import { FileOp, ScreenMeta, type FileOpT, type RoomFileView, type RoomVersion, type ScreenMetaT, type TimelineEntry } from "./schema.ts";

// The views live in schema.ts (type-only: the dashboard imports them without the fold's dependencies).
export type { ContextFile, RoomFileDetail, RoomFileView, RoomVersion, TaskContext } from "./schema.ts";

/** Live files per room, versions per file: checked where things are created, and the fold ignores what exceeds them. */
export const ROOM_LIMITS = { files: 1_000, versions: 100 };
/** Pinned documents inlined into an agent's context: text files only, this much each and in total. */
export const PIN_INLINE_FILE = 16 * 1024;
export const PIN_INLINE_TOTAL = 48 * 1024;
/** Bytes one task start may fetch from peers for pinned documents, whatever sizes the room ops claim (tests lower it). */
export const PIN_FETCH = { bytes: 32 * 1024 * 1024 };

export interface RoomFileState {
  id: string; name: string; pinned: boolean; state: "active" | "removed";
  versions: RoomVersion[];
  /** Attached card ids (last attach last). */
  cards: string[];
  /** PROJECT-PAGES-1: what the file is on the project's status page, or null when it is not a screen. */
  screen: ScreenMetaT | null;
  created_at: number; created_by: Author; updated_at: number; updated_by: Author;
  rev: number; head: string;
  timeline: TimelineEntry[];
}

const FILE_FIELDS = ["name", "hash", "size", "mime", "share", "pin", "state", "attach", "detach", "screen"] as const;

function fieldsOf(op: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of FILE_FIELDS) {
    if (op[k] === undefined) continue;
    // `screen: null` is a value (off the page); `undefined` from screenOf, for a field the op carries, is one this build cannot read.
    const screen = k === "screen" ? screenOf(op as FileOpT) : undefined;
    out[k] = k === "screen" ? (screen === undefined ? UNREADABLE : screen) : op[k];
  }
  return out;
}

/** What a file's history says of a `screen` value this build cannot read (the value itself is never copied: it may be anything, up to 16 KB). */
const UNREADABLE = "(unreadable)";

function parse(v: unknown): FileOpT | null {
  const r = FileOp.safeParse(v);
  return r.success ? r.data : null;
}

/**
 * The screen register an op writes: `null` clears it, a valid ScreenMeta sets it, `undefined` is "this op does not touch it".
 * A value that is not a ScreenMeta (written by a newer build) is "does not touch it": the rest of the op still applies.
 */
function screenOf(op: FileOpT): ScreenMetaT | null | undefined {
  if (op.screen === undefined) return undefined;
  if (op.screen === null) return null;
  const r = ScreenMeta.safeParse(op.screen);
  return r.success ? r.data : undefined;
}

/** 0: no content field; 1: all four; -1: some (a malformed version). */
function content(op: FileOpT): -1 | 0 | 1 {
  const n = [op.hash, op.size, op.mime, op.share].filter((x) => x !== undefined).length;
  return n === 0 ? 0 : n === 4 ? 1 : -1;
}

function denial(ev: OpEvent, op: FileOpT, pinned: boolean, versions: { person: number; agent: number }): string | null {
  const person = isPerson(ev);
  const c = content(op);
  if (c === -1) return "bad_version";
  if (!person && (op.name !== undefined || op.pin !== undefined || op.state !== undefined || op.detach !== undefined)) return "person_only";
  if (!person && c === 1 && pinned) return "person_pinned";
  if (c === 1 && versions[person ? "person" : "agent"] >= ROOM_LIMITS.versions) return "version_limit";
  return null;
}

function byTs(a: RoomFileState, b: RoomFileState): number {
  return a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function byTsEntry(a: TimelineEntry, b: TimelineEntry): number {
  return a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

type Parsed = { ev: OpEvent; op: FileOpT };

/**
 * Every file of a room (roots in create order), each folded from its root and the room ops in its thread. Live,
 * unpinned files created by agents past ROOM_LIMITS.files (in create order) are left out. O(n log n) in the number of ops (appends, no copies).
 */
export function foldRoom(posts: readonly OpEvent[]): RoomFileState[] {
  const roots: Parsed[] = [];
  const replies = new Map<string, Parsed[]>();
  for (const ev of posts) {
    const op = parse(ev.board);
    if (!op) continue;
    if (!ev.thread) {
      if (!ev.hidden && op.name !== undefined && content(op) === 1) roots.push({ ev, op });
      continue;
    }
    const list = replies.get(ev.thread);
    if (list) list.push({ ev, op }); else replies.set(ev.thread, [{ ev, op }]);
  }
  const files = roots.map((root) => foldFile(root, replies.get(root.ev.id) ?? [])).sort(byTs);
  let capped = 0;
  return files.filter((f) => f.state !== "active" || f.pinned || isPerson({ author: f.created_by }) || ++capped <= ROOM_LIMITS.files);
}

function foldFile(root: Parsed, replies: readonly Parsed[]): RoomFileState {
  const r = root.op;
  let s = {
    name: r.name as string, pinned: r.pin === true && isPerson(root.ev), state: "active" as RoomFileState["state"],
    updated_at: root.ev.ts, updated_by: root.ev.author, rev: 0, head: refOf(root.ev),
    screen: screenOf(r) ?? null,
  };
  const versions: RoomVersion[] = [];
  const counts = { person: 0, agent: 0 };
  /** Person pin ops applied (the root when a person created it pinned): the versions they descend from count. */
  const pins: Parsed[] = s.pinned ? [root] : [];
  const attached = new Map<string, true>();
  const { applied, waiting } = order(root, replies);
  const timeline: TimelineEntry[] = waiting.map((x) => ({
    id: x.ev.id, ts: x.ev.ts, author: x.ev.author, kind: "op" as const, changes: fieldsOf(x.op as Record<string, unknown>), ignored: "waiting_for_parent",
  }));
  for (const o of applied) {
    const changes = fieldsOf(o.op as Record<string, unknown>);
    const entry: TimelineEntry = { id: o.ev.id, ts: o.ev.ts, author: o.ev.author, kind: o.root ? "create" : "op", changes, rev: o.op.rev, effective_rev: o.rank };
    const denied = o.root ? null : denial(o.ev, o.op, s.pinned, counts);
    if (denied) { timeline.push({ ...entry, ignored: denied }); continue; }
    timeline.push(entry);
    const op = o.op;
    const name = !o.root && op.name !== undefined ? op.name : s.name;
    if (content(op) === 1) {
      counts[isPerson(o.ev) ? "person" : "agent"]++;
      versions.push({ v: versions.length + 1, id: o.ev.id, hash: op.hash as string, size: op.size as number, mime: op.mime as string, share: op.share as string, name, ts: o.ev.ts, by: o.ev.author });
    }
    if (!o.root && op.pin === true) pins.push(o); // a pin reaching here is a person's (person_only above)
    for (const id of op.attach ?? []) { attached.delete(id); attached.set(id, true); }
    for (const id of op.detach ?? []) attached.delete(id);
    const screen = o.root ? undefined : screenOf(op);
    s = {
      ...s, head: refOf(o.ev), rev: o.rank, name,
      ...(!o.root && op.pin !== undefined ? { pinned: op.pin } : {}),
      ...(!o.root && op.state !== undefined ? { state: op.state } : {}),
      ...(screen !== undefined ? { screen } : {}),
      updated_at: Math.max(s.updated_at, o.ev.ts), updated_by: o.ev.ts >= s.updated_at ? o.ev.author : s.updated_by,
    };
  }
  return {
    id: root.ev.id, name: s.name, pinned: s.pinned, state: s.state,
    versions: s.pinned ? flagUnseen(versions, pins, root, replies) : versions,
    cards: [...attached.keys()], screen: s.screen,
    created_at: root.ev.ts, created_by: root.ev.author, updated_at: s.updated_at, updated_by: s.updated_by,
    rev: s.rev, head: s.head, timeline: timeline.sort(byTsEntry),
  };
}

/**
 * A pinned file's versions with the ones that are not the pinned document flagged: an agent's version that no person
 * pin descends from (its author hadn't seen the pin, or named an older parent on purpose). Ancestry follows each op's
 * `after` (a ref: id + signature hash), so only what the pinner had folded counts; hidden parents count as links.
 */
function flagUnseen(versions: readonly RoomVersion[], pins: readonly Parsed[], root: Parsed, replies: readonly Parsed[]): RoomVersion[] {
  if (versions.every((v) => isPerson({ author: v.by }))) return [...versions];
  const byRef = new Map<string, Parsed>([[refOf(root.ev), root], ...replies.map((x) => [refOf(x.ev), x] as const)]);
  const seen = new Set<string>();
  for (const pin of pins) {
    let cur: Parsed | undefined = pin;
    while (cur && !seen.has(cur.ev.id)) {
      seen.add(cur.ev.id);
      if (cur === root) break;
      cur = cur.op.after === undefined ? root : byRef.get(cur.op.after);
    }
  }
  return versions.map((v) => (isPerson({ author: v.by }) || seen.has(v.id) ? v : { ...v, ignored: "person_pinned" as const }));
}

/** How many versions people and agents added (each capped at ROOM_LIMITS.versions on its own). */
export function versionCount(versions: readonly RoomVersion[]): { person: number; agent: number } {
  let person = 0;
  for (const v of versions) if (isPerson({ author: v.by })) person++;
  return { person, agent: versions.length - person };
}

/** The current version: the last one in fold order; for a pinned file, the last one that is the pinned document. */
export function currentVersion(f: Pick<RoomFileState, "versions" | "pinned">): RoomVersion {
  if (f.pinned) {
    for (let i = f.versions.length - 1; i >= 0; i--) if (!f.versions[i]?.ignored) return f.versions[i] as RoomVersion;
  }
  return f.versions[f.versions.length - 1] as RoomVersion;
}

/**
 * A file as the API lists it. `cards` is narrowed to the project's cards by the caller; `available` too. A screen's details are read
 * through the status page's own cleaning (page-text.ts), so the Data Room never shows what the page would not; a screen whose title,
 * group or sentence is a join code has no register here. (The signed events themselves, and an NDJSON export of them, are as signed.)
 */
export function roomFileView(f: RoomFileState, channel: string, opts: { cards: readonly string[]; available: boolean }): RoomFileView {
  const cur = currentVersion(f);
  const screen = f.screen ? shownScreen(f.screen) : null;
  return {
    id: f.id, channel, name: f.name, pinned: f.pinned, state: f.state, hash: cur.hash, size: cur.size, mime: cur.mime,
    version: cur.v, versions: f.versions.length, updated_at: cur.ts, updated_by: cur.by, created_at: f.created_at, created_by: f.created_by,
    cards: [...opts.cards], available: opts.available, rev: f.rev,
    ...(screen ? { screen } : {}),
  };
}

/** A file's history as the Data Room shows it: a screen register in it read through the same cleaning as the file's own. */
export function shownTimeline(timeline: readonly TimelineEntry[]): TimelineEntry[] {
  return timeline.map((entry) => {
    const screen = entry.changes?.screen;
    if (screen === undefined || screen === null || typeof screen === "string") return entry; // off the page, or one this build cannot read
    return { ...entry, changes: { ...entry.changes, screen: shownScreen(screen as ScreenMetaT) ?? "(withheld)" } };
  });
}

/** Room order: pinned first, then by name (case-insensitive), then create order. */
export function roomOrder(a: Pick<RoomFileView, "pinned" | "name" | "created_at" | "id">, b: Pick<RoomFileView, "pinned" | "name" | "created_at" | "id">): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const n = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  return n || a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The readable text a room op carries (what an older daemon shows as a channel message). Never empty. */
export function roomOpText(name: string, fields: Record<string, unknown>, version?: number): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const parts: string[] = [];
  if (fields.hash !== undefined) parts.push(version && version > 1 ? `new version (v${version})` : "added");
  if (typeof fields.name === "string" && fields.name !== name) parts.push(`renamed to ${clip(fields.name, 120)}`);
  if (fields.pin === true) parts.push("pinned");
  if (fields.pin === false) parts.push("unpinned");
  if (fields.state === "removed") parts.push("removed");
  if (fields.state === "active") parts.push("restored");
  if (Array.isArray(fields.attach)) parts.push(`attached to ${fields.attach.length} card${fields.attach.length === 1 ? "" : "s"}`);
  if (Array.isArray(fields.detach)) parts.push(`detached from ${fields.detach.length} card${fields.detach.length === 1 ? "" : "s"}`);
  if (fields.screen === null) parts.push("taken off the status page");
  else if (fields.screen !== undefined && fields.hash === undefined) parts.push("screen details changed");
  return `Data Room: ${clip(name, 160)} ${parts.join(", ") || "updated"}`;
}
