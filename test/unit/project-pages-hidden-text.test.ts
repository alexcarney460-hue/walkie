// PROJECT-PAGES-1: what a status page's own text (facts, screens) may not carry, at both ends. Where it is written the checks
// look at the text as shown and at its bare letters (a disguise cannot hide a join code or a secret), and a screen's route goes
// through the same checks as every other text. Where it is read the same checks run again, so a peer's signed event that was
// never checked (a modified daemon) is not shown as it came. Plus: a time from a clock that runs ahead is never shown as later
// than the moment the page was read.
import { afterEach, describe, expect, test } from "bun:test";
import { sha256Hex } from "../../src/daemon/blobs.ts";
import { addScreen, buildPage, setFact } from "../../src/daemon/projects/page.ts";
import { fileDetail, listRoom } from "../../src/daemon/projects/room.ts";
import type { ProjectView } from "../../src/protocol/projects/schema.ts";
import type { BodyOf } from "../../src/protocol/schemas.ts";
import { feed } from "../helpers/core.ts";
import { ev } from "../helpers/events.ts";
import { png } from "../helpers/images.ts";
import { reportsWorld } from "../helpers/project-reports.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const KEY = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CODE = `wk1${"B".repeat(40)}`;
const meta = { title: "Home", group: "Site", status: "works", about: "The home page." };
/** ASCII letters and digits as fullwidth forms: they read the same, and the daemon's own check does not see them. */
const fullwidth = (s: string) => s.replace(/[A-Za-z0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));

async function world() {
  const t = reportsWorld(cleanups);
  const p = await t.project("Portal", "POR", { off: true });
  const page = () => { t.idx.flushAll(); return buildPage(t.deps, t.idx.project(p.channel) as ProjectView); };
  return { t, p, page };
}

