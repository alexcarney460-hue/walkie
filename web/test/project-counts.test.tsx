import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentView, NodeView, ProjectView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import { go, installWindow } from "./window-stub.ts";

const hadWindow = "window" in globalThis;
const hadDocument = "document" in globalThis;
installWindow();
const inert: unknown = new Proxy(() => inert, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : inert), apply: () => undefined });
(globalThis as { document?: unknown }).document ??= inert;
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  if (!hadDocument) delete (globalThis as { document?: unknown }).document;
});

let count: typeof import("../src/lib/project-counts.ts").projectCounts;
let MissionControl: () => ReactNode;
let StaticStore: (p: { state: State; children: ReactNode }) => ReactNode;
let initialState: State;
let projectsStore: typeof import("../src/state/projects.ts").projectsStore;
let api: typeof import("../src/api/client.ts").api;
beforeAll(async () => {
  count = (await import("../src/lib/project-counts.ts")).projectCounts;
  MissionControl = (await import("../src/views/mission/MissionControl.tsx")).MissionControl;
  StaticStore = (await import("../src/state/store.tsx")).StaticStore;
  initialState = (await import("../src/state/reducer.ts")).initialState;
  projectsStore = (await import("../src/state/projects.ts")).projectsStore;
  api = (await import("../src/api/client.ts")).api;
});
afterEach(() => projectsStore.set({ status: "idle", error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} }));

const meter = { mode: "count" as const, done: 0, counted: 0, by_role: { backlog: 0, todo: 0, active: 0, review: 0, done: 0, cancelled: 0 } };
const project = (name: string, prefix: string, channel: string, paths: ProjectView["paths"] = []): ProjectView => ({
  channel, id: `${channel}:1`, name, prefix, paths, folder: "", description: "", meter_mode: "count", meter,
  automations: { pr_opened: false, pr_merged: false, agents_can_close: false }, state: "active", steward: "off", steward_node: "",
  private: false, admins: [], creator: "maren", created_at: 0, boards: [], cards: 0, last_activity: 0,
});
const WALKIE = project("Walkie", "WALK", "p-walk", [{ path: "~/work/walkie" }, { repo: "walkie" }]);
const SEQUENCE = project("Sequence platform", "SEQ", "p-seq", [{ path: "~/work/sequence" }]);
const OPS = project("Fleet ops", "OPS", "p-ops", [{ repo: "ops" }]);
const NODE: NodeView = { node_id: "n1", handle: "maren", hostname: "mbp", ip: "100.64.0.1", online: true,
  last_seen: Date.now(), rtt_ms: 0, self: true, sync: { behind: 0, last_sync: Date.now() } };
const agent = (name: string, status: Partial<AgentView["status"]> = {}, effective_state: AgentView["effective_state"] = "working"): AgentView => ({
  id: `maren/mbp/${name}`, handle: "maren", node: "n1", hostname: "mbp", agent: name,
  status: { agent: name, state: effective_state, runtime: "claude-code", ...status },
  updated_at: Date.now(), machine_online: true, effective_state, archived: false,
});

test("counts task and branch keys before path and repo; longest path before repo", () => {
  const agents = [
    agent("task", { task: "WALK-80", branch: "SEQ-2", cwd: "~/work/sequence", repo: "ops" }),
    agent("branch", { branch: "feat/SEQ-2", cwd: "~/work/walkie", repo: "ops" }),
    agent("path", { cwd: "~/work/sequence/app", repo: "ops" }),
    agent("repo", { repo: "OPS" }),
  ];
  expect(count(agents, [WALKIE, SEQUENCE, OPS])).toEqual([
    { channel: SEQUENCE.channel, name: SEQUENCE.name, prefix: SEQUENCE.prefix, count: 2 },
    { channel: OPS.channel, name: OPS.name, prefix: OPS.prefix, count: 1 },
    { channel: WALKIE.channel, name: WALKIE.name, prefix: WALKIE.prefix, count: 1 },
  ]);
});

test("the most specific matching path wins regardless of project order", () => {
  const nested = project("Nested", "NEST", "p-nest", [{ path: "~/work/sequence/app" }]);
  expect(count([agent("nested", { cwd: "~/work/sequence/app/src", repo: "walkie" })], [SEQUENCE, WALKIE, nested])).toEqual([
    { channel: nested.channel, name: nested.name, prefix: nested.prefix, count: 1 },
  ]);
});

