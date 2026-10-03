import { afterEach, expect, test } from "bun:test";
import { sha256Hex } from "../../src/daemon/blobs.ts";
import { ProjectsIndex } from "../../src/daemon/projects/index.ts";
import { addScreen, buildPage, removeScreen, setFact } from "../../src/daemon/projects/page.ts";
import { addFile, changeFile } from "../../src/daemon/projects/room.ts";
import { compareIds } from "../../src/protocol/projects/page.ts";
import type { ProjectView } from "../../src/protocol/projects/schema.ts";
import type { BodyOf } from "../../src/protocol/schemas.ts";
import { feed } from "../helpers/core.ts";
import { ev } from "../helpers/events.ts";
import { png } from "../helpers/images.ts";
import { reportsWorld } from "../helpers/project-reports.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const meta = { group: "Carrier", title: "Dispatch", status: "works", about: "Booked loads." };
async function world() {
  const t = reportsWorld(cleanups);
  const p = await t.project("Portal", "POR", { off: true });
  const page = () => { t.idx.flushAll(); return buildPage(t.deps, t.idx.project(p.channel) as ProjectView); };
  return { t, p, page };
}

for (const equalCreation of [false, true]) test(`duplicate writes match reads with ${equalCreation ? "equal" : "different"} creation times`, async () => {
  const { t, p, page } = await world();
  const members = [t.teammate("kira"), t.teammate("maren")].sort((a, b) => compareIds(`${a.node.keys.nodeId}:1`, `${b.node.keys.nodeId}:1`));
  const bytes = png(10, 10);
  const start = t.tick();
  // The smaller ID is newer by creation, so skipping creation selects the wrong file.
  const roots = members.map((member, i) => {
    const ts = start + (equalCreation ? 0 : (1 - i) * 1000);
    const share = ev(t.team, member.node, "artifact.share", { hash: sha256Hex(bytes), name: `${i}.png`, size: bytes.length, mime: "image/png", note: "Data Room: Portal" }, { channel: p.channel, ts });
    const root = ev(t.team, member.node, "msg.post", { text: "Screen", board: { v: 1, rev: 0, op: "file", name: `${i}.png`, hash: sha256Hex(bytes), size: bytes.length, mime: "image/png", share: share.id, screen: { ...meta, w: 10, h: 10 } } } as BodyOf<"msg.post">, { channel: p.channel, ts });
    feed(t.core, [share, root]);
    return root;
  });
  t.tick(3000);
  for (const root of roots) addFile(t.w, p.channel, png(10, 10, 1), { file: root.id, name: "capture.png", mime: "image/png" });
  const files = t.idx.room(p.channel);
  expect(files[0]!.versions.at(-1)!.ts).toBe(files[1]!.versions.at(-1)!.ts);
  expect(files[0]!.created_at === files[1]!.created_at).toBe(equalCreation);
  setFact(t.w, p.channel, { label: "Build", value: "one" });
  const sibling = addScreen(t.w, p.channel, bytes, { ...meta, title: "Sibling" }).screen;
  const shown = page().screens.groups[0]!.screens.find((s) => s.title === meta.title)!;
  expect(shown.id).toBe(roots[equalCreation ? 1 : 0]!.id);
  t.tick();
  const written = addScreen(t.w, p.channel, png(10, 10, 1), { ...meta, status: "partial" });
  expect(written.screen.id).toBe(shown.id);
  expect(page().screens.groups[0]!.screens.find((s) => s.id === shown.id)!.status).toBe("partial");
  expect(page().screens.groups[0]!.screens.find((s) => s.id === sibling.id)).toEqual(sibling);
  expect(page().facts.set[0]!.value).toBe("one");
  expect(removeScreen(t.w, p.channel, meta).removed).toBe(2);
  expect(page().screens.total).toBe(1);
});

test("metadata advances page time but preserves image time; no-op writes preserve both", async () => {
  const { t, p, page } = await world();
  const bytes = png(10, 10);
  const added = addScreen(t.w, p.channel, bytes, meta);
  const changedAt = t.tick();
  const updated = addScreen(t.w, p.channel, bytes, { ...meta, about: "New details.", status: "partial" });
  expect(updated.screen.at).toBe(added.screen.at);
  expect(updated.version).toBe(1);
  expect(page().updated_at).toBe(changedAt);
  t.tick();
  expect(addScreen(t.w, p.channel, bytes, { ...meta, about: "New details.", status: "partial" }).unchanged).toBe(true);
  expect(page().updated_at).toBe(changedAt);
});

