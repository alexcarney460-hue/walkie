// PROJECT-REPORTS-1 dashboard: who may switch a project's hourly status report, the switch and the read-only marker,
// toggling through the API (the store follows the daemon's answer, an error leaves it alone), the rows of the project
// list, and the latest-report panel in each of its states.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
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

type Lib = typeof import("../src/lib/status-report.ts");
type Switch = typeof import("../src/views/projects/StatusReportSwitch.tsx");
type Panel = typeof import("../src/views/projects/StatusReportPanel.tsx");
let lib: Lib, sw: Switch, panel: Panel;
let ProjectList: typeof import("../src/views/projects/ProjectList.tsx").ProjectList;
let st: typeof import("../src/state/projects.ts");
let StaticStore: (p: { state: State; children: ReactNode }) => ReactNode;
let initialState: State;
beforeAll(async () => {
  lib = await import("../src/lib/status-report.ts");
  sw = await import("../src/views/projects/StatusReportSwitch.tsx");
  panel = await import("../src/views/projects/StatusReportPanel.tsx");
  ProjectList = (await import("../src/views/projects/ProjectList.tsx")).ProjectList;
  st = await import("../src/state/projects.ts");
  const s = await import("../src/state/store.tsx");
  StaticStore = s.StaticStore;
  initialState = (await import("../src/state/reducer.ts")).initialState;
});

const meter = { mode: "count" as const, done: 1, counted: 4, by_role: { backlog: 0, todo: 2, active: 1, review: 0, done: 1, cancelled: 0 } };
const project = (extra: Partial<ProjectView> = {}): ProjectView => ({
  channel: "p-00000001", id: "a000000000000001:1", name: "Website", folder: "Acme", description: "", prefix: "WEB", paths: [], meter_mode: "count",
  automations: { pr_opened: true, pr_merged: false, agents_can_close: true }, state: "active", steward: "on", steward_node: "", status_report: "off",
  private: false, admins: ["maren"], creator: "maren", created_at: 0, boards: [], meter, cards: 4, last_activity: Date.now(), ...extra,
});

// ---- who may switch it ----------------------------------------------------------------------------------------------

test("the project's creator while a member, and the team's owners may switch it; an observer, another member and nobody may not", () => {
  const p = project();
  expect(lib.canSetStatusReport({ handle: "kira", role: "owner" }, p)).toBe(true);
  expect(lib.canSetStatusReport({ handle: "maren", role: "member" }, p)).toBe(true);
  expect(lib.canSetStatusReport({ handle: "bob", role: "member" }, p)).toBe(false);
  expect(lib.canSetStatusReport({ handle: "maren", role: "observer" }, p)).toBe(false);
  expect(lib.canSetStatusReport({ handle: null, role: "owner" }, p)).toBe(false);
  expect(lib.canSetStatusReport(null, p)).toBe(false);
});

// ---- the switch -----------------------------------------------------------------------------------------------------

test("the switch is a labelled checkbox with the switch role, naming its project, on or off", () => {
  const props = { busy: false, error: null, onToggle: () => {} };
  const on = renderToStaticMarkup(<sw.StatusReportSwitch project={project({ status_report: "hourly" })} canSet {...props} />);
  expect(on).toContain('type="checkbox"');
  expect(on).toContain('role="switch"');
  expect(on).toContain('aria-checked="true"');
  expect(on).toContain("checked");
  expect(on).toContain("Hourly status report");
  expect(on).toContain('aria-label="Hourly status report for Website"');
  const off = renderToStaticMarkup(<sw.StatusReportSwitch project={project()} canSet {...props} />);
  expect(off).toContain('aria-checked="false"');
  expect(off).not.toMatch(/checked=""/);
});

/** The `<input>` element of a rendered tree (function components without hooks can be called as functions). */
function findInput(node: unknown): { props: Record<string, unknown> } | null {
  if (!node || typeof node !== "object") return null;
  const el = node as { type?: unknown; props?: { children?: unknown } & Record<string, unknown> };
  if (el.type === "input") return el as { props: Record<string, unknown> };
  const kids = el.props?.children;
  for (const k of Array.isArray(kids) ? kids : [kids]) { const hit = findInput(k); if (hit) return hit; }
  return null;
}

