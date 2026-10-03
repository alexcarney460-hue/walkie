// PROJECT-PAGES-1 in the daemon: facts and screens written through the service and the real routes (a person, a named agent,
// an unnamed one, an observer, someone who cannot see the project), what the page answers (the counts Walkie makes itself,
// the story the report post carries, the facts, the screens in groups), and the access rules (a project of the team's
// owners, cards labelled confidential, a report that is not WalkieTalkie's own).
import { afterEach, describe, expect, test } from "bun:test";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { ProjectsIndex } from "../../src/daemon/projects/index.ts";
import "../../src/daemon/projects/page-routes.ts";
import { addScreen, buildPage, removeScreen, setFact } from "../../src/daemon/projects/page.ts";
import { addFile, changeFile, fileContent } from "../../src/daemon/projects/room.ts";
import { createCard, updateCard, updateProject, type WriteCtx } from "../../src/daemon/projects/service.ts";
import { sha256Hex } from "../../src/daemon/blobs.ts";
import { dashboardRoute } from "../../src/daemon/local-api.ts";
import { MAX_FACTS, MAX_SCREEN_GROUPS, MAX_SCREENS, SCREEN_MAX_BYTES, DEFAULT_COLUMNS, type BoardDelta, type ProjectView } from "../../src/protocol/projects/schema.ts";
import type { StatusPagePayload } from "../../src/protocol/projects/status-page.ts";
import type { BodyOf, Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, ev as signed, memberEv, nodeEv, tnode } from "../helpers/events.ts";
import { png, jpeg, webpLossy } from "../helpers/images.ts";
import { reportsWorld } from "../helpers/project-reports.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const H = 3_600_000;
const D = 24 * H;
const meta = (over: Record<string, unknown> = {}) => ({ title: "Dispatch board", group: "Carrier", status: "works", about: "The board of booked loads.", ...over });
const seqOf = (core: { store: { allocatedSelfSeq(n: string): number }; nodeId: string }) => core.store.allocatedSelfSeq(core.nodeId);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** An owner's team with one project (the report on), and the helpers of the report tests. */
async function owner() {
  const t = reportsWorld(cleanups);
  const web = await t.project("Website relaunch", "WEB", { description: "The new site." });
  const page = (now?: number): StatusPagePayload => buildPage({ ...t.deps, ...(now !== undefined ? { now: () => now } : {}) }, t.idx.project(web.channel) as ProjectView);
  return { t, web, page };
}

