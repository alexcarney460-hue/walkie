// WALK-121: control response completion order, without timers or a real daemon.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { api, ApiError } from "../src/api/client.ts";
import type { ProjectView, ProjectsPayload } from "../src/api/types.ts";
import { toggleStatusReport } from "../src/lib/status-report.ts";
import { projectsStore as store } from "../src/state/projects.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const project = (channel = "p-00000001", extra: Partial<ProjectView> = {}): ProjectView => ({
  channel, id: `node:${channel}`, name: "Website", folder: "Acme", description: "", prefix: "WEB", paths: [], meter_mode: "count",
  automations: { pr_opened: true, pr_merged: false, agents_can_close: true }, state: "active", status_report: "off",
  private: false, admins: ["maren"], creator: "maren", created_at: 0, boards: [], cards: 0, last_activity: 0,
  meter: { mode: "count", done: 0, counted: 0, by_role: { backlog: 0, todo: 0, active: 0, review: 0, done: 0, cancelled: 0 } }, ...extra,
});
const p = project();
const originalList = api.projects;
const originalProject = api.project;
let reads: ReturnType<typeof deferred<ProjectsPayload>>[];
const answer = (index: number, projects: ProjectView[], stubs: ProjectsPayload["stubs"] = []) => reads[index]!.resolve({ projects, stubs });

