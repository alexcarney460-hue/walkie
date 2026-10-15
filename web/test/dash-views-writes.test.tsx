// fx-dash-views: a write the store dropped is never reported as success, a refused write says why, and an evicted
// project's report text does not outlive the eviction.
import { test, expect, afterEach } from "bun:test";
import { act, create } from "react-test-renderer";
import { installWindow } from "./window-stub.ts";
installWindow();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const inert: any = new Proxy(() => inert, { get: (_, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => "" : inert), apply: () => undefined });
(globalThis as any).document = inert;
const { projectsStore: s } = await import("../src/state/projects.ts");
const { api } = await import("../src/api/client.ts");
const { toggleStatusReport } = await import("../src/lib/status-report.ts");
const { ProjectSettings } = await import("../src/views/projects/ProjectSettings.tsx");
const { ProjectBoard } = await import("../src/views/projects/ProjectBoard.tsx");
const { DataRoom } = await import("../src/views/projects/DataRoom.tsx");
const { CardDrawer } = await import("../src/views/projects/CardDrawer.tsx");
const { Kanban } = await import("../src/views/projects/Kanban.tsx");
const { Updates } = await import("../src/views/updates/Updates.tsx");
const { useRoomUpload } = await import("../src/views/projects/RoomUpload.tsx");
const { StaticStore } = await import("../src/state/store.tsx");
const { initialState } = await import("../src/state/reducer.ts");

const meter = { mode: "count", done: 0, counted: 0, by_role: { backlog: 0, todo: 0, active: 0, review: 0, done: 0, cancelled: 0 } };
const author = { handle: "maren", node: "synthetic" };
const p: any = { channel: "p-alpha", id: "p-alpha:1", name: "Synthetic Alpha", prefix: "ALPHA", folder: "", description: "", paths: [], meter_mode: "count",
  automations: { pr_opened: false, pr_merged: false, agents_can_close: false }, state: "active", private: false, admins: [], creator: "maren", created_at: 0,
  status_report: "off", steward: "on", steward_node: "",
  boards: [{ id: "board:1", name: "Main", state: "active", created_at: 0, created_by: author, columns: [{ id: "todo", name: "To do", role: "todo" }], meter, live_cards: 0 }],
  cards: 0, meter, last_activity: 0 };
const card: any = { id: "card:1", channel: p.channel, board: "board:1", key: "ALPHA-1", n: 1, title: "Test card", body: "", column: "todo", pos: "m", assignee: null, reviewer: null, labels: [], estimate: null, due: null,
  blocked: false, blocked_reason: null, state: "open", created_at: 0, created_by: author, updated_at: 0, updated_by: author, comments: 0, rev: 0 };
const roomFile: any = { id: "file:1", channel: p.channel, name: "proof.txt", state: "active", pinned: false, version: 1, versions: 1, size: 1, mime: "text/plain", available: true,
  cards: [], updated_at: 0, updated_by: author };
const base = () => ({ status: "ready" as const, error: null, projects: [p], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {},
  visibilityGeneration: { [p.channel]: 1 } });
const deferred = () => { let resolve: any; const promise = new Promise<any>((r) => (resolve = r)); return { promise, resolve }; };
const someoneElse = { kind: "team.member", body: { handle: "someone-else", role: "member" } } as any;
const original = { ...api };
afterEach(() => { Object.assign(api, original); s.set({ ...base(), status: "idle", projects: [] }); });
const me = { ...initialState, phase: "ready" as const, me: { handle: "maren", role: "owner" } as any };

test("toggleStatusReport refreshes the list instead of reporting a dropped write as success", async () => {
  s.set(base());
  const reply = deferred();
  let reads = 0;
  api.projects = async () => { reads++; return { projects: [{ ...p, status_report: "hourly" }], stubs: [] }; };
  const write = toggleStatusReport({ updateProject: () => reply.promise }, s, p.channel, true);
  await act(async () => { void s.accessChanged(someoneElse, "maren"); });
  reply.resolve({ project: { ...p, status_report: "hourly" } });
  expect(await write).toContain("Saved; refreshing");
  await act(async () => { await Bun.sleep(0); });
  expect(reads).toBeGreaterThan(1);
  await act(async () => { await Bun.sleep(0); });
  expect(s.get().projects[0]!.status_report).toBe("hourly");
});