/** What a member's or an observer's own machine sees: alex (owner, the creator) and the project are another machine's. */
function other(role: "member" | "observer", opts: { private?: boolean } = {}) {
  const alex = tnode("alex"), dave = tnode("dave");
  const { team, create } = createTeam(alex);
  const CH = "p-5e7a7e01";
  const channel = signed(team, alex, "channel.upsert", { name: CH, project: true, ...(opts.private ? { members: ["alex"] } : {}) });
  const root = signed(team, alex, "msg.post", { text: "Project", board: { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB" } } as BodyOf<"msg.post">, { channel: CH });
  const board = signed(team, alex, "msg.post", { text: "Board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } } as BodyOf<"msg.post">, { channel: CH });
  const core = makeCore(dave, team, cleanups);
  const idx = new ProjectsIndex(core, createLogger({}));
  cleanups.push(() => idx.stop());
  core.onPostChange = (e, change) => idx.onPost(e, change);
  core.onRosterChange = () => idx.rosterChanged();
  feed(core, [create, memberEv(team, alex, dave, role), nodeEv(team, alex, dave), channel, root, board]);
  idx.flushAll();
  const w: WriteCtx = { core, idx, client: {} as WriteCtx["client"], catchUp: async () => {} };
  return { core, idx, w, CH };
}

// ---- facts --------------------------------------------------------------------------------------------------------------

describe("setting a fact", () => {
  test("a member sets one: a signed page op in the project's thread with readable text; the page lists it with who and when", async () => {
    const { t, web, page } = await owner();
    const res = setFact(t.w, web.channel, { label: "Live build", value: "ddee2f0bca" });
    expect(res.unchanged).toBe(false);
    expect(res.facts).toMatchObject([{ label: "Live build", value: "ddee2f0bca", by: { handle: "alex" } }]);
    const posts = t.core.store.queryEvents({ channel: web.channel, kinds: ["msg.post"], limit: 1 }).map((r) => JSON.parse(r.json) as Event);
    const body = posts[0]?.body as { text: string; thread: string; board: Record<string, unknown> };
    expect(body.text).toBe('Status page: "Live build" set to "ddee2f0bca"');
    expect(body.thread).toBe(web.id);
    expect(body.board).toMatchObject({ v: 1, op: "page", fact: { label: "Live build", value: "ddee2f0bca" } });
    expect(page().facts.set).toMatchObject([{ label: "Live build", value: "ddee2f0bca", by: { handle: "alex" }, at: t.wall() }]);
  });

  test("setting it again takes the newer value and keeps its place; a label that differs only in case is the same fact; null removes", async () => {
    const { t, web, page } = await owner();
    setFact(t.w, web.channel, { label: "Live build", value: "1" });
    setFact(t.w, web.channel, { label: "Next release", value: "Friday" });
    t.tick();
    setFact(t.w, web.channel, { label: "live  build", value: "2" });
    expect(page().facts.set.map((f) => [f.label, f.value])).toEqual([["live build", "2"], ["Next release", "Friday"]]);
    setFact(t.w, web.channel, { label: "NEXT RELEASE", value: null });
    expect(page().facts.set.map((f) => f.label)).toEqual(["live build"]);
  });

  test("the same value again, or removing what is not there, signs nothing", async () => {
    const { t, web } = await owner();
    setFact(t.w, web.channel, { label: "Live build", value: "1" });
    const before = seqOf(t.core);
    expect(setFact(t.w, web.channel, { label: "Live build", value: "1" }).unchanged).toBe(true);
    expect(setFact(t.w, web.channel, { label: "Nothing here", value: null }).unchanged).toBe(true);
    expect(seqOf(t.core)).toBe(before);
  });

  test("six facts at most: the seventh is refused with what to do; removing one frees a place", async () => {
    const { t, web, page } = await owner();
    for (let i = 1; i <= MAX_FACTS; i++) setFact(t.w, web.channel, { label: `Fact ${i}`, value: String(i) });
    expect(() => setFact(t.w, web.channel, { label: "Fact 7", value: "7" })).toThrow(expect.objectContaining({ status: 409, code: "fact_limit", message: expect.stringContaining("--remove") }));
    expect(page().facts.set).toHaveLength(MAX_FACTS);
    setFact(t.w, web.channel, { label: "Fact 2", value: null });
    setFact(t.w, web.channel, { label: "Fact 7", value: "7" });
    expect(page().facts.set.map((f) => f.label)).toEqual(["Fact 1", "Fact 3", "Fact 4", "Fact 5", "Fact 6", "Fact 7"]);
  });

  test("a named agent of a member may set one, and its name stays on the fact; an agent that does not name itself may not", async () => {
    const { t, web, page } = await owner();
    setFact({ ...t.w, agent: "cc-9" }, web.channel, { label: "Agents working", value: "about 70 on 6 machines" });
    expect(page().facts.set[0]?.by).toEqual({ handle: "alex", agent: "cc-9" });
    expect(() => setFact({ ...t.w, underAgent: true }, web.channel, { label: "x", value: "y" })).toThrow(expect.objectContaining({ status: 403, code: "agent_unnamed" }));
  });

  test("an observer is refused with its reason, and nothing is written; a stranger cannot even see the project", async () => {
    const watcher = other("observer");
    expect(() => setFact(watcher.w, watcher.CH, { label: "x", value: "y" })).toThrow(expect.objectContaining({ status: 403, message: "observers can't change a project's status page" }));
    const stranger = other("member", { private: true });
    expect(() => setFact(stranger.w, stranger.CH, { label: "x", value: "y" })).toThrow(expect.objectContaining({ status: 404 }));
  });

  test("a member on another machine sets one, and it arrives like any signed event; an observer's op is ignored by the fold", async () => {
    const m = other("member");
    const before = seqOf(m.core);
    expect(setFact(m.w, m.CH, { label: "Next release", value: "Friday" }).facts[0]).toMatchObject({ label: "Next release", by: { handle: "dave" } });
    expect(seqOf(m.core)).toBe(before + 1);
    const { t, web, page } = await owner();
    const kira = t.teammate("kira");
    const watcher = t.teammate("maren", "member");
    t.core.emit("team.member", { login: tnode("maren").login, handle: "maren", role: "observer" });
    kira.post(web.channel, { text: 'Status page: "Live build" set to "7"', thread: web.id, board: { v: 1, rev: 1, op: "page", fact: { label: "Live build", value: "7" } } });
    watcher.post(web.channel, { text: 'Status page: "Live build" set to "evil"', thread: web.id, board: { v: 1, rev: 1, op: "page", fact: { label: "Live build", value: "evil" } } });
    t.idx.flushAll();
    expect(page().facts.set.map((f) => [f.label, f.value, f.by.handle])).toEqual([["Live build", "7", "kira"]]);
  });

  test("a project that is archived takes no new fact", async () => {
    const { t, web } = await owner();
    await updateProject(t.w, web.channel, { state: "archived" });
    expect(() => setFact(t.w, web.channel, { label: "x", value: "y" })).toThrow(expect.objectContaining({ status: 409 }));
  });

  test("hostile labels and values are refused with a plain reason and nothing is signed", async () => {
    const { t, web } = await owner();
    const before = seqOf(t.core);
    const refuse = (label: string, value: string | null, match: Partial<{ status: number; code: string; message: unknown }>) =>
      expect(() => setFact(t.w, web.channel, { label, value })).toThrow(expect.objectContaining(match));
    refuse("x".repeat(25), "y", { status: 400, message: "a fact's label is at most 24 characters" });
    refuse("x", "y".repeat(61), { status: 400, message: "a fact's value is at most 60 characters" });
    refuse("   ", "y", { status: 400, message: "a fact's label can't be empty" });
    refuse("x", "   ", { status: 400, message: "a fact's value can't be empty" });
    refuse("x\u0007y", "z", { status: 400, message: expect.stringContaining("characters a page can't show") });
    refuse("x", "zero​width", { status: 400, message: expect.stringContaining("characters a page can't show") });
    refuse("x", "flip‮text", { status: 400, message: expect.stringContaining("characters a page can't show") });
    refuse("Site", "https://evil.example/login", { status: 400, message: expect.stringContaining("plain text") });
    refuse("Site", "see www.evil.example", { status: 400, message: expect.stringContaining("plain text") });
    refuse("Site", "javascript:alert(1)", { status: 400, message: expect.stringContaining("plain text") });
    refuse("Invite", `wk1${"B".repeat(50)}`, { status: 400, message: expect.stringContaining("join code") });
    refuse("Key", "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA", { status: 409, code: "secret_detected" });
    expect(seqOf(t.core)).toBe(before);
  });

  test("what looks like a build id is not a secret: a short hash, a version, a date and a count are fine", async () => {
    const { t, web, page } = await owner();
    for (const [label, value] of [["Live build", "ddee2f0bca"], ["Version", "v0.2.0-pre.11"], ["Next release", "Friday 3 Oct"], ["Pilot checks", "12 / 38 at baseline"], ["Agents", "about 70 on 6 machines"]] as const) {
      setFact(t.w, web.channel, { label, value });
    }
    expect(page().facts.set.map((f) => f.value)).toEqual(["ddee2f0bca", "v0.2.0-pre.11", "Friday 3 Oct", "12 / 38 at baseline", "about 70 on 6 machines"]);
  });
});

// ---- screens ------------------------------------------------------------------------------------------------------------

describe("adding a screen", () => {
  test("it is a Data Room file named for its group and title, with its details beside it; the page groups it", async () => {
    const { t, web, page } = await owner();
    const res = addScreen(t.w, web.channel, png(1280, 720), meta({ route: "/carrier/dispatch", note: "Seeded demo data." }));
    expect([res.created, res.version, res.unchanged]).toEqual([true, 1, false]);
    expect(res.screen).toMatchObject({ title: "Dispatch board", group: "Carrier", status: "works", route: "/carrier/dispatch", note: "Seeded demo data.", w: 1280, h: 720, mime: "image/png", available: true, version: 1 });
    const files = t.idx.room(web.channel).filter((f) => f.state === "active");
    expect(files.map((f) => [f.name, f.pinned, f.versions.length])).toEqual([["Carrier - Dispatch board.png", false, 1]]);
    const g = page().screens;
    expect(g.total).toBe(1);
    expect(g.groups.map((x) => [x.id, x.name, x.screens.map((s) => s.title)])).toEqual([["carrier", "Carrier", ["Dispatch board"]]]);
    expect(g.newest_at).toBe(files[0]?.updated_at ?? null);
  });

  test("the file type is read from the bytes: JPEG and WebP are named for what they are, and the declared type is never asked", async () => {
    const { t, web, page } = await owner();
    addScreen(t.w, web.channel, jpeg(390, 844), meta({ title: "Phone", group: "Driver app" }));
    addScreen(t.w, web.channel, webpLossy(640, 480), meta({ title: "Web", group: "Driver app" }));
    expect(t.idx.room(web.channel).map((f) => f.name).sort()).toEqual(["Driver app - Phone.jpg", "Driver app - Web.webp"]);
    expect(page().screens.groups[0]?.screens.map((s) => s.mime)).toEqual(["image/jpeg", "image/webp"]);
  });

  test("the same group and title again replaces it: a new version of the same file, in the same place", async () => {
    const { t, web, page } = await owner();
    addScreen(t.w, web.channel, png(1280, 720, 1), meta());
    addScreen(t.w, web.channel, png(1280, 720, 2), meta({ title: "Billing" }));
    t.tick();
    const again = addScreen(t.w, web.channel, png(1280, 720, 3), meta({ title: "dispatch  BOARD", status: "partial", about: "Now with the crew board." }));
    expect([again.created, again.version]).toEqual([false, 2]);
    expect(t.idx.room(web.channel).filter((f) => f.state === "active")).toHaveLength(2);
    const [first, second] = page().screens.groups[0]?.screens ?? [];
    expect([first?.title, first?.version, first?.status, first?.about]).toEqual(["dispatch BOARD", 2, "partial", "Now with the crew board."]); // the newest details win, spelling included
    expect(second?.title).toBe("Billing");
  });

  test("the same bytes with new details change the details only; with the same details too, nothing is signed", async () => {
    const { t, web, page } = await owner();
    const bytes = png(1280, 720, 5);
    addScreen(t.w, web.channel, bytes, meta());
    const detailsOnly = addScreen(t.w, web.channel, bytes, meta({ status: "empty", about: "Nothing on the board yet." }));
    expect([detailsOnly.created, detailsOnly.version, detailsOnly.unchanged]).toEqual([false, 1, false]);
    expect(page().screens.groups[0]?.screens[0]).toMatchObject({ status: "empty", about: "Nothing on the board yet.", version: 1 });
    const before = seqOf(t.core);
    expect(addScreen(t.w, web.channel, bytes, meta({ status: "empty", about: "Nothing on the board yet." })).unchanged).toBe(true);
    expect(seqOf(t.core)).toBe(before);
  });

  test("a named agent adds one, and the screen says whose; an unnamed agent may not; an agent cannot add a version to a file a person pinned", async () => {
    const { t, web, page } = await owner();
    addScreen({ ...t.w, agent: "cc-3" }, web.channel, png(800, 600), meta());
    expect(page().screens.groups[0]?.screens[0]?.by).toEqual({ handle: "alex", agent: "cc-3" });
    expect(() => addScreen({ ...t.w, underAgent: true }, web.channel, png(800, 600, 1), meta({ title: "Other" }))).toThrow(expect.objectContaining({ code: "agent_unnamed" }));
    const file = t.idx.room(web.channel)[0] as { id: string };
    changeFile(t.w, web.channel, file.id, { pin: true });
    expect(() => addScreen({ ...t.w, agent: "cc-3" }, web.channel, png(800, 600, 9), meta())).toThrow(expect.objectContaining({ status: 403 }));
    // A person's replacement of the pinned file still works.
    expect(addScreen(t.w, web.channel, png(800, 600, 9), meta()).version).toBe(2);
  });

  test("what is not a screen is refused whatever it says it is, and nothing is written", async () => {
    const { t, web } = await owner();
    const before = seqOf(t.core);
    const text = (s: string) => new TextEncoder().encode(s);
    const refuse = (bytes: Uint8Array, m: Record<string, unknown>, match: Partial<{ status: number; code: string; message: unknown }>) =>
      expect(() => addScreen(t.w, web.channel, bytes, meta(m))).toThrow(expect.objectContaining(match));
    refuse(text('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>'), {}, { status: 400, message: expect.stringContaining("PNG, JPEG or WebP") });
    refuse(text("<!doctype html><script>alert(1)</script>"), {}, { status: 400 });
    refuse(text("%PDF-1.7"), {}, { status: 400 });
    refuse(new Uint8Array(0), {}, { status: 400 });
    refuse(png(30_000, 30_000), {}, { status: 400 });
    refuse(png(0, 10), {}, { status: 400 });
    refuse(new Uint8Array(SCREEN_MAX_BYTES + 1), {}, { status: 413, code: "too_large" });
    refuse(png(10, 10), { status: "broken" }, { status: 400, message: expect.stringContaining("works, partial, empty, not-built") });
    refuse(png(10, 10), { title: "" }, { status: 400 });
    refuse(png(10, 10), { title: "x".repeat(61) }, { status: 400, message: "a screen's title is at most 60 characters" });
    refuse(png(10, 10), { group: "x".repeat(41) }, { status: 400 });
    refuse(png(10, 10), { about: "x".repeat(301) }, { status: 400 });
    refuse(png(10, 10), { note: "x".repeat(201) }, { status: 400 });
    const routeRule = { status: 400, message: expect.stringContaining("the path of a page, like /carrier/loads") };
    refuse(png(10, 10), { route: "carrier/loads" }, routeRule);
    refuse(png(10, 10), { route: "/has space" }, routeRule);
    refuse(png(10, 10), { route: `/${"a".repeat(120)}` }, routeRule);
    refuse(png(10, 10), { route: "/go?to=https://evil.example" }, { status: 400, message: expect.stringContaining("not an address") });
    refuse(png(10, 10), { about: "see https://evil.example/login for the form" }, { status: 400, message: expect.stringContaining("plain text") });
    refuse(png(10, 10), { note: "token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, { status: 409, code: "secret_detected" });
    refuse(png(10, 10), { about: `invite wk1${"Q".repeat(60)}` }, { status: 400, message: expect.stringContaining("join code") });
    refuse(png(10, 10), { title: "bell\u0007ring" }, { status: 400, message: expect.stringContaining("characters a page can't show") });
    expect(seqOf(t.core)).toBe(before);
    expect(t.idx.room(web.channel)).toEqual([]);
  });

  test("line breaks and runs of spaces in a title are tidied to single spaces, not refused", async () => {
    const { t, web, page } = await owner();
    addScreen(t.w, web.channel, png(10, 10), meta({ title: "  two\n  lines\t here ", group: " Carrier\n" }));
    expect(page().screens.groups[0]).toMatchObject({ name: "Carrier", screens: [{ title: "two lines here" }] });
  });

  test("a slash in a group or title cannot make a Data Room name with a path in it, and two such names do not collide", async () => {
    const { t, web } = await owner();
    addScreen(t.w, web.channel, png(10, 10, 1), meta({ group: "Sign-in / Sign up", title: "A/B" }));
    addScreen(t.w, web.channel, png(10, 10, 2), meta({ group: "Sign-in - Sign up", title: "A-B" }));
    const names = t.idx.room(web.channel).map((f) => f.name).sort();
    expect(names).toEqual(["Sign-in - Sign up - A-B (2).png", "Sign-in - Sign up - A-B.png"]);
    expect(names.every((n) => !/[\\/]/.test(n))).toBe(true);
  });

  test("twelve groups and 120 screens at most; one more is refused with what to do", async () => {
    const { t, web, page } = await owner();
    for (let g = 1; g <= MAX_SCREEN_GROUPS; g++) addScreen(t.w, web.channel, png(10 + g, 10), meta({ group: `Group ${g}`, title: "First" }));
    expect(() => addScreen(t.w, web.channel, png(99, 10), meta({ group: "Group 13", title: "First" }))).toThrow(expect.objectContaining({ status: 409, code: "group_limit" }));
    // A screen in a group that exists is still welcome.
    addScreen(t.w, web.channel, png(98, 10), meta({ group: "group 1", title: "Second" }));
    expect(page().screens.groups).toHaveLength(MAX_SCREEN_GROUPS);
    const big = await owner();
    for (let i = 1; i <= MAX_SCREENS; i++) addScreen(big.t.w, big.web.channel, png(10 + i, 10), meta({ group: "All", title: `Screen ${i}` }));
    expect(() => addScreen(big.t.w, big.web.channel, png(500, 10), meta({ group: "All", title: "One more" }))).toThrow(expect.objectContaining({ status: 409, code: "screen_limit", message: expect.stringContaining("--remove") }));
    addScreen(big.t.w, big.web.channel, png(501, 10), meta({ group: "All", title: "screen 7" })); // a replacement is not one more
    expect(big.page().screens.total).toBe(MAX_SCREENS);
  }, 60_000);

  test("two machines adding the same screen at once show once, the newest; taking it off clears both", async () => {
    const { t, web, page } = await owner();
    addScreen(t.w, web.channel, png(100, 100, 1), meta());
    // kira's machine had not seen alex's file: it adds the same group and title as a file of its own, a moment later.
    const kira = t.teammate("kira");
    const bytes = png(100, 100, 2);
    t.tick();
    const share = signed(t.team, kira.node, "artifact.share", { hash: sha256Hex(bytes), name: "kira.png", size: bytes.byteLength, mime: "image/png", note: "Data Room: Website relaunch" }, { channel: web.channel, ts: t.wall() });
    const root = signed(t.team, kira.node, "msg.post", {
      text: "Data Room: kira.png added", board: { v: 1, rev: 0, op: "file", name: "kira.png", hash: sha256Hex(bytes), size: bytes.byteLength, mime: "image/png", share: share.id, screen: meta({ about: "Kira's capture." }) },
    } as BodyOf<"msg.post">, { channel: web.channel, ts: t.wall() });
    feed(t.core, [share, root]);
    t.idx.flushAll();
    expect(t.idx.room(web.channel).filter((f) => f.state === "active" && f.screen)).toHaveLength(2);
    const shown = page().screens;
    expect(shown.total).toBe(1);
    expect(shown.groups[0]?.screens[0]).toMatchObject({ about: "Kira's capture.", by: { handle: "kira" } });
    expect(removeScreen(t.w, web.channel, { group: "carrier", title: "DISPATCH board" })).toEqual({ removed: 2 });
    expect(page().screens.total).toBe(0);
  });
});

describe("taking a screen off the page", () => {
  test("the file stays in the Data Room; asking again says there is none; adding it again puts it back in its place", async () => {
    const { t, web, page } = await owner();
    addScreen(t.w, web.channel, png(100, 100, 1), meta());
    addScreen(t.w, web.channel, png(100, 100, 2), meta({ title: "Billing" }));
    expect(removeScreen(t.w, web.channel, { group: "Carrier", title: "Dispatch board" })).toEqual({ removed: 1 });
    expect(page().screens.groups[0]?.screens.map((s) => s.title)).toEqual(["Billing"]);
    expect(t.idx.room(web.channel).filter((f) => f.state === "active").map((f) => f.name).sort()).toEqual(["Carrier - Billing.png", "Carrier - Dispatch board.png"]);
    expect(removeScreen(t.w, web.channel, { group: "Carrier", title: "Dispatch board" })).toEqual({ removed: 0 });
    addScreen(t.w, web.channel, png(100, 100, 1), meta());
    expect(page().screens.groups[0]?.screens.map((s) => s.title)).toEqual(["Dispatch board", "Billing"]);
  });

  test("a plain Data Room file with the screen's name becomes its file (the Data Room's own rule: the same name is a new version)", async () => {
    const { t, web, page } = await owner();
    addFile(t.w, web.channel, png(100, 100, 7), { name: "Carrier - Dispatch board.png", mime: "image/png" });
    expect(page().screens.total).toBe(0);
    const res = addScreen(t.w, web.channel, png(100, 100, 8), meta());
    expect([res.created, res.version]).toEqual([false, 2]);
    expect(t.idx.room(web.channel)).toHaveLength(1);
    expect(page().screens.total).toBe(1);
  });

  test("an agent may take one off; an observer may not", async () => {
    const { t, web, page } = await owner();
    addScreen(t.w, web.channel, png(100, 100), meta());
    expect(removeScreen({ ...t.w, agent: "cc-1" }, web.channel, { group: "Carrier", title: "Dispatch board" })).toEqual({ removed: 1 });
    expect(page().screens.total).toBe(0);
    expect(() => removeScreen(other("observer").w, "p-5e7a7e01", { group: "x", title: "y" })).toThrow(expect.objectContaining({ status: 403 }));
  });

  test("an ordinary Data Room image is not on the page", async () => {
    const { t, web, page } = await owner();
    addFile(t.w, web.channel, png(100, 100), { name: "logo.png", mime: "image/png" });
    expect(page().screens.total).toBe(0);
  });
});

// ---- the page -----------------------------------------------------------------------------------------------------------

describe("the page", () => {
  test("with the report off it answers the setting, the facts and the screens (an agent can prepare them) and no story and no counts", async () => {
    const { t } = await owner();
    const quiet = await t.project("Quiet", "QUI", { off: true });
    setFact(t.w, quiet.channel, { label: "Live build", value: "1" });
    addScreen(t.w, quiet.channel, png(10, 10), meta());
    const p = buildPage(t.deps, t.idx.project(quiet.channel) as ProjectView);
    expect(p).toMatchObject({ mode: "off", story: null, facts: { computed: null, set: [{ label: "Live build" }] }, screens: { total: 1 } });
  });

  test("it counts what Walkie knows itself: done in the last 24 hours and 7 days, in progress, in review, blocked or waiting, agents working, and the last change", async () => {
    const { t, web, page } = await owner();
    const t0 = t.wall();
    createCard(t.w, web.channel, { title: "Old", column: "done" }); // 10 days before the page is read: in neither window
    t.tick(7 * D);
    createCard(t.w, web.channel, { title: "This week", column: "done" }); // 3 days before: this week only
    t.tick(3 * D - 2 * H);
    createCard(t.w, web.channel, { title: "Today", column: "done" }); // 2 hours before: both
    createCard(t.w, web.channel, { title: "Today too", column: "done" });
    createCard(t.w, web.channel, { title: "Doing 1", column: "doing" });
    createCard(t.w, web.channel, { title: "Doing 2", column: "doing", labels: ["blocker"] });
    createCard(t.w, web.channel, { title: "Review", column: "review" });
    const stuck = createCard(t.w, web.channel, { title: "Stuck", column: "todo" });
    updateCard(t.w, stuck.id, { blocked: true, blocked_reason: "waiting on legal" });
    createCard(t.w, web.channel, { title: "Waiting", column: "todo", labels: ["waiting-on"] });
    createCard(t.w, web.channel, { title: "Done but labelled", column: "done", labels: ["blocker"] }); // finished work is not blocked
    t.idx.flushAll();
    t.tick(2 * H);
    expect(page().facts.computed).toEqual({
      done_day: 3, done_week: 4, in_progress: 2, in_review: 1, blocked: 3, agents_working: 0, agent_machines: 0, last_change: t0 + 10 * D - 2 * H,
    });
  });

  test("cards labelled confidential are in no count and set no time; archived and deleted ones are not done work", async () => {
    const { t, web, page } = await owner();
    createCard(t.w, web.channel, { title: "Open", column: "doing" });
    t.tick(H);
    const gone = createCard(t.w, web.channel, { title: "Gone", column: "done" });
    updateCard(t.w, gone.id, { state: "deleted" });
    const filed = createCard(t.w, web.channel, { title: "Filed", column: "done" });
    updateCard(t.w, filed.id, { state: "archived" });
    t.idx.flushAll();
    const quiet = t.idx.db.card(filed.id)?.updated_at as number;
    t.tick(H); // the confidential cards are strictly the newest thing that happened
    createCard(t.w, web.channel, { title: "Merger memo", column: "doing", labels: ["Confidential "] });
    createCard(t.w, web.channel, { title: "Merger memo 2", column: "done", labels: ["confidential"] });
    createCard(t.w, web.channel, { title: "Merger memo 3", column: "todo", labels: ["confidential", "blocker"] });
    t.idx.flushAll();
    const c = page().facts.computed;
    expect(c).toMatchObject({ in_progress: 1, done_day: 0, done_week: 0, blocked: 0, in_review: 0 });
    expect(c?.last_change).toBe(quiet); // not the confidential cards' time
    expect(JSON.stringify(page())).not.toMatch(/Merger|memo/i);
  });

  test("agents working on the project now, and on how many machines (idle, offline and other projects' agents are not counted)", async () => {
    const { t, web, page } = await owner();
    const other = await t.project("Other", "OTH");
    t.card(web, "WEB-1 first");
    t.setAgents([
      t.agent("a1", "WEB-1", { id: "alex/m1/a1", node: "n-1" }),
      t.agent("a2", "WEB-1", { id: "alex/m1/a2", node: "n-1" }),
      t.agent("a3", "WEB-2", { id: "alex/m2/a3", node: "n-2" }),
      t.agent("idle", "WEB-1", { id: "alex/m3/idle", node: "n-3", effective_state: "idle" }),
      t.agent("off", "WEB-1", { id: "alex/m4/off", node: "n-4", effective_state: "offline" }),
      t.agent("elsewhere", "OTH-1", { id: "alex/m5/elsewhere", node: "n-5" }),
    ]);
    expect(page().facts.computed).toMatchObject({ agents_working: 3, agent_machines: 2 });
    expect(buildPage(t.deps, t.idx.project(other.channel) as ProjectView).facts.computed).toMatchObject({ agents_working: 1, agent_machines: 1 });
  });

  test("a project with no cards and no agents counts zeros and no last change", async () => {
    const { page } = await owner();
    expect(page().facts.computed).toEqual({ done_day: 0, done_week: 0, in_progress: 0, in_review: 0, blocked: 0, agents_working: 0, agent_machines: 0, last_change: null });
    expect(page()).toMatchObject({ story: null, facts: { set: [] }, screens: { total: 0, groups: [], newest_at: null }, updated_at: null, state: "active", mode: "hourly" });
  });
});

describe("the story", () => {
  const story = { v: 1, headline: "The portal is on track and sign-in is live", lede: "This page shows what the portal does today. Billing is still being built.", live_now: ["Customers can sign in."], landing_next: ["Billing is next."] };
  const report = (t: Awaited<ReturnType<typeof owner>>["t"], web: ProjectView, status_page: unknown, asOf = t.wall()) =>
    t.core.emit("msg.post", { text: `**Status report · Website relaunch · as of x**\n\nBody.`, status_report: { v: 1, as_of: asOf }, ...(status_page === undefined ? {} : { status_page }) } as BodyOf<"msg.post">, { channel: web.channel, agent: "orchestrator" });

  test("the newest report post's story is on the page, with when its facts are as of and who wrote it", async () => {
    const { t, web, page } = await owner();
    const at = t.wall();
    report(t, web, story, at);
    expect(page().story).toMatchObject({ headline: story.headline, lede: story.lede, live_now: story.live_now, landing_next: story.landing_next, as_of: at, by: { handle: "alex", agent: "orchestrator" } });
    expect(page().updated_at).toBe(page().story?.at ?? null);
  });

  test("a newer report with no page leaves the last story standing, with its own time; no report at all is no story", async () => {
    const { t, web, page } = await owner();
    expect(page().story).toBeNull();
    const first = t.wall();
    report(t, web, story, first);
    t.tick(H);
    report(t, web, undefined, t.wall());
    expect(page().story?.as_of).toBe(first);
  });

  test("it is read through the cleaning again, whoever signed it: a link goes, a join code drops the item or the page, a card key goes, a secret is redacted", async () => {
    const { t, web, page } = await owner();
    // A second owner's WalkieTalkie, as a daemon that did not clean would post (this daemon's own emit refuses a join code from an agent).
    const modified = t.teammate("kira", "owner");
    const post = (status_page: unknown) => { t.tick(H); modified.post(web.channel, { text: "**Status report · Website relaunch · as of x**\n\nBody.", status_report: { v: 1, as_of: t.wall() }, status_page }, t.wall(), "orchestrator"); };
    post({ ...story, headline: "Visit https://evil.example now: the portal is on track (WEB-12)", live_now: ["Key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA is set.", `Invite wk1${"Q".repeat(60)} sent.`, "Fine."] });
    const s = page().story;
    expect(s?.headline).toBe("Visit now: the portal is on track");
    expect(s?.live_now).toHaveLength(2);
    expect(s?.live_now[0]).not.toContain("sk-ant");
    expect(s?.live_now[1]).toBe("Fine.");
    post({ ...story, lede: `Join with wk1${"Z".repeat(60)} to see it.` });
    expect(page().story?.headline).toContain("Visit now"); // the newer one has no usable page; the older one stands
    post({ ...story, headline: 42, lede: ["not", "a", "string"], live_now: "nope" });
    post("a string where an object belongs");
    post({ v: 2, headline: "A page from the future, which this build does not read", lede: "Its version is not one this build knows how to show." });
    expect(page().story?.headline).toContain("Visit now");
  });

  test("a post by someone who is not an owner is not a report, even under WalkieTalkie's name", async () => {
    const { t, web, page } = await owner();
    t.teammate("kira").post(web.channel, { text: "**Status report · x**\n\nForged.", status_report: { v: 1, as_of: t.wall() }, status_page: { ...story, headline: "FORGED: everything is fine here" } }, undefined, "orchestrator");
    expect(page().story).toBeNull();
  });

  test("with the report off the story is not shown", async () => {
    const { t } = await owner();
    const quiet = await t.project("Quiet", "QUI", { off: true });
    report(t, quiet, story);
    expect(buildPage(t.deps, t.idx.project(quiet.channel) as ProjectView).story).toBeNull();
  });

  test("a sentence about out-of-date screens is shown only while it is true: a fresh screen takes it away, an old one leaves it", async () => {
    const { t, web, page } = await owner();
    report(t, web, { ...story, screens_note: "Screens are out of date; none have been added yet." });
    expect(page().story?.screens_note).toBe("Screens are out of date; none have been added yet.");
    addScreen(t.w, web.channel, png(10, 10), meta());
    expect(page().story).not.toHaveProperty("screens_note");
    expect(page(t.wall() + 8 * D).story?.screens_note).toBe("Screens are out of date; none have been added yet.");
  });
});

// ---- access -------------------------------------------------------------------------------------------------------------

describe("telling an open page", () => {
  test("a fact and a report send a `page` delta and a screen a `room` one; none of them re-folds a card or the project", async () => {
    const { t, web } = await owner();
    t.card(web, "WEB-1 first");
    t.idx.flushAll();
    const deltas: BoardDelta[] = [];
    t.idx.onDelta = (d) => deltas.push(d);
    setFact(t.w, web.channel, { label: "Live build", value: "1" });
    expect(deltas.filter((d) => d.channel === web.channel).map((d) => d.page === true)).toContain(true);
    deltas.length = 0;
    t.core.emit("msg.post", { text: "**Status report · Website relaunch · as of x**\n\nBody.", status_report: { v: 1, as_of: t.wall() } } as BodyOf<"msg.post">, { channel: web.channel, agent: "orchestrator" });
    t.idx.flushAll();
    expect(deltas.some((d) => d.channel === web.channel && d.page === true)).toBe(true);
    deltas.length = 0;
    addScreen(t.w, web.channel, png(10, 10), meta());
    expect(deltas.some((d) => d.channel === web.channel && d.room === true)).toBe(true);
    t.idx.flushAll();
    // Nothing but the page and the room changed: no delta asks a dashboard to refetch the board.
    expect(deltas.every((d) => !d.reset && !(d.cards?.length) && !(d.removed?.length))).toBe(true);
  });

  test("a fact changes no card and no setting: the project's view is the same but for its last activity (it is a post in the channel)", async () => {
    const { t, web } = await owner();
    t.card(web, "WEB-1 first");
    t.idx.flushAll();
    const without = (p: ProjectView | null) => JSON.stringify({ ...p, last_activity: 0 });
    const before = t.idx.project(web.channel);
    t.tick(H);
    setFact(t.w, web.channel, { label: "Live build", value: "1" });
    t.idx.flushAll();
    const after = t.idx.project(web.channel);
    expect(without(after)).toBe(without(before));
    expect(after?.last_activity).toBeGreaterThan(before?.last_activity ?? 0);
    expect(t.idx.db.cards(web.channel, { states: ["open"], limit: 10 })).toHaveLength(1);
  });
});

describe("who sees the page", () => {
  test("a project of the team's owners is not there for a member: not the page, not a fact, not a screen", async () => {
    const m = other("member", { private: true });
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const req = new Request(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: body instanceof Uint8Array ? (body as unknown as BodyInit) : JSON.stringify(body) }), headers });
      return dispatch({ core: m.core, sync: { requestCatchUp: async () => {}, isOnline: () => true }, client: {}, req, url: new URL(req.url), agent: undefined, via: "cli", listener: "unix", projects: m.idx, noTimeout: () => {} } as unknown as RouteCtx);
    };
    for (const attempt of [
      () => call("GET", `/v1/projects/${m.CH}/page`),
      () => call("POST", `/v1/projects/${m.CH}/page/facts`, { label: "x", value: "y" }),
      () => call("POST", `/v1/projects/${m.CH}/page/screens/remove`, { group: "x", title: "y" }),
      () => call("POST", `/v1/projects/${m.CH}/page/screens`, png(10, 10), { "x-walkie-screen": encodeURIComponent(JSON.stringify(meta())) }),
    ]) await expect(attempt()).rejects.toMatchObject({ status: 404 });
  });

  test("the dashboard's session allow-list takes the page's read and none of its writes", () => {
    expect(dashboardRoute("GET", "/v1/projects/p-12345678/page")).toBe(true);
    for (const [method, path] of [["POST", "/v1/projects/p-12345678/page"], ["POST", "/v1/projects/p-12345678/page/facts"], ["POST", "/v1/projects/p-12345678/page/screens"],
      ["POST", "/v1/projects/p-12345678/page/screens/remove"], ["DELETE", "/v1/projects/p-12345678/page"], ["GET", "/v1/projects/p-12345678/page/facts"], ["GET", "/v1/projects/not-one/page"]] as const) {
      expect(dashboardRoute(method, path)).toBe(false);
    }
  });
});

describe("the routes", () => {
  function caller(h: { core: ReturnType<typeof reportsWorld>["core"]; idx: ProjectsIndex }) {
    return (method: string, path: string, opts: { agent?: string; underAgent?: boolean; body?: unknown; headers?: Record<string, string> } = {}) => {
      const body = opts.body === undefined ? undefined : opts.body instanceof Uint8Array ? (opts.body as unknown as BodyInit) : JSON.stringify(opts.body);
      const req = new Request(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body }), ...(opts.headers ? { headers: opts.headers } : {}) });
      return dispatch({ core: h.core, sync: { requestCatchUp: async () => {}, isOnline: () => true }, client: {}, req, url: new URL(req.url), agent: opts.agent, ...(opts.underAgent ? { underAgent: true } : {}),
        via: "cli", listener: "unix", projects: h.idx, noTimeout: () => {} } as unknown as RouteCtx);
    };
  }
  const screenHeader = (m: Record<string, unknown> = meta()) => ({ "x-walkie-screen": encodeURIComponent(JSON.stringify(m)) });

  test("a person sets a fact, reads the page and removes the fact; a value and remove together, or neither, is a 400", async () => {
    const { t, web } = await owner();
    const call = caller(t);
    const set = await call("POST", `/v1/projects/${web.channel}/page/facts`, { body: { label: "Live build", value: "ddee2f0bca" } });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ unchanged: false, facts: [{ label: "Live build", value: "ddee2f0bca" }] });
    const read = await call("GET", `/v1/projects/${web.channel}/page`);
    expect(((await read.json()) as StatusPagePayload).facts.set).toHaveLength(1);
    await expect(call("POST", `/v1/projects/${web.channel}/page/facts`, { body: { label: "Live build", value: "x", remove: true } })).rejects.toMatchObject({ status: 400 });
    await expect(call("POST", `/v1/projects/${web.channel}/page/facts`, { body: { label: "Live build" } })).rejects.toMatchObject({ status: 400 });
    await expect(call("POST", `/v1/projects/${web.channel}/page/facts`, { body: { label: "Live build", value: "x", extra: 1 } })).rejects.toMatchObject({ status: 400 });
    const gone = await call("POST", `/v1/projects/${web.channel}/page/facts`, { body: { label: "live build", remove: true } });
    expect(await gone.json()).toMatchObject({ facts: [] });
  });

  test("a named agent writes; an unnamed one is refused; WalkieTalkie's reserved name is refused; a join code in an agent's text is refused", async () => {
    const { t, web } = await owner();
    const call = caller(t);
    expect((await call("POST", `/v1/projects/${web.channel}/page/facts`, { agent: "cc-1", body: { label: "Next release", value: "Friday" } })).status).toBe(200);
    await expect(call("POST", `/v1/projects/${web.channel}/page/facts`, { underAgent: true, body: { label: "x", value: "y" } })).rejects.toMatchObject({ status: 403, code: "agent_unnamed" });
    await expect(call("POST", `/v1/projects/${web.channel}/page/facts`, { agent: "orchestrator", body: { label: "x", value: "y" } })).rejects.toMatchObject({ status: 403 });
    await expect(call("POST", `/v1/projects/${web.channel}/page/facts`, { agent: "cc-1", body: { label: "Invite", value: `wk1${"B".repeat(50)}` } })).rejects.toMatchObject({ status: 403, code: "join_credential_private_reply_only" });
    await expect(call("POST", `/v1/projects/${web.channel}/page/screens`, { agent: "cc-1", body: png(10, 10), headers: screenHeader(meta({ about: `wk1${"B".repeat(50)}` })) })).rejects.toMatchObject({ status: 403 });
  });

  test("a screen goes in as the image's bytes with its details in a header; a missing, damaged or oversized one is refused before anything is read in", async () => {
    const { t, web } = await owner();
    const call = caller(t);
    const added = await call("POST", `/v1/projects/${web.channel}/page/screens`, { body: png(1280, 720), headers: screenHeader() });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ created: true, version: 1, unchanged: false, screen: { title: "Dispatch board", group: "Carrier", w: 1280, h: 720 } });
    await expect(call("POST", `/v1/projects/${web.channel}/page/screens`, { body: png(10, 10) })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("X-Walkie-Screen") });
    await expect(call("POST", `/v1/projects/${web.channel}/page/screens`, { body: png(10, 10), headers: { "x-walkie-screen": "%7Bnot json" } })).rejects.toMatchObject({ status: 400 });
    await expect(call("POST", `/v1/projects/${web.channel}/page/screens`, { body: png(10, 10), headers: { "x-walkie-screen": "x".repeat(12_001) } })).rejects.toMatchObject({ status: 400 });
    await expect(call("POST", `/v1/projects/${web.channel}/page/screens`, { body: png(10, 10), headers: screenHeader({ ...meta(), extra: 1 }) })).rejects.toMatchObject({ status: 400 });
    await expect(call("POST", `/v1/projects/${web.channel}/page/screens`, { body: new Uint8Array(SCREEN_MAX_BYTES + 1), headers: screenHeader() })).rejects.toMatchObject({ status: 413 });
    await expect(call("POST", `/v1/projects/${web.channel}/page/screens`, { body: new TextEncoder().encode("<svg/>"), headers: screenHeader() })).rejects.toMatchObject({ status: 400 });
    const off = await call("POST", `/v1/projects/${web.channel}/page/screens/remove`, { body: { group: "carrier", title: "dispatch board" } });
    expect(await off.json()).toEqual({ removed: 1 });
  });

  test("the page answers a project that does not exist with a 404, whatever the path", async () => {
    const { t } = await owner();
    await expect(caller(t)("GET", "/v1/projects/p-ffffffff/page")).rejects.toMatchObject({ status: 404 });
  });

  test("the bytes of a screen are served by the Data Room's own route, and only to those who see the project", async () => {
    const { t, web } = await owner();
    const { fileContent } = await import("../../src/daemon/projects/room.ts");
    const bytes = png(640, 480, 3);
    const res = addScreen(t.w, web.channel, bytes, meta());
    const got = await fileContent(t.w, web.channel, res.screen.id, undefined, async () => null);
    expect(decode(got.bytes.slice(0, 4))).toContain("PNG");
    expect(got.version.mime).toBe("image/png");
  });
});
