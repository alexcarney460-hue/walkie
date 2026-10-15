import { afterEach, beforeAll, expect, test } from "bun:test";
import { create, act, type ReactTestRenderer } from "react-test-renderer";
import type { ProjectView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import { installWindow } from "./window-stub.ts";

installWindow();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let api: typeof import("../src/api/client.ts").api;
let store: typeof import("../src/state/projects.ts").projectsStore;
let CreateProject: typeof import("../src/views/projects/CreateProject.tsx").CreateProject;
let StaticStore: typeof import("../src/state/store.tsx").StaticStore;
let initialState: State;
beforeAll(async () => {
  api = (await import("../src/api/client.ts")).api;
  store = (await import("../src/state/projects.ts")).projectsStore;
  CreateProject = (await import("../src/views/projects/CreateProject.tsx")).CreateProject;
  StaticStore = (await import("../src/state/store.tsx")).StaticStore;
  initialState = (await import("../src/state/reducer.ts")).initialState;
});
afterEach(() => {
  store.set({ status: "idle", error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  installWindow().location.hash = "#/projects";
});

const project: ProjectView = {
  channel: "p-new", id: "p-new:1", name: "New", prefix: "NEW", folder: "", description: "", paths: [],
  meter_mode: "count", automations: { pr_opened: false, pr_merged: false, agents_can_close: false },
  state: "active", private: false, admins: [], creator: "maren", created_at: 0, boards: [], cards: 0,
  meter: { mode: "count", done: 0, counted: 0, by_role: { backlog: 0, todo: 0, active: 0, review: 0, done: 0, cancelled: 0 } }, last_activity: 0,
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

async function mount(onClose: () => void): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<StaticStore state={initialState}><CreateProject onClose={onClose} /></StaticStore>); });
  await act(async () => { tree.root.findByProps({ id: "np-name" }).props.onChange({ target: { value: "New" } }); });
  return tree;
}

test("create navigates when its upsert precedes the create response", async () => {
  const originalCreate = api.createProject;
  const originalProjects = api.projects;
  const response = deferred<Awaited<ReturnType<typeof api.createProject>>>();
  (api as { createProject: typeof originalCreate }).createProject = async () => response.promise;
  (api as { projects: typeof originalProjects }).projects = async () => ({ projects: [project], stubs: [] });
  store.set({ status: "ready", error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  let closed = 0;
  const tree = await mount(() => { closed += 1; });
  try {
    await act(async () => { void tree.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    await act(async () => {
      await store.accessChanged({ kind: "channel.upsert", body: { name: project.channel, project: true, members: ["maren"] } }, "maren");
    });
    await act(async () => { response.resolve({ project }); });
    expect(installWindow().location.hash).toBe("#/projects/p-new");
    expect(closed).toBe(1);
  } finally {
    await act(async () => { tree.unmount(); });
    (api as { createProject: typeof originalCreate }).createProject = originalCreate;
    (api as { projects: typeof originalProjects }).projects = originalProjects;
  }
});

test("failed post-create refresh keeps the dialog open and retries without creating twice", async () => {
  const originalCreate = api.createProject;
  const originalProjects = api.projects;
  let creates = 0;
  let lists = 0;
  (api as { createProject: typeof originalCreate }).createProject = async () => { creates += 1; return { project }; };
  (api as { projects: typeof originalProjects }).projects = async () => {
    if (++lists === 1) throw new Error("list unavailable");
    return { projects: [project], stubs: [] };
  };
  store.set({ status: "ready", error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  let closed = 0;
  const tree = await mount(() => { closed += 1; });
  try {
    await act(async () => { void tree.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    expect(closed).toBe(0);
    expect(tree.root.findByProps({ role: "alert" }).children.join("")).toContain("Try again");
    expect(tree.root.findByProps({ children: "Retry" }).props.type).toBe("submit");
    await act(async () => { void tree.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    expect(closed).toBe(1);
    expect(installWindow().location.hash).toBe("#/projects/p-new");
    expect(creates).toBe(1);
  } finally {
    await act(async () => { tree.unmount(); });
    (api as { createProject: typeof originalCreate }).createProject = originalCreate;
    (api as { projects: typeof originalProjects }).projects = originalProjects;
  }
});

for (const revoked of [false, true]) {
  test(`real CreateProject waits past an obsolete list${revoked ? " and rejects revoked admission" : " before navigation"}`, async () => {
    const originalCreate = api.createProject;
    const originalList = api.projects;
    const old = deferred<Awaited<ReturnType<typeof api.projects>>>();
    const current = deferred<Awaited<ReturnType<typeof api.projects>>>();
    const response = deferred<Awaited<ReturnType<typeof api.createProject>>>();
    let lists = 0;
    api.projects = () => ++lists === 1 ? old.promise : current.promise;
    api.createProject = () => response.promise;
    store.set({ status: "ready", error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
    const pending = store.refresh();
    let closed = 0;
    const tree = await mount(() => { closed += 1; });
    try {
      await act(async () => { void tree.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
      let access: Promise<void> | undefined;
      if (revoked) access = store.accessChanged({ kind: "channel.upsert", body: { name: project.channel, members: [] } }, "maren");
      await act(async () => { response.resolve({ project }); });
      expect(store.get().projects).toEqual([]);
      expect(closed).toBe(0);
      await act(async () => { old.resolve({ projects: [], stubs: [] }); });
      expect(lists).toBe(2);
      expect(closed).toBe(0);
      await act(async () => {
        current.resolve({ projects: [project], stubs: [] });
        await pending;
        await access;
      });
      expect(closed).toBe(revoked ? 0 : 1);
      expect(store.get().projects).toEqual(revoked ? [] : [project]);
      expect(installWindow().location.hash).toBe(revoked ? "#/projects" : "#/projects/p-new");
      if (revoked) expect(tree.root.findByProps({ role: "alert" }).children.join("")).toContain("not visible yet");
    } finally {
      await act(async () => { tree.unmount(); });
      api.createProject = originalCreate;
      api.projects = originalList;
    }
  });
}