test("status report says saved while an accepted reply waits for the access list", async () => {
  s.set(base());
  const reply = deferred();
  const read = deferred();
  api.projects = () => read.promise;
  const write = toggleStatusReport({ updateProject: () => reply.promise }, s, p.channel, true);
  await act(async () => { void s.accessChanged(someoneElse, "maren"); });
  reply.resolve({ project: { ...p, status_report: "hourly" } });
  try {
    expect(await write).toContain("Saved; refreshing");
    expect(s.get().projects[0]?.status_report).toBe("off");
  } finally {
    read.resolve({ projects: [{ ...p, status_report: "hourly" }], stubs: [] });
    await act(async () => { await Bun.sleep(0); });
  }
});

test("upload says saved while its accepted file waits for the access list", async () => {
  s.set({ ...base(), rooms: { [p.channel]: [] } });
  const reply = deferred();
  const read = deferred();
  const savedFile = { id: "file:1", channel: p.channel, name: "proof.txt" };
  api.roomAdd = () => reply.promise;
  api.projects = () => read.promise;
  api.room = async () => ({ files: [savedFile], limits: { files: 1000, versions: 100 } });
  let hook: any; let tree: any;
  function Harness() { hook = useRoomUpload(p.channel); return hook.notice; }
  try {
    await act(async () => { tree = create(<Harness />); });
    let upload!: Promise<void>;
    await act(async () => { upload = hook.upload([new File(["x"], "proof.txt")]); });
    await act(async () => { void s.accessChanged(someoneElse, "maren"); });
    await act(async () => { reply.resolve({ file: savedFile, created: true, version: 1 }); await upload; });
    expect(JSON.stringify(tree.toJSON())).toContain("Saved; refreshing");
    expect(JSON.stringify(tree.toJSON())).not.toContain("Added proof.txt");
    expect(s.get().rooms[p.channel]).toEqual([]);
    read.resolve({ projects: [p], stubs: [] });
    await act(async () => { await Bun.sleep(0); });
    expect(s.get().rooms[p.channel]).toEqual([savedFile]);
    expect(JSON.stringify(tree.toJSON())).not.toContain("Saved; refreshing");
  } finally {
    read.resolve({ projects: [p], stubs: [] });
    await act(async () => { await Bun.sleep(0); tree?.unmount(); });
  }
});

test("DataRoom file change says saved when access refresh refuses its answer", async () => {
  s.set({ ...base(), rooms: { [p.channel]: [roomFile] } });
  const reply = deferred(); const read = deferred();
  api.roomChange = () => reply.promise;
  api.projects = () => read.promise;
  api.room = async () => ({ files: [roomFile], limits: { files: 1000, versions: 100 } });
  let tree: any;
  try {
    await act(async () => { tree = create(<StaticStore state={me}><DataRoom project={p} cards={[]} /></StaticStore>); });
    const pin = tree.root.find((n: any) => n.type === "button" && n.props["aria-label"] === "Pin proof.txt");
    await act(async () => { pin.props.onClick(); });
    await act(async () => { void s.accessChanged(someoneElse, "maren"); });
    await act(async () => { reply.resolve({ file: { ...roomFile, pinned: true } }); await Bun.sleep(0); });
    expect(JSON.stringify(tree.toJSON())).toContain("Saved; refreshing");
    expect(s.get().rooms[p.channel]?.[0]?.pinned).toBe(false);
  } finally { read.resolve({ projects: [p], stubs: [] }); await act(async () => { await Bun.sleep(0); tree?.unmount(); }); }
});

for (const action of ["save", "comment", "file"] as const) test(`CardDrawer ${action} says saved when access refresh refuses its answer`, async () => {
  s.set({ ...base(), cards: { [p.channel]: [card] }, rooms: { [p.channel]: [roomFile] } });
  const reply = deferred(); const read = deferred();
  api.updateTask = () => reply.promise;
  api.commentTask = () => reply.promise;
  api.roomChange = () => reply.promise;
  api.task = async () => ({ card, timeline: [], agents: [] });
  api.projects = () => read.promise;
  let tree: any;
  try {
    await act(async () => { tree = create(<StaticStore state={me}><CardDrawer card={card} project={p} byCard={new Map()} onClose={() => {}} /></StaticStore>); });
    if (action === "save") {
      const button = tree.root.find((n: any) => n.type === "button" && n.props.children === "Archive");
      await act(async () => { button.props.onClick(); });
    } else if (action === "comment") {
      const input = tree.root.find((n: any) => n.type === "textarea" && n.props["aria-label"] === "Comment");
      await act(async () => { input.props.onChange({ target: { value: "Looks good" } }); });
      const button = tree.root.find((n: any) => n.type === "button" && n.props.children === "Comment");
      await act(async () => { button.props.onClick(); });
    } else {
      const select = tree.root.find((n: any) => n.type === "select" && n.props["aria-label"] === "Attach a file from the Data Room");
      await act(async () => { select.props.onChange({ target: { value: roomFile.id } }); });
    }
    await act(async () => { void s.accessChanged(someoneElse, "maren"); });
    await act(async () => { reply.resolve(action === "file" ? { file: { ...roomFile, cards: [card.id] } } : { task: { ...card, state: "archived", comments: 1 } }); await Bun.sleep(0); });
    expect(JSON.stringify(tree.toJSON())).toContain("Saved; refreshing");
  } finally { read.resolve({ projects: [p], stubs: [] }); await act(async () => { await Bun.sleep(0); tree?.unmount(); }); }
});

