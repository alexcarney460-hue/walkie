// PROJECT-PAGES-1, the pure parts: the `page` op and who may write it, the fold of a project's set facts (newest wins per
// label, any arrival order, the limit of six), the screen register of a Data Room file, how the screens group and order
// on the page, and the check that an image is really a PNG, JPEG or WebP of a size a browser can show.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { refOf, type OpEvent } from "../../src/protocol/projects/fold.ts";
import { sniffImage } from "../../src/protocol/projects/page-image.ts";
import { jpeg, png, webpExtended, webpLossless, webpLossy } from "../helpers/images.ts";
import { cleanFactText, compareIds, composeScreens, factKey, foldPage, pageOpText, screenKey, screensWanted, SCREENS_STALE_MS, slugGroup } from "../../src/protocol/projects/page.ts";
import { foldRoom, roomFileView, roomOpText, type RoomFileState } from "../../src/protocol/projects/room.ts";
import {
  BoardOpSchema, FileOp, isBoardOp, MAX_FACTS, MAX_SCREEN_GROUPS, MAX_SCREENS, PageOp, ScreenMeta, SCREEN_MAX_BYTES, SCREEN_MAX_PIXELS, SCREEN_MAX_SIDE,
  type RoomFileView, type ScreenMetaT,
} from "../../src/protocol/projects/schema.ts";

const NODES = { alex: "a000000000000001", kira: "b000000000000002", maren: "c000000000000003" } as const;
type Who = keyof typeof NODES;
const seqs: Record<string, number> = {};
let clock = 1_700_000_000_000;
const hashOf = (id: string) => createHash("sha256").update(`sig-${id}`).digest("hex").slice(0, 16);
const H = (n: number) => n.toString(16).padStart(64, "0");

function post(who: Who, board: unknown, opts: { thread?: string; agent?: string; hidden?: boolean } = {}): OpEvent {
  const origin = NODES[who];
  const seq = (seqs[origin] = (seqs[origin] ?? 0) + 1);
  clock += 1000;
  const id = `${origin}:${seq}`;
  return {
    id, origin, seq, ts: clock, h: hashOf(id), author: { handle: who, node: origin, ...(opts.agent ? { agent: opts.agent } : {}) },
    ...(opts.thread ? { thread: opts.thread } : {}), text: "op", board, ...(opts.hidden ? { hidden: true } : {}),
  };
}

// ---- the page op and the facts fold ------------------------------------------------------------------------------------

const root = post("alex", { v: 1, rev: 0, op: "project", name: "Portal", prefix: "POR" });
const ROLES: Record<string, "owner" | "member" | "observer" | "removed" | null> = { alex: "owner", kira: "member", maren: "observer" };
const env = (roles: Record<string, "owner" | "member" | "observer" | "removed" | null> = ROLES) => ({ creator: "alex", roleOf: (ev: OpEvent) => roles[ev.author.handle] ?? null });
const fact = (who: Who, parent: OpEvent | null, label: string, value: string | null, opts: { agent?: string; thread?: string; hidden?: boolean } = {}): OpEvent =>
  post(who, { v: 1, rev: 1, op: "page", ...(parent ? { after: refOf(parent) } : {}), fact: { label, value } }, { thread: opts.thread ?? root.id, ...opts });
const shown = (f: ReturnType<typeof foldPage>) => f.facts.map((x) => [x.label, x.value]);

