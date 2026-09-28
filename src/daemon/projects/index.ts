// The board index (WALKIE-PROJECTS-1): keeps board_projects / board_cards equal to the fold (src/protocol/projects/
// fold.ts) of the accepted posts in project channels. An accepted or newly hidden post marks the entity it belongs to
// (a card, or the project's settings); a roster change marks every project (permissions follow the chain). Dirty work
// is re-folded off the ingest path in pages, then each touched project's view is rebuilt and sent as an SSE `board`
// delta. Nothing here is replicated: every node folds its own copy of the log and gets the same boards.
import type { Event, Role } from "../../protocol/schemas.ts";
import {
  assignKeys, cardView, foldBoards, foldCard, foldProject, projectView,
  type BoardState, type CardGroup, type CardState, type FoldEnv, type OpEvent, type ProjectState,
} from "../../protocol/projects/fold.ts";
import { type BoardDelta, type CardView, type ProjectView } from "../../protocol/projects/schema.ts";
import { currentVersion, foldRoom, type RoomFileState } from "../../protocol/projects/room.ts";
import type { Core } from "../core.ts";
import { scrubPrivateKeys } from "../../protocol/projects/assoc.ts";
import { cardRef } from "../../protocol/projects/short.ts";
import type { Logger } from "../logger.ts";
import { memberByHandle } from "../roster.ts";
import { ProjectsDb } from "./db.ts";

/** Bumped when the fold's rules change: every project is re-folded once at startup. */
export const FOLD_VERSION = "8"; // 8: an agent's project and board roots count (AGENT-PROJECTS); 7: 8-hex short ids, oversize bodies aren't ops; 6: ranks from the parent chain only (board ops never evicted), card short ids
const FOLD_META = "projects_fold";
/**
 * Set while any re-fold work is queued, cleared when the queue drains (round-1 audit, Codex M8): a daemon stopped with
 * work in flight rebuilds every board at its next start instead of trusting half-updated tables. FOLD_META is written
 * only once a rebuild has fully drained.
 */
const PENDING_META = "projects_pending";
/**
 * The newest event row (rowid) the tables reflect, written when the queue drains. An event committed but not yet
 * marked (a crash between its commit and the index hearing of it) is newer than this, so the next start rebuilds
 * (round-2 audit, Codex M5): no window depends on two separate writes.
 */
const CHECKPOINT_META = "projects_checkpoint";
/**
 * The stored project views carry a Data Room summary (files, pinned, current-version bytes) that FOLD_VERSION doesn't
 * cover (it stays "8" for pre.5 peers and downgrades). When the room fold's rules change, bump this: every project's
 * room summary is rebuilt once at start (a room re-fold and a view save per project; no card is re-folded).
 */
export const ROOM_SUMMARY_VERSION = "1"; // 1: DATA-ROOM-1 (causal pinned document, per-author version caps, file cap exemptions)
const ROOM_SUMMARY_META = "projects_room_summary";
/** Cards re-folded per pass; the rest continue on the next tick. */
const PAGE = 400;
/** A delta listing more cards than this is sent as `reset` (clients refetch the project). */
const DELTA_MAX_CARDS = 100;

export interface Settings { project: ProjectState | null; boards: BoardState[] }

function roleIn(r: ReturnType<Core["rosterAt"]>, handle: string): Role | "removed" | null {
  return memberByHandle(r, handle)?.role ?? null;
}

export class ProjectsIndex {
  readonly db: ProjectsDb;
  private readonly settings = new Map<string, Settings>();
  private readonly dirtyFull = new Set<string>();
  private readonly dirtyCards = new Map<string, Set<string>>();
  private readonly keysDirty = new Set<string>();
  private readonly rosterDirty = new Set<string>();
  /** Project channels whose Data Room changed (DATA-ROOM-1): the view's room summary and a `room` delta. */
  private readonly roomDirty = new Set<string>();
  /** Each project's Data Room, folded from the log on first use and dropped when a room op arrives or is hidden. */
  private readonly rooms = new Map<string, RoomFileState[]>();
  /** Per channel, what this pass changed (for its delta). */
  private readonly changed = new Map<string, { cards: Map<string, CardView>; removed: Set<string>; reset: boolean; room?: boolean }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** Called with each project's delta once its dirty work is done (the SSE hub). */
  onDelta: ((d: BoardDelta) => void) | null = null;

  constructor(private readonly core: Core, private readonly log: Logger) {
    this.db = new ProjectsDb(core.store.db);
  }

