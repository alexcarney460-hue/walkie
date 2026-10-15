// Projects state for the dashboard (WALKIE-PROJECTS-1): the project list, and the cards of the projects opened so far.
// Loaded on demand, kept current by the stream's `board` deltas (state/store.tsx forwards them here).
import { useSyncExternalStore } from "react";
import { api, friendlyError } from "../api/client.ts";
import type { BoardDelta, CardView, Event, ProjectStub, ProjectView, RoomFileView } from "../api/types.ts";

export interface ProjectsState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  projects: ProjectView[];
  stubs: ProjectStub[];
  /** Cards per project channel, for the projects opened in this tab. */
  cards: Record<string, CardView[]>;
  cardsError: Record<string, string>;
  /** Data Room files per project channel (DATA-ROOM-1), for the rooms opened in this tab (removed ones included). */
  rooms: Record<string, RoomFileView[]>;
  roomsError: Record<string, string>;
  /** Status page and Data Room stream invalidations. */
  pageTicks?: Record<string, number>;
  /** Changes when a channel enters the visible list, including after it was removed. */
  visibilityGeneration?: Record<string, number>;
}

const EMPTY: ProjectsState = { status: "idle", error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {}, pageTicks: {} };

/** Applies a board delta (pure): the project's view, changed cards, removed cards. */
export function applyDelta(s: ProjectsState, d: BoardDelta): ProjectsState {
  const projects = d.project === undefined ? s.projects
    : d.project === null ? s.projects.filter((p) => p.channel !== d.channel)
    : s.projects.some((p) => p.channel === d.channel) ? s.projects.map((p) => (p.channel === d.channel ? d.project as ProjectView : p))
    : [...s.projects, d.project];
  const loaded = s.cards[d.channel];
  if (!loaded || d.reset) return { ...s, projects };
  const changed = new Map((d.cards ?? []).map((c) => [c.id, c]));
  const removed = new Set(d.removed ?? []);
  const kept = loaded.filter((c) => !removed.has(c.id)).map((c) => changed.get(c.id) ?? c);
  const added = [...changed.values()].filter((c) => !loaded.some((x) => x.id === c.id));
  return { ...s, projects, cards: { ...s.cards, [d.channel]: [...kept, ...added] } };
}

/** A card replaced by the server's answer to this tab's own write (before the delta arrives). */
export function withCard(s: ProjectsState, card: CardView): ProjectsState {
  const list = s.cards[card.channel];
  if (!list) return s;
  const next = list.some((c) => c.id === card.id) ? list.map((c) => (c.id === card.id ? card : c)) : [...list, card];
  return { ...s, cards: { ...s.cards, [card.channel]: next } };
}

class ProjectsStore {
  private state: ProjectsState = EMPTY;
  private readonly subs = new Set<() => void>();
  private readonly inflight = new Map<string, number>();
  private listGeneration = 0;
  private lastAcceptedListSeq = 0;
  private latestRevocationSeq = 0;
  /** Only admitted writes/deltas stamp this journal; reads never copy a possibly stale row into it. */
  private seq = 0;
  private changes = new Map<string, { at: number; project: ProjectView | null; source: "stream" | "write" }>();
  private accessVersion = 0;
  /** Only access invalidations, not ordinary removals, may reconsider a proved revocation. */
  private accessRevision = 0;
  private visibilityClock = 0;
  private detailGeneration = 0;
  private listFlight: Promise<void> | null = null;
  private listDirty = false;
  private accessPending = false;
  private viewerRemoved = false;
  private viewer: string | null = null;
  private readonly revokedChannels = new Set<string>();
  private readonly pendingDeltas: BoardDelta[] = [];
  private readonly detailDeltas = new Map<string, BoardDelta[]>();
  private readonly reloadCards = new Set<string>();
  private readonly reloadRooms = new Set<string>();

