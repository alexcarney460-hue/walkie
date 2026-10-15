import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ReactNode } from "react";
import type { CardView, ProjectView, RoomFileView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import { installWindow } from "./window-stub.ts";

const hadWindow = "window" in globalThis;
const hadDocument = "document" in globalThis;
installWindow();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const inert: unknown = new Proxy(() => inert, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : inert), apply: () => undefined });
(globalThis as { document?: unknown }).document ??= inert;
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  if (!hadDocument) delete (globalThis as { document?: unknown }).document;
});

let store: typeof import("../src/state/projects.ts").projectsStore;
let api: typeof import("../src/api/client.ts").api;
let ProjectBoard: typeof import("../src/views/projects/ProjectBoard.tsx").ProjectBoard;
let StaticStore: (p: { state: State; children: ReactNode }) => ReactNode;
let changesProjectAccess: typeof import("../src/state/store.tsx").changesProjectAccess;
let initialState: State;
beforeAll(async () => {
  store = (await import("../src/state/projects.ts")).projectsStore;
  api = (await import("../src/api/client.ts")).api;
  ProjectBoard = (await import("../src/views/projects/ProjectBoard.tsx")).ProjectBoard;
  const stateModule = await import("../src/state/store.tsx");
  StaticStore = stateModule.StaticStore;
  changesProjectAccess = stateModule.changesProjectAccess;
  initialState = (await import("../src/state/reducer.ts")).initialState;
});
afterEach(() => store.set({ status: "idle", error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} }));

const project = (channel: string): ProjectView => ({
  channel, id: `${channel}:1`, name: channel, prefix: "TEST", folder: "", description: "", paths: [],
  meter_mode: "count", automations: { pr_opened: false, pr_merged: false, agents_can_close: false },
  state: "active", private: true, admins: [], creator: "maren", created_at: 0, boards: [], cards: 0,
  meter: { mode: "count", done: 0, counted: 0, by_role: { backlog: 0, todo: 0, active: 0, review: 0, done: 0, cancelled: 0 } }, last_activity: 0,
});
const P = project("p-private");
const Q = project("p-visible");
const base = () => ({ status: "ready" as const, error: null, projects: [P, Q], stubs: [], cards: { [P.channel]: [], [Q.channel]: [] }, cardsError: {}, rooms: { [P.channel]: [], [Q.channel]: [] }, roomsError: {} });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test("only member, team identity, and project-channel roster events invalidate project access", () => {
  store.set(base());
  expect(changesProjectAccess({ kind: "team.create", body: {} })).toBe(true);
  expect(changesProjectAccess({ kind: "team.member", body: { role: "removed" } })).toBe(true);
  expect(changesProjectAccess({ kind: "channel.upsert", body: { name: "p-private", members: [] } })).toBe(true);
  expect(changesProjectAccess({ kind: "channel.upsert", body: { name: "p-new", project: true } })).toBe(true);
  expect(changesProjectAccess({ kind: "channel.upsert", body: { name: "p-ordinary", members: [] } })).toBe(false);
  expect(changesProjectAccess({ kind: "channel.upsert", body: { name: "general", members: [] } })).toBe(false);
  expect(changesProjectAccess({ kind: "team.node", body: { revoked: true } })).toBe(false);
  expect(changesProjectAccess({ kind: "team.license", body: {} })).toBe(false);
});

test("an older detail response cannot restore a project removed by a newer list", async () => {
  const originalProject = api.project;
  const originalProjects = api.projects;
  const detail = deferred<Awaited<ReturnType<typeof api.project>>>();
  (api as { project: typeof originalProject }).project = async (channel) => channel === P.channel ? detail.promise : { project: Q, cards: [] };
  (api as { projects: typeof originalProjects }).projects = async () => ({ projects: [Q], stubs: [] });
  store.set(base());
  try {
    const old = store.loadCards(P.channel);
    await store.accessChanged();
    detail.resolve({ project: P, cards: [] });
    await old;
    expect(store.get().projects).toEqual([Q]);
    expect(store.get().cards[P.channel]).toBeUndefined();
    expect(store.get().rooms[P.channel]).toBeUndefined();
  } finally {
    (api as { project: typeof originalProject }).project = originalProject;
    (api as { projects: typeof originalProjects }).projects = originalProjects;
  }
});

test("every project writer drops a response resolved after access was revoked", async () => {
  const original = api.projects;
  (api as { projects: typeof original }).projects = async () => ({ projects: [Q], stubs: [] });
  store.set(base());
  const before = store.accessGeneration();
  const card = { id: "card:1", channel: P.channel } as CardView;
  const file = { id: "file:1", channel: P.channel } as RoomFileView;
  try {
    await store.accessChanged();
    store.project(P, before); // settings, archive, restore, membership and create responses
    store.project(P); // even a caller that fails to retain its request generation
    store.card(card, before); // card and board writes
    store.card(card);
    store.roomFile(file, before);
    store.roomFile(file);
    store.delta({ channel: P.channel, project: P, cards: [card] });
    expect(store.get().projects).toEqual([Q]);
    expect(store.get().cards[P.channel]).toBeUndefined();
    expect(store.get().rooms[P.channel]).toBeUndefined();
  } finally {
    (api as { projects: typeof original }).projects = original;
  }
});