test("while it saves the switch keeps keyboard focus (aria-disabled, not disabled) and ignores a change; idle it is neither", () => {
  const busy = renderToStaticMarkup(<sw.StatusReportSwitch project={project()} canSet busy error={null} onToggle={() => {}} />);
  expect(busy).toContain('aria-disabled="true"');
  expect(busy).not.toMatch(/\sdisabled(=|\s|>|\/)/); // a disabled input drops focus, which a keyboard user pressing Space loses their place by
  expect(busy).toContain('role="switch"');
  const idle = renderToStaticMarkup(<sw.StatusReportSwitch project={project()} canSet busy={false} error={null} onToggle={() => {}} />);
  expect(idle).not.toContain("aria-disabled");
  expect(idle).not.toMatch(/\sdisabled(=|\s|>|\/)/);
  // The handler: a change while it saves is dropped; idle it reports the new state.
  const calls: boolean[] = [];
  const change = (isBusy: boolean, checked: boolean) => (findInput(sw.StatusReportSwitch({ project: project(), canSet: true, busy: isBusy, error: null, onToggle: (on) => calls.push(on) }))?.props.onChange as (e: unknown) => void)({ currentTarget: { checked } });
  change(true, true);
  expect(calls).toEqual([]);
  change(false, true);
  change(false, false);
  expect(calls).toEqual([true, false]);
});

test("while it saves, an error is announced next to it", () => {
  const busy = renderToStaticMarkup(<sw.StatusReportSwitch project={project()} canSet busy error={null} onToggle={() => {}} />);
  expect(busy).toContain("Hourly status report");
  const failed = renderToStaticMarkup(<sw.StatusReportSwitch project={project()} canSet busy={false} error="only the project's creator or an owner can turn its status report on or off" onToggle={() => {}} />);
  expect(failed).toContain('role="alert"');
  expect(failed).toContain("only the project&#x27;s creator or an owner can turn its status report on or off");
});

test("a person who may not switch it sees a small marker on a project that has it on, and nothing on one that does not", () => {
  const props = { canSet: false, busy: false, error: null, onToggle: () => {} };
  const marked = renderToStaticMarkup(<sw.StatusReportSwitch project={project({ status_report: "hourly" })} {...props} />);
  expect(marked).toContain("Reported hourly");
  expect(marked).not.toContain("<input");
  expect(renderToStaticMarkup(<sw.StatusReportSwitch project={project()} {...props} />)).toBe("");
});

test("an archived project is not reported on, so it shows neither the switch nor the marker", () => {
  const props = { busy: false, error: null, onToggle: () => {} };
  const archived = project({ state: "archived", status_report: "hourly" });
  expect(renderToStaticMarkup(<sw.StatusReportSwitch project={archived} canSet {...props} />)).toBe("");
  expect(renderToStaticMarkup(<sw.StatusReportSwitch project={archived} canSet={false} {...props} />)).toBe("");
});

// ---- toggling -------------------------------------------------------------------------------------------------------

