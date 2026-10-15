import { beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CardView, ProjectView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import { installWindow } from "./window-stub.ts";
import { trapDialogTab } from "../src/views/projects/dialogFocus.ts";

let ProjectSettings: typeof import("../src/views/projects/ProjectSettings.tsx").ProjectSettings;
let CardDrawer: typeof import("../src/views/projects/CardDrawer.tsx").CardDrawer;
let StaticStore: typeof import("../src/state/store.tsx").StaticStore;
let state: State;
beforeAll(async () => {
  installWindow();
  const inert: unknown = new Proxy(() => inert, { get: (_t, k) => k === Symbol.toPrimitive ? () => "" : inert, apply: () => undefined });
  (globalThis as { document?: unknown }).document ??= inert;
  const [settings, drawer, store, reducer] = await Promise.all([
    import("../src/views/projects/ProjectSettings.tsx"), import("../src/views/projects/CardDrawer.tsx"),
    import("../src/state/store.tsx"), import("../src/state/reducer.ts"),
  ]);
  ProjectSettings = settings.ProjectSettings;
  CardDrawer = drawer.CardDrawer;
  StaticStore = store.StaticStore;
  state = { ...reducer.initialState, me: { handle: "maren", role: "owner" } as State["me"] };
});

const meter = { mode: "count" as const, done: 0, counted: 0, by_role: { backlog: 0, todo: 0, active: 0, review: 0, done: 0, cancelled: 0 } };
const author = { handle: "maren", node: "n" };
const project = {
  channel: "p-test", id: "n:1", name: "Test", folder: "", description: "", prefix: "T", paths: [], meter_mode: "count",
  automations: { agents_can_close: true, pr_opened: false, pr_merged: false }, state: "active", private: false,
  admins: [], creator: "maren", created_at: 0, boards: [{ id: "b", name: "Board", columns: [{ id: "todo", name: "To do", role: "todo" }], state: "active", created_at: 0, created_by: author, meter, live_cards: 1 }],
  meter, cards: 1, last_activity: 0,
} as ProjectView;
const card = {
  id: "n:2", channel: "p-test", board: "b", key: "T-1", n: 1, short: "test", ref: "T-1-test", title: "Task", body: "",
  column: "todo", pos: "a", assignee: null, reviewer: null, labels: [], estimate: null, due: null, blocked: false,
  blocked_reason: null, state: "open", created_at: 0, created_by: author, updated_at: 0, updated_by: author, comments: 0, rev: 0,
} as CardView;

test("project settings focuses a control on entry", () => {
  const html = renderToStaticMarkup(<StaticStore state={state}><ProjectSettings project={project} onClose={() => {}} /></StaticStore>);
  expect(html).toMatch(/aria-label="Close"[^>]*autofocus=""/);
});

test("card drawer can receive focus when its controls are unavailable", () => {
  const html = renderToStaticMarkup(<StaticStore state={state}><CardDrawer card={card} project={project} onClose={() => {}} byCard={new Map()} /></StaticStore>);
  expect(html).toMatch(/role="dialog" aria-modal="true"[^>]*tabindex="-1"/);
});

test("Tab and Shift+Tab wrap within a dialog and recover focus from the board", () => {
  const previous = globalThis.document;
  let active: object;
  let prevented = false;
  const control = () => ({
    focus() { active = this; }, hasAttribute: () => false, matches: () => false, getClientRects: () => [1],
  });
  const first = control();
  const last = control();
  const board = control();
  const dialog = {
    querySelectorAll: () => [first, last], contains: (node: object) => node === first || node === last,
    focus() { active = this; },
  } as unknown as HTMLElement;
  const key = (shiftKey: boolean) => ({ key: "Tab", shiftKey, preventDefault() { prevented = true; } }) as KeyboardEvent;
  (globalThis as { document: Document }).document = { get activeElement() { return active; } } as Document;
  try {
    active = last;
    trapDialogTab(dialog, key(false));
    expect(active).toBe(first);
    expect(prevented).toBe(true);
    prevented = false;
    trapDialogTab(dialog, key(true));
    expect(active).toBe(last);
    expect(prevented).toBe(true);
    prevented = false;
    active = board;
    trapDialogTab(dialog, key(false));
    expect(active).toBe(first);
    expect(prevented).toBe(true);
  } finally {
    (globalThis as { document: Document }).document = previous;
  }
});

test("Shift+Tab from the dialog container wraps to the last control", () => {
  const previous = globalThis.document;
  let active: object;
  let prevented = false;
  const control = () => ({
    focus() { active = this; }, hasAttribute: () => false, matches: () => false, getClientRects: () => [1],
  });
  const first = control();
  const last = control();
  const dialog = {
    querySelectorAll: () => [first, last],
    contains: (node: object) => node === dialog || node === first || node === last,
    focus() { active = this; },
  } as unknown as HTMLElement;
  (globalThis as { document: Document }).document = { get activeElement() { return active; } } as Document;
  try {
    active = dialog;
    trapDialogTab(dialog, { key: "Tab", shiftKey: true, preventDefault() { prevented = true; } } as KeyboardEvent);
    expect(prevented).toBe(true);
    expect(active).toBe(last);
  } finally {
    (globalThis as { document: Document }).document = previous;
  }
});