test("an old write cannot apply after the same project is revoked then restored", async () => {
  const original = api.projects;
  let visible = false;
  (api as { projects: typeof original }).projects = async () => ({ projects: visible ? [P, Q] : [Q], stubs: [] });
  store.set(base());
  const before = store.accessGeneration();
  try {
    await store.accessChanged();
    visible = true;
    await store.accessChanged();
    store.project({ ...P, name: "stale settings" }, before);
    expect(store.get().projects.find((p) => p.channel === P.channel)?.name).toBe(P.name);
  } finally {
    (api as { projects: typeof original }).projects = original;
  }
});

test("a private channel removal evicts its project before the access list resolves", async () => {
  const original = api.projects;
  const list = deferred<Awaited<ReturnType<typeof api.projects>>>();
  (api as { projects: typeof original }).projects = async () => list.promise;
  store.set(base());
  try {
    const pending = store.accessChanged({ kind: "channel.upsert", body: { name: P.channel, members: ["someone-else"] } }, "maren");
    const immediate = store.get();
    list.resolve({ projects: [Q], stubs: [] });
    await pending;
    expect(immediate.projects).toEqual([Q]);
    expect(immediate.cards[P.channel]).toBeUndefined();
    expect(immediate.rooms[P.channel]).toBeUndefined();
    expect(immediate.status).toBe("ready");
  } finally {
    (api as { projects: typeof original }).projects = original;
  }
});

test("removing the viewer from the team immediately evicts every project", async () => {
  const original = api.projects;
  const list = deferred<Awaited<ReturnType<typeof api.projects>>>();
  (api as { projects: typeof original }).projects = async () => list.promise;
  store.set({ ...base(), stubs: [{ channel: "p-stub", private: true, stub: true, members: ["maren"] }] });
  try {
    const pending = store.accessChanged({ kind: "team.member", body: { handle: "maren", role: "removed" } }, "maren");
    const immediate = store.get();
    list.resolve({ projects: [], stubs: [] });
    await pending;
    expect(immediate.projects).toEqual([]);
    expect(immediate.stubs).toEqual([]);
    expect(immediate.cards).toEqual({});
  } finally {
    (api as { projects: typeof original }).projects = original;
  }
});

test("an old list cannot undo a proved revocation; a later grant can restore it", async () => {
  const original = api.projects;
  (api as { projects: typeof original }).projects = async () => ({ projects: [P, Q], stubs: [] });
  store.set(base());
  try {
    await store.accessChanged({ kind: "channel.upsert", body: { name: P.channel, members: [] } }, "maren");
    expect(store.get().projects).toEqual([Q]);
    await store.accessChanged({ kind: "channel.upsert", body: { name: P.channel, members: ["maren"] } }, "maren");
    expect(store.get().projects).toEqual([P, Q]);
  } finally {
    (api as { projects: typeof original }).projects = original;
  }
});

test("a later authoritative list restores a revoked project without a reload", async () => {
  const original = api.projects;
  (api as { projects: typeof original }).projects = async () => ({ projects: [P, Q], stubs: [] });
  store.set(base());
  try {
    await store.accessChanged({ kind: "channel.upsert", body: { name: P.channel, members: [] } }, "maren");
    expect(store.get().projects).toEqual([Q]);
    await store.accessChanged({ kind: "team.create", body: {} }, "maren");
    expect(store.get().projects).toEqual([P, Q]);
  } finally {
    (api as { projects: typeof original }).projects = original;
  }
});

test("a new viewer clears the previous viewer's revocations before their list resolves", async () => {
  const original = api.projects;
  const nextViewer = deferred<Awaited<ReturnType<typeof api.projects>>>();
  let requests = 0;
  (api as { projects: typeof original }).projects = async () => ++requests === 1
    ? { projects: [P, Q], stubs: [] } : nextViewer.promise;
  store.set(base());
  try {
    await store.accessChanged({ kind: "channel.upsert", body: { name: P.channel, members: [] } }, "maren");
    expect(store.get().projects).toEqual([Q]);
    const pending = store.accessChanged(undefined, "kira");
    expect(store.get().projects).toEqual([]);
    nextViewer.resolve({ projects: [P], stubs: [] });
    await pending;
    expect(store.get().projects).toEqual([P]);
  } finally {
    (api as { projects: typeof original }).projects = original;
  }
});

