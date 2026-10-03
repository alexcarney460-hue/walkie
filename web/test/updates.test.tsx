// UPDATES-1: the Updates page (every reported project's latest plain-English status report on one page), its place near
// the top of the navigation, its route and shortcut, and the way to it from the Projects list.
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

test("the other active projects are named under a closed disclosure, with who can turn their report on", () => {
  const out = html([web, off, archived], { [web.channel]: report(AT) });
  expect(out).toContain("<details");
  expect(out).not.toContain("<details open");
  expect(out).toContain("1 other project has no hourly update");
  expect(out).toContain("Acme · Legal");
  expect(out).not.toContain("Old site");
  expect(out).toContain("creator or an owner");
});

test("with no project reported it says how to turn one on, naming a real project in the command", () => {
  const out = html([off, archived], {});
  expect(out).toContain("No project updates yet");
  expect(out).toContain("walkie projects report LEG on");
  expect(out).toContain('href="#/projects"');
  expect(out).not.toContain('class="update"');
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

test("the sidebar lists Updates right under Mission Control, above Projects; the phone tab bar does not (six fit)", () => {
  const rail = renderToStaticMarkup(<StaticStore state={ready({ handle: "kira", role: "owner" })}><shell.Sidebar onSearch={() => {}} /></StaticStore>);
  const at = (label: string) => rail.indexOf(`<span class="rail-link-label">${label}</span>`);
  expect(at("Updates")).toBeGreaterThan(at("Mission Control"));
  expect(at("Projects")).toBeGreaterThan(at("Updates"));
  expect(rail).toContain('href="#/updates"');
  const tabs = renderToStaticMarkup(<StaticStore state={ready({ handle: "kira", role: "owner" })}><shell.TabBar /></StaticStore>);
  expect(tabs).not.toContain('href="#/updates"');
  expect(tabs.match(/class="tab(?: is-active)?"/g)).toHaveLength(6);
});

test("the Projects list opens with a link to Updates that counts the reported projects", () => {
  st.projectsStore.set({ status: "ready", error: null, projects: [web, hiring, off], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  const out = renderToStaticMarkup(<StaticStore state={ready({ handle: "bob", role: "member" })}><ProjectList /></StaticStore>);
  expect(out).toContain('class="updates-link" href="#/updates"');
  expect(out).toContain("plain-English status reports on 2 projects");
  expect(out.indexOf("updates-link")).toBeLessThan(out.indexOf("project-row"));
});
