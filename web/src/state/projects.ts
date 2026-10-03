// Projects state for the dashboard (WALKIE-PROJECTS-1): the project list, and the cards of the projects opened so far.
// Loaded on demand, kept current by the stream's `board` deltas (state/store.tsx forwards them here).
import { useSyncExternalStore } from "react";
import { api, friendlyError } from "../api/client.ts";
import type { BoardDelta, CardView, ProjectStub, ProjectView, RoomFileView } from "../api/types.ts";

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
  /** Per project channel, how many times the stream said its status page or its Data Room changed (PROJECT-PAGES-1): an open page looks again. */
  pageTicks?: Record<string, number>;
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
  private readonly inflight = new Set<string>();

  get = (): ProjectsState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  };

  set(next: ProjectsState): void {
    this.state = next;
    for (const fn of this.subs) fn();
  }

  async refresh(): Promise<void> {
    if (this.state.status === "idle") this.set({ ...this.state, status: "loading" });
    try {
      const r = await api.projects();
      this.set({ ...this.state, status: "ready", error: null, projects: r.projects, stubs: r.stubs });
    } catch (err) {
      this.set({ ...this.state, status: this.state.projects.length ? "ready" : "error", error: friendlyError(err) });
    }
  }

  async loadCards(channel: string): Promise<void> {
    if (this.inflight.has(channel)) return;
    this.inflight.add(channel);
    try {
      const r = await api.project(channel);
      const { [channel]: _drop, ...errs } = this.state.cardsError;
      const projects = this.state.projects.some((p) => p.channel === channel)
        ? this.state.projects.map((p) => (p.channel === channel ? r.project : p)) : [...this.state.projects, r.project];
      this.set({ ...this.state, projects, cards: { ...this.state.cards, [channel]: r.cards }, cardsError: errs });
    } catch (err) {
      this.set({ ...this.state, cardsError: { ...this.state.cardsError, [channel]: friendlyError(err) } });
    } finally {
      this.inflight.delete(channel);
    }
  }

  delta(d: BoardDelta): void {
    const next = applyDelta(this.state, d);
    this.set(d.page || d.room ? { ...next, pageTicks: { ...next.pageTicks, [d.channel]: (next.pageTicks?.[d.channel] ?? 0) + 1 } } : next);
    if (d.reset && this.state.cards[d.channel]) void this.loadCards(d.channel);
    if (d.room && this.state.rooms[d.channel]) void this.loadRoom(d.channel);
  }

  /** A project's Data Room (every file, removed ones included: the view filters). */
  async loadRoom(channel: string): Promise<void> {
    const key = `room:${channel}`;
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    try {
      const r = await api.room(channel, true);
      const { [channel]: _drop, ...errs } = this.state.roomsError;
      this.set({ ...this.state, rooms: { ...this.state.rooms, [channel]: r.files }, roomsError: errs });
    } catch (err) {
      this.set({ ...this.state, roomsError: { ...this.state.roomsError, [channel]: friendlyError(err) } });
    } finally {
      this.inflight.delete(key);
    }
  }

  /** A file replaced by the server's answer to this tab's own write (before the delta arrives). */
  roomFile(f: RoomFileView): void {
    const list = this.state.rooms[f.channel];
    if (!list) return;
    const next = list.some((x) => x.id === f.id) ? list.map((x) => (x.id === f.id ? f : x)) : [...list, f];
    this.set({ ...this.state, rooms: { ...this.state.rooms, [f.channel]: next } });
  }

  card(card: CardView): void { this.set(withCard(this.state, card)); }
  project(p: ProjectView): void { this.set(applyDelta(this.state, { channel: p.channel, project: p })); }

  /** After a reconnect: whatever was loaded is fetched again. */
  resync(): void {
    if (this.state.status === "idle") return;
    void this.refresh();
    for (const ch of Object.keys(this.state.cards)) void this.loadCards(ch);
    for (const ch of Object.keys(this.state.rooms)) void this.loadRoom(ch);
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