for (const body of [{ state: "deleted" }, { state: "archived" }]) test(`ProjectSettings ${body.state}: a roster event mid-request keeps a saved notice visible`, async () => {
  s.set(base());
  const reply = deferred();
  api.updateProject = (async () => reply.promise) as any;
  api.projects = async () => ({ projects: [p], stubs: [] });
  let closed = 0;
  const confirm = (globalThis as any).window.confirm;
  (globalThis as any).window.confirm = () => true;
  let tree: any;
  try {
    await act(async () => { tree = create(<StaticStore state={me}><ProjectSettings project={p} onClose={() => { closed++; }} /></StaticStore>); });
    const label = body.state === "deleted" ? "Delete project" : "Archive project";
    const btn = tree.root.findAll((n: any) => n.type === "button" && n.props.children === label)[0];
    await act(async () => { btn.props.onClick(); });
    await act(async () => { void s.accessChanged(someoneElse, "maren"); });
    await act(async () => { reply.resolve({ project: { ...p, state: body.state } }); await Bun.sleep(0); });
    expect(closed).toBe(0);
    expect(JSON.stringify(tree.toJSON())).toContain("Saved; refreshing");
  } finally { (globalThis as any).window.confirm = confirm; await act(async () => tree?.unmount()); }
});

test("a drag or card-create while the access list is refreshing says so", async () => {
  s.set(base());
  api.project = async () => ({ project: p, cards: [] });
  api.room = async () => ({ files: [], limits: { files: 1000, versions: 100 } });
  let created = 0;
  api.createTask = (async () => { created++; return { task: {} }; }) as any;
  const read = deferred();
  api.projects = () => read.promise;
  let tree: any;
  try {
    await act(async () => { tree = create(<StaticStore state={initialState}><ProjectBoard channel={p.channel} /></StaticStore>); });
    await act(async () => { void s.accessChanged(someoneElse, "maren"); });
    let ok: any;
    await act(async () => { ok = await tree.root.findByType(Kanban).props.onCreate("todo", "New card"); });
    expect(ok).toBe(false);
    expect(created).toBe(0);
    expect(JSON.stringify(tree.toJSON())).toContain("Access is refreshing");
  } finally { read.resolve({ projects: [p], stubs: [] }); await act(async () => { await Bun.sleep(0); tree?.unmount(); }); }
});

test("ProjectBoard create says saved when access refresh refuses its card answer", async () => {
  s.set({ ...base(), cards: { [p.channel]: [] } });
  const reply = deferred(); const read = deferred();
  api.createTask = () => reply.promise;
  api.projects = () => read.promise;
  api.project = async () => ({ project: p, cards: [] });
  api.room = async () => ({ files: [], limits: { files: 1000, versions: 100 } });
  let tree: any;
  try {
    await act(async () => { tree = create(<StaticStore state={me}><ProjectBoard channel={p.channel} /></StaticStore>); });
    let result!: Promise<boolean>;
    await act(async () => { result = tree.root.findByType(Kanban).props.onCreate("todo", "New card"); });
    await act(async () => { void s.accessChanged(someoneElse, "maren"); });
    await act(async () => { reply.resolve({ task: card }); await result; });
    expect(JSON.stringify(tree.toJSON())).toContain("Saved; refreshing");
    expect(s.get().cards[p.channel]).toEqual([]);
  } finally { read.resolve({ projects: [p], stubs: [] }); await act(async () => { await Bun.sleep(0); tree?.unmount(); }); }
});