describe("the page op", () => {
  test("a fact is a label up to 24 and a value up to 60 plain characters; null as the value removes it", () => {
    const ok = (fact: unknown) => PageOp.safeParse({ v: 1, rev: 1, op: "page", fact }).success;
    expect(ok({ label: "Live build", value: "ddee2f0bca" })).toBe(true);
    expect(ok({ label: "Live build", value: null })).toBe(true);
    expect(ok({ label: "x".repeat(24), value: "y".repeat(60) })).toBe(true);
    expect(ok({ label: "x".repeat(25), value: "y" })).toBe(false);
    expect(ok({ label: "x", value: "y".repeat(61) })).toBe(false);
    expect(ok({ label: "", value: "y" })).toBe(false);
    expect(ok({ label: "x", value: "" })).toBe(false);
    expect(ok({ label: "line\nbreak", value: "y" })).toBe(false);
    expect(ok({ label: "x", value: "tab\there" })).toBe(false);
    expect(ok({ label: "x", value: "zero​width" })).toBe(false);
    expect(ok({ label: "x", value: "flip‮text" })).toBe(false);
    expect(ok({ label: "x", value: "para graph" })).toBe(false);
    expect(ok({ label: "Aufträge", value: "größer als 12 · 日本語" })).toBe(true);
    expect(PageOp.safeParse({ v: 1, rev: 1, op: "page" }).success).toBe(true); // an op with no fact is a valid, empty one
    expect(PageOp.safeParse({ v: 1, rev: 1, op: "page", fact: { label: "x" } }).success).toBe(false); // a value, or null, is required
  });

  test("it is a board op in a project channel, so hidden ones are bounded like every other board op", () => {
    const body = { text: "Status page: x", board: { v: 1, rev: 1, op: "page", fact: { label: "Live build", value: "1" } } };
    expect(BoardOpSchema.safeParse(body.board).success).toBe(true);
    expect(isBoardOp({ kind: "msg.post", channel: "p-00000001", body })).toBe(true);
    expect(isBoardOp({ kind: "msg.post", channel: "general", body })).toBe(false);
    expect(isBoardOp({ kind: "msg.post", channel: "p-00000001", body: { text: "x", board: { v: 1, rev: 1, op: "page", fact: { label: "x".repeat(40), value: "y" } } } })).toBe(false);
  });

  test("its readable text for a daemon that does not know it", () => {
    expect(pageOpText({ label: "Live build", value: "ddee2f0bca" })).toBe('Status page: "Live build" set to "ddee2f0bca"');
    expect(pageOpText({ label: "Live build", value: null })).toBe('Status page: "Live build" removed');
  });

  test("labels compare ignoring case, spacing and compatibility forms; text is tidied before it is checked", () => {
    expect(factKey("Live  build")).toBe(factKey(" live BUILD "));
    expect(factKey("Ｌｉｖｅ build")).toBe(factKey("live build"));
    expect(factKey("Live build")).not.toBe(factKey("Next release"));
    expect(cleanFactText("  Live \t build\n ")).toBe("Live build");
    expect(cleanFactText("é")).toBe("é"); // composed
  });
});