test("a mounted board reloads cards through its effect when visibility returns", async () => {
  const originalProjects = api.projects;
  const originalProject = api.project;
  const originalRoom = api.room;
  const author = { handle: "maren", node: "node" };
  const board = { id: "board:1", name: "Main", state: "active" as const, created_at: 0, created_by: author,
    columns: [{ id: "todo", name: "To do", role: "todo" as const }], meter: P.meter, live_cards: 1 };
  const restored = { ...P, boards: [board] };
  const card = { id: "card:1", channel: P.channel, board: board.id, key: "TEST-1", n: 1, short: "0000", ref: "TEST-1-0000",
    title: "Restored card", body: "", column: "todo", pos: "m", assignee: null, reviewer: null, labels: [], estimate: null,
    due: null, blocked: false, blocked_reason: null, state: "open" as const, created_at: 0, created_by: author,
    updated_at: 0, updated_by: author, comments: 0, rev: 0 };
  let visible = true;
  let detailRequests = 0;
  (api as { projects: typeof originalProjects }).projects = async () => ({ projects: visible ? [restored, Q] : [Q], stubs: [] });
  (api as { project: typeof originalProject }).project = async () => { detailRequests += 1; return { project: restored, cards: [card] }; };
  (api as { room: typeof originalRoom }).room = async () => ({ files: [], limits: { files: 1000, versions: 100 } });
  store.set({ ...base(), status: "loading", cards: {}, rooms: {}, visibilityGeneration: { [P.channel]: 1 } });
  let tree: ReactTestRenderer | undefined;
  try {
    await act(async () => { tree = create(<StaticStore state={initialState}><ProjectBoard channel={P.channel} /></StaticStore>); });
    expect(detailRequests).toBe(0);
    visible = false;
    await act(async () => { await store.accessChanged(); });
    expect(store.get().projects).toEqual([Q]);
    expect(store.get().cards[P.channel]).toBeUndefined();
    expect(JSON.stringify(tree.toJSON())).toContain("no longer available");
    visible = true;
    await act(async () => { await store.accessChanged(); });
    expect(store.get().visibilityGeneration?.[P.channel]).toBeGreaterThan(1);
    expect(detailRequests).toBe(1);
    expect(JSON.stringify(tree.toJSON())).toContain("Restored card");
  } finally {
    if (tree) await act(async () => { tree?.unmount(); });
    (api as { projects: typeof originalProjects }).projects = originalProjects;
    (api as { project: typeof originalProject }).project = originalProject;
    (api as { room: typeof originalRoom }).room = originalRoom;
  }
});

test("a board removal drops cached cards and advances the key if the list restores it", async () => {
  const original = api.projects;
  (api as { projects: typeof original }).projects = async () => ({ projects: [P, Q], stubs: [] });
  store.set(base());
  try {
    await store.refresh();
    const before = store.get().visibilityGeneration?.[P.channel] ?? 0;
    store.delta({ channel: P.channel, project: null });
    expect(store.get().projects).toEqual([Q]);
    expect(store.get().cards[P.channel]).toBeUndefined();
    await store.refresh();
    expect(store.get().visibilityGeneration?.[P.channel]).toBeGreaterThan(before);
  } finally {
    (api as { projects: typeof original }).projects = original;
  }
});

test("an older room response cannot restore files for a removed project", async () => {
  const originalRoom = api.room;
  const originalProjects = api.projects;
  const room = deferred<Awaited<ReturnType<typeof api.room>>>();
  (api as { room: typeof originalRoom }).room = async (channel) => channel === P.channel ? room.promise : { files: [], limits: { files: 1000, versions: 100 } };
  (api as { projects: typeof originalProjects }).projects = async () => ({ projects: [Q], stubs: [] });
  store.set(base());
  try {
    const old = store.loadRoom(P.channel);
    await store.accessChanged();
    room.resolve({ files: [], limits: { files: 1000, versions: 100 } });
    await old;
    expect(store.get().rooms[P.channel]).toBeUndefined();
  } finally {
    (api as { room: typeof originalRoom }).room = originalRoom;
    (api as { projects: typeof originalProjects }).projects = originalProjects;
  }
});

test("an in-flight board detail is retried after its project remains visible", async () => {
  const originalProject = api.project;
  const originalProjects = api.projects;
  const oldDetail = deferred<Awaited<ReturnType<typeof api.project>>>();
  let requests = 0;
  (api as { project: typeof originalProject }).project = async () => (++requests === 1 ? oldDetail.promise : { project: P, cards: [] });
  (api as { projects: typeof originalProjects }).projects = async () => ({ projects: [P], stubs: [] });
  store.set({ ...base(), projects: [P], cards: {}, rooms: {} });
  try {
    const old = store.loadCards(P.channel);
    await store.accessChanged();
    oldDetail.resolve({ project: P, cards: [] });
    await old;
    await Bun.sleep(0);
    expect(requests).toBe(2);
    expect(store.get().cards[P.channel]).toEqual([]);
  } finally {
    (api as { project: typeof originalProject }).project = originalProject;
    (api as { projects: typeof originalProjects }).projects = originalProjects;
  }
});