test("toggling calls the API with hourly or off, and the project list follows the daemon's answer", async () => {
  const p = project();
  st.projectsStore.set({ status: "ready", error: null, projects: [p], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  const calls: Array<[string, unknown]> = [];
  const client = { updateProject: async (channel: string, body: Record<string, unknown>) => { calls.push([channel, body]); return { project: { ...p, status_report: body.status_report as "hourly" | "off" } }; } };
  expect(await lib.toggleStatusReport(client, st.projectsStore, p.channel, true)).toBeNull();
  expect(calls).toEqual([[p.channel, { status_report: "hourly" }]]);
  expect(st.projectsStore.get().projects[0]?.status_report).toBe("hourly");
  expect(await lib.toggleStatusReport(client, st.projectsStore, p.channel, false)).toBeNull();
  expect(calls[1]).toEqual([p.channel, { status_report: "off" }]);
  expect(st.projectsStore.get().projects[0]?.status_report).toBe("off");
});

test("a refusal comes back as its plain reason and leaves the project as it was", async () => {
  const p = project({ status_report: "hourly" });
  st.projectsStore.set({ status: "ready", error: null, projects: [p], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  const { ApiError } = await import("../src/api/client.ts");
  const client = { updateProject: async () => { throw new ApiError("forbidden", "observers can't change a project's status report", 403); } };
  expect(await lib.toggleStatusReport(client, st.projectsStore, p.channel, false)).toContain("observers can't change a project's status report");
  expect(st.projectsStore.get().projects[0]?.status_report).toBe("hourly");
});

// ---- the project list -----------------------------------------------------------------------------------------------

function listHtml(me: { handle: string; role: string }, projects: ProjectView[]): string {
  st.projectsStore.set({ status: "ready", error: null, projects, stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  const state = { ...initialState, phase: "ready" as const, me: me as State["me"], agents: [] };
  return renderToStaticMarkup(<StaticStore state={state}><ProjectList /></StaticStore>);
}

test("each row of the project list has the switch for an owner, outside the link to its board", () => {
  const html = listHtml({ handle: "kira", role: "owner" }, [project({ status_report: "hourly" }), project({ channel: "p-00000002", name: "Hiring", prefix: "HR" })]);
  expect(html.match(/role="switch"/g)).toHaveLength(2);
  expect(html).toContain('aria-label="Hourly status report for Hiring"');
  // No control sits inside a link: the rows' anchors hold no input.
  const anchors = [...html.matchAll(/<a class="project-row"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1] ?? "");
  expect(anchors).toHaveLength(2);
  for (const inner of anchors) expect(inner).not.toContain("<input");
});

test("a member who is not the creator sees only the marker, and only where it is on", () => {
  const html = listHtml({ handle: "bob", role: "member" }, [project({ status_report: "hourly" }), project({ channel: "p-00000002", name: "Hiring", prefix: "HR" })]);
  expect(html).not.toContain('role="switch"');
  expect(html.match(/Reported hourly/g)).toHaveLength(1);
});

// ---- the latest report ----------------------------------------------------------------------------------------------

const AT = Date.UTC(2026, 9, 1, 14, 0);
const MARKDOWN = "**On track:** the pricing page shipped.\n\n## Next\n- Checkout.";

test("the panel shows the latest report as Markdown with the time its facts are as of", () => {
  const html = renderToStaticMarkup(<panel.StatusReportView state={{ status: "ready", data: { mode: "hourly", report: { markdown: MARKDOWN, header: "**Status report · Website · as of 2026-10-01 14:00 UTC**", as_of: AT, at: AT + 60_000, by: { handle: "kira", agent: "orchestrator" } } } }} onRetry={() => {}} />);
  expect(html).toContain("Status report");
  expect(html).toContain("<strong>On track:</strong>");
  expect(html).toContain("<h3");
  expect(html).toContain("Checkout.");
  expect(html).toContain('dateTime="2026-10-01T14:00:00.000Z"');
  expect(html).toContain("as of");
  expect(html).toContain("WalkieTalkie");
});

test("with no report yet it says so plainly, and differently when reports are off", () => {
  const hourly = renderToStaticMarkup(<panel.StatusReportView state={{ status: "ready", data: { mode: "hourly", report: null } }} onRetry={() => {}} />);
  expect(hourly).toContain("No status report yet");
  expect(hourly).toContain("each hour something changes");
  const off = renderToStaticMarkup(<panel.StatusReportView state={{ status: "ready", data: { mode: "off", report: null } }} onRetry={() => {}} />);
  expect(off).toContain("Hourly status reports are off");
  expect(off).not.toContain("No status report yet");
});

test("an archived project says its reports are paused, with or without an older report to show", () => {
  const empty = renderToStaticMarkup(<panel.StatusReportView paused state={{ status: "ready", data: { mode: "hourly", report: null } }} onRetry={() => {}} />);
  expect(empty).toContain("Status reports pause while a project is archived.");
  expect(empty).not.toContain("No status report yet");
  const older = renderToStaticMarkup(<panel.StatusReportView paused state={{ status: "ready", data: { mode: "hourly", report: { markdown: MARKDOWN, header: null, as_of: AT, at: AT, by: { handle: "kira", agent: "orchestrator" } } } }} onRetry={() => {}} />);
  expect(older).toContain("<strong>On track:</strong>");
  expect(older).toContain("This project is archived, so this report is no longer updated.");
});

test("while loading it is a busy skeleton, and a failure says why with a retry", () => {
  expect(renderToStaticMarkup(<panel.StatusReportView state={{ status: "loading" }} onRetry={() => {}} />)).toContain('aria-busy="true"');
  const failed = renderToStaticMarkup(<panel.StatusReportView state={{ status: "error", message: "the daemon is not reachable" }} onRetry={() => {}} />);
  expect(failed).toContain("the daemon is not reachable");
  expect(failed).toContain("Retry");
});

test("a report older than the project's switch still shows, saying when it is from", () => {
  const html = renderToStaticMarkup(<panel.StatusReportView state={{ status: "ready", data: { mode: "off", report: { markdown: MARKDOWN, header: null, as_of: AT, at: AT, by: { handle: "kira", agent: "orchestrator" } } } }} onRetry={() => {}} />);
  expect(html).toContain("<strong>On track:</strong>");
  expect(html).toContain("Hourly status reports are off");
});