test("screen removal and last screen removal retain mutation time after rebuilding the index", async () => {
  const { t, p, page } = await world();
  const first = addScreen(t.w, p.channel, png(10, 10), meta);
  t.tick();
  addScreen(t.w, p.channel, png(10, 10), { ...meta, title: "Newest" });
  const removedAt = t.tick();
  removeScreen(t.w, p.channel, { ...meta, title: "Newest" });
  expect(page().updated_at).toBe(removedAt);
  expect(page().screens.groups[0]!.screens[0]!.id).toBe(first.screen.id);
  const lastAt = t.tick();
  removeScreen(t.w, p.channel, meta);
  expect(page().updated_at).toBe(lastAt);
  expect(page().screens.total).toBe(0);
  expect(t.idx.room(p.channel)).toHaveLength(2);
  const rebuilt = new ProjectsIndex(t.core, t.core.log);
  cleanups.push(() => rebuilt.stop());
  expect(buildPage({ ...t.deps, idx: rebuilt }, rebuilt.project(p.channel)!).updated_at).toBe(lastAt);
  t.tick();
  expect(removeScreen(t.w, p.channel, meta).removed).toBe(0);
  expect(page().updated_at).toBe(lastAt);
});

test("fact removal including the last fact retains time; same-millisecond edits are valid", async () => {
  const { t, p, page } = await world();
  expect(page().updated_at).toBeNull();
  setFact(t.w, p.channel, { label: "Build", value: "one" });
  const sameAt = page().updated_at;
  setFact(t.w, p.channel, { label: "Build", value: "two" });
  expect(page().facts.set[0]!.value).toBe("two");
  expect(page().updated_at).toBe(sameAt);
  t.tick();
  setFact(t.w, p.channel, { label: "Release", value: "Friday" });
  const removedAt = t.tick();
  setFact(t.w, p.channel, { label: "Release", value: null });
  expect(page().updated_at).toBe(removedAt);
  expect(page().facts.set[0]!.value).toBe("two");
  const lastAt = t.tick();
  setFact(t.w, p.channel, { label: "Build", value: null });
  expect(page().facts.set).toEqual([]);
  expect(page().updated_at).toBe(lastAt);
  t.idx.markPage(p.channel);
  expect(page().updated_at).toBe(lastAt);
  t.tick();
  expect(setFact(t.w, p.channel, { label: "Build", value: null }).unchanged).toBe(true);
  expect(page().updated_at).toBe(lastAt);
});

test("Data Room remove and restore affect screen time; unrelated room writes do not", async () => {
  const { t, p, page } = await world();
  const added = addScreen(t.w, p.channel, png(10, 10), meta);
  const removedAt = t.tick();
  changeFile(t.w, p.channel, added.screen.id, { state: "removed" });
  expect(page().updated_at).toBe(removedAt);
  expect(page().screens.total).toBe(0);
  const restoredAt = t.tick();
  changeFile(t.w, p.channel, added.screen.id, { state: "active" });
  expect(page().updated_at).toBe(restoredAt);
  t.tick();
  changeFile(t.w, p.channel, added.screen.id, { name: "renamed.png" });
  addFile(t.w, p.channel, png(20, 20), { name: "ordinary.png", mime: "image/png" });
  expect(page().updated_at).toBe(restoredAt);
});

test("a slower member clock cannot roll back time, and content edited after detaching is not a page mutation", async () => {
  const { t, p, page } = await world();
  const member = t.teammate("kira");
  const added = addScreen(t.w, p.channel, png(10, 10), meta);
  t.tick(2000);
  addScreen(t.w, p.channel, png(10, 10), { ...meta, about: "Updated details." });
  const latest = page().updated_at;
  const file = t.idx.room(p.channel).find((f) => f.id === added.screen.id)!;
  member.post(p.channel, { text: "Take off page", thread: file.id, board: { v: 1, rev: file.rev + 1, after: file.head, op: "file", screen: null } }, t.wall() - 1000);
  expect(page().screens.total).toBe(0);
  expect(page().updated_at).toBe(latest);
  t.tick();
  addFile(t.w, p.channel, png(10, 10, 2), { file: file.id, name: file.name, mime: "image/png" });
  expect(page().updated_at).toBe(latest);
  const reattachedAt = t.tick();
  addScreen(t.w, p.channel, png(10, 10, 2), meta);
  expect(page().updated_at).toBe(reattachedAt);
  expect(page().screens.total).toBe(1);
});