  /** Re-folds everything once if the stored boards came from another fold version (or none: a fresh upgrade). */
  start(): void {
    const cp = Number(this.core.store.getMeta(CHECKPOINT_META) ?? "0");
    const unseen = this.db.projectPostsAfter(Number.isSafeInteger(cp) ? cp : 0);
    const rooms = this.core.store.getMeta(ROOM_SUMMARY_META) !== ROOM_SUMMARY_VERSION;
    // Either way the room summaries are rebuilt (a full rebuild saves every view); PENDING_META, set by markRoom and
    // the full rebuild, covers a restart before this drains: the next start rebuilds everything.
    if (this.core.store.getMeta(FOLD_META) === FOLD_VERSION && this.core.store.getMeta(PENDING_META) === null && !unseen) {
      // Marked pending first (markRoom persists PENDING_META), then the version: a crash between them rebuilds all.
      if (rooms) for (const ch of this.db.projectChannels()) if (this.core.isProjectChannel(ch)) this.markRoom(ch);
      if (rooms) this.core.store.setMeta(ROOM_SUMMARY_META, ROOM_SUMMARY_VERSION);
      return;
    }
    if (rooms) this.core.store.setMeta(ROOM_SUMMARY_META, ROOM_SUMMARY_VERSION); // the full rebuild below covers them
    // Everything derived is rebuilt from the log. The old rows stay until each project is re-folded (round-4 audit,
    // Opus M3: emptying them first left the status scrub without the private prefixes); rows of channels that are no
    // longer project channels go now. Until the rebuild drains, statuses are scrubbed of every key-shaped token.
    this.rebuilding = true;
    for (const { channel } of this.db.allProjectJson()) if (!this.core.isProjectChannel(channel)) this.db.deleteChannel(channel);
    this.core.store.deleteMeta(FOLD_META);
    for (const ch of this.db.projectChannels()) if (this.core.isProjectChannel(ch)) this.markFull(ch);
    this.notePending();
    this.schedule();
  }

  /** A full rebuild is running (start): the status scrub fails closed until it drains. */
  private rebuilding = false;