describe("the facts fold", () => {
  test("a member sets facts in the order they were first set; the same label again keeps its place and takes the newer value", () => {
    const a = fact("alex", null, "Live build", "ddee2f0bca");
    const b = fact("kira", a, "Next release", "Friday");
    const c = fact("alex", b, "Live build", "2d4ed863a3");
    const f = foldPage([root, a, b, c], root, env());
    expect(shown(f)).toEqual([["Live build", "2d4ed863a3"], ["Next release", "Friday"]]);
    expect(f.facts[0]).toMatchObject({ by: { handle: "alex" }, at: c.ts });
    expect(f.facts[1]).toMatchObject({ by: { handle: "kira" }, at: b.ts });
  });

  test("an agent of a member may set a fact too, and its name is kept", () => {
    const a = fact("kira", null, "Agents working", "about 70 on 6 machines", { agent: "cc-1" });
    const f = foldPage([root, a], root, env());
    expect(shown(f)).toEqual([["Agents working", "about 70 on 6 machines"]]);
    expect(f.facts[0]?.by.agent).toBe("cc-1");
  });

  test("an observer, a removed member and someone the roster does not know are not members: their ops are ignored", () => {
    const o = fact("maren", null, "Live build", "1");
    const gone = fact("kira", o, "Live build", "2");
    const f = foldPage([root, o, gone], root, env({ alex: "owner", kira: "removed", maren: "observer" }));
    expect(f.facts).toEqual([]);
    expect(f.ignored.map((i) => i.reason)).toEqual(["not_member", "not_member"]);
    expect(foldPage([root, fact("kira", null, "Live build", "1")], root, env({ alex: "owner" })).facts).toEqual([]);
  });

  test("a value of null removes the label; setting it again puts it at the end", () => {
    const a = fact("alex", null, "A", "1");
    const b = fact("alex", a, "B", "2");
    const rm = fact("kira", b, "a", null);
    const again = fact("alex", rm, "A", "3");
    expect(shown(foldPage([root, a, b, rm], root, env()))).toEqual([["B", "2"]]);
    expect(shown(foldPage([root, a, b, rm, again], root, env()))).toEqual([["B", "2"], ["A", "3"]]);
    expect(shown(foldPage([root, fact("alex", null, "Nothing", null)], root, env()))).toEqual([]); // removing what is not there is harmless
  });

  test("six labels at most: a seventh is ignored with its reason, and a freed slot can be taken", () => {
    let parent: OpEvent | null = null;
    const ops: OpEvent[] = [];
    for (let i = 1; i <= MAX_FACTS; i++) { parent = fact("alex", parent, `Fact ${i}`, String(i)); ops.push(parent); }
    const seventh = fact("kira", parent, "Fact 7", "7");
    const full = foldPage([root, ...ops, seventh], root, env());
    expect(full.facts).toHaveLength(MAX_FACTS);
    expect(full.facts.map((x) => x.label)).not.toContain("Fact 7");
    expect(full.ignored).toEqual([{ id: seventh.id, reason: "fact_limit" }]);
    const update = fact("kira", seventh, "fact 3", "three");
    expect(foldPage([root, ...ops, seventh, update], root, env()).facts.find((x) => x.label === "fact 3")?.value).toBe("three"); // a label already there is no new slot
    const free = fact("kira", seventh, "Fact 2", null);
    const taken = fact("kira", free, "Fact 7", "7");
    expect(foldPage([root, ...ops, seventh, free, taken], root, env()).facts.map((x) => x.label)).toEqual(["Fact 1", "Fact 3", "Fact 4", "Fact 5", "Fact 6", "Fact 7"]);
  });

  test("concurrent edits of different labels both stand; concurrent edits of one label end on the same value on every machine, whatever order they arrive in", () => {
    const base = fact("alex", null, "Live build", "1");
    const k = fact("kira", base, "Next release", "Friday");
    const a1 = fact("alex", base, "Live build", "2"); // same parent as k: concurrent
    const k2 = fact("kira", base, "Live build", "3"); // concurrent with a1
    const all = [root, base, k, a1, k2];
    const want = JSON.stringify(foldPage(all, root, env()));
    for (let i = 0; i < 30; i++) expect(JSON.stringify(foldPage([...all].sort(() => Math.random() - 0.5), root, env()))).toBe(want);
    const f = foldPage(all, root, env());
    expect(f.facts.find((x) => x.label === "Next release")?.value).toBe("Friday");
    // kira's edit names the base from another machine than the base's, so it ranks above alex's own follow-up to it (the fold's rule
    // for a correction from elsewhere): "3" ends up last, on every machine.
    expect(f.facts.find((x) => x.label === "Live build")?.value).toBe("3");
  });

  test("an op built on what its author saw ranks above it: a correction cannot be out-ranked by an older edit", () => {
    const a = fact("kira", null, "Live build", "1");
    const b = fact("alex", a, "Live build", "2");
    const c = fact("kira", b, "Live build", "3");
    for (const order of [[a, b, c], [c, b, a], [b, c, a]]) expect(foldPage([root, ...order], root, env()).facts[0]?.value).toBe("3");
  });

  test("an op in no project thread, one that names a parent that is not a page op, and one still waiting for its parent apply nothing", () => {
    const stray = fact("alex", null, "Stray", "1", { thread: "a000000000000001:9999" });
    const rootless = post("alex", { v: 1, rev: 1, op: "page", fact: { label: "Rootless", value: "1" } }); // a root post, not in the thread
    const settings = post("alex", { v: 1, rev: 1, op: "project", description: "x" }, { thread: root.id });
    const wrongParent = fact("alex", settings, "Settings parent", "1"); // a settings op is not a page op
    const missingParent = fact("alex", post("alex", { v: 1, rev: 0, op: "page" }, { thread: root.id }), "Waiting", "1");
    const f = foldPage([root, stray, rootless, settings, wrongParent], root, env());
    expect(f.facts).toEqual([]);
    expect(foldPage([root, missingParent], root, env()).facts).toEqual([]); // its parent never arrived
  });

  test("a hidden parent carries rank for the op built on it and applies nothing itself", () => {
    const hidden = fact("alex", null, "Hidden", "1", { hidden: true });
    const child = fact("kira", hidden, "Shown", "2");
    const f = foldPage([root, hidden, child], root, env());
    expect(shown(f)).toEqual([["Shown", "2"]]);
  });

  test("the head the next op names is the newest accepted page op (the project root when there is none), and its rev follows", () => {
    const empty = foldPage([root], root, env());
    expect([empty.head, empty.rev]).toEqual([refOf(root), 0]);
    const a = fact("alex", null, "A", "1");
    const b = fact("kira", a, "B", "2");
    const denied = fact("maren", b, "C", "3");
    const f = foldPage([root, a, b, denied], root, env());
    expect(f.head).toBe(refOf(b));
    expect(f.rev).toBe(2);
  });
});