test("unmatched agents go into a trailing No project chip", () => {
  expect(count([agent("assigned", { repo: "walkie" }), agent("unknown")], [WALKIE])).toEqual([
    { channel: WALKIE.channel, name: WALKIE.name, prefix: WALKIE.prefix, count: 1 },
    { channel: null, name: "No project", prefix: null, count: 1 },
  ]);
});

test("sorts project counts descending, then names; No project remains last even if largest", () => {
  const agents = [agent("a", { repo: "walkie" }), agent("b", { repo: "ops" }), agent("c", { repo: "walkie" }), ...[1, 2, 3].map((n) => agent(`none-${n}`))];
  expect(count(agents, [OPS, WALKIE]).map((x) => x.name)).toEqual(["Walkie", "Fleet ops", "No project"]);
  expect(count([agent("a", { repo: "ops" }), agent("b", { repo: "walkie" })], [WALKIE, OPS]).map((x) => x.name)).toEqual(["Fleet ops", "Walkie"]);
});

test("empty shown list hides the row, but a loaded empty project list counts unmatched agents", () => {
  expect(count([], [WALKIE])).toEqual([]);
  expect(count([agent("a")], [])).toEqual([{ channel: null, name: "No project", prefix: null, count: 1 }]);
  expect(count([agent("a", { repo: "walkie" })], [WALKIE]).some((x) => x.channel === null)).toBe(false);
});

test("Mission Control renders counts from the shown roster, excluding idle, offline and archived agents", () => {
  go("#/mission");
  projectsStore.set({ ...projectsStore.get(), status: "ready", projects: [WALKIE, SEQUENCE] });
  const agents = [
    agent("w1", { branch: "WALK-80" }),
    agent("w2", { repo: "walkie" }, "waiting"),
    agent("s1", { branch: "SEQ-2" }, "blocked"),
    agent("none"),
    { ...agent("idle", { repo: "walkie" }, "idle"), updated_at: Date.now() - 40 * 60_000, archived: true },
    agent("offline", { task: "WALK-80" }, "offline"),
  ];
  const state: State = { ...initialState, phase: "ready", agents, nodes: [NODE], team: { id: "t", name: "team", members: [{ login: "maren", handle: "maren", role: "owner" }], nodes: [NODE], channels: [], authority: null, plan: undefined as never } };
  const html = renderToStaticMarkup(<StaticStore state={state}><MissionControl /></StaticStore>);
  expect(html).toContain('<span class="sr-only">Walkie (WALK): 2 agents</span>');
  expect(html).toContain('<span class="sr-only">Sequence platform (SEQ): 1 agent</span>');
  expect(html).toContain('<span class="sr-only">No project: 1 agent</span>');
  expect(html).toContain('<ul class="project-counts"');
  expect(html).toMatch(/<li class="chip project-count-chip"[^>]*><span class="sr-only">Walkie \(WALK\): 2 agents<\/span>/);
  expect(html.indexOf('data-testid="project-counts"')).toBeLessThan(html.indexOf('role="tablist"'));
  expect(html).not.toContain('Walkie (WALK): 4 agents');
});

test("revoked project access replaces its name and moves its agent to No project without a reload", async () => {
  go("#/mission");
  const privateWalkie = { ...WALKIE, private: true };
  projectsStore.set({ ...projectsStore.get(), status: "ready", projects: [privateWalkie, SEQUENCE],
    cards: { [privateWalkie.channel]: [] }, rooms: { [privateWalkie.channel]: [] } });
  const state: State = {
    ...initialState, phase: "ready", agents: [agent("private", { cwd: "~/work/walkie" })], nodes: [NODE],
    team: { id: "t", name: "team", members: [{ login: "maren", handle: "maren", role: "owner" }], nodes: [NODE], channels: [], authority: null, plan: undefined as never },
  };
  const render = () => renderToStaticMarkup(<StaticStore state={state}><MissionControl /></StaticStore>);
  expect(render()).toContain("Walkie (WALK): 1 agent");
  const original = api.projects;
  (api as { projects: typeof original }).projects = async () => ({ projects: [SEQUENCE], stubs: [] });
  try {
    const refresh = projectsStore.accessChanged();
    expect(render()).toContain("Walkie (WALK): 1 agent");
    await refresh;
    expect(projectsStore.get().projects).toEqual([SEQUENCE]);
    expect(projectsStore.get().cards).toEqual({});
    expect(projectsStore.get().rooms).toEqual({});
    expect(render()).not.toContain("Walkie (WALK): 1 agent");
    expect(render()).toContain("No project: 1 agent");
  } finally {
    (api as { projects: typeof original }).projects = original;
  }
});