beforeEach(() => {
  reads = [];
  api.projects = () => {
    const read = deferred<ProjectsPayload>();
    reads.push(read);
    return read.promise;
  };
  store.set({ status: "ready", error: null, projects: [p], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
});
afterEach(() => { api.projects = originalList; api.project = originalProject; });
// Refreshes coalesce: the superseded response is discarded before a follow-up list starts.
const nextList = async () => { await Bun.sleep(0); expect(reads.length).toBe(2); };

test("a successful create refresh supersedes an older list that omits its ID", async () => {
  const read = store.refresh();
  const created = project("p-00000002", { name: "New project" });
  // CreateProject does not trust the POST payload for admission: it awaits refresh().
  expect(store.project(created)).toBe(false);
  const admission = store.refresh();
  answer(0, [p]);
  await nextList();
  expect(store.get().projects).toEqual([p]);
  answer(1, [{ ...p, name: "Server rename" }, created]);
  await Promise.all([read, admission]);
  expect(store.get().projects).toEqual([{ ...p, name: "Server rename" }, created]);
});

test("local deletion survives a superseded active list followed by the authoritative empty list", async () => {
  const older = store.refresh();
  store.project({ ...p, state: "deleted" });
  const newer = store.refresh();
  answer(0, [p]);
  await nextList();
  expect(store.get().projects).toEqual([]);
  answer(1, []);
  await Promise.all([older, newer]);
  expect(store.get().projects).toEqual([]);
});

test("a local deletion is a tombstone against a pending list", async () => {
  const read = store.refresh();
  store.project({ ...p, state: "deleted" });
  answer(0, [p]);
  await read;
  expect(store.get().projects).toEqual([]);
});

for (const change of ["archive", "delete", "deleted value", "update", "create"] as const) {
  test(`stream ${change} survives a list already in flight`, async () => {
    const read = store.refresh();
    const changed = change === "delete" ? null : change === "deleted value" ? { ...p, state: "deleted" as const }
      : change === "archive" ? { ...p, state: "archived" as const }
      : change === "create" ? project("p-00000002") : { ...p, name: "From teammate", status_report: "hourly" as const };
    store.delta({ channel: changed?.channel ?? p.channel, project: changed });
    answer(0, [p]);
    if (change === "create") {
      await nextList();
      expect(store.get().projects).toEqual([p]); // unknown stream channels need list admission
      answer(1, [p, changed!]);
    }
    await read;
    expect(store.get().projects).toEqual(change === "delete" || change === "deleted value" ? [] : change === "create" ? [p, changed!] : [changed!]);
  });
}

test("only the latest-started list supplies projects and private stubs", async () => {
  const older = store.refresh();
  const newer = store.refresh();
  const stub = { channel: "p-private", private: true as const, stub: true as const, members: ["maren"] };
  answer(0, [p]);
  await nextList();
  answer(1, [{ ...p, name: "Latest" }], [stub]);
  await Promise.all([older, newer]);
  expect(store.get().projects).toEqual([{ ...p, name: "Latest" }]);
  expect(store.get().stubs).toEqual([stub]);
});

test("an older list is already superseded while the newest list is pending", async () => {
  const older = store.refresh();
  const newer = store.refresh();
  answer(0, [{ ...p, name: "Obsolete" }]);
  await nextList();
  const during = store.get().projects;
  answer(1, [{ ...p, name: "Latest" }]);
  await newer;
  expect(during).toEqual([p]);
  expect(store.get().projects[0]?.name).toBe("Latest");
});

test("a superseded list failure cannot prevent the newest success", async () => {
  const older = store.refresh();
  const newer = store.refresh();
  reads[0]!.reject(new ApiError("network", "offline", 0));
  await nextList();
  answer(1, []);
  await Promise.all([older, newer]);
  expect(store.get()).toMatchObject({ projects: [], status: "ready", error: null });
});

test("an older success cannot erase the latest list failure", async () => {
  const older = store.refresh();
  const newer = store.refresh();
  answer(0, [{ ...p, name: "Obsolete" }]);
  await nextList();
  reads[1]!.reject(new ApiError("network", "offline", 0));
  await Promise.all([older, newer]);
  expect(store.get()).toMatchObject({ projects: [p], status: "ready", error: "Can't reach the Sqwakie daemon on this machine." });
});

test("stream changes are not pinned against a list started after them", async () => {
  store.delta({ channel: p.channel, project: { ...p, state: "archived" } });
  const read = store.refresh();
  answer(0, [p]);
  await read;
  expect(store.get().projects).toEqual([p]);
});

test("a later list may restore a stream-deleted project", async () => {
  store.delta({ channel: p.channel, project: null });
  const read = store.refresh();
  answer(0, [p]);
  await read;
  expect(store.get().projects).toEqual([p]);
});

test("card-only stream activity must not stamp a stale project value", async () => {
  const read = store.refresh();
  store.delta({ channel: p.channel, cards: [], page: true });
  answer(0, [{ ...p, name: "Server rename" }]);
  await read;
  expect(store.get().projects[0]?.name).toBe("Server rename");
  expect(store.get().pageTicks?.[p.channel]).toBe(1);
});

test("concurrent write completions are stamped when they finish, including one omitted by a pending list", async () => {
  const q = project("p-00000002");
  store.set({ ...store.get(), projects: [p, q] }); // both channels were already admitted
  const first = deferred<{ project: ProjectView }>();
  const second = deferred<{ project: ProjectView }>();
  const client = { updateProject: (channel: string) => channel === p.channel ? first.promise : second.promise };
  const a = toggleStatusReport(client, store, p.channel, true);
  const b = toggleStatusReport(client, store, q.channel, true);
  const read = store.refresh();
  second.resolve({ project: { ...q, status_report: "hourly" } });
  await b;
  first.resolve({ project: { ...p, status_report: "hourly" } });
  await a;
  answer(0, [p]);
  await read;
  expect(store.get().projects).toEqual([{ ...p, status_report: "hourly" }, { ...q, status_report: "hourly" }]);
});

test("the last completed write to a project survives an intervening list read", async () => {
  const olderWrite = deferred<{ project: ProjectView }>();
  const newerWrite = deferred<{ project: ProjectView }>();
  const a = toggleStatusReport({ updateProject: () => olderWrite.promise }, store, p.channel, true);
  const b = toggleStatusReport({ updateProject: () => newerWrite.promise }, store, p.channel, false);
  newerWrite.resolve({ project: p });
  await b;
  const read = store.refresh();
  olderWrite.resolve({ project: { ...p, status_report: "hourly" } });
  await a;
  answer(0, [p]);
  await read;
  expect(store.get().projects[0]?.status_report).toBe("hourly");
});

test("reconciliation uses the saved write value even when a detail read replaced the current row", async () => {
  const detail = deferred<Awaited<ReturnType<typeof api.project>>>();
  api.project = () => detail.promise;
  const read = store.refresh();
  const cards = store.loadCards(p.channel);
  const written = { ...p, status_report: "hourly" as const };
  store.project(written);
  detail.resolve({ project: p, cards: [], timeline: [] });
  await cards;
  answer(0, [p]);
  await read;
  expect(store.get().projects).toEqual([written]);
});

test("repeated stream and local changes to the same ID merge only the last observed value", async () => {
  const read = store.refresh();
  store.project({ ...p, status_report: "hourly" });
  store.delta({ channel: p.channel, project: null });
  const restored = { ...p, name: "Restored", state: "archived" as const };
  store.delta({ channel: p.channel, project: restored });
  answer(0, []);
  await nextList();
  expect(store.get().projects).toEqual([]); // a removed channel must be readmitted
  answer(1, [restored]);
  await read;
  expect(store.get().projects).toEqual([restored]);
});

test("a new list forgets earlier write values and tombstones without letting an old list restore them", async () => {
  const older = store.refresh();
  store.project({ ...p, name: "Old write" });
  store.delta({ channel: p.channel, project: null });
  const newer = store.refresh();
  answer(0, [project("p-00000002")]);
  await nextList();
  answer(1, [p]);
  await Promise.all([older, newer]);
  expect(store.get().projects).toEqual([p]);
});

for (const change of ["write", "stream", "delete"] as const) {
  test(`access revocation wins over a journaled ${change} and two older list snapshots`, async () => {
    const before = store.accessGeneration();
    const older = store.refresh();
    if (change === "write") store.project({ ...p, name: "Saved private name" }, before);
    else store.delta({ channel: p.channel, project: change === "delete" ? null : { ...p, name: "Stream private name" } });
    const revoke = store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: [] } }, "maren");
    expect(store.get().projects).toEqual([]);
    answer(0, [p]);
    await nextList();
    // Even this request can see an old server projection; proved removal must still win.
    answer(1, [p], [{ channel: p.channel, private: true, stub: true, members: ["maren"] }]);
    await Promise.all([older, revoke]);
    expect(store.get().projects).toEqual([]);
    expect(store.get().stubs).toEqual([]);
    expect(store.get().cards[p.channel]).toBeUndefined();
    expect(store.get().rooms[p.channel]).toBeUndefined();
  });
}

