import { afterEach, beforeEach, expect, test } from "bun:test";
import { api } from "../src/api/client.ts";
import type { CardView, ProjectView, ProjectsPayload } from "../src/api/types.ts";
import { projectsStore as store } from "../src/state/projects.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const p: ProjectView = {
  channel: "p-race", id: "node:p-race", name: "old", folder: "", description: "", prefix: "RACE", paths: [], meter_mode: "count",
  automations: { pr_opened: false, pr_merged: false, agents_can_close: false }, state: "active", status_report: "off",
  private: false, admins: [], creator: "maren", created_at: 0, boards: [], cards: 0, last_activity: 0,
  meter: { mode: "count", done: 0, counted: 0, by_role: { backlog: 0, todo: 0, active: 0, review: 0, done: 0, cancelled: 0 } },
};
const card = { channel: p.channel, id: "card-1", title: "newer" } as CardView;
const original = { projects: api.projects, project: api.project };
const empty = () => ({ status: "idle" as const, error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
beforeEach(() => { store.set(empty()); store.set({ ...empty(), status: "ready", projects: [p] }); });
afterEach(() => { api.projects = original.projects; api.project = original.project; store.set(empty()); });

test("newer stream row and card survive an older detail response", async () => {
  const detail = deferred<Awaited<ReturnType<typeof api.project>>>();
  api.project = () => detail.promise;
  const pending = store.loadCards(p.channel);
  store.delta({ channel: p.channel, project: { ...p, name: "newer" }, cards: [card] });
  detail.resolve({ project: p, cards: [], timeline: [] });
  await pending;
  expect(store.get().projects[0]?.name).toBe("newer");
  expect(store.get().cards[p.channel]).toEqual([card]);
});

test("revocations absent from accepted lists stay guarded until a grant", async () => {
  api.projects = async () => ({ projects: [], stubs: [] });
  for (let i = 0; i < 20; i++) await store.accessChanged({ kind: "channel.upsert", body: { name: `absent-${i}`, members: [] } }, "maren");
  expect((store as any).revokedChannels.size).toBe(20);
});

test("a proved private revocation survives an omitted list and a later stale list", async () => {
  const privateProject = { ...p, private: true };
  store.set({ ...store.get(), projects: [privateProject] });
  api.projects = async () => ({ projects: [], stubs: [] });
  await store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: [] } }, "maren");
  expect(store.get().projects).toEqual([]);
  const stale = deferred<ProjectsPayload>();
  api.projects = () => stale.promise;
  const read = store.refresh();
  const again = store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: [] } }, "maren");
  api.projects = async () => ({ projects: [], stubs: [] });
  stale.resolve({ projects: [privateProject], stubs: [] });
  await Promise.all([read, again]);
  expect(store.get().projects).toEqual([]);
});

test("a stale included list followed by an unrelated access change cannot restore a revoked private project", async () => {
  const privateProject = { ...p, private: true };
  store.set({ ...store.get(), projects: [privateProject] });
  api.projects = async () => ({ projects: [privateProject], stubs: [] });
  await store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: [] } }, "maren");
  expect(store.get().projects).toEqual([]);
  await store.accessChanged({ kind: "team.member", body: { handle: "someone-else", role: "member" } }, "maren");
  expect(store.get().projects).toEqual([]);
});

test("observed revocations whose accepted lists omit them stay guarded", async () => {
  api.projects = async () => ({ projects: [], stubs: [] });
  for (let i = 0; i < 20; i++) {
    const channel = `p-observed-${i}`;
    store.set({ ...store.get(), projects: [{ ...p, channel, private: true }] });
    await store.accessChanged({ kind: "channel.upsert", body: { name: channel, members: [] } }, "maren");
  }
  expect((store as any).revokedChannels.size).toBe(20);
});

test("a repeated revocation discards list evidence from the earlier revocation", async () => {
  const privateProject = { ...p, private: true };
  store.set({ ...store.get(), projects: [privateProject] });
  api.projects = async () => ({ projects: [privateProject], stubs: [] });
  await store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: [] } }, "maren");
  api.projects = async () => ({ projects: [], stubs: [] });
  await store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: [] } }, "maren");
  const stale = deferred<ProjectsPayload>();
  api.projects = () => stale.promise;
  const read = store.refresh();
  const again = store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: [] } }, "maren");
  api.projects = async () => ({ projects: [], stubs: [] });
  stale.resolve({ projects: [privateProject], stubs: [] });
  await Promise.all([read, again]);
  expect(store.get().projects).toEqual([]);
});

test("an intervening omission keeps a later stale list from readmitting a revoked channel", async () => {
  const privateProject = { ...p, private: true };
  store.set({ ...store.get(), projects: [privateProject] });
  api.projects = async () => ({ projects: [privateProject], stubs: [] });
  await store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: [] } }, "maren");
  api.projects = async () => ({ projects: [], stubs: [] });
  await store.accessChanged({ kind: "team.member", body: { handle: "someone-else", role: "member" } }, "maren");
  const stale = deferred<ProjectsPayload>();
  api.projects = () => stale.promise;
  const read = store.refresh();
  const again = store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: [] } }, "maren");
  api.projects = async () => ({ projects: [], stubs: [] });
  stale.resolve({ projects: [privateProject], stubs: [] });
  await Promise.all([read, again]);
  expect(store.get().projects).toEqual([]);
});