describe("where it is written", () => {
  const refuseFact = (t: Awaited<ReturnType<typeof world>>["t"], channel: string, value: string, match: object) =>
    expect(() => setFact(t.w, channel, { label: "Note", value })).toThrow(expect.objectContaining(match));

  test("a join code written with an accent or in fullwidth letters is refused, like a plain one", async () => {
    const { t, p } = await world();
    refuseFact(t, p.channel, `wk1á${CODE.slice(4)}`, { status: 400, message: expect.stringContaining("join code") });
    refuseFact(t, p.channel, fullwidth(CODE), { status: 400, message: expect.stringContaining("join code") });
  });

  test("a secret with a blank-looking filler or an accent inside it is refused, like a plain one", async () => {
    const { t, p } = await world();
    refuseFact(t, p.channel, `${KEY.slice(0, 8)}ㅤ${KEY.slice(8)}`, { status: 409, code: "secret_detected" });
    refuseFact(t, p.channel, KEY, { status: 409, code: "secret_detected" });
  });

  test("a screen's route goes through the secret check and the join-code check, and is a path, never an address", async () => {
    const { t, p } = await world();
    const add = (route: string) => () => addScreen(t.w, p.channel, png(10, 10), { ...meta, route });
    expect(add(`/settings?key=${KEY}`)).toThrow(expect.objectContaining({ status: 409, code: "secret_detected" }));
    expect(add(`/invite/${CODE}`)).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("not an address") }));
    expect(add("//evil.example/phish")).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("not an address") }));
    expect(add("#//evil.example/phish")).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("not an address") }));
    // Browsers read a backslash after the slash as a second slash.
    expect(add("/\\evil.example/phish")).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("not an address") }));
    expect(add("#/\\evil.example/phish")).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("not an address") }));
    // An honest route is a path, and takes the screen.
    expect(addScreen(t.w, p.channel, png(10, 10), { ...meta, route: "/carrier/loads" }).screen.route).toBe("/carrier/loads");
    expect(addScreen(t.w, p.channel, png(11, 10), { ...meta, title: "Hash", route: "#/projects" }).screen.route).toBe("#/projects");
  });

  test("routes of the product's real shapes still pass: paths, slugs, numeric ids, and the dashboard's own ids", async () => {
    const { t, p } = await world();
    const routes = [
      "/carrier/loads", "/carrier/loads/12345", "/loads/LD-20931", "/orders/000123456789012345678901234",
      "/settings/billing-and-invoices", "/blog/how-to-do-it-in-a-day-or-two", "/reports/2026-10-02-weekly-sync", "/docs/internationalization-guide",
      "/ShipmentTrackingDashboard/OverviewPanel", "/users/507f1f77bcf86cd799439011", "/watch/dQw4w9WgXcQ",
      // The dashboard's own routes (web/src/lib/route.ts): a hash route, a project channel, an event id (a board, a card, a thread; its
      // colon raw or encoded) and a machine's node id.
      "#/projects", "#/projects/p-0000a1b2", "#/projects/p-0000a1b2/a000000000000001:12", "#/projects/p-0000a1b2/a000000000000001%3A12",
      "#/projects/p-0000a1b2/room", "#/projects/p-0000a1b2/page", "#/machines/a1b2c3d4e5f6a7b8", "#/board/general/a000000000000001:7",
    ];
    for (const [i, route] of routes.entries()) {
      expect(addScreen(t.w, p.channel, png(10, 10 + i, i), { ...meta, title: `Ok ${i}`, route }).screen.route, route).toBe(route);
    }
  });

  test("a one-time token in a route's path is refused, whatever shape it takes, with a plain reason", async () => {
    const { t, p } = await world();
    // Built at runtime: a committed JWT-shaped literal stops the public export's secret scan.
    const jwt = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join(".");
    const tokens = [
      "/invite/Xk9pQ2rT7vW4yZ1aB6cD3eF8gH5jK0mN", "/reset/3f9a1c7e2b8d4f6a9c0e1b2d3f4a5b6c", "/reset/8f14e45f-ceea-467f-a8d0-e8f8f8f8f8f8",
      "#/accept/Xk9pQ2rT7vW4yZ1aB6cD3eF8gH5jK0mN", "/join/Xk9pQ2rT-7vW4yZ1a_B6cD3eF8gH5jK0mN", "/verify/a8f3k2m9x1q7w5z4p6n0b3v8c2d9", "/s/session-3f9a1c7e2b8d4f6a9c0e1b2d3f4a5b6c",
    ];
    let i = 0;
    for (const route of tokens) {
      expect(() => addScreen(t.w, p.channel, png(30 + i, 10, i++), { ...meta, title: `T${i}`, route }), route)
        .toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("one-time token") }));
    }
    // A token the secret detector already knows is still answered as a secret.
    expect(() => addScreen(t.w, p.channel, png(50, 10), { ...meta, title: "Jwt", route: `/invite/${jwt}` })).toThrow(expect.objectContaining({ status: 409, code: "secret_detected" }));
    // Facts and notes are unchanged: a build id or a long hash is still fine there.
    expect(setFact(t.w, p.channel, { label: "Token-ish", value: "3f9a1c7e2b8d4f6a9c0e1b2d3f4a" }).unchanged).toBe(false);
    expect(addScreen(t.w, p.channel, png(51, 10), { ...meta, title: "Noted", note: "Build Xk9pQ2rT7vW4yZ1aB6cD3eF8gH5jK0mN shown." }).screen.note).toBe("Build Xk9pQ2rT7vW4yZ1aB6cD3eF8gH5jK0mN shown.");
  });

  test("a screen's route has no query string: a token the detectors do not know (an OAuth code, a session id) cannot ride along; what the page was filtered by goes in the note", async () => {
    const { t, p } = await world();
    let i = 0;
    for (const route of ["/carrier/loads?status=open", "/auth/callback?code=4/0AY0e-g7Xq3vB2mZpLkR8sT1uW9yNcD5fHjK6", "/app?session_id=3f9a1c7e2b8d4f6a9c0e1b2d3f4a5b6c", "#/projects?card=x"]) {
      expect(() => addScreen(t.w, p.channel, png(20 + i, 10, i++), { ...meta, title: `Q${i}`, route })).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("no query string") }));
    }
    expect(addScreen(t.w, p.channel, png(10, 10), { ...meta, route: "/carrier/loads", note: "Filtered to open loads." }).screen.note).toBe("Filtered to open loads.");
  });
});