  get = (): ProjectsState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  };

  set(next: ProjectsState): void {
    if (next.status === "idle") { this.viewer = null; this.viewerRemoved = false; this.revokedChannels.clear(); this.pendingDeltas.length = 0; this.detailDeltas.clear(); }
    this.state = next;
    for (const fn of this.subs) fn();
  }

  accessGeneration(): number { return this.accessVersion; }

  /** All production writes pass here. Only a current list can change visibility. */
  private commit(
    permit: { kind: "list"; generation: number; startedAt: number } | { kind: "revoke"; generation: number }
      | { kind: "visible"; channel: string; generation: number }
      | { kind: "detail"; channel: string; generation: number; visibility: number | undefined },
    update: (state: ProjectsState) => ProjectsState,
  ): boolean {
    if (permit.kind === "list") {
      if (this.listDirty || permit.generation !== this.listGeneration
        || permit.startedAt <= this.lastAcceptedListSeq || permit.startedAt <= this.latestRevocationSeq) return false;
    } else if (permit.kind === "revoke") {
      if (permit.generation !== this.accessVersion) return false;
    } else if (permit.kind === "detail") {
      // An unrelated deletion invalidates write permits, but not this channel's read.
      // Access changes and removal/readmission of this channel still invalidate it.
      if (permit.generation !== this.accessRevision || !this.isVisible(permit.channel)
        || permit.visibility !== this.state.visibilityGeneration?.[permit.channel]) return false;
    } else if (this.accessPending || permit.generation !== this.accessVersion || this.state.status !== "ready"
      || !this.state.projects.some((p) => p.channel === permit.channel)) return false;
    const next = update(this.state);
    if (permit.kind === "list") this.lastAcceptedListSeq = permit.startedAt;
    this.set(next);
    return true;
  }

  isVisible(channel: string, generation = this.accessVersion): boolean {
    return !this.accessPending && generation === this.accessVersion && this.state.status === "ready"
      && this.state.projects.some((p) => p.channel === channel);
  }

  refresh(): Promise<void> {
    for (const key of this.inflight.keys()) {
      if (key.startsWith("room:")) this.reloadRooms.add(key.slice(5));
      else this.reloadCards.add(key);
    }
    this.detailGeneration += 1;
    if (this.listFlight) {
      this.listDirty = true;
      return this.listFlight;
    }
    this.listFlight = this.fetchLists();
    return this.listFlight;
  }

  private async fetchLists(): Promise<void> {
    do {
      this.listDirty = false;
      const generation = ++this.listGeneration;
      const startedAt = ++this.seq;
      this.changes = new Map();
      if (this.state.status === "idle") this.set({ ...this.state, status: "loading" });
      try {
        const r = await api.projects();
        // Every access change dirties this flight; an ordinary deletion instead stays in the journal.
        if (this.listDirty || generation !== this.listGeneration) continue;
        let visible = new Set<string>();
        const accepted = this.commit({ kind: "list", generation, startedAt }, (s) => {
          // A role demotion can reach the stream before the restricted channel update. Only a stream grant clears this guard.
          const reconciled = new Map(r.projects.map((p) => [p.channel, p]));
          for (const [channel, change] of this.changes) {
            if (change.at <= startedAt) continue;
            if (change.project && (change.source === "write" || reconciled.has(channel))) reconciled.set(channel, change.project);
            else reconciled.delete(channel);
          }
          const projects = this.viewerRemoved ? [] : [...reconciled.values()].filter((p) => !this.revokedChannels.has(p.channel));
          const stubs = this.viewerRemoved ? [] : r.stubs.filter((p) => !this.revokedChannels.has(p.channel)
            && this.changes.get(p.channel)?.project !== null);
          visible = new Set(projects.map((p) => p.channel));
          // A list can reveal access loss even without a roster event. Invalidate old write permits
          // before a later list readmits the channel; visibility alone is not a request permit.
          if (s.projects.some((p) => !visible.has(p.channel))) this.accessVersion += 1;
          const keep = <T>(entries: Record<string, T>): Record<string, T> =>
            Object.fromEntries(Object.entries(entries).filter(([channel]) => visible.has(channel)));
          this.accessPending = false;
          return { ...s, status: "ready", error: null, projects, stubs,
            visibilityGeneration: Object.fromEntries(projects.map((p) => [p.channel,
              s.visibilityGeneration?.[p.channel] ?? ++this.visibilityClock])),
            pageTicks: keep(s.pageTicks ?? {}), cards: keep(s.cards), cardsError: keep(s.cardsError),
            rooms: keep(s.rooms), roomsError: keep(s.roomsError) };
        });
        if (!accepted) continue;
        for (const delta of this.pendingDeltas) {
          if (visible.has(delta.channel) && this.isVisible(delta.channel)
            && this.changes.get(delta.channel)?.project !== null) this.applyProjectDelta(delta, this.accessVersion, false, "stream");
        }
        this.pendingDeltas.length = 0;
        for (const channel of this.reloadCards) if (visible.has(channel)) void this.loadCards(channel);
        for (const channel of this.reloadRooms) if (visible.has(channel)) void this.loadRoom(channel);
        this.reloadCards.clear();
        this.reloadRooms.clear();
      } catch (err) {
        if (this.listDirty || generation !== this.listGeneration) continue;
        const accessFailed = this.accessPending;
        const accepted = this.commit({ kind: "list", generation, startedAt }, (s) => ({ ...s,
          status: !accessFailed && s.projects.length ? "ready" : "error", error: friendlyError(err) }));
        if (accepted) { this.accessPending = false; this.pendingDeltas.length = 0; }
      }
    } while (this.listDirty);
    this.listFlight = null;
  }

  /** Evict only access losses proved by the event; an opaque change has one accepted list round-trip window. */
  accessChanged(event?: Pick<Event, "kind" | "body">, viewer?: string | null): Promise<void> {
    if (viewer !== undefined) {
      if (this.viewer && viewer !== this.viewer) {
        this.viewerRemoved = false;
        this.revokedChannels.clear();
        this.reloadCards.clear();
        this.reloadRooms.clear();
        this.set({ ...EMPTY, status: "loading" });
      }
      this.viewer = viewer;
    }
    this.changes = new Map();
    this.pendingDeltas.length = 0;
    this.accessVersion += 1;
    this.accessRevision += 1;
    this.latestRevocationSeq = this.seq;
    this.accessPending = true;
    if (event?.kind === "team.member" && viewer && event.body.handle === viewer) {
      if (this.viewerRemoved && event.body.role !== "removed") this.revokedChannels.clear();
      this.viewerRemoved = event.body.role === "removed";
      if (event.body.role === "owner") this.revokedChannels.clear();
    }
    if (event?.kind === "team.create") this.revokedChannels.clear();
    if (event?.kind === "channel.upsert" && viewer) {
      const body = event.body as { name?: unknown; members?: unknown; public?: unknown };
      if (typeof body.name === "string" && (body.public === true
        || (Array.isArray(body.members) && body.members.includes(viewer)))) this.revokedChannels.delete(body.name);
    }
    const hidden = this.revokedBy(event, viewer);
    for (const channel of hidden) this.revokedChannels.add(channel);
    // Publish the epoch even for opaque invalidations so private view-local caches can reset.
    this.commit({ kind: "revoke", generation: this.accessVersion }, (s) => {
      const keep = <T>(entries: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(entries).filter(([channel]) => !hidden.has(channel)));
      return { ...s, projects: s.projects.filter((p) => !hidden.has(p.channel)),
        stubs: s.stubs.filter((p) => !hidden.has(p.channel)), visibilityGeneration: keep(s.visibilityGeneration ?? {}),
        pageTicks: keep(s.pageTicks ?? {}), cards: keep(s.cards), cardsError: keep(s.cardsError),
        rooms: keep(s.rooms), roomsError: keep(s.roomsError) };
    });
    for (const channel of Object.keys(this.state.cards)) this.reloadCards.add(channel);
    for (const channel of Object.keys(this.state.rooms)) this.reloadRooms.add(channel);
    return this.refresh();
  }

  private revokedBy(event?: Pick<Event, "kind" | "body">, viewer?: string | null): Set<string> {
    if (!event || !viewer) return new Set();
    if (event.kind === "team.member") {
      const body = event.body as { handle?: unknown; role?: unknown };
      if (body.handle !== viewer) return new Set();
      if (body.role === "removed") return new Set([...this.state.projects, ...this.state.stubs].map((p) => p.channel));
      if (body.role !== "owner") return new Set(this.state.projects.filter((p) => p.private).map((p) => p.channel));
    }
    if (event.kind === "channel.upsert") {
      const body = event.body as { name?: unknown; members?: unknown; public?: unknown };
      if (typeof body.name === "string" && body.public !== true && Array.isArray(body.members)
        && body.members.every((member) => typeof member === "string") && !body.members.includes(viewer)) {
        return new Set([body.name]);
      }
    }
    return new Set();
  }

  async loadCards(channel: string): Promise<void> {
    if (this.accessPending) return;
    if (this.state.status !== "ready" || !this.state.projects.some((p) => p.channel === channel)) return;
    const generation = this.detailGeneration;
    const permit = { kind: "detail" as const, channel, generation: this.accessRevision,
      visibility: this.state.visibilityGeneration?.[channel] };
    if (this.inflight.get(channel) === generation) return;
    this.inflight.set(channel, generation);
    const initialProject = this.state.projects.find((p) => p.channel === channel);
    const deltas: BoardDelta[] = [];
    this.detailDeltas.set(channel, deltas);
    try {
      const r = await api.project(channel);
      if (!this.detailIsCurrent(channel, generation)) return;
      if (r.project.channel !== channel || r.cards.some((card) => card.channel !== channel)) throw new Error("project detail channel mismatch");
      if (deltas.some((delta) => delta.reset)) return;
      const { [channel]: _drop, ...errs } = this.state.cardsError;
      this.commit(permit, (s) => {
        const projects = s.projects.map((p) => (p.channel === channel ? (p === initialProject ? r.project : p) : p));
        const cards = deltas.reduce((list, delta) => applyDelta({ ...s, cards: { ...s.cards, [channel]: list } },
          { ...delta, project: undefined }).cards[channel] ?? list, r.cards);
        return { ...s, projects, cards: { ...s.cards, [channel]: cards }, cardsError: errs };
      });
    } catch (err) {
      if (!this.detailIsCurrent(channel, generation)) return;
      this.commit(permit, (s) => ({ ...s, cardsError: { ...s.cardsError, [channel]: friendlyError(err) } }));
    } finally {
      if (this.inflight.get(channel) === generation) this.inflight.delete(channel);
      if (this.detailDeltas.get(channel) === deltas) this.detailDeltas.delete(channel);
      if (deltas.some((delta) => delta.reset) && this.detailIsCurrent(channel, generation)) void this.loadCards(channel);
    }
  }

  private detailIsCurrent(channel: string, generation: number): boolean {
    return generation === this.detailGeneration && this.isVisible(channel);
  }

  delta(d: BoardDelta): void {
    if ((d.project && d.project.channel !== d.channel) || d.cards?.some((card) => card.channel !== d.channel)) return;
    // Removal cannot disclose data, and must survive an older access-list response.
    // Positive stream values and local writes still require current visibility.
    if (d.project === null || d.project?.state === "deleted") {
      this.applyProjectDelta(d, this.accessVersion, true);
      return;
    }
    if (this.accessPending) {
      this.pendingDeltas.push(d);
      return;
    }
    if (d.project && !this.state.projects.some((p) => p.channel === d.channel)) {
      void this.refresh();
      return;
    }
    if (!this.isVisible(d.channel)) return;
    this.applyProjectDelta(d, this.accessVersion, false, "stream");
    this.detailDeltas.get(d.channel)?.push(d);
    if (d.reset && this.state.cards[d.channel]) void this.loadCards(d.channel);
    if (d.room && this.state.rooms[d.channel]) void this.loadRoom(d.channel);
  }

  private applyProjectDelta(d: BoardDelta, generation: number, streamRemoval = false, source: "stream" | "write" = "write"): boolean {
    const project = d.project?.state === "deleted" ? null : d.project;
    const permit = streamRemoval && project === null ? { kind: "revoke" as const, generation }
      : { kind: "visible" as const, channel: d.channel, generation };
    return this.commit(permit, (s) => {
      if (project !== undefined) this.changes = new Map(this.changes).set(d.channel, { at: ++this.seq, project, source });
      const applied = applyDelta(s, { ...d, project });
      const next = d.page || d.room ? { ...applied,
        pageTicks: { ...applied.pageTicks, [d.channel]: (applied.pageTicks?.[d.channel] ?? 0) + 1 } } : applied;
      if (project !== null) return next;
      this.accessVersion += 1; // a later readmission must not revive an outstanding write
      const drop = <T>(entries: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(entries).filter(([channel]) => channel !== d.channel));
      return { ...next, stubs: s.stubs.filter((p) => p.channel !== d.channel),
        visibilityGeneration: drop(s.visibilityGeneration ?? {}), pageTicks: drop(s.pageTicks ?? {}), cards: drop(s.cards),
        cardsError: drop(s.cardsError), rooms: drop(s.rooms), roomsError: drop(s.roomsError) };
    });
  }

  /** A project's Data Room (every file, removed ones included: the view filters). */
  async loadRoom(channel: string): Promise<void> {
    if (this.accessPending) return;
    if (this.state.status !== "ready" || !this.state.projects.some((p) => p.channel === channel)) return;
    const key = `room:${channel}`;
    const generation = this.detailGeneration;
    const permit = { kind: "detail" as const, channel, generation: this.accessRevision,
      visibility: this.state.visibilityGeneration?.[channel] };
    if (this.inflight.get(key) === generation) return;
    this.inflight.set(key, generation);
    try {
      const r = await api.room(channel, true);
      if (!this.detailIsCurrent(channel, generation)) return;
      if (r.files.some((file) => file.channel !== channel)) throw new Error("room file channel mismatch");
      const { [channel]: _drop, ...errs } = this.state.roomsError;
      this.commit(permit, (s) => ({ ...s, rooms: { ...s.rooms, [channel]: r.files }, roomsError: errs }));
    } catch (err) {
      if (!this.detailIsCurrent(channel, generation)) return;
      this.commit(permit, (s) => ({ ...s, roomsError: { ...s.roomsError, [channel]: friendlyError(err) } }));
    } finally {
      if (this.inflight.get(key) === generation) this.inflight.delete(key);
    }
  }

  /** A file replaced by the server's answer to this tab's own write (before the delta arrives). */
  roomFile(f: RoomFileView, generation = this.accessVersion): void {
    this.commit({ kind: "visible", channel: f.channel, generation }, (s) => {
      const list = s.rooms[f.channel];
      if (!list) return s;
      const next = list.some((x) => x.id === f.id) ? list.map((x) => (x.id === f.id ? f : x)) : [...list, f];
      return { ...s, rooms: { ...s.rooms, [f.channel]: next } };
    });
  }

  card(card: CardView, generation = this.accessVersion): void {
    this.commit({ kind: "visible", channel: card.channel, generation }, (s) => withCard(s, card));
  }
  project(p: ProjectView, generation = this.accessVersion): boolean {
    return this.applyProjectDelta({ channel: p.channel, project: p }, generation);
  }

  /** After a reconnect: whatever was loaded is fetched again. */
  resync(): void {
    if (this.state.status === "idle") return;
    void this.accessChanged();
  }
}

export const projectsStore = new ProjectsStore();

export function useProjects(): ProjectsState {
  return useSyncExternalStore(projectsStore.subscribe, projectsStore.get, projectsStore.get);
}

/** How many times a project's status page or Data Room was said to have changed (a number that only goes up). */
export function usePageTick(channel: string): number {
  return useSyncExternalStore(projectsStore.subscribe, () => projectsStore.get().pageTicks?.[channel] ?? 0, () => 0);
}
