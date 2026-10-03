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
import { foldPage, type PageState } from "../../protocol/projects/page.ts";
import { foldDispute, type DisputeState } from "../../protocol/projects/dispute.ts";
import { escalationContactOf } from "../../protocol/projects/escalation.ts";
import type { Core } from "../core.ts";
import { scrubPrivateKeys } from "../../protocol/projects/assoc.ts";
import { cardRef } from "../../protocol/projects/short.ts";
import { isStewardAuthor } from "../../protocol/projects/steward.ts";
import type { Logger } from "../logger.ts";
import { memberByHandle } from "../roster.ts";
import { ProjectsDb } from "./db.ts";
import { trackOp } from "../watchdog.ts";

/** Bumped when the fold's rules change: every project is re-folded once at startup. */
export const FOLD_VERSION = "13"; // 13: `escalation_contact` is the contact on the settings head's own parent chain, not the last writer over every op (WALK-73); a stored view is re-folded once. 12: `escalation_contact` is a project setting (WALK-73); a view stored before the field is re-folded once. 11: `status_report` is a project setting (PROJECT-REPORTS-1); 10: the steward lease `steward_node` is a project setting (FO-6 r3); 9: the board steward may move a person's card (FO-6); 8: an agent's project and board roots count (AGENT-PROJECTS); 7: 8-hex short ids, oversize bodies aren't ops; 6: ranks from the parent chain only (board ops never evicted), card short ids
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
 * cover (DATA-ROOM-1 kept that at "8"; FO-6 took it to "10"). When the room fold's rules change, bump this: every project's
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
  /** Project channels whose status page changed (PROJECT-PAGES-1): a page op arrived, or a report was posted. Nothing is re-folded for it. */
  private readonly pageDirty = new Set<string>();
  /** Each project's status page facts, folded from the log on first use and dropped when a page op arrives or is hidden, or the roster changes. */
  private readonly pages = new Map<string, PageState>();
  /** Per channel, what this pass changed (for its delta). */
  private readonly changed = new Map<string, { cards: Map<string, CardView>; removed: Set<string>; reset: boolean; room?: boolean; page?: boolean }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** Called with each project's delta once its dirty work is done (the SSE hub). */
  onDelta: ((d: BoardDelta) => void) | null = null;

  constructor(private readonly core: Core, private readonly log: Logger) {
    this.db = new ProjectsDb(core.store.db);
    // A rolled-back write may have been read into the cache: it is dropped (the next scrub reads the tables again).
    core.store.onTransaction<null>({ snapshot: () => null, restore: () => { this.scrubPrefixes = null; } });
  }

  /**
   * The status scrub's private prefixes, for one board_projects revision and one roster (rosters are replaced, never
   * changed, on every chain entry): every own status is scrubbed, a minute's archive upkeep re-projects each one, and
   * parsing every project's view per status was most of that work (DAEMON-STALL-1).
   */
  private scrubPrefixes: { rev: number; roster: object; prefixes: string[] } | null = null;

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
    const b = ev.body as { thread?: unknown; board?: { op?: unknown }; status_report?: unknown };
    // PROJECT-PAGES-1: a status page op (a reply in the project's thread, which must not re-fold the project) or a report post
    // (it carries the page's story): the page is read again; no card and no setting is re-folded.
    if (b.board?.op === "page" || (b.board === undefined && b.status_report !== undefined)) { this.markPage(ch); return; }
    // WALK-73: a dispute lives in the card's thread and folds on read. It is not a card op, so it must not re-fold the card.
    if (b.board?.op === "dispute") return;
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
    this.pages.clear(); // who may set a fact is judged by the roster
    this.schedule();
  }

  /** A room op arrived, was hidden or was written here: the room is re-folded on next use and its summary resent. */
  markRoom(channel: string): void {
    this.notePending();
    this.rooms.delete(channel);
    this.roomDirty.add(channel);
    this.schedule();
  }

  /** A status page op arrived, was hidden or was written here, or a report was posted: the page is folded again on next use and its watchers told. */
  markPage(channel: string): void {
    this.pages.delete(channel);
    this.pageDirty.add(channel);
    this.schedule();
  }

  /**
   * The card's dispute, folded from the log on each read (no cache: a dispute post does not mark the card). Empty when
   * the card root isn't stored here.
   */
  disputeOf(channel: string, cardId: string): DisputeState {
    const root = this.db.opEvent(cardId, channel);
    if (!root) return { current: null, ignored: [], head: "", rev: 0 };
    const project = this.settingsOf(channel).project;
    const foldEnv = this.env(channel);
    const owners = [...this.core.roster.members.values()].filter((m) => m.role === "owner").map((m) => m.handle);
    return foldDispute(this.db.disputePosts(channel, cardId), root, {
      ...foldEnv,
      contact: project ? escalationContactOf(project) : "",
      projectCreator: project?.creator ?? "",
      owners,
      roleNow: (handle) => memberByHandle(this.core.roster, handle)?.role ?? null,
      roleAt: (ev, handle) => roleIn(this.core.rosterAt(ev.origin, ev.seq), handle),
      // The contact at each resolve, from the settings posts every peer holds. Not the contact the project has now.
      settingsPosts: this.db.settingsPosts(channel),
      settingsEnv: foldEnv,
    });
  }

  /** The facts of the project's status page, folded (cached until a page op marks it). Empty (and an empty head) for a channel with no project. */
  page(channel: string): PageState {
    const hit = this.pages.get(channel);
    if (hit) return hit;
    const project = this.settingsOf(channel).project;
    const root = project ? this.db.opEvent(project.id, channel) : null;
    const state: PageState = project && root
      ? foldPage([root, ...this.db.pagePosts(channel, project.id)], root, this.env(channel))
      : { facts: [], ignored: [], head: "", rev: 0 };
    this.pages.set(channel, state);
    return state;
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
    this.pages.delete(channel); // the page's ops rank against the project root
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
        if (trackOp("projects_fold", () => this.flush(PAGE))) this.schedule(); else this.noteDrained();
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

  /** Refresh one project's authorization view without draining another project's queued cards. */
  flushProject(channel: string): void {
    while (this.flush(Number.MAX_SAFE_INTEGER, channel)) { /* until this project is clean */ }
    if (!this.hasPending()) this.noteDrained();
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

  /**
   * One card folded from the log right now, with its timeline (the card's detail view, the next op's rev). `without` names
   * posts to leave out, to see the card as it stood before they arrived (null when its root is among them).
   */
  foldCardNow(channel: string, id: string, without?: ReadonlySet<string>): { state: CardState; settings: Settings } | null {
    const s = this.settingsOf(channel);
    if (!s.project) return null;
    const { root, thread } = this.db.threadPosts(id, channel);
    if (!root || without?.has(root.id)) return null;
    const env = this.env(channel);
    const creator = s.project.creator;
    const state = foldCard(root, without ? thread.filter((e) => !without.has(e.id)) : thread, {
      boards: new Map(s.boards.map((b) => [b.id, b])),
      steward: (ev) => { const role = env.roleOf(ev); return isStewardAuthor(ev.author, role === "removed" ? null : role, creator); },
    });
    return state ? { state, settings: s } : null;
  }

  /** One pass: returns true while work remains. */
  private flush(budget: number, onlyChannel?: string): boolean {
    for (const ch of [...this.rosterDirty]) {
      if (onlyChannel && ch !== onlyChannel) continue;
      this.rosterDirty.delete(ch);
      if (this.dirtyFull.has(ch)) continue;
      const before = this.settings.get(ch);
      this.settings.delete(ch);
      const after = this.settingsOf(ch);
      if (!before || JSON.stringify(before) !== JSON.stringify(after)) this.markFull(ch);
      else if (!this.dirtyCards.has(ch)) this.finishChannel(ch, after);
    }
    for (const ch of [...this.dirtyFull]) {
      if (onlyChannel && ch !== onlyChannel) continue;
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
      if (onlyChannel && ch !== onlyChannel) continue;
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
    for (const ch of [...this.keysDirty]) if (!onlyChannel || ch === onlyChannel) this.finishChannel(ch, this.settingsOf(ch));
    for (const ch of [...this.roomDirty]) {
      if (onlyChannel && ch !== onlyChannel) continue;
      this.roomDirty.delete(ch);
      this.delta(ch).room = true;
      this.finishChannel(ch, this.settingsOf(ch));
    }
    for (const ch of [...this.pageDirty]) {
      if (onlyChannel && ch !== onlyChannel) continue;
      this.pageDirty.delete(ch);
      this.delta(ch).page = true;
      this.finishChannel(ch, this.settingsOf(ch));
    }
    return onlyChannel ? this.dirtyFull.has(onlyChannel) || this.dirtyCards.has(onlyChannel) || this.rosterDirty.has(onlyChannel)
      : this.dirtyFull.size > 0 || this.dirtyCards.size > 0 || this.rosterDirty.size > 0;
  }

  private hasPending(): boolean {
    return this.dirtyFull.size > 0 || this.dirtyCards.size > 0 || this.rosterDirty.size > 0
      || this.keysDirty.size > 0 || this.roomDirty.size > 0 || this.pageDirty.size > 0;
  }

  private delta(ch: string): { cards: Map<string, CardView>; removed: Set<string>; reset: boolean; room?: boolean; page?: boolean } {
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
      ...(d?.page ? { page: true } : {}),
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
    const hit = this.scrubPrefixes;
    const prefixes = hit && hit.rev === this.db.revision && hit.roster === r ? hit.prefixes : this.projects()
      .filter((p) => p.private || !!r.channels.get(p.channel)?.members)
      .flatMap((p) => [p.prefix, ...(p.prior_prefixes ?? [])]);
    if (prefixes !== hit?.prefixes) this.scrubPrefixes = { rev: this.db.revision, roster: r, prefixes };
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