describe("where it is read", () => {
  test("a fact a modified peer signed with a link, a join code or a secret is not shown as written; an honest one is untouched", async () => {
    const { t, p, page } = await world();
    const kira = t.teammate("kira");
    const put = (rev: number, label: string, value: string) =>
      kira.post(p.channel, { text: `Status page: ${label}`, thread: p.id, board: { v: 1, rev, op: "page", fact: { label, value } } });
    put(1, "Docs", "see https://evil.example/login now");
    put(2, "Invite", CODE);
    put(3, "Token", `use ${KEY}`);
    put(4, "Build", "ddee2f0bca");
    const shown = page().facts.set;
    const byLabel = Object.fromEntries(shown.map((f) => [f.label, f.value]));
    expect(byLabel.Build).toBe("ddee2f0bca");
    expect(byLabel.Docs).toBe("see now");
    expect(byLabel.Docs).not.toContain("https");
    expect(byLabel.Token).not.toContain("sk-ant");
    expect(Object.keys(byLabel)).not.toContain("Invite"); // a join code withholds the fact altogether
    expect(JSON.stringify(shown)).not.toContain(CODE);
  });

  test("a screen a modified peer signed with a link, a secret, a join code or an address for a route is shown cleaned, or not at all", async () => {
    const { t, p, page } = await world();
    const kira = t.teammate("kira");
    const bytes = png(10, 10);
    const sign = (name: string, screen: Record<string, unknown>, at: number) => {
      const share = ev(t.team, kira.node, "artifact.share", { hash: sha256Hex(bytes), name, size: bytes.length, mime: "image/png", note: "Data Room: Portal" }, { channel: p.channel, ts: at });
      const root = ev(t.team, kira.node, "msg.post", { text: "Screen", board: { v: 1, rev: 0, op: "file", name, hash: sha256Hex(bytes), size: bytes.length, mime: "image/png", share: share.id, screen: { ...screen, w: 10, h: 10 } } } as BodyOf<"msg.post">, { channel: p.channel, ts: at });
      feed(t.core, [share, root]);
    };
    const start = t.tick();
    sign("a.png", { ...meta, title: "Home", about: `Log in at https://evil.example/x with ${KEY}`, note: `Invite ${CODE}`, route: "//evil.example/phish" }, start);
    sign("b.png", { ...meta, title: "Pricing", about: "The price list.", route: `/settings?key=${KEY}` }, start + 1);
    sign("c.png", { ...meta, title: `Invite ${CODE}`, about: "Never shown." }, start + 2);
    sign("d.png", { ...meta, title: "Honest", about: "A plain sentence.", note: "Seen signed out.", route: "/carrier/loads" }, start + 3);
    sign("e.png", { ...meta, title: "Backslash", about: "A route browsers read as an address.", route: "/\\evil.example/phish" }, start + 4);
    sign("f.png", { ...meta, title: "Callback", about: "Where the sign-in lands.", route: "/auth/callback?code=4/0AY0e-g7Xq3vB2mZpLkR8sT1uW9yNcD5fHjK6" }, start + 5);
    sign("g.png", { ...meta, title: "Invite", about: "Accepting an invitation.", route: "/invite/Xk9pQ2rT7vW4yZ1aB6cD3eF8gH5jK0mN" }, start + 6);
    t.idx.flushAll();
    const screens = page().screens.groups.flatMap((g) => g.screens);
    const named = Object.fromEntries(screens.map((s) => [s.title, s]));
    expect(Object.keys(named).sort()).toEqual(["Backslash", "Callback", "Home", "Honest", "Invite", "Pricing"]); // the one whose title is a join code is not there
    expect(named.Home!.about).not.toMatch(/https?:|evil\.example|sk-ant/);
    expect(named.Home!.about).toContain("Log in at");
    expect(named.Home!.note).toBeUndefined();
    expect(named.Home!.route).toBeUndefined();
    expect(named.Pricing!.route).toBe("/settings"); // the query string, where the key was, is never shown
    expect(named.Callback!.route).toBe("/auth/callback");
    expect(named.Backslash!.route).toBeUndefined();
    expect(named.Invite!.route).toBeUndefined(); // a token in the path: the screen stays, the route does not
    expect(named.Honest).toMatchObject({ about: "A plain sentence.", note: "Seen signed out.", route: "/carrier/loads" });
    expect(JSON.stringify(page())).not.toContain(CODE);
    expect(JSON.stringify(page())).not.toContain("sk-ant");
  });
});

