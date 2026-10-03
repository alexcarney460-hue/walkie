// WALK-77 Phase 0: the card drawer shows proposed / shaped / decided, read-only, from signed ops.
import { readFileSync } from "node:fs";
import { afterAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CardView, ProjectView, TimelineEntry } from "../src/api/types.ts";
import { ProvenanceSection } from "../src/views/projects/ProvenancePanel.tsx";
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

const ALEX = "a000000000000001";
const BEA = "b000000000000002";
const MAREN = "c000000000000003";
const OLIVE = "d000000000000004";
const BOARD = "a000000000000001:1";
const T0 = 1_700_000_000_000;

const COLS = [
  { id: "todo", name: "To do", role: "todo" as const, board: BOARD },
  { id: "review", name: "In review", role: "review" as const, board: BOARD },
  { id: "done", name: "Done <img>", role: "done" as const, board: BOARD },
];

const NOTE = "A name written in the card or a comment does not count";

function at(n: number, who: TimelineEntry["author"], kind: TimelineEntry["kind"], extra: Partial<TimelineEntry> = {}): TimelineEntry {
  return { id: `${who.node}:${n}`, ts: T0 + n * 60_000, author: who, kind, effective_rev: n, ...extra };
}

function slice(html: string, kind: string): string {
  const start = html.indexOf(`data-provenance="${kind}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = html.slice(start);
  const next = rest.slice(1).search(/data-provenance="(?:proposed|shaped|decided)"/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function authors(html: string): string[] {
  return [...html.matchAll(/data-author="([^"]*)"/g)].map((m) => m[1] ?? "");
}

function visible(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

test("an empty thread renders three empty lines and no names, and nothing you can edit", () => {
  const timeline: TimelineEntry[] = [
    at(1, { handle: "olive", node: OLIVE }, "comment", { text: "Proposed by @bea. Decided by @maren." }),
    at(2, { handle: "alex", node: ALEX }, "op", { ignored: "person_card", changes: { column: "done" } }),
    at(3, { handle: "maren", node: MAREN }, "op", { changes: { decided_by: "@olive", proposed_by: "@bea" } }),
  ];
  const html = renderToStaticMarkup(<ProvenanceSection status="ready" timeline={timeline} columns={COLS} />);
  expect(html).toContain('data-provenance-panel="ready"');
  expect(html).toContain(NOTE);
  expect(html).toContain("Proposed by");
  expect(html).toContain("Shaped by");
  expect(html).toContain("Decided by");
  expect(authors(html)).toEqual([]);
  expect(html.match(/Nobody yet\./g)?.length).toBe(3);
  expect(html).not.toContain("@olive");
  expect(html).not.toContain("@bea");
  expect(html).not.toContain("@maren");
  expect(html).not.toMatch(/<(button|input|textarea|select)\b/);
});

test("one author is the only name in proposed, shaped and decided, with each time", () => {
  const maren = { handle: "maren", node: MAREN };
  const timeline: TimelineEntry[] = [
    at(1, maren, "create", { changes: { title: "Pick", body: "Decided by @olive", column: "done" } }),
    at(2, maren, "op", { changes: { title: "Pick the font" } }),
    at(3, maren, "op", { changes: { body: "What we know and what we do not." } }),
    at(4, maren, "op", { changes: { column: "review" } }),
    at(5, maren, "op", { changes: { column: "done" } }),
    at(6, { handle: "olive", node: OLIVE }, "comment", { text: "I decided this." }),
  ];
  const html = renderToStaticMarkup(<ProvenanceSection status="ready" timeline={timeline} columns={COLS} />);
  expect(authors(slice(html, "proposed"))).toEqual(["@maren"]);
  expect(slice(html, "proposed")).toContain("created the card");
  expect(authors(slice(html, "shaped"))).toEqual(["@maren", "@maren", "@maren"]);
  expect(slice(html, "shaped")).toContain("edited the title");
  expect(slice(html, "shaped")).toContain("edited the description");
  expect(slice(html, "shaped")).toContain("edited the column");
  expect(slice(html, "shaped")).toContain("In review");
  expect(slice(html, "shaped")).not.toContain("moved it to done");
  expect(authors(slice(html, "decided"))).toEqual(["@maren"]);
  expect(slice(html, "decided")).toContain("moved it to done");
  expect(slice(html, "decided")).toContain('data-standing="person"');
  expect(slice(html, "decided")).toContain('data-decision="stands"');
  expect(slice(html, "decided")).toContain(">stands<");
  const exact = new Date(T0 + 5 * 60_000).toISOString();
  expect(slice(html, "decided")).toContain(`aria-label="Signed ${exact}"`);
  expect(slice(html, "decided")).toContain(`class="prov-exact">${exact}`);
  expect(visible(slice(html, "decided"))).toContain(` · ${exact}`);
  expect(slice(html, "decided")).not.toContain("(agent)");
  expect(slice(html, "decided")).not.toContain("A person has not decided.");
  expect(html).not.toContain("@olive");
  expect(html).not.toContain("@bea");
  for (const n of [1, 2, 3, 4, 5]) {
    expect(html).toContain(`dateTime="${new Date(T0 + n * 60_000).toISOString()}"`);
  }
  expect(html).not.toMatch(/<(button|input|textarea|select)\b/);
});

test("many authors stay in their own sections, and a column name is text", () => {
  const timeline: TimelineEntry[] = [
    at(1, { handle: "alex", node: ALEX }, "create", { changes: { title: "Pick the font", column: "todo" } }),
    at(2, { handle: "bea", node: BEA, agent: "builder" }, "op", { changes: { title: "Pick a font" } }),
    at(3, { handle: "maren", node: MAREN }, "op", { changes: { body: "Evidence, not a preference." } }),
    at(4, { handle: "alex", node: ALEX }, "op", { changes: { column: "review" } }),
    at(5, { handle: "olive", node: OLIVE }, "op", { changes: { column: "done" } }),
    at(6, { handle: "bea", node: BEA }, "comment", { text: "Decided by @alex" }),
  ];
  const html = renderToStaticMarkup(<ProvenanceSection status="ready" timeline={timeline} columns={COLS} />);
  expect(authors(slice(html, "proposed"))).toEqual(["@alex"]);
  expect(authors(slice(html, "shaped"))).toEqual(["@bea/builder", "@maren", "@alex"]);
  expect(authors(slice(html, "decided"))).toEqual(["@olive"]);
  expect(slice(html, "decided")).not.toContain("@alex");
  expect(slice(html, "decided")).not.toContain("@bea");
  expect(html).toContain("moved it to done");
  expect(html).toContain("Done &lt;img&gt;");
  expect(html).not.toContain("<img>");
  expect(html).not.toContain("Evidence, not a preference.");
});

test("while the signed history is loading or failed, the panel names nobody", () => {
  const loading = renderToStaticMarkup(<ProvenanceSection status="loading" columns={COLS} />);
  expect(loading).toContain('data-provenance-panel="loading"');
  expect(loading).toContain("Reading the signed history…");
  expect(loading).toContain(NOTE);
  expect(loading).not.toContain("Nobody yet.");
  expect(loading).not.toContain("data-author=");
  const failed = renderToStaticMarkup(<ProvenanceSection status="error" columns={COLS} />);
  expect(failed).toContain('data-provenance-panel="error"');
  expect(failed).toContain("The signed history did not load, so provenance is not shown.");
  expect(failed).not.toContain("Nobody yet.");
  expect(failed).not.toContain("data-author=");
});

test("the card drawer hosts the panel and does not borrow the card's created_by before the thread loads", async () => {
  const { CardDrawer } = await import("../src/views/projects/CardDrawer.tsx");
  const { StaticStore } = await import("../src/state/store.tsx");
  const { initialState } = await import("../src/state/reducer.ts");
  const author = { handle: "olive", node: OLIVE };
  const columns = [
    { id: "todo", name: "To do", role: "todo" as const },
    { id: "done", name: "Done", role: "done" as const },
  ];
  const project = {
    channel: "p-00000001", id: "a000000000000001:1", name: "Website", folder: "", description: "", prefix: "WEB",
    paths: [], meter_mode: "count" as const, automations: { pr_opened: false, pr_merged: false, agents_can_close: true },
    steward: "off" as const, steward_node: "", status_report: "off" as const,
    state: "active" as const, private: false, admins: ["maren"], creator: "maren", created_at: 0,
    boards: [{ id: BOARD, name: "Main", columns, state: "active" as const, created_at: 0, created_by: author, meter: { mode: "count" as const, done: 0, counted: 1, by_role: { backlog: 0, todo: 1, active: 0, review: 0, done: 0, cancelled: 0 } }, live_cards: 1 }],
    meter: { mode: "count" as const, done: 0, counted: 1, by_role: { backlog: 0, todo: 1, active: 0, review: 0, done: 0, cancelled: 0 } },
    cards: 1, last_activity: 0,
  } satisfies ProjectView;
  const card = {
    id: "a000000000000001:2", channel: project.channel, board: BOARD, key: "WEB-1", n: 1, short: "abcd1234", ref: "WEB-1-abcd1234",
    title: "Pick the font", body: "Two options.", column: "todo", pos: "i", assignee: null, reviewer: null,
    labels: [], estimate: null, due: null, blocked: false, blocked_reason: null, state: "open" as const,
    created_at: T0, created_by: author, updated_at: T0, updated_by: author, comments: 0, rev: 0,
  } satisfies CardView;
  const html = renderToStaticMarkup(
    <StaticStore state={{ ...initialState, phase: "ready", me: { handle: "maren", role: "owner" } as NonNullable<typeof initialState.me> }}>
      <CardDrawer card={card} project={project} byCard={new Map()} onClose={() => {}} />
    </StaticStore>,
  );
  expect(html).toContain('data-provenance-panel="loading"');
  expect(html).toContain("Provenance");
  expect(html).toContain("Reading the signed history…");
  expect(html).not.toContain("@olive");
  expect(html).not.toContain("data-author=");
});

test("a move signed at ts -1 stays on the card, with the time left unshown", () => {
  const maren = { handle: "maren", node: MAREN };
  const timeline: TimelineEntry[] = [
    at(1, { handle: "alex", node: ALEX }, "create", { changes: { title: "Pick", column: "todo", board: BOARD } }),
    at(2, maren, "op", { ts: -1, changes: { column: "done" } }),
  ];
  const html = renderToStaticMarkup(<ProvenanceSection status="ready" timeline={timeline} columns={COLS} />);
  const decided = slice(html, "decided");
  expect(authors(decided)).toEqual(["@maren"]);
  expect(decided).toContain('<time class="tnum prov-time" data-time="unshown">time not shown</time>');
  expect(decided).not.toContain('<span class="prov-time"');
  expect(decided).toContain('data-decision="stands"');
  expect(decided).not.toContain("Nobody yet.");
  expect(decided).not.toContain('dateTime=');
});

test("a reopened card shows the earlier move as reopened and no decision standing", () => {
  const timeline: TimelineEntry[] = [
    at(1, { handle: "alex", node: ALEX }, "create", { changes: { title: "Pick", column: "todo", board: BOARD } }),
    at(2, { handle: "maren", node: MAREN }, "op", { changes: { column: "done" } }),
    at(3, { handle: "alex", node: ALEX }, "op", { changes: { column: "todo" } }),
  ];
  const html = renderToStaticMarkup(<ProvenanceSection status="ready" timeline={timeline} columns={COLS} />);
  const decided = slice(html, "decided");
  expect(authors(decided)).toEqual(["@maren"]);
  expect(decided).toContain('data-standing="none"');
  expect(decided).toContain('data-decision="reopened"');
  expect(decided).toContain(">reopened<");
  expect(decided).toContain("No decision stands.");
  expect(decided).not.toContain("Nobody yet.");
  expect(decided).not.toContain('data-decision="stands"');
});

test("a backdated done move stays after the one the board applied first", () => {
  const timeline: TimelineEntry[] = [
    at(1, { handle: "alex", node: ALEX }, "create", { effective_rev: 0, changes: { title: "Pick", column: "todo", board: BOARD } }),
    at(2, { handle: "maren", node: MAREN }, "op", { ts: T0 + 50_000, effective_rev: 1, changes: { column: "done" } }),
    at(3, { handle: "alex", node: ALEX }, "op", { ts: T0 + 80_000, effective_rev: 2, changes: { column: "todo" } }),
    at(4, { handle: "bea", node: BEA }, "op", { ts: T0 + 1, effective_rev: 3, changes: { column: "done" } }),
  ];
  const html = renderToStaticMarkup(<ProvenanceSection status="ready" timeline={timeline} columns={COLS} />);
  const decided = slice(html, "decided");
  expect(authors(decided)).toEqual(["@maren", "@bea"]);
  expect(decided).toContain('data-decision="superseded"');
  expect(decided).toContain('data-decision="stands"');
  expect(decided).toContain('data-standing="person"');
  expect(decided.indexOf("@maren")).toBeLessThan(decided.indexOf("@bea"));
});

test("a column the card's board does not have is an edit, not a decision", () => {
  const other = "a000000000000001:2";
  const columns = [
    { id: "todo", name: "To do", role: "todo" as const, board: BOARD },
    { id: "done", name: "Done", role: "done" as const, board: BOARD },
    { id: "todo", name: "To do", role: "todo" as const, board: other },
    { id: "ship", name: "Shipped", role: "done" as const, board: other },
  ];
  const timeline: TimelineEntry[] = [
    at(1, { handle: "alex", node: ALEX }, "create", { changes: { title: "Pick", column: "todo", board: other } }),
    at(2, { handle: "bea", node: BEA }, "op", { changes: { column: "done" } }),
  ];
  const html = renderToStaticMarkup(<ProvenanceSection status="ready" timeline={timeline} columns={columns} />);
  expect(authors(slice(html, "decided"))).toEqual([]);
  expect(slice(html, "decided")).toContain("Nobody yet.");
  expect(authors(slice(html, "shaped"))).toEqual(["@bea"]);
  expect(slice(html, "shaped")).toContain("edited the column");
  expect(slice(html, "shaped")).not.toContain("moved it to done");
});

test("an agent move into done is labelled as the agent's, and a person has not decided", () => {
  const timeline: TimelineEntry[] = [
    at(1, { handle: "alex", node: ALEX }, "create", { changes: { title: "Pick", column: "todo", board: BOARD } }),
    at(2, { handle: "bea", node: BEA, agent: "builder" }, "op", { changes: { column: "done" } }),
  ];
  const html = renderToStaticMarkup(<ProvenanceSection status="ready" timeline={timeline} columns={COLS} />);
  const decided = slice(html, "decided");
  expect(authors(decided)).toEqual(["@bea/builder"]);
  expect(decided).toContain("moved it to done (Done &lt;img&gt;) (agent)");
  expect(decided).toContain('data-by="agent"');
  expect(decided).toContain('data-standing="agent"');
  expect(decided).toContain("A person has not decided.");
  expect(decided).not.toContain("Nobody yet.");
});

test("a clock set ahead is shown as ahead, and one more than a day ahead is left unshown", () => {
  const soon = Date.now() + 2 * 60 * 60 * 1000;
  const far = Date.now() + 48 * 60 * 60 * 1000;
  const timeline: TimelineEntry[] = [
    at(1, { handle: "alex", node: ALEX }, "create", { ts: T0, effective_rev: 0, changes: { title: "Pick", column: "todo" } }),
    at(2, { handle: "maren", node: MAREN }, "op", { ts: soon, effective_rev: 1, changes: { column: "done" } }),
    at(3, { handle: "bea", node: BEA }, "op", { ts: far, effective_rev: 2, changes: { title: "Later" } }),
  ];
  const html = renderToStaticMarkup(<ProvenanceSection status="ready" timeline={timeline} columns={COLS} />);
  const decided = slice(html, "decided");
  const shaped = slice(html, "shaped");
  const soonExact = new Date(soon).toISOString();
  expect(decided).toContain('data-time="ahead"');
  expect(decided).toContain(`aria-label="Signed ${soonExact}"`);
  expect(decided).toMatch(/class="prov-rel">in /);
  expect(visible(decided)).toMatch(new RegExp(`in \\d+h · ${soonExact.replace(/[.]/g, "\\.")}`));
  expect(decided).not.toContain(">now<");
  expect(shaped).toContain("@bea");
  expect(shaped).toContain('<time class="tnum prov-time" data-time="unshown">time not shown</time>');
  expect(shaped).not.toContain('<span class="prov-time"');
});

test("a board-only move stands only when the card's column is done on the board it lands on", () => {
  const other = "a000000000000001:2";
  const columns = [
    { id: "todo", name: "To do", role: "todo" as const, board: BOARD },
    { id: "done", name: "Done", role: "done" as const, board: BOARD },
    { id: "todo", name: "To do", role: "todo" as const, board: other },
    { id: "ship", name: "Shipped", role: "done" as const, board: other },
  ];
  const landed = renderToStaticMarkup(<ProvenanceSection status="ready" timeline={[
    at(1, { handle: "alex", node: ALEX }, "create", { changes: { title: "Pick", column: "ship", board: BOARD } }),
    at(2, { handle: "bea", node: BEA }, "op", { changes: { board: other } }),
  ]} columns={columns} />);
  const decided = slice(landed, "decided");
  expect(authors(decided)).toEqual(["@bea"]);
  expect(decided).toContain("moved it to done (Shipped)");
  expect(decided).toContain('data-decision="stands"');
  expect(decided).toContain('data-standing="person"');

  const cleared = renderToStaticMarkup(<ProvenanceSection status="ready" timeline={[
    at(1, { handle: "alex", node: ALEX }, "create", { changes: { title: "Pick", column: "todo", board: BOARD } }),
    at(2, { handle: "maren", node: MAREN }, "op", { changes: { column: "done" } }),
    at(3, { handle: "bea", node: BEA }, "op", { changes: { board: other } }),
  ]} columns={columns} />);
  const was = slice(cleared, "decided");
  expect(authors(was)).toEqual(["@maren"]);
  expect(was).toContain('data-decision="reopened"');
  expect(was).toContain("No decision stands.");
  expect(was).not.toContain('data-decision="stands"');
});

test("a long author name can wrap: the who-line breaks anywhere and stays inside the row", () => {
  const handle = "maren-from-the-north-win";
  const agent = "a".repeat(48);
  const timeline: TimelineEntry[] = [
    at(1, { handle, node: MAREN, agent }, "create", { changes: { title: "Pick" } }),
  ];
  const html = renderToStaticMarkup(<ProvenanceSection status="ready" timeline={timeline} columns={COLS} />);
  expect(html).toContain(`class="mono prov-who">@${handle}/${agent}`);
  const css = readFileSync(new URL("../src/styles/projects.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.prov-who\s*\{[^}]*overflow-wrap:\s*anywhere/);
  expect(css).toMatch(/\.prov-who\s*\{[^}]*white-space:\s*normal/);
  expect(css).toMatch(/\.prov-who\s*\{[^}]*min-width:\s*0/);
  expect(css).toMatch(/\.prov-who\s*\{[^}]*max-width:\s*100%/);
});