// ---- the screen register of a room file --------------------------------------------------------------------------------

const meta = (over: Partial<ScreenMetaT> = {}): ScreenMetaT => ({ title: "Dispatch board", group: "Carrier", status: "works", about: "The board of booked loads.", ...over });
const content = (n: number, mime = "image/png", size = 1_000) => ({ hash: H(n), size, mime, share: `${NODES.alex}:${9000 + n}` });
const file = (who: Who, name: string, n: number, extra: Record<string, unknown> = {}, opts: { agent?: string } = {}) =>
  post(who, { v: 1, rev: 0, op: "file", name, ...content(n), ...extra }, opts);
const fileOp = (who: Who, rootEv: OpEvent, parent: OpEvent, fields: Record<string, unknown>, opts: { agent?: string } = {}) =>
  post(who, { v: 1, rev: 1, op: "file", after: refOf(parent), ...fields }, { thread: rootEv.id, ...opts });
const only = (posts: OpEvent[]): RoomFileState => { const fs = foldRoom(posts); expect(fs.length).toBe(1); return fs[0] as RoomFileState; };

describe("the screen register", () => {
  test("a file created as a screen carries its metadata; the view shows it, an ordinary file shows none", () => {
    const r = file("alex", "Screen - Carrier - Dispatch board.png", 1, { screen: meta() });
    const f = only([r]);
    expect(f.screen).toEqual(meta());
    expect(roomFileView(f, "p-00000001", { cards: [], available: true }).screen).toEqual(meta());
    const plain = only([file("alex", "spec.md", 2, {}, {})]);
    expect(plain.screen).toBeNull();
    expect("screen" in roomFileView(plain, "p-00000001", { cards: [], available: true })).toBe(false);
  });

  test("a later op replaces it (the last writer in fold order), with new content or without, and anyone who can post may: an agent too", () => {
    const r = file("alex", "s.png", 1, { screen: meta({ status: "partial" }) });
    const v2 = fileOp("kira", r, r, { ...content(2), screen: meta({ status: "works", about: "Now complete." }) }, { agent: "cc-1" });
    const only3 = fileOp("alex", r, v2, { screen: meta({ status: "empty" }) });
    const f = only([r, v2, only3]);
    expect([f.screen?.status, f.versions.length]).toEqual(["empty", 2]);
    expect(only([r, v2]).screen).toMatchObject({ status: "works", about: "Now complete." });
    expect(f.timeline.some((t) => t.ignored)).toBe(false);
  });

  test("null takes the file off the page and leaves it in the room; the file can be put back", () => {
    const r = file("alex", "s.png", 1, { screen: meta() });
    const off = fileOp("kira", r, r, { screen: null }, { agent: "cc-1" });
    const f = only([r, off]);
    expect([f.screen, f.state, f.versions.length]).toEqual([null, "active", 1]);
    expect(only([r, off, fileOp("alex", r, off, { screen: meta({ about: "Back again." }) })]).screen?.about).toBe("Back again.");
  });

  test("a screen that is not valid is ignored without costing the op its other fields (a newer daemon's metadata must not lose a version here)", () => {
    const r = file("alex", "s.png", 1, { screen: meta() });
    const bad = fileOp("kira", r, r, { ...content(2), screen: { title: "x", group: "g", status: "beta", about: "a new status this build does not know" } });
    const f = only([r, bad]);
    expect(f.versions.length).toBe(2); // the version still counts
    expect(f.screen).toEqual(meta()); // the register keeps what it had
    expect(FileOp.safeParse({ v: 1, op: "file", rev: 1, screen: { anything: true } }).success).toBe(true);
    expect(isBoardOp({ kind: "msg.post", channel: "p-00000001", body: { text: "x", board: { v: 1, rev: 1, op: "file", screen: 7 } } })).toBe(true);
  });

  test("a file's history never copies a screen value this build cannot read: it says so instead", () => {
    const r = file("alex", "s.png", 1, { screen: meta() });
    const junk = { deep: { deeper: ["x".repeat(2_000)] }, status: "from the future" };
    const bad = fileOp("kira", r, r, { screen: junk });
    const off = fileOp("alex", r, bad, { screen: null });
    const timeline = only([r, bad, off]).timeline;
    expect(timeline.find((t) => t.id === bad.id)?.changes).toEqual({ screen: "(unreadable)" });
    expect(timeline.find((t) => t.id === off.id)?.changes).toEqual({ screen: null });
    expect(timeline.find((t) => t.id === r.id)?.changes).toMatchObject({ screen: meta() });
    expect(JSON.stringify(timeline)).not.toContain("xxxxxxxx");
  });

  test("the readable text of an op names the screen change", () => {
    expect(roomOpText("s.png", { screen: null })).toBe("Data Room: s.png taken off the status page");
    expect(roomOpText("s.png", { screen: meta() })).toBe("Data Room: s.png screen details changed");
    expect(roomOpText("s.png", { hash: H(1), screen: meta() })).toBe("Data Room: s.png added");
  });

  test("metadata is plain: bounded lengths, a status from the four, a route that is a path, sizes that are real", () => {
    expect(ScreenMeta.safeParse(meta({ route: "/carrier/dispatch", note: "Seeded demo data.", w: 1280, h: 720 })).success).toBe(true);
    expect(ScreenMeta.safeParse(meta({ route: "#/projects/<project>?card=<card>" })).success).toBe(true); // an app that routes by hash
    for (const bad of [
      meta({ title: "" }), meta({ title: "x".repeat(61) }), meta({ group: "x".repeat(41) }), meta({ about: "x".repeat(301) }), meta({ note: "x".repeat(201) }),
      meta({ route: "carrier" }), meta({ route: "/has space" }), meta({ route: `/${"x".repeat(120)}` }), meta({ title: "two\nlines" }), meta({ about: "a‮b" }),
      meta({ status: "broken" as ScreenMetaT["status"] }), meta({ w: 0 }), meta({ h: SCREEN_MAX_SIDE + 1 }),
    ]) expect(ScreenMeta.safeParse(bad).success).toBe(false);
  });
});