test("twelve rapid access invalidations use at most two list requests and never clear visible data", async () => {
  const original = api.projects;
  const first = deferred<Awaited<ReturnType<typeof api.projects>>>();
  const second = deferred<Awaited<ReturnType<typeof api.projects>>>();
  let requests = 0;
  (api as { projects: typeof original }).projects = async () => (++requests === 1 ? first.promise : second.promise);
  store.set(base());
  const snapshots: string[][] = [];
  const unsubscribe = store.subscribe(() => snapshots.push(store.get().projects.map((p) => p.channel)));
  try {
    const pending = Array.from({ length: 12 }, () => store.accessChanged());
    expect(requests).toBe(1);
    expect(store.get().projects).toEqual([P, Q]);
    first.resolve({ projects: [P, Q], stubs: [] });
    await Bun.sleep(0);
    expect(requests).toBe(2);
    second.resolve({ projects: [Q], stubs: [] });
    await Promise.all(pending);
    expect(requests).toBe(2);
    expect(snapshots.every((channels) => channels.length > 0)).toBe(true);
    expect(store.get().projects).toEqual([Q]);
    expect(store.get().cards[P.channel]).toBeUndefined();
  } finally {
    unsubscribe();
    (api as { projects: typeof original }).projects = original;
  }
});

test("an open board shows unavailable when its project leaves the visible list", async () => {
  const original = api.projects;
  (api as { projects: typeof original }).projects = async () => ({ projects: [Q], stubs: [] });
  store.set(base());
  try {
    await store.accessChanged();
    const html = renderToStaticMarkup(<StaticStore state={initialState}><ProjectBoard channel={P.channel} /></StaticStore>);
    expect(html).toContain("This project is no longer available to you");
    expect(html).toContain('href="#/projects"');
  } finally {
    (api as { projects: typeof original }).projects = original;
  }
});

test("a list error on an open board shows its error and Retry", async () => {
  const original = api.projects;
  const { ApiError } = await import("../src/api/client.ts");
  (api as { projects: typeof original }).projects = async () => { throw new ApiError("server_error", "list unavailable", 503); };
  store.set({ ...base(), projects: [], cards: {}, rooms: {} });
  try {
    await store.accessChanged();
    const html = renderToStaticMarkup(<StaticStore state={initialState}><ProjectBoard channel={P.channel} /></StaticStore>);
    expect(html).toContain("list unavailable");
    expect(html).toContain("Retry");
  } finally {
    (api as { projects: typeof original }).projects = original;
  }
});

test("a plain list removal and readmission also invalidates an outstanding write", async () => {
  const original = api.projects;
  let visible = false;
  api.projects = async () => ({ projects: visible ? [P] : [], stubs: [] });
  store.set({ ...base(), projects: [P], cards: {}, rooms: {} });
  const before = store.accessGeneration();
  try {
    await store.refresh();
    visible = true;
    await store.refresh();
    store.project({ ...P, name: "Old write after list removal" }, before);
    expect(store.get().projects).toEqual([P]);
  } finally { api.projects = original; }
});

test("a board removal and readmission invalidates writes sent before removal", async () => {
  const original = api.projects;
  api.projects = async () => ({ projects: [P], stubs: [] });
  store.set({ ...base(), projects: [P], cards: {}, rooms: {} });
  const before = store.accessGeneration();
  try {
    store.delta({ channel: P.channel, project: null });
    await store.refresh();
    store.project({ ...P, name: "Old write after board removal" }, before);
    expect(store.get().projects).toEqual([P]);
  } finally { api.projects = original; }
});

test("an unrelated list or board removal cannot grant a proved revoked channel", async () => {
  const original = api.projects;
  let listed = [P, Q];
  api.projects = async () => ({ projects: listed, stubs: [] });
  store.set({ ...base(), cards: {}, rooms: {} });
  try {
    await store.accessChanged({ kind: "channel.upsert", body: { name: P.channel, members: [] } }, "maren");
    expect(store.get().projects).toEqual([Q]);
    listed = [P];
    await store.refresh(); // Q leaves the list and invalidates pending write permits
    await store.refresh(); // no actual access event has granted P
    expect(store.get().projects).toEqual([]);
    listed = [P, Q];
    await store.refresh();
    store.delta({ channel: Q.channel, project: null });
    await store.refresh();
    expect(store.get().projects).toEqual([Q]);
  } finally { api.projects = original; }
});
