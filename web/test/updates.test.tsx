// UPDATES-1: the Updates page (every reported project's latest plain-English status report on one page), its place near
// the top of the navigation, its route and shortcut, and the way to it from the Projects list. WALK-121: the picker on the
// page that turns a project's hourly update on (its order, its filter, who gets a control).
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectView, StatusReportPayload } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import type { UpdateEntry } from "../src/lib/updates.ts";
import { installWindow } from "./window-stub.ts";

const hadWindow = "window" in globalThis;
const hadDocument = "document" in globalThis;
installWindow();
const inert: unknown = new Proxy(() => inert, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : inert), apply: () => undefined });
(globalThis as { document?: unknown }).document ??= inert;
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  if (!hadDocument) delete (globalThis as { document?: unknown }).document;
});

let lib: typeof import("../src/lib/updates.ts");
let view: typeof import("../src/views/updates/Updates.tsx");
let route: typeof import("../src/lib/route.ts");
let hotkeys: typeof import("../src/lib/hotkeys.ts");
let shell: typeof import("../src/components/Shell.tsx");
let ProjectList: typeof import("../src/views/projects/ProjectList.tsx").ProjectList;
let Settings: typeof import("../src/views/settings/Settings.tsx").Settings;
let st: typeof import("../src/state/projects.ts");
let StaticStore: (p: { state: State; children: ReactNode }) => ReactNode;
let initialState: State;
beforeAll(async () => {
  lib = await import("../src/lib/updates.ts");
  view = await import("../src/views/updates/Updates.tsx");
  route = await import("../src/lib/route.ts");
  hotkeys = await import("../src/lib/hotkeys.ts");
  shell = await import("../src/components/Shell.tsx");
  ProjectList = (await import("../src/views/projects/ProjectList.tsx")).ProjectList;
  Settings = (await import("../src/views/settings/Settings.tsx")).Settings;
  st = await import("../src/state/projects.ts");
  StaticStore = (await import("../src/state/store.tsx")).StaticStore;
  initialState = (await import("../src/state/reducer.ts")).initialState;
});

const meter = { mode: "count" as const, done: 1, counted: 4, by_role: { backlog: 0, todo: 2, active: 1, review: 0, done: 1, cancelled: 0 } };
const project = (extra: Partial<ProjectView> = {}): ProjectView => ({
  channel: "p-00000001", id: "a000000000000001:1", name: "Website", folder: "Acme", description: "", prefix: "WEB", paths: [], meter_mode: "count",
  automations: { pr_opened: true, pr_merged: false, agents_can_close: true }, state: "active", steward: "on", steward_node: "", status_report: "hourly",
  private: false, admins: ["maren"], creator: "maren", created_at: 0, boards: [], meter, cards: 4, last_activity: Date.now(), ...extra,
});

const AT = Date.UTC(2026, 9, 1, 14, 0);
const report = (at: number, markdown = "**On track:** the pricing page shipped.\n\n## Next\n- Checkout."): UpdateEntry => ({
  status: "ready",
  data: { mode: "hourly", report: { markdown, header: null, as_of: at, at, by: { handle: "kira", agent: "orchestrator" } } } satisfies StatusReportPayload,
});

const web = project();
const hiring = project({ channel: "p-00000002", name: "Hiring", prefix: "HR", folder: "" });
const ops = project({ channel: "p-00000003", name: "Ops", prefix: "OPS" });
const off = project({ channel: "p-00000004", name: "Legal", prefix: "LEG", status_report: "off" });
const archived = project({ channel: "p-00000005", name: "Old site", prefix: "OLD", state: "archived" });

// ---- which projects, in what order ------------------------------------------------------------------------------------

test("only active projects with the hourly report on are reported; the other active ones are named, archived ones neither", () => {
  const all = [web, off, archived, hiring];
  expect(lib.reportedProjects(all).map((p) => p.prefix)).toEqual(["WEB", "HR"]);
  expect(lib.unreportedProjects(all).map((p) => p.prefix)).toEqual(["LEG"]);
  expect(lib.reportedProjects([project({ status_report: undefined })])).toEqual([]);
});

test("newest report first, then projects with none yet (loading, failed or empty) by name, without changing the input", () => {
  const input = [ops, web, hiring];
  const entries: Record<string, UpdateEntry> = {
    [web.channel]: report(AT),
    [hiring.channel]: report(AT + 3_600_000),
    [ops.channel]: { status: "error", message: "the daemon is not reachable" },
  };
  expect(lib.orderUpdates(input, entries).map((p) => p.prefix)).toEqual(["HR", "WEB", "OPS"]);
  expect(input.map((p) => p.prefix)).toEqual(["OPS", "WEB", "HR"]);
});