// ---- how the screens group and order ------------------------------------------------------------------------------------

let n = 0;
const view = (group: string, title: string, over: Omit<Partial<RoomFileView>, "screen"> & { screen?: Partial<ScreenMetaT> | null } = {}): RoomFileView => {
  const i = ++n;
  const { screen, ...rest } = over;
  return {
    id: `${NODES.alex}:${i}`, channel: "p-00000001", name: `Screen - ${group} - ${title}.png`, pinned: false, state: "active", hash: H(i), size: 5_000, mime: "image/png",
    version: 1, versions: 1, updated_at: 1_000 + i, updated_by: { handle: "alex", node: NODES.alex }, created_at: 1_000 + i, created_by: { handle: "alex", node: NODES.alex },
    cards: [], available: true, rev: 0,
    ...(screen === null ? {} : { screen: meta({ group, title, ...screen }) }), ...rest,
  };
};

describe("the screens of a page", () => {
  test("groups come in the order their first screen was added, screens in the order they were added; each group counts its screens", () => {
    const files = [view("Sign-in", "Sign in"), view("Carrier", "Home"), view("Sign-in", "Product page"), view("Driver app", "Today"), view("Carrier", "Dispatch")];
    const { groups, total } = composeScreens(files);
    expect(groups.map((g) => [g.name, g.screens.map((s) => s.title)])).toEqual([["Sign-in", ["Sign in", "Product page"]], ["Carrier", ["Home", "Dispatch"]], ["Driver app", ["Today"]]]);
    expect(total).toBe(5);
    // The order does not depend on how the room happens to list the files.
    expect(composeScreens([...files].reverse()).groups.map((g) => g.name)).toEqual(["Sign-in", "Carrier", "Driver app"]);
  });

  test("screens added in the same instant keep the order they were added in: ids compare by origin, then by sequence as a number", () => {
    const at = 5_000;
    const mk = (seq: number, title: string) => ({ ...view("Carrier", title), id: `${NODES.alex}:${seq}`, created_at: at, updated_at: at });
    const files = [mk(11, "Third"), mk(9, "First"), mk(10, "Second")];
    expect(composeScreens(files).groups[0]?.screens.map((s) => s.title)).toEqual(["First", "Second", "Third"]);
    expect(compareIds(`${NODES.alex}:9`, `${NODES.alex}:10`)).toBeLessThan(0);
    expect(compareIds(`${NODES.kira}:1`, `${NODES.alex}:99`)).toBeGreaterThan(0);
    expect(compareIds(`${NODES.alex}:7`, `${NODES.alex}:7`)).toBe(0);
  });

  test("a replaced screen keeps its place and shows the newer version; the same title in another group is another screen", () => {
    const a = view("Carrier", "Home");
    const b = view("Carrier", "Billing");
    const replaced = { ...a, version: 2, versions: 2, updated_at: 9_999, hash: H(77) };
    const { groups } = composeScreens([replaced, b]);
    expect(groups[0]?.screens.map((s) => [s.title, s.version, s.at])).toEqual([["Home", 2, 9_999], ["Billing", 1, b.updated_at]]);
    const other = view("Broker", "Home");
    expect(composeScreens([a, other]).groups.map((g) => [g.name, g.screens.length])).toEqual([["Carrier", 1], ["Broker", 1]]);
  });

  test("two files for one group and title (added on two machines at once) show once: the newest", () => {
    const a = view("Carrier", "Home", { updated_at: 5_000 });
    const b = view("carrier", " home ", { updated_at: 6_000, screen: { group: "carrier", title: " home " } });
    const { groups, total } = composeScreens([a, b]);
    expect(total).toBe(1);
    expect(groups[0]?.screens[0]?.id).toBe(b.id);
    expect(screenKey("Carrier", "Home")).toBe(screenKey(" carrier ", "HOME"));
  });

  test("only active files with their register set and an image under the cap are on the page", () => {
    const keep = view("Carrier", "Keep");
    const files = [
      keep, view("Carrier", "Removed", { state: "removed" }), view("Carrier", "Off", { screen: null }), view("Carrier", "Pdf", { mime: "application/pdf" }),
      view("Carrier", "Svg", { mime: "image/svg+xml" }), view("Carrier", "Huge", { size: SCREEN_MAX_BYTES + 1 }), view("Carrier", "Empty", { size: 0 }),
    ];
    expect(composeScreens(files).groups.flatMap((g) => g.screens.map((s) => s.title))).toEqual(["Keep"]);
    expect(composeScreens([view("Carrier", "Jpeg", { mime: "image/jpeg" }), view("Carrier", "Webp", { mime: "image/webp" })]).total).toBe(2);
  });

  test("a screen says whether its bytes can be served, and who set it and when", () => {
    const { groups } = composeScreens([view("Carrier", "Home", { available: false, updated_by: { handle: "kira", node: NODES.kira, agent: "cc-2" } })]);
    expect(groups[0]?.screens[0]).toMatchObject({ available: false, by: { handle: "kira", agent: "cc-2" }, status: "works", mime: "image/png" });
  });

  test("a page shows at most 120 screens in 12 groups, in the order they were added", () => {
    const files: RoomFileView[] = [];
    for (let g = 1; g <= MAX_SCREEN_GROUPS + 3; g++) files.push(view(`Group ${g}`, "first"));
    expect(composeScreens(files).groups).toHaveLength(MAX_SCREEN_GROUPS);
    const many: RoomFileView[] = [];
    for (let i = 1; i <= MAX_SCREENS + 10; i++) many.push(view("One group", `Screen ${i}`));
    const out = composeScreens(many);
    expect(out.total).toBe(MAX_SCREENS);
    expect(out.groups[0]?.screens.at(-1)?.title).toBe(`Screen ${MAX_SCREENS}`);
  });

  test("groups get stable, unique anchors, whatever they are called", () => {
    expect(slugGroup("Driver app", new Set())).toBe("driver-app");
    expect(slugGroup("Sign-in / Sign up!", new Set())).toBe("sign-in-sign-up");
    expect(slugGroup("Café", new Set())).toBe("cafe");
    expect(slugGroup("司机", new Set())).toBe("group");
    expect(slugGroup("Driver app", new Set(["driver-app"]))).toBe("driver-app-2");
    const out = composeScreens([view("Staff", "a"), view("staff", "b", { screen: { group: "staff" } }), view("STAFF!", "c")]);
    expect(new Set(out.groups.map((g) => g.id)).size).toBe(out.groups.length);
  });

  test("the newest screen's time is what 'out of date' is judged by", () => {
    expect(composeScreens([]).newest_at).toBeNull();
    expect(composeScreens([view("A", "1", { updated_at: 4_000 }), view("A", "2", { updated_at: 9_000 })]).newest_at).toBe(9_000);
    const at = 100 * SCREENS_STALE_MS;
    expect(screensWanted({ count: 0, newest: null }, at)).toBe(true);
    expect(screensWanted({ count: 3, newest: at - SCREENS_STALE_MS - 1 }, at)).toBe(true);
    expect(screensWanted({ count: 3, newest: at - SCREENS_STALE_MS }, at)).toBe(false);
    expect(screensWanted({ count: 3, newest: at }, at)).toBe(false);
    expect(SCREENS_STALE_MS).toBe(7 * 24 * 3_600_000);
  });
});