for (const transition of ["revoke-restore", "viewer-change"] as const) {
  test(`the real status-report writer rejects an old response after ${transition}`, async () => {
    // Establish the previous viewer through the same boot path as StoreProvider.
    const boot = store.accessChanged(undefined, "maren");
    answer(0, [p]);
    await boot;
    const response = deferred<{ project: ProjectView }>();
    const write = toggleStatusReport({ updateProject: () => response.promise }, store, p.channel, true);
    const read = store.refresh();
    store.delta({ channel: p.channel, project: { ...p, name: "Journal before access change" } });
    const access = transition === "viewer-change" ? store.accessChanged(undefined, "kira")
      : store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: [] } }, "maren");
    answer(1, [p]);
    await Bun.sleep(0);
    answer(2, transition === "viewer-change" ? [p] : []);
    await Promise.all([read, access]);
    if (transition === "revoke-restore") {
      const restore = store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: ["maren"] } }, "maren");
      answer(3, [p]);
      await restore;
    }
    response.resolve({ project: { ...p, name: "Old private response", status_report: "hourly" } });
    await write;
    // The dropped answer is not reported as success without a re-read of the list (fx-dash-views): the daemon did apply it.
    answer(reads.length - 1, [p]);
    await Bun.sleep(0);
    expect(store.get().projects).toEqual([p]);
    // The rejected completion also must not enter the independent journal.
    const check = store.refresh();
    answer(reads.length - 1, [p]);
    await check;
    expect(store.get().projects).toEqual([p]);
  });
}