test("a Data Room upload while the access list is refreshing says so", async () => {
  s.set({ ...base(), rooms: { [p.channel]: [] } });
  const read = deferred();
  api.projects = () => read.promise;
  let hook: any; let tree: any;
  function Harness() { hook = useRoomUpload(p.channel); return hook.notice; }
  try {
    await act(async () => { tree = create(<Harness />); });
    await act(async () => { void s.accessChanged(someoneElse, "maren"); });
    await act(async () => { await hook.upload([new File(["x"], "a.txt")]); });
    expect(JSON.stringify(tree.toJSON())).toContain("Access is refreshing");
  } finally { read.resolve({ projects: [p], stubs: [] }); await act(async () => { await Bun.sleep(0); tree?.unmount(); }); }
});

test("Updates drops an evicted project's report text so a re-admission does not show it", async () => {
  const hourly = { ...p, status_report: "hourly" };
  s.set({ ...base(), projects: [hourly] });
  const second = deferred();
  let reads = 0;
  api.projects = async () => ({ projects: [hourly], stubs: [] });
  api.statusReport = (async () => {
    if (++reads === 1) return { mode: "hourly", report: { markdown: "STALE PRIVATE REPORT", header: null, as_of: 1, at: 1, by: { handle: "kira", agent: "x" } } };
    return second.promise;
  }) as any;
  let tree: any;
  try {
    await act(async () => { tree = create(<StaticStore state={initialState}><Updates /></StaticStore>); });
    await act(async () => { await Bun.sleep(0); });
    expect(JSON.stringify(tree.toJSON())).toContain("STALE PRIVATE REPORT");
    await act(async () => { s.set({ ...s.get(), projects: [] }); });
    await act(async () => { s.set({ ...s.get(), projects: [hourly] }); await Bun.sleep(0); });
    expect(JSON.stringify(tree.toJSON())).not.toContain("STALE PRIVATE REPORT");
  } finally { await act(async () => tree?.unmount()); }
});

test("Updates ignores a report response that lands after its project was evicted", async () => {
  const hourly = { ...p, status_report: "hourly" };
  s.set({ ...base(), projects: [hourly] });
  const late = deferred();
  let reads = 0;
  api.projects = async () => ({ projects: [hourly], stubs: [] });
  api.statusReport = (async () => {
    if (++reads === 1) return late.promise;
    return new Promise(() => {});
  }) as any;
  let tree: any;
  try {
    await act(async () => { tree = create(<StaticStore state={initialState}><Updates /></StaticStore>); });
    await act(async () => { await Bun.sleep(0); });
    await act(async () => { s.set({ ...s.get(), projects: [] }); });
    await act(async () => { late.resolve({ mode: "hourly", report: { markdown: "LATE EVICTED PRIVATE TEXT", header: null, as_of: 1, at: 1, by: { handle: "kira", agent: "x" } } }); await Bun.sleep(0); });
    await act(async () => { s.set({ ...s.get(), projects: [hourly] }); await Bun.sleep(0); });
    expect(JSON.stringify(tree.toJSON())).not.toContain("LATE EVICTED PRIVATE TEXT");
  } finally { await act(async () => tree?.unmount()); }
});

test("Updates ignores an old report response after eviction and re-admission", async () => {
  const hourly = { ...p, status_report: "hourly" };
  s.set({ ...base(), projects: [hourly] });
  const old = deferred();
  const fresh = deferred();
  let reads = 0;
  api.projects = async () => ({ projects: [hourly], stubs: [] });
  api.statusReport = (async () => (++reads === 1 ? old.promise : fresh.promise)) as any;
  let tree: any;
  try {
    await act(async () => { tree = create(<StaticStore state={initialState}><Updates /></StaticStore>); });
    await act(async () => { await Bun.sleep(0); });
    await act(async () => { s.set({ ...s.get(), projects: [] }); });
    await act(async () => { s.set({ ...s.get(), projects: [hourly] }); await Bun.sleep(0); });
    expect(reads).toBe(2);
    await act(async () => { old.resolve({ mode: "hourly", report: { markdown: "STALE AFTER RE-ADMIT", header: null, as_of: 1, at: 1, by: { handle: "kira", agent: "x" } } }); await Bun.sleep(0); });
    expect(JSON.stringify(tree.toJSON())).not.toContain("STALE AFTER RE-ADMIT");
    await act(async () => { fresh.resolve({ mode: "hourly", report: { markdown: "FRESH AFTER RE-ADMIT", header: null, as_of: 2, at: 2, by: { handle: "kira", agent: "x" } } }); await Bun.sleep(0); });
    expect(JSON.stringify(tree.toJSON())).toContain("FRESH AFTER RE-ADMIT");
  } finally { await act(async () => tree?.unmount()); }
});