// ---- images -------------------------------------------------------------------------------------------------------------

describe("the image check", () => {
  test("reads the type and the size from the bytes themselves", () => {
    expect(sniffImage(png(1280, 720))).toEqual({ mime: "image/png", width: 1280, height: 720 });
    expect(sniffImage(jpeg(390, 844))).toEqual({ mime: "image/jpeg", width: 390, height: 844 });
    expect(sniffImage(jpeg(1024, 768, false))).toEqual({ mime: "image/jpeg", width: 1024, height: 768 });
    expect(sniffImage(webpLossy(640, 480))).toEqual({ mime: "image/webp", width: 640, height: 480 });
    expect(sniffImage(webpLossless(800, 600))).toEqual({ mime: "image/webp", width: 800, height: 600 });
    expect(sniffImage(webpExtended(1920, 1080))).toEqual({ mime: "image/webp", width: 1920, height: 1080 });
  });

  test("anything else is not an image the page shows: SVG, HTML, a PDF, text, an empty or cut-short file", () => {
    const text = (s: string) => new TextEncoder().encode(s);
    for (const bad of [
      text('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), text("<!doctype html><script>alert(1)</script>"), text("%PDF-1.7"), text("GIF89a"), text("hello"),
      new Uint8Array(0), png(10, 10).slice(0, 20), jpeg(10, 10).slice(0, 10), webpLossy(10, 10).slice(0, 25), Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    ]) expect(sniffImage(bad)).toBeNull();
    // A file that starts like an image but is something else behind the signature is judged by its header only: the browser decides the rest, and a broken image shows a placeholder.
    expect(sniffImage(Uint8Array.from([...png(5, 5), ...text("<svg/>")]))).toEqual({ mime: "image/png", width: 5, height: 5 });
  });

  test("a size of zero, or one no tab should be asked to decode, is refused however few bytes it takes", () => {
    expect(sniffImage(png(0, 10))).toBeNull();
    expect(sniffImage(png(10, 0))).toBeNull();
    expect(sniffImage(png(SCREEN_MAX_SIDE, 100))?.width).toBe(SCREEN_MAX_SIDE);
    expect(sniffImage(png(SCREEN_MAX_SIDE + 1, 100))).toBeNull();
    expect(sniffImage(png(100, SCREEN_MAX_SIDE + 1))).toBeNull();
    expect(sniffImage(png(30_000, 30_000))).toBeNull(); // a few hundred bytes of compressed zeros: 900 million pixels
    const side = Math.floor(Math.sqrt(SCREEN_MAX_PIXELS));
    expect(sniffImage(png(side, side))).not.toBeNull();
    expect(sniffImage(png(side + 400, side + 400))).toBeNull();
    expect(sniffImage(jpeg(65_535, 65_535))).toBeNull();
    expect(sniffImage(webpExtended(16_000_000, 16_000_000))).toBeNull();
  });

  test("a hostile file costs next to nothing to look at", () => {
    const time = (f: () => unknown) => Math.min(...[1, 2, 3].map(() => { const t0 = performance.now(); f(); return performance.now() - t0; }));
    const marker = new Uint8Array(8_000_000).fill(0xff); // 0xff 0xff 0xff …: markers that never end
    marker[0] = 0xff; marker[1] = 0xd8;
    expect(time(() => sniffImage(marker))).toBeLessThan(200);
    expect(sniffImage(marker)).toBeNull();
    const segments = new Uint8Array(4_000_000);
    segments.set([0xff, 0xd8]);
    for (let i = 2; i + 4 <= segments.length; i += 4) segments.set([0xff, 0xe1, 0x00, 0x02], i); // empty segments, no frame header ever
    expect(time(() => sniffImage(segments))).toBeLessThan(200);
    expect(sniffImage(segments)).toBeNull();
  });
});
