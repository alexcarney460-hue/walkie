// LINEAR-IMPORT-1 dashboard: "Switch from Linear" renders its first step, a plan row counts only what stays ticked
// and shows its flags, the selection sent to the daemon is what the person chose, and the project list offers it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ImportPlan, ImportPlanProject } from "../src/api/types.ts";
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

let mod: typeof import("../src/views/projects/LinearImport.tsx");
let ProjectList: typeof import("../src/views/projects/ProjectList.tsx").ProjectList;
let StaticStore: (p: { state: State; children: ReactNode }) => ReactNode;
let initialState: State;
beforeAll(async () => {
  mod = await import("../src/views/projects/LinearImport.tsx");
  ProjectList = (await import("../src/views/projects/ProjectList.tsx")).ProjectList;
  StaticStore = (await import("../src/state/store.tsx")).StaticStore;
  initialState = (await import("../src/state/reducer.ts")).initialState;
});

const issue = (id: string, column: string, flags: string[] = [], include = true) => ({
  id, identifier: `HAR-${id}`, title: `Issue ${id}`, column, archived: false, updated_at: "2026-09-01T00:00:00Z", include, flags, assignee: null,
});
const P: ImportPlanProject = {
  key: "proj-1", linear_id: "proj-1", team_id: "t", team_key: "HAR", name: "Website relaunch", state: "started", url: null, updated_at: null,
  include: true, target: null, prefix: "WR", folder: "Growth", counts: { backlog: 1, todo: 2, doing: 0, review: 0, done: 0, canceled: 0 },
  flags: ["stale"], issues: [issue("1", "backlog", ["stale"]), issue("2", "todo", ["duplicate_of:HAR-3"]), issue("3", "todo")],
};
const PLAN = { v: 1, generated_at: "", options: { include_closed: false, stale_days: 60, skip_stale: false, skip_duplicates: false, folder_by: "initiative" },
  teams: [], projects: [P, { ...P, key: "proj-2", name: "Old CRM", include: false, flags: ["completed"], issues: [] }], totals: {} as ImportPlan["totals"], unmapped_users: [] } as ImportPlan;

const noop = () => undefined;

test("the dialog opens on the connect step", () => {
  const html = renderToStaticMarkup(<mod.LinearImport onClose={noop} />);
  expect(html).toContain("Switch from Linear");
  expect(html).toContain('aria-current="step"');
  expect(html).toContain("Build the plan");
  expect(html).toContain("Linear API key file");
  expect(html).toContain('role="dialog"');
});

test("a plan row counts only ticked issues, flags what may not be worth moving, and lists issues when open", () => {
  const html = renderToStaticMarkup(<table><tbody><mod.ProjectRows p={P} on off={new Set(["2"])} open setOn={noop} toggleIssue={noop} setOpen={noop} /></tbody></table>);
  expect(html).toContain("no recent updates");
  expect(html).toContain("1 stale");
  expect(html).toContain("1 possible duplicate");
  expect(html).toContain("looks like HAR-3");
  expect(html).toContain("HAR-2");
  // backlog 1, to do 1 (HAR-2 unticked), total 2
  expect(html).toMatch(/li-col-count">1<\/td><td class="num tnum li-col-count">1</);
  expect(html).toContain('li-col-total">2<');
});

test("the selection is what the person ticked", () => {
  const sel = mod.selectionOf(PLAN, new Map([["proj-2", true]]), new Set(["1"]));
  expect(sel.projects.map((p) => [p.key, p.include, p.exclude])).toEqual([["proj-1", true, ["1"]], ["proj-2", true, []]]);
  expect(sel.projects[0]!.prefix).toBe("WR");
});

test("the project list offers the import", () => {
  const state = { ...initialState, phase: "ready" as const, me: { handle: "maren", role: "owner" } as State["me"] };
  const html = renderToStaticMarkup(<StaticStore state={state}><ProjectList /></StaticStore>);
  expect(html).toContain("Import from Linear");
});