  private pendingNoted = false;
  /** Work is queued: persisted, so a restart before it drains rebuilds. */
  private notePending(): void {
    if (this.pendingNoted) return;
    this.pendingNoted = true;
    this.core.store.setMeta(PENDING_META, "1");
  }
  /** The queue drained: the tables match the log for this fold version. */
  private noteDrained(): void {
    this.rebuilding = false;
    this.core.store.setMeta(FOLD_META, FOLD_VERSION);
    this.core.store.setMeta(CHECKPOINT_META, String(this.db.maxRowid()));
    if (!this.pendingNoted && this.core.store.getMeta(PENDING_META) === null) return;
    this.pendingNoted = false;
    this.core.store.deleteMeta(PENDING_META);
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** How the fold judges this channel's posts: its creator, and each author's role in the roster its event is judged by. */
  env(channel: string): FoldEnv {
    return {
      creator: this.core.channelCreator(channel),
      roleOf: (ev: OpEvent) => roleIn(this.core.rosterAt(ev.origin, ev.seq), ev.author.handle),
    };
  }

  /** Core.onPostChange: an accepted or newly hidden post, or artifact share. */
  onPost(ev: Event, _change: "accepted" | "hidden"): void {
    if (!this.core.isProjectChannel(ev.channel)) return;
    const ch = ev.channel as string;
    // A share in a project channel may be a room version's bytes: whether they can be served (`available`) changed, so
    // the room is resent even when its room op arrived first (round-2 audit LOW).
    if (ev.kind === "artifact.share") { this.markRoom(ch); return; }
    const b = ev.body as { thread?: unknown; board?: { op?: unknown } };
    const thread = typeof b.thread === "string" ? b.thread : null;
    // A reply belongs to its root's entity; a root that was just hidden is still known as a card by its row.
    // Only a root of THIS channel counts (round-1 audit, Codex HIGH 1).
    const op = thread ? this.db.rootOp(thread, ch) ?? (this.db.card(thread)?.channel === ch ? "card" : null) : b.board?.op;
    if (op === "card") {
      this.markCard(ch, thread ?? ev.id);
      if (!thread) this.keysDirty.add(ch);
    } else if (op === "project" || op === "board") {
      this.markFull(ch);
    } else if (op === "file") {
      this.markRoom(ch);
    } else {
      return; // a plain message in the channel: nothing on the board changes
    }
    this.schedule();
  }

  /**
   * The chain grew: who is an owner (settings permissions), whether a project is private and its admins may have
   * changed. Each project's settings are re-folded; only a project whose settings came out different re-folds its cards.
   */
  rosterChanged(): void {
    for (const name of this.core.roster.channels.keys()) if (this.core.isProjectChannel(name)) { this.notePending(); this.rosterDirty.add(name); }
    this.schedule();
  }

  /** A room op arrived, was hidden or was written here: the room is re-folded on next use and its summary resent. */
  markRoom(channel: string): void {
    this.notePending();
    this.rooms.delete(channel);
    this.roomDirty.add(channel);
    this.schedule();
  }

  /** The project's Data Room, folded (cached until a room op marks it). Every file, removed ones included. */
  room(channel: string): RoomFileState[] {
    const hit = this.rooms.get(channel);
    if (hit) return hit;
    const files = foldRoom(this.db.roomPosts(channel));
    this.rooms.set(channel, files);
    return files;
  }

  markFull(channel: string): void {
    this.notePending();
    this.dirtyFull.add(channel);
    this.settings.delete(channel);
  }

  private markCard(channel: string, id: string): void {
    this.notePending();
    const set = this.dirtyCards.get(channel) ?? new Set<string>();
    set.add(id);
    this.dirtyCards.set(channel, set);
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        if (this.flush(PAGE)) this.schedule(); else this.noteDrained();
      } catch (err) {
        this.log.warn("projects_fold_failed", { err: err instanceof Error ? err.message : String(err) });
      }
    }, 5);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * A settings / board change this node just made: the project's view is rebuilt now from the new settings and the
   * stored cards, and the cards are re-folded in the background, paged (round-1 audit LOW: no synchronous re-fold of
   * every card inside a request).
   */
  touchSettings(channel: string): void {
    this.markFull(channel);
    const s = this.settingsOf(channel);
    const view = this.buildView(channel, s);
    this.db.saveProject(channel, s.project?.id ?? null, view ? JSON.stringify(view) : null, view?.last_activity ?? 0);
    this.schedule();
  }

  /** Everything dirty, now (tests, and a route that needs the result of its own write). Bounded by the dirty set. */
  flushAll(): void {
    while (this.flush(Number.MAX_SAFE_INTEGER)) { /* until clean */ }
    this.noteDrained();
  }

  /** The project's settings entities, folded (cached until something marks the project). */
  settingsOf(channel: string): Settings {
    const hit = this.settings.get(channel);
    if (hit) return hit;
    const posts = this.db.settingsPosts(channel);
    const env = this.env(channel);
    const project = foldProject(posts, env);
    const s: Settings = { project, boards: foldBoards(posts, env, project) };
    this.settings.set(channel, s);
    return s;
  }

  /** One card folded from the log right now, with its timeline (the card's detail view, the next op's rev). */
  foldCardNow(channel: string, id: string): { state: CardState; settings: Settings } | null {
    const s = this.settingsOf(channel);
    if (!s.project) return null;
    const { root, thread } = this.db.threadPosts(id, channel);
    if (!root) return null;
    const state = foldCard(root, thread, { boards: new Map(s.boards.map((b) => [b.id, b])) });
    return state ? { state, settings: s } : null;
  }

  /** One pass: returns true while work remains. */
  private flush(budget: number): boolean {
    for (const ch of [...this.rosterDirty]) {
      this.rosterDirty.delete(ch);
      if (this.dirtyFull.has(ch)) continue;
      const before = this.settings.get(ch);
      this.settings.delete(ch);
      const after = this.settingsOf(ch);
      if (!before || JSON.stringify(before) !== JSON.stringify(after)) this.markFull(ch);
      else if (!this.dirtyCards.has(ch)) this.finishChannel(ch, after);
    }
    for (const ch of [...this.dirtyFull]) {
      this.dirtyFull.delete(ch);
      this.settings.delete(ch);
      const ids = new Set([...this.db.cardRootIds(ch), ...this.db.cardRows(ch).map((r) => r.id)]);
      const set = this.dirtyCards.get(ch) ?? new Set<string>();
      for (const id of ids) set.add(id);
      this.dirtyCards.set(ch, set);
      this.keysDirty.add(ch);
      this.delta(ch).reset = true;
    }
    let done = 0;
    for (const [ch, ids] of this.dirtyCards) {
      const s = this.settingsOf(ch);
      for (const id of ids) {
        if (done >= budget) return true;
        ids.delete(id);
        done++;
        this.refoldCard(ch, id, s);
      }
      this.dirtyCards.delete(ch);
      this.finishChannel(ch, s);
    }
    for (const ch of [...this.keysDirty]) this.finishChannel(ch, this.settingsOf(ch));
    for (const ch of [...this.roomDirty]) {
      this.roomDirty.delete(ch);
      this.delta(ch).room = true;
      this.finishChannel(ch, this.settingsOf(ch));
    }
    return this.dirtyFull.size > 0 || this.dirtyCards.size > 0 || this.rosterDirty.size > 0;
  }

  private delta(ch: string): { cards: Map<string, CardView>; removed: Set<string>; reset: boolean; room?: boolean } {
    let d = this.changed.get(ch);
    if (!d) { d = { cards: new Map(), removed: new Set(), reset: false }; this.changed.set(ch, d); }
    return d;
  }

  private refoldCard(ch: string, id: string, s: Settings): void {
    if (this.db.card(id) && this.db.card(id)?.channel !== ch) return; // another project's card: never touched from here
    const got = s.project ? this.foldCardNow(ch, id) : null;
    const board = got ? s.boards.find((b) => b.id === got.state.board) : undefined;
    if (!got || !board || !s.project) {
      if (this.db.card(id)) { this.db.deleteCard(id); this.delta(ch).removed.add(id); }
      return;
    }
    const prev = this.db.card(id);
    const n = prev?.n ?? got.state.n_proposed ?? this.db.maxN(ch) + 1;
    const view = cardView(got.state, ch, s.project.prefix, n, board.columns);
    this.db.saveCard(view, got.state.n_proposed, got.state.created_at);
    this.delta(ch).cards.set(id, view);
  }

  /** Key numbers (when a card was created), the project's view and meters, and the delta. */
  private finishChannel(ch: string, s: Settings): void {
    if (this.keysDirty.delete(ch) && s.project) {
      const rows = this.db.cardRows(ch);
      const keys = assignKeys(rows.map((r) => ({ id: r.id, ts: r.root_ts, n: r.n_proposed })));
      for (const r of rows) {
        const n = keys.get(r.id);
        if (n === undefined || n === r.n) continue;
        const card = this.db.card(r.id);
        if (!card) continue;
        const key = `${s.project.prefix}-${n}`;
        const view = { ...card, n, key, ref: cardRef(key, card.id) }; // the reference follows the key (Codex r6 LOW)
        this.db.saveCard(view, r.n_proposed, r.root_ts);
        this.delta(ch).cards.set(r.id, view);
      }
    }
    const view = this.buildView(ch, s);
    this.db.saveProject(ch, s.project?.id ?? null, view ? JSON.stringify(view) : null, view?.last_activity ?? 0);
    if (!view) this.db.deleteChannel(ch);
    const d = this.changed.get(ch);
    this.changed.delete(ch);
    const cards = d ? [...d.cards.values()] : [];
    const reset = !!d?.reset || cards.length > DELTA_MAX_CARDS;
    this.onDelta?.({
      channel: ch, project: view,
      ...(reset ? { reset: true } : { ...(cards.length ? { cards } : {}), ...(d?.removed.size ? { removed: [...d.removed] } : {}) }),
      ...(d?.room ? { room: true } : {}),
    });
  }

  /** The project's view from its settings and the stored cards (null: no valid project in this channel). */
  buildView(ch: string, s: Settings = this.settingsOf(ch)): ProjectView | null {
    if (!s.project) return null;
    const groups = new Map<string, CardGroup[]>();
    for (const g of this.db.meterGroups(ch)) {
      groups.set(g.board, [...(groups.get(g.board) ?? []), { column: g.column_id, state: g.state, n: g.n, pts: g.pts }]);
    }
    const r = this.core.roster;
    const owners = [...r.members.values()].filter((m) => m.role === "owner").map((m) => m.handle);
    const live = this.room(ch).filter((f) => f.state === "active");
    return {
      ...projectView(ch, s.project, s.boards, groups, { private: !!r.channels.get(ch)?.members, owners, lastActivity: this.db.lastTs(ch) }),
      room: { files: live.length, pinned: live.filter((f) => f.pinned).length, bytes: live.reduce((n, f) => n + currentVersion(f).size, 0) },
    };
  }

  /**
   * An own agent status without private card keys (round-1 audit M7): a task or branch naming a card of a private
   * project is dropped, and the key is masked in the title and activity. Peers who aren't owners must not learn the
   * project's prefix, its card numbers or who works on them.
   */
  scrubStatus<B extends Record<string, unknown>>(b: B): B {
    // Private = restricted in the CURRENT roster (not the stored view, which may lag a privacy change); every prefix
    // the project ever had (its old keys stay masked after a rename; round-4 audit, Opus M4).
    const r = this.core.roster;
    const prefixes = this.projects()
      .filter((p) => p.private || !!r.channels.get(p.channel)?.members)
      .flatMap((p) => [p.prefix, ...(p.prior_prefixes ?? [])]);
    return scrubPrivateKeys(b, prefixes, { anyKey: this.rebuilding });
  }

  /** The stored view of a project (fresh after flushAll). */
  project(channel: string): ProjectView | null {
    const json = this.db.projectJson(channel);
    return json ? (JSON.parse(json) as ProjectView) : null;
  }

  /** Every folded project (visibility is the caller's). */
  projects(): ProjectView[] {
    return this.db.allProjectJson().map((r) => JSON.parse(r.json) as ProjectView);
  }
}