test("while any report is still loading, the projects keep the order of their latest activity", () => {
  const recent = project({ channel: "p-0000000a", name: "Zeta", prefix: "ZET", last_activity: 3_000 });
  const older = project({ channel: "p-0000000b", name: "Alpha", prefix: "ALP", last_activity: 1_000 });
  const middle = project({ channel: "p-0000000c", name: "Mid", prefix: "MID", last_activity: 2_000 });
  expect(lib.orderUpdates([older, recent, middle], {}).map((p) => p.prefix)).toEqual(["ZET", "MID", "ALP"]);
  // One report in, two still loading: still by activity, not the arrived one first.
  expect(lib.orderUpdates([older, recent, middle], { [older.channel]: report(AT), [recent.channel]: { status: "loading" } }).map((p) => p.prefix)).toEqual(["ZET", "MID", "ALP"]);
});

test("report reads run with at most the limit in flight, and every one runs", async () => {
  let inFlight = 0;
  let most = 0;
  const done: number[] = [];
  await lib.eachLimited([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    done.push(n);
  });
  expect(most).toBe(4);
  expect([...done].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  await lib.eachLimited([], 4, async () => { throw new Error("never called"); });
});

// ---- the page ---------------------------------------------------------------------------------------------------------

const html = (projects: ProjectView[], entries: Record<string, UpdateEntry>) =>
  renderToStaticMarkup(<view.UpdatesView projects={projects} entries={entries} onRetry={() => {}} />);

test("each reported project shows its report as Markdown, when it is as of, and links to its status page and board", () => {
  const out = html([web, off], { [web.channel]: report(AT) });
  expect(out).toContain("<strong>On track:</strong>");
  expect(out).toContain("Checkout.");
  expect(out).toContain('dateTime="2026-10-01T14:00:00.000Z"');
  expect(out).toContain("Acme · </span>Website");
  expect(out).toContain('href="#/projects/p-00000001/page"');
  expect(out).toContain('href="#/projects/p-00000001"');
  expect(out).toContain('aria-labelledby="update-p-00000001"');
  expect(out).toContain("plain English");
});

test("a project still loading is a busy skeleton, a failed one says why with a retry, one with no report yet says so", () => {
  const out = html([web, hiring, ops], {
    [hiring.channel]: { status: "error", message: "the daemon is not reachable" },
    [ops.channel]: { status: "ready", data: { mode: "hourly", report: null } },
  });
  expect(out).toContain('aria-busy="true"');
  expect(out).toContain("the daemon is not reachable");
  expect(out).toContain("Retry");
  expect(out).toContain("No update yet.");
});

// ---- the picker (WALK-121) ---------------------------------------------------------------------------------------------

test("the picker lists active projects only, in a fixed order: by folder (none first), then name, then channel, ignoring case", () => {
  const rows = [
    project({ channel: "p-0000000d", name: "zed", folder: "Beta", prefix: "ZED", status_report: "hourly" }),
    project({ channel: "p-0000000e", name: "Alpha", folder: "beta", prefix: "ALP", status_report: "off" }),
    project({ channel: "p-00000012", name: "Mid", folder: "", prefix: "MID", status_report: "hourly" }),
    project({ channel: "p-00000013", name: "Early", folder: "Acme", prefix: "EAR", status_report: "off" }),
    archived,
    project({ channel: "p-0000000f", name: "Gone", prefix: "GON", state: "deleted" }),
  ];
  const names = (list: ProjectView[]) => lib.pickerProjects(list).map((p) => p.name);
  expect(names(rows)).toEqual(["Mid", "Early", "Alpha", "zed"]);
  expect(rows.map((p) => p.prefix)).toEqual(["ZED", "ALP", "MID", "EAR", "OLD", "GON"]);
  // Whether a project is on is not part of the order: switch every one the other way and no row moves.
  const flipped = rows.map((p) => ({ ...p, status_report: p.status_report === "hourly" ? "off" as const : "hourly" as const }));
  expect(names(flipped)).toEqual(names(rows));
  // The same label in different case, or twice: the channel decides, so rows never swap between renders.
  const a = project({ channel: "p-00000011", name: "Site", folder: "A", status_report: "off" });
  const b = project({ channel: "p-00000010", name: "site", folder: "a", status_report: "off" });
  expect(lib.pickerProjects([a, b]).map((p) => p.channel)).toEqual(["p-00000010", "p-00000011"]);
  expect(lib.pickerProjects([b, a]).map((p) => p.channel)).toEqual(["p-00000010", "p-00000011"]);
});

test("the filter matches name, folder or prefix, ignoring case and surrounding spaces; no text keeps every project", () => {
  const all = [web, hiring, ops, off];
  expect(lib.filterPickerProjects(all, "").map((p) => p.prefix)).toEqual(["WEB", "HR", "OPS", "LEG"]);
  expect(lib.filterPickerProjects(all, "   ").map((p) => p.prefix)).toEqual(["WEB", "HR", "OPS", "LEG"]);
  expect(lib.filterPickerProjects(all, "WEBSITE").map((p) => p.prefix)).toEqual(["WEB"]);
  expect(lib.filterPickerProjects(all, "  acme ").map((p) => p.prefix)).toEqual(["WEB", "OPS", "LEG"]);
  expect(lib.filterPickerProjects(all, "hr").map((p) => p.prefix)).toEqual(["HR"]);
  expect(lib.filterPickerProjects(all, "nothing like it")).toEqual([]);
});

const owner = { handle: "kira", role: "owner" };
const pageHtml = (me: { handle: string; role: string }, projects: ProjectView[], entries: Record<string, UpdateEntry> = {}) =>
  renderToStaticMarkup(<StaticStore state={ready(me)}><view.UpdatesView projects={projects} entries={entries} onRetry={() => {}} /></StaticStore>);
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

test("with no project reported the picker is open under the explanation, in place of the pointer to the Projects list", () => {
  const out = pageHtml(owner, [off, project({ ...hiring, status_report: "off" }), archived]);
  expect(out).toContain("No project updates yet");
  // The same disclosure as when some are on (so it stays mounted when the first one is ticked), open, headed by its summary.
  expect(out).toContain('<details class="updates-pick-details" open="">');
  expect(out).toContain("<summary>Choose projects for hourly updates</summary>");
  expect(out).not.toContain("Projects list");
  expect(out).not.toContain('href="#/projects"');
  // Every active project has its switch, named for it; the archived one is not offered.
  expect(count(out, 'role="switch"')).toBe(2);
  expect(out).toContain('aria-label="Hourly status report for Legal"');
  expect(out).toContain('aria-label="Hourly status report for Hiring"');
  expect(out).not.toContain("Old site");
  expect(out.indexOf("No project updates yet")).toBeLessThan(out.indexOf("Choose projects for hourly updates"));
});

test("with projects reported the cards come first and the picker follows in a closed disclosure that counts what is on", () => {
  const out = pageHtml(owner, [web, hiring, off, archived], { [web.channel]: report(AT), [hiring.channel]: report(AT) });
  expect(out).toContain('<details class="updates-pick-details">');
  expect(out).not.toContain("<details open");
  expect(out).toContain("Hourly updates: 2 of 3 projects");
  expect(out.lastIndexOf('class="update"')).toBeLessThan(out.indexOf("<details"));
  expect(out).toContain("Choose projects for hourly updates");
  // In the order of the labels they show, folder then name, not with the reported ones first: Hiring has no folder, Legal and Website are Acme's.
  const rows = out.slice(out.indexOf("<details"));
  expect(rows.indexOf("Hiring")).toBeLessThan(rows.indexOf("Legal"));
  expect(rows.indexOf("Legal")).toBeLessThan(rows.indexOf("Website"));
  expect(out).not.toContain("have no hourly update");
  expect(out).not.toContain("has no hourly update");
  expect(out).not.toContain("Old site");
  expect(pageHtml(owner, [web, off], { [web.channel]: report(AT) })).toContain("Hourly updates: 1 of 2 projects");
});

test("each row keeps the report switch: the switch role and a label naming the project, checked where it is on", () => {
  const out = pageHtml(owner, [web, off], { [web.channel]: report(AT) });
  expect(count(out, 'role="switch"')).toBe(2);
  expect(out).toContain('aria-label="Hourly status report for Website"');
  expect(out).toContain('aria-checked="true"');
  expect(out).toContain('aria-checked="false"');
  expect(out).toContain("Acme · </span>Legal");
});

test("a person who may not change a project sees no control: Reported hourly where it is on, Off where it is not, and who can change it", () => {
  const out = pageHtml({ handle: "bob", role: "member" }, [web, off, hiring], { [web.channel]: report(AT), [hiring.channel]: report(AT) });
  expect(out).not.toContain('role="switch"');
  expect(out).not.toContain("<input");
  expect(count(out, "Reported hourly")).toBe(2);
  expect(count(out, 'class="project-report-off">Off</span>')).toBe(1);
  expect(count(out, "Only the creator or an owner can change this.")).toBe(3);
  // The creator of every project has the controls and no note about who can change them.
  const creator = pageHtml({ handle: "maren", role: "member" }, [web, off], { [web.channel]: report(AT) });
  expect(count(creator, 'role="switch"')).toBe(2);
  expect(creator).not.toContain("creator or an owner");
  // A project of someone else's stays without one.
  const someone = pageHtml({ handle: "maren", role: "member" }, [web, project({ channel: "p-00000022", name: "Theirs", prefix: "THE", creator: "bob", status_report: "off" })], { [web.channel]: report(AT) });
  expect(count(someone, 'role="switch"')).toBe(1);
  expect(count(someone, 'class="project-report-off">Off</span>')).toBe(1);
  expect(count(someone, "Only the creator or an owner can change this.")).toBe(1);
  // Nobody signed in: no control either.
  expect(pageHtml({ handle: "", role: "owner" } as { handle: string; role: string }, [web, off])).not.toContain('role="switch"');
});

test("a text filter appears above twelve active projects only, labelled Find a project", () => {
  const many = (n: number, extra: Partial<ProjectView> = {}) => Array.from({ length: n }, (_, i) =>
    project({ channel: `p-${(100 + i).toString(16).padStart(8, "0")}`, name: `Project ${String.fromCharCode(65 + i)}`, prefix: `P${i}`, status_report: "off", ...extra }));
  const twelve = pageHtml(owner, [...many(12), archived]);
  expect(twelve).not.toContain("Find a project");
  expect(twelve).not.toContain('type="search"');
  const thirteen = pageHtml(owner, many(13));
  expect(thirteen).toContain("Find a project");
  expect(thirteen).toContain('type="search"');
  expect(thirteen).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Find a project<\/label>/);
  // The archived ones are not counted, so twelve active plus archived stays without it.
  expect(pageHtml(owner, [...many(12), archived, project({ channel: "p-000000ff", name: "Old two", prefix: "OL2", state: "archived" })])).not.toContain("Find a project");
});

