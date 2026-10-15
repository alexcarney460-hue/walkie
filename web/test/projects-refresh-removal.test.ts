import { afterEach, beforeEach, expect, test } from "bun:test";
import { api, ApiError } from "../src/api/client.ts";
import type { ProjectView, ProjectsPayload } from "../src/api/types.ts";
import { projectsStore as store } from "../src/state/projects.ts";
import { resetProjectsStore } from "./projects-store-fixture.ts";

const project = (channel: string): ProjectView => ({
  channel, id: `${channel}:1`, name: channel, prefix: "TEST", folder: "", description: "", paths: [],
  meter_mode: "count", automations: { pr_opened: false, pr_merged: false, agents_can_close: false },
  state: "active", private: false, admins: [], creator: "maren", created_at: 0, boards: [], cards: 0,
  meter: { mode: "count", done: 0, counted: 0, by_role: { backlog: 0, todo: 0, active: 0, review: 0, done: 0, cancelled: 0 } },
  last_activity: 0,
});
const alpha = project("p-alpha");
const beta = project("p-beta");
const stub = { channel: beta.channel, private: true as const, stub: true as const, members: ["maren"] };
const original = { projects: api.projects, project: api.project, room: api.room };
const empty = () => ({ status: "idle" as const, error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetProjectsStore();
  store.set({ ...empty(), status: "ready", projects: [alpha, beta],
    cards: { [beta.channel]: [] }, rooms: { [beta.channel]: [] },
    cardsError: { [beta.channel]: "old cards error" }, roomsError: { [beta.channel]: "old room error" },
    pageTicks: { [beta.channel]: 7 }, visibilityGeneration: { [alpha.channel]: 1, [beta.channel]: 2 } });
  api.project = async (channel) => ({ project: channel === alpha.channel ? alpha : beta, cards: [] });
  api.room = async () => ({ files: [] });
});
afterEach(() => {
  api.projects = original.projects; api.project = original.project; api.room = original.room;
  resetProjectsStore();
});

for (const trigger of ["reconnect", "unrelated member"] as const) {
  for (const form of ["null", "deleted value"] as const) {
    test(`stream ${form} evicts cached data during ${trigger} and beats the old list`, async () => {
      const list = deferred<ProjectsPayload>();
      api.projects = () => list.promise;
      const pending = trigger === "reconnect" ? (store.resync(), undefined)
        : store.accessChanged({ kind: "team.member", body: { handle: "someone-else", role: "member" } }, "maren");
      store.delta({ channel: beta.channel, project: form === "null" ? null : { ...beta, state: "deleted" } });
      const immediate = store.get();
      list.resolve({ projects: [alpha, beta], stubs: [] });
      await pending; await Bun.sleep(0);
      expect(immediate.projects).toEqual([alpha]);
      for (const state of [immediate, store.get()]) {
        expect(state.projects).toEqual([alpha]);
        expect(state.cards[beta.channel]).toBeUndefined();
        expect(state.rooms[beta.channel]).toBeUndefined();
        expect(state.cardsError[beta.channel]).toBeUndefined();
        expect(state.roomsError[beta.channel]).toBeUndefined();
        expect(state.pageTicks?.[beta.channel]).toBeUndefined();
        expect(state.visibilityGeneration?.[beta.channel]).toBeUndefined();
      }
    });
  }
}

for (const listed of ["unknown", "stub"] as const) {
  test(`a stream tombstone also excludes an ${listed} channel from an older access response`, async () => {
    store.set({ ...store.get(), projects: [alpha], stubs: listed === "stub" ? [stub] : [] });
    const list = deferred<ProjectsPayload>();
    api.projects = () => list.promise;
    const pending = store.accessChanged();
    store.delta({ channel: beta.channel, project: null });
    const immediate = store.get();
    list.resolve({ projects: [alpha], stubs: [stub] });
    await pending;
    expect(immediate.stubs).toEqual([]);
    expect(store.get().stubs).toEqual([]);
    expect(store.get().cards[beta.channel]).toBeUndefined();
  });
}

test("a failed access refresh cannot retain a project whose stream deletion was observed", async () => {
  const list = deferred<ProjectsPayload>();
  api.projects = () => list.promise;
  const pending = store.accessChanged();
  store.delta({ channel: beta.channel, project: null });
  list.reject(new ApiError("network", "offline", 0));
  await pending;
  expect(store.get().status).toBe("error");
  expect(store.get().projects).toEqual([alpha]);
  expect(store.get().rooms[beta.channel]).toBeUndefined();
});

test("a later fresh list may readmit a deleted channel but cannot revive its old write permit", async () => {
  const oldPermit = store.accessGeneration();
  const list = deferred<ProjectsPayload>();
  api.projects = () => list.promise;
  const pending = store.accessChanged();
  store.delta({ channel: beta.channel, project: null });
  list.resolve({ projects: [alpha, beta], stubs: [] });
  await pending;
  const afterOldList = store.get().projects;
  api.projects = async () => ({ projects: [alpha, beta], stubs: [] });
  await store.refresh();
  expect(afterOldList).toEqual([alpha]);
  expect(store.get().projects).toEqual([alpha, beta]);
  expect(store.project({ ...beta, name: "stale write" }, oldPermit)).toBe(false);
  expect(store.get().projects).toEqual([alpha, beta]);
});

test("stream removal does not admit positive deltas or local write completions during an access refresh", async () => {
  const list = deferred<ProjectsPayload>();
  api.projects = () => list.promise;
  const pending = store.accessChanged();
  const permit = store.accessGeneration();
  const writeAccepted = store.project({ ...alpha, state: "deleted" }, permit);
  store.delta({ channel: beta.channel, project: null });
  store.delta({ channel: beta.channel, project: { ...beta, name: "unadmitted name" } });
  list.resolve({ projects: [alpha, beta], stubs: [] });
  await pending;
  expect(writeAccepted).toBe(false);
  expect(store.get().projects).toEqual([alpha]);
});

test("a mismatched stream payload cannot evict a channel during an access refresh", async () => {
  const list = deferred<ProjectsPayload>();
  api.projects = () => list.promise;
  const pending = store.accessChanged();
  store.delta({ channel: alpha.channel, project: { ...beta, state: "deleted" } });
  list.resolve({ projects: [alpha, beta], stubs: [] });
  await pending;
  expect(store.get().projects).toEqual([alpha, beta]);
});