test("one accepted omission retains a revocation guard", async () => {
  const privateProject = { ...p, private: true };
  store.set({ ...store.get(), projects: [privateProject] });
  api.projects = async () => ({ projects: [], stubs: [] });
  await store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: [] } }, "maren");
  expect(store.get().projects).toEqual([]);
  expect((store as any).revokedChannels.has(p.channel)).toBe(true);
});

test("a list started after an accepted omission cannot readmit without a grant", async () => {
  const privateProject = { ...p, private: true };
  store.set({ ...store.get(), projects: [privateProject] });
  api.projects = async () => ({ projects: [], stubs: [] });
  await store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: [] } }, "maren");
  api.projects = async () => ({ projects: [privateProject], stubs: [] });
  await store.refresh();
  expect(store.get().projects).toEqual([]);
  await store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: ["maren"] } }, "maren");
  expect(store.get().projects).toEqual([privateProject]);
});

test("2,000 seeded list, revocation, and stream schedules never show a revoked project", async () => {
  const privateProject = { ...p, private: true };
  for (const seed of [0x12345678, 0x9abcdef0]) {
    let random = seed;
    const pick = () => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return random >>> 0; };
    for (let schedule = 0; schedule < 1000; schedule++) {
      store.set(empty());
      store.set({ ...empty(), status: "ready", projects: [privateProject] });
      let serverVisible = true;
      const reads: Array<{ resolve: (value: ProjectsPayload) => void; snapshot: boolean }> = [];
      api.projects = () => {
        const read = deferred<ProjectsPayload>();
        reads.push({ resolve: read.resolve, snapshot: serverVisible });
        return read.promise;
      };
      const pending = store.refresh();
      if (pick() % 2) store.delta({ channel: p.channel, project: { ...privateProject, name: "stream" } });
      serverVisible = false;
      void store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: [] } }, "maren");
      const hidden = () => {
        if (!serverVisible) expect(store.get().projects.some((project) => project.channel === p.channel)).toBe(false);
      };
      hidden();
      if (pick() % 3 === 0) {
        serverVisible = true;
        void store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: ["maren"] } }, "maren");
      }
      if (pick() % 2) store.delta({ channel: p.channel, project: { ...privateProject, name: "late stream" } });
      let answered = 0;
      while (answered < reads.length) {
        const read = reads[answered++]!;
        read.resolve({ projects: read.snapshot ? [privateProject] : [], stubs: [] });
        await Promise.resolve();
        await Promise.resolve();
        hidden();
        if (answered === 1 && pick() % 4 === 0) {
          serverVisible = false;
          void store.accessChanged({ kind: "channel.upsert", body: { name: p.channel, members: [] } }, "maren");
          hidden();
        }
      }
      await pending;
      hidden();
      expect((store as any).revokedChannels.has(p.channel)).toBe(!serverVisible);
      if (!serverVisible) {
        api.projects = async () => ({ projects: [privateProject], stubs: [] });
        await store.refresh();
        hidden();
      }
    }
  }
});

test("pending positive row and page tick recover only after list admission", async () => {
  const list = deferred<ProjectsPayload>();
  api.projects = () => list.promise;
  const pending = store.accessChanged({ kind: "team.member", body: { handle: "someone-else", role: "member" } }, "maren");
  store.delta({ channel: p.channel, project: { ...p, name: "newer" }, page: true });
  expect(store.get().projects[0]?.name).toBe("old");
  list.resolve({ projects: [p], stubs: [] });
  await pending;
  expect(store.get().projects[0]?.name).toBe("newer");
  expect(store.get().pageTicks?.[p.channel]).toBe(1);
});

test("a stream row cannot keep a project omitted by the authoritative list", async () => {
  const list = deferred<ProjectsPayload>();
  api.projects = () => list.promise;
  const pending = store.refresh();
  store.delta({ channel: p.channel, project: { ...p, name: "newer" } });
  list.resolve({ projects: [], stubs: [] });
  await pending;
  expect(store.get().projects).toEqual([]);
});

test("stream reset during detail load retries instead of accepting the older card list", async () => {
  const first = deferred<Awaited<ReturnType<typeof api.project>>>();
  const second = deferred<Awaited<ReturnType<typeof api.project>>>();
  let calls = 0;
  api.project = () => ++calls === 1 ? first.promise : second.promise;
  const pending = store.loadCards(p.channel);
  store.delta({ channel: p.channel, reset: true });
  first.resolve({ project: p, cards: [], timeline: [] });
  await pending;
  expect(calls).toBe(2);
  second.resolve({ project: p, cards: [card], timeline: [] });
  await Bun.sleep(0);
  expect(store.get().cards[p.channel]).toEqual([card]);
});