test("with no project reported it points to the switches below without a command", () => {
  const out = html([off, archived], {});
  expect(out).toContain("No project updates yet");
  expect(out).toContain("Turn on a project&#x27;s hourly status report");
  expect(out).not.toContain("walkie projects report");
  expect(out).not.toContain("Projects list");
  expect(out).not.toContain('class="update"');
});

test("with no active project the picker says so and points to the Projects page to make one", () => {
  const out = pageHtml(owner, [archived]);
  expect(out).toContain("No active projects yet");
  expect(out).toContain('href="#/projects"');
  expect(out).not.toContain('role="switch"');
});

// ---- where it is ------------------------------------------------------------------------------------------------------

test("the route is #/updates both ways", () => {
  expect(route.parseHash("#/updates").view).toBe("updates");
  expect(route.hrefFor({ view: "updates" })).toBe("#/updates");
});

test("g r jumps to it, and the shortcut list says so", () => {
  expect(hotkeys.SHORTCUTS.some((s) => s.keys.join(" ") === "g r" && s.label.startsWith("Updates"))).toBe(true);
});

const ready = (me: { handle: string; role: string }) => ({ ...initialState, phase: "ready" as const, me: { ...me, node: { hostname: "kira-mac" } } as unknown as State["me"], agents: [] });

test("Updates remains in Projects and Settings while the primary navigation has five items", () => {
  const rail = renderToStaticMarkup(<StaticStore state={ready({ handle: "kira", role: "owner" })}><shell.Sidebar onSearch={() => {}} /></StaticStore>);
  expect(rail).not.toContain('href="#/updates"');
  expect(rail).toContain('href="#/settings"');
  const settings = renderToStaticMarkup(<StaticStore state={ready({ handle: "kira", role: "owner" })}><Settings /></StaticStore>);
  expect(settings).toContain('href="#/updates"');
  const tabs = renderToStaticMarkup(<StaticStore state={ready({ handle: "kira", role: "owner" })}><shell.TabBar /></StaticStore>);
  expect(tabs).not.toContain('href="#/updates"');
  expect(tabs.match(/class="tab(?: is-active)?"/g)).toHaveLength(5);
});

test("the Projects list omits the Updates banner; Settings reaches reports", () => {
  st.projectsStore.set({ status: "ready", error: null, projects: [web, hiring, off], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  const out = renderToStaticMarkup(<StaticStore state={ready({ handle: "bob", role: "member" })}><ProjectList /></StaticStore>);
  expect(out).not.toContain('class="updates-link"');
  expect(out).toContain('class="project-row"');
});