describe("facts and screens a modified peer signed, further", () => {
  test("a fact withheld for a join code does not take one of the six places", async () => {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB", { off: true });
    const kira = t.teammate("kira");
    const put = (rev: number, label: string, value: string) => kira.post(web.channel, { text: `Status page: ${label}`, thread: web.id, board: { v: 1, rev, op: "page", fact: { label, value } } });
    put(1, "One", "1"); put(2, "Two", "2"); put(3, "Three", "3"); put(4, "Four", "4");
    put(5, "Invite", CODE);
    const page = () => { t.idx.flushAll(); return buildPage(t.deps, t.idx.project(web.channel) as ProjectView); };
    expect(page().facts.set.map((f) => f.label)).toEqual(["One", "Two", "Three", "Four"]);
    // Four are shown, so two more fit; the seventh label is the one that is refused.
    setFact(t.w, web.channel, { label: "Five", value: "5" });
    setFact(t.w, web.channel, { label: "Six", value: "6" });
    expect(page().facts.set).toHaveLength(6);
    expect(() => setFact(t.w, web.channel, { label: "Seven", value: "7" })).toThrow(expect.objectContaining({ status: 409, code: "fact_limit" }));
  });

  test("the Data Room's listing and a file's history show a screen's details as the page does", async () => {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB", { off: true });
    const kira = t.teammate("kira");
    const bytes = png(10, 10);
    const at = t.tick();
    const share = ev(t.team, kira.node, "artifact.share", { hash: sha256Hex(bytes), name: "a.png", size: bytes.length, mime: "image/png", note: "Data Room: Website" }, { channel: web.channel, ts: at });
    const root = ev(t.team, kira.node, "msg.post", { text: "Screen", board: { v: 1, rev: 0, op: "file", name: "a.png", hash: sha256Hex(bytes), size: bytes.length, mime: "image/png", share: share.id,
      screen: { title: "Home", group: "Site", status: "works", about: "Log in at https://evil.example/x now", note: `Invite ${CODE}`, route: "//evil.example/phish", w: 10, h: 10 } } } as BodyOf<"msg.post">, { channel: web.channel, ts: at });
    feed(t.core, [share, root]);
    t.idx.flushAll();
    const listed = listRoom(t.w, web.channel).files.find((f) => f.id === root.id)!;
    expect(listed.screen?.about).toBe("Log in at now");
    expect(listed.screen?.note).toBeUndefined();
    expect(listed.screen?.route).toBeUndefined();
    const detail = fileDetail(t.w, web.channel, root.id);
    expect(detail.file.screen?.about).toBe("Log in at now");
    expect(JSON.stringify(detail.timeline)).not.toContain("evil.example");
    expect(JSON.stringify(detail.timeline)).not.toContain(CODE);
  });
});

test("a time from a clock that runs ahead is never later than the moment the page was read", async () => {
  const { t, p, page } = await world();
  const kira = t.teammate("kira");
  const ahead = t.wall() + 20 * 3_600_000;
  kira.post(p.channel, { text: "Status page: Live build", thread: p.id, board: { v: 1, rev: 1, op: "page", fact: { label: "Live build", value: "abc" } } }, ahead);
  const read = page();
  expect(read.facts.set[0]!.at).toBeLessThanOrEqual(read.generated_at);
  expect(read.updated_at).not.toBeNull();
  expect(read.updated_at!).toBeLessThanOrEqual(read.generated_at);
});