test("the strip counts only agents drawn under a member and node", () => {
  go("#/mission");
  projectsStore.set({ ...projectsStore.get(), status: "ready", projects: [WALKIE] });
  const agents = [agent("drawn", { repo: "walkie" }), { ...agent("no-node", { repo: "walkie" }), node: "missing" }];
  const state: State = { ...initialState, phase: "ready", agents, nodes: [NODE],
    team: { id: "t", name: "team", members: [{ login: "maren", handle: "maren", role: "owner" }], nodes: [NODE], channels: [], authority: null, plan: undefined as never } };
  const html = renderToStaticMarkup(<StaticStore state={state}><MissionControl /></StaticStore>);
  expect(html).toContain("Walkie (WALK): 1 agent");
  expect(html).not.toContain("Walkie (WALK): 2 agents");
  expect(html).toContain("drawn on mbp");
  expect(html).not.toContain("no-node on mbp");
});

test("last visible project removed leaves a No project count for drawn agents", async () => {
  go("#/mission");
  projectsStore.set({ ...projectsStore.get(), status: "ready", projects: [WALKIE] });
  const state: State = { ...initialState, phase: "ready", agents: [agent("builder", { repo: "walkie" })], nodes: [NODE],
    team: { id: "t", name: "team", members: [{ login: "maren", handle: "maren", role: "owner" }], nodes: [NODE], channels: [], authority: null, plan: undefined as never } };
  const original = api.projects;
  (api as { projects: typeof original }).projects = async () => ({ projects: [], stubs: [] });
  try {
    await projectsStore.accessChanged();
    const html = renderToStaticMarkup(<StaticStore state={state}><MissionControl /></StaticStore>);
    expect(html).toContain("No project: 1 agent");
    expect(html).not.toContain("Walkie (WALK): 1 agent");
  } finally {
    (api as { projects: typeof original }).projects = original;
  }
});

test("a failed access refresh does not expose cached project names in Mission Control", async () => {
  go("#/mission");
  projectsStore.set({ ...projectsStore.get(), status: "ready", projects: [WALKIE] });
  const state: State = { ...initialState, phase: "ready", agents: [agent("builder", { repo: "walkie" })], nodes: [NODE],
    team: { id: "t", name: "team", members: [{ login: "maren", handle: "maren", role: "owner" }], nodes: [NODE], channels: [], authority: null, plan: undefined as never } };
  const original = api.projects;
  const { ApiError } = await import("../src/api/client.ts");
  (api as { projects: typeof original }).projects = async () => { throw new ApiError("server_error", "list unavailable", 503); };
  try {
    await projectsStore.accessChanged();
    const html = renderToStaticMarkup(<StaticStore state={state}><MissionControl /></StaticStore>);
    expect(html).not.toContain("Walkie (WALK): 1 agent");
    expect(html).not.toContain('data-testid="project-counts"');
    expect(html).not.toContain("project-chip");
  } finally {
    (api as { projects: typeof original }).projects = original;
  }
});

test("an older projects response cannot restore a revoked private project", async () => {
  let answerOld: ((value: Awaited<ReturnType<typeof api.projects>>) => void) | undefined;
  const original = api.projects;
  (api as { projects: typeof original }).projects = () => new Promise((resolve) => { answerOld = resolve; });
  projectsStore.set({ ...projectsStore.get(), status: "ready", projects: [WALKIE, SEQUENCE] });
  try {
    const old = projectsStore.refresh();
    (api as { projects: typeof original }).projects = async () => ({ projects: [SEQUENCE], stubs: [] });
    const latest = projectsStore.accessChanged();
    answerOld?.({ projects: [WALKIE, SEQUENCE], stubs: [] });
    await old;
    await latest;
    expect(projectsStore.get().projects).toEqual([SEQUENCE]);
  } finally {
    (api as { projects: typeof original }).projects = original;
  }
});
