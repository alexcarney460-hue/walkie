// WALK-77 Phase 0: proposed / shaped / decided come only from who signed applied card ops.
// A rank, and this view, ignore anything an op says about itself (PROTOCOL §10 "Convergence").
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { foldCard, refOf, shownColumn, type CardContext, type OpEvent } from "../../src/protocol/projects/fold.ts";
import { cardProvenance, provenanceTimeKind, PROVENANCE_FUTURE_MS, PROVENANCE_MAX_TS, type ProvenanceColumn } from "../../src/protocol/projects/provenance.ts";
import type { TimelineEntry } from "../../src/protocol/projects/schema.ts";
import type { Author } from "../../src/protocol/schemas.ts";

const ALEX = "a000000000000001";
const BEA = "b000000000000002";
const MAREN = "c000000000000003";
const OLIVE = "d000000000000004";

const alex: Author = { handle: "alex", node: ALEX };
const bea: Author = { handle: "bea", node: BEA, agent: "builder" };
const maren: Author = { handle: "maren", node: MAREN };
const olive: Author = { handle: "olive", node: OLIVE };

const BOARD = "a000000000000001:1";
const COLS: ProvenanceColumn[] = [
  { id: "todo", name: "To do", role: "todo", board: BOARD },
  { id: "review", name: "In review", role: "review", board: BOARD },
  { id: "done", name: "Done", role: "done", board: BOARD },
  { id: "c3", name: "Shipped", role: "done", board: "a000000000000001:9" },
  { id: "later", name: "Done", role: "todo", board: BOARD },
];

let seq = 0;
function entry(who: Author, kind: TimelineEntry["kind"], extra: Partial<TimelineEntry> = {}): TimelineEntry {
  seq += 1;
  const origin = who.node;
  return {
    id: `${origin}:${seq}`, ts: 1_700_000_000_000 + seq * 1000, author: who, kind, effective_rev: seq, ...extra,
  };
}

function handles(acts: readonly { author: Author }[]): string[] {
  return acts.map((a) => a.author.agent ? `@${a.author.handle}/${a.author.agent}` : `@${a.author.handle}`);
}

describe("cardProvenance", () => {
  test("an empty thread, comments, and ignored or self-describing ops attribute nobody", () => {
    expect(cardProvenance([], COLS)).toEqual({ proposed: [], shaped: [], decided: [] });
    expect(cardProvenance(null, COLS)).toEqual({ proposed: [], shaped: [], decided: [] });
    const timeline: TimelineEntry[] = [
      entry(olive, "comment", { text: "Proposed by @bea. Decided by @maren. I moved it to done." }),
      entry(alex, "op", { ignored: "person_card", changes: { column: "done", title: "Mine" } }),
      entry(olive, "op", { ignored: "waiting_for_parent", changes: { column: "done" } }),
      entry(maren, "op", { changes: { decided_by: "@olive", proposed_by: "@bea", assignee: "@alex", labels: ["decision-needed"] } }),
      entry(bea, "op", { text: "decided by @olive", changes: { pos: "m" } }),
    ];
    const got = cardProvenance(timeline, COLS);
    expect(got).toEqual({ proposed: [], shaped: [], decided: [] });
    expect(JSON.stringify(got)).not.toContain("olive");
    expect(JSON.stringify(got)).not.toContain("bea");
  });

  test("the create op is the proposal, even when its text and fields name someone else or start in done", () => {
    const timeline: TimelineEntry[] = [
      entry(alex, "create", {
        text: "Decided by @olive. Shaped by @maren.",
        changes: { title: "Pick the font", body: "Decided by @olive", column: "done", decided_by: "@olive" },
      }),
    ];
    const got = cardProvenance(timeline, COLS);
    expect(handles(got.proposed)).toEqual(["@alex"]);
    expect(got.proposed[0]?.field).toBe("create");
    expect(got.shaped).toEqual([]);
    expect(got.decided).toEqual([]);
    expect(JSON.stringify(got)).not.toContain("olive");
    expect(got.proposed[0]?.author).toEqual(alex);
  });

  test("one author who later edits and moves to done is the only name, in time order", () => {
    const created = entry(maren, "create", { changes: { title: "Pick", column: "todo" } });
    const title = entry(maren, "op", { changes: { title: "Pick the font" } });
    const body = entry(maren, "op", { changes: { body: "Two options, and what we have not checked." } });
    const column = entry(maren, "op", { changes: { column: "review" } });
    const done = entry(maren, "op", { changes: { column: "done", title: "Pick the font" } });
    const noise = entry(olive, "comment", { text: "I decided this. Proposed by @bea." });
    const got = cardProvenance([done, noise, created, column, body, title], COLS);
    expect(handles(got.proposed)).toEqual(["@maren"]);
    expect(got.shaped.map((a) => a.field)).toEqual(["title", "body", "column", "title"]);
    expect(handles(got.shaped)).toEqual(["@maren", "@maren", "@maren", "@maren"]);
    expect(got.shaped[2]?.columnId).toBe("review");
    expect(got.shaped[2]?.columnName).toBe("In review");
    expect(handles(got.decided)).toEqual(["@maren"]);
    expect(got.decided[0]?.columnId).toBe("done");
    expect(got.decided[0]?.id).toBe(done.id);
    expect(got.decided[0]?.decision).toBe("stands");
    expect(got.shaped.some((a) => a.id === done.id && a.field === "title")).toBe(true);
    expect(got.shaped.some((a) => a.id === done.id && a.field === "column")).toBe(false);
    expect(JSON.stringify(got)).not.toContain("olive");
    expect(JSON.stringify(got)).not.toContain("bea");
  });

  test("many authors stay in the section their own signed fields earned", () => {
    const timeline: TimelineEntry[] = [
      entry(alex, "create", { changes: { title: "Pick the font", column: "todo", body: "Decided by @olive" } }),
      entry(bea, "op", { changes: { title: "Pick a font" } }),
      entry(maren, "op", { changes: { body: "Noor prefers serif, which is not evidence." } }),
      entry(alex, "op", { changes: { column: "review" } }),
      entry({ handle: "olive", node: OLIVE, agent: "steward" }, "op", { changes: { column: "c3", board: "a000000000000001:9" } }),
      entry(bea, "op", { changes: { pos: "z", assignee: "@maren" } }),
    ];
    const got = cardProvenance(timeline, COLS);
    expect(handles(got.proposed)).toEqual(["@alex"]);
    expect(handles(got.shaped)).toEqual(["@bea/builder", "@maren", "@alex"]);
    expect(got.shaped.map((a) => a.field)).toEqual(["title", "body", "column"]);
    expect(handles(got.decided)).toEqual(["@olive/steward"]);
    expect(got.decided[0]?.decision).toBe("stands");
    expect(got.decided[0]?.columnName).toBe("Shipped");
    expect(JSON.stringify(got.decided)).not.toContain("serif");
    expect(JSON.stringify(got.shaped)).not.toContain("prefers");
  });

  test("done is a column role, not the column id or a column named Done", () => {
    const namedDone = entry(alex, "op", { changes: { column: "later" } });
    const roleDone = entry(maren, "op", { changes: { column: "c3" } });
    const unknown = entry(bea, "op", { changes: { column: "mystery" } });
    const notAnId = entry(bea, "op", { changes: { column: "Done" } });
    const got = cardProvenance([
      entry(olive, "create", { changes: { column: "todo" } }),
      namedDone, roleDone, unknown, notAnId,
    ], COLS);
    expect(got.decided.map((a) => a.id)).toEqual([roleDone.id]);
    expect(got.shaped.map((a) => a.columnId)).toEqual(["later", "mystery"]);
    expect(got.shaped[0]?.columnName).toBe("Done");
    expect(got.shaped.concat(got.decided).some((a) => a.id === notAnId.id)).toBe(false);
    expect(handles(got.proposed)).toEqual(["@olive"]);
  });

  test("a column id that is done on one board and not another is decided only when the op names that board", () => {
    const cols: ProvenanceColumn[] = [
      { id: "col", name: "To do", role: "todo", board: "a000000000000001:1" },
      { id: "col", name: "Done", role: "done", board: "a000000000000001:9" },
    ];
    const ambiguous = entry(alex, "op", { changes: { column: "col" } });
    const named = entry(maren, "op", { changes: { column: "col", board: "a000000000000001:9" } });
    const other = entry(bea, "op", { changes: { column: "col", board: "a000000000000001:1" } });
    const got = cardProvenance([
      entry(olive, "create", { changes: { title: "Pick" } }),
      ambiguous, named, other,
    ], cols);
    expect(got.decided.map((a) => a.id)).toEqual([named.id]);
    expect(got.shaped.map((a) => a.id)).toEqual([ambiguous.id, other.id]);
    expect(got.shaped[0]?.columnName).toBeUndefined();
    expect(got.shaped[1]?.columnName).toBe("To do");
  });

  test("a malformed author or id is skipped; an unusable time is kept and the input is not mutated", () => {
    const good = entry(alex, "create", { changes: { title: "Pick" } });
    const kept = { id: `${BEA}:2`, ts: Number.NaN, author: bea, kind: "op" as const, changes: { title: "Kept" } };
    const huge = entry(alex, "op", { ts: 8_640_000_000_000_001, changes: { body: "still here" } });
    const back = entry(maren, "op", { ts: -1, changes: { column: "done" } });
    const timeline = [
      good,
      { id: "not an id", ts: good.ts, author: alex, kind: "op" as const, changes: { title: "nope" } },
      kept,
      { id: `${OLIVE}:3`, ts: good.ts + 1, author: { handle: "Olive", node: OLIVE }, kind: "op" as const, changes: { title: "nope" } },
      { id: `${MAREN}:4`, ts: good.ts + 2, author: { handle: "maren", node: "nope" }, kind: "op" as const, changes: { column: "done" } },
      { id: `${ALEX}:5`, ts: good.ts + 3, author: { ...alex, decidedBy: "@olive" }, kind: "op" as const, changes: { body: "notes" } },
      huge,
      back,
    ] as TimelineEntry[];
    const before = JSON.stringify(timeline);
    const got = cardProvenance(timeline, COLS);
    expect(JSON.stringify(timeline)).toBe(before);
    expect(handles(got.proposed)).toEqual(["@alex"]);
    expect(got.proposed[0]?.author).toEqual(alex);
    // Rows with no effective_rev rank as 0, then by machine. The helper rows carry the seq they were built with.
    expect(got.shaped.map((a) => a.id)).toEqual([`${ALEX}:5`, kept.id, huge.id]);
    expect(got.shaped.map((a) => a.field)).toEqual(["body", "title", "body"]);
    expect(got.decided.map((a) => a.id)).toEqual([back.id]);
    expect(got.decided[0]?.ts).toBe(-1);
    expect(got.decided[0]?.decision).toBe("stands");
    expect(JSON.stringify(got)).not.toContain("olive");
    expect(JSON.stringify(got)).not.toContain("Olive");
    expect(JSON.stringify(got)).not.toContain("nope");
  });
});

describe("cardProvenance on a folded card thread", () => {
  test("the fold's timeline, not the words in the posts, is what the panel can see", () => {
    const boardId = BOARD;
    const columns = [
      { id: "todo", name: "To do", role: "todo" as const },
      { id: "review", name: "In review", role: "review" as const },
      { id: "done", name: "Done", role: "done" as const },
    ];
    const ctx: CardContext = { boards: new Map([[boardId, { id: boardId, columns }]]) };
    const hid = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);
    let n = 1;
    const make = (who: Author, board: unknown, opts: { thread?: string; text?: string } = {}): OpEvent => {
      n += 1;
      const id = `${who.node}:${n}`;
      return {
        id, origin: who.node, seq: n, ts: 1_700_000_100_000 + n * 1000, h: hid(id), author: who,
        text: opts.text ?? "op", ...(opts.thread ? { thread: opts.thread } : {}), ...(board !== undefined ? { board } : {}),
      };
    };
    const root = make(alex, {
      v: 1, op: "card", rev: 0, board: boardId, title: "Pick the font", column: "todo",
      body: "Decided by @olive",
    }, { text: "Proposed by @olive" });
    const assign = make(alex, { v: 1, op: "card", rev: 1, after: refOf(root), assignee: "@alex" }, { thread: root.id });
    const title = make(bea, { v: 1, op: "card", rev: 1, after: refOf(assign), title: "Pick a font" }, { thread: root.id, text: "Decided by @olive" });
    const sneak = make(bea, { v: 1, op: "card", rev: 1, after: refOf(title), column: "done" }, { thread: root.id, text: "moved it to done" });
    const done = make(maren, { v: 1, op: "card", rev: 1, after: refOf(sneak), column: "done" }, { thread: root.id });
    const comment = make(olive, undefined, { thread: root.id, text: "I decided this. Proposed by @noor." });
    const card = foldCard(root, [comment, sneak, assign, done, title], ctx);
    expect(card).not.toBeNull();
    expect(card?.timeline.find((t) => t.id === sneak.id)?.ignored).toBe("person_card");
    const got = cardProvenance(card?.timeline ?? [], columns.map((c) => ({ ...c, board: boardId })));
    expect(handles(got.proposed)).toEqual(["@alex"]);
    expect(handles(got.shaped)).toEqual(["@bea/builder"]);
    expect(got.shaped[0]?.field).toBe("title");
    expect(handles(got.decided)).toEqual(["@maren"]);
    expect(got.decided[0]?.id).toBe(done.id);
    expect(got.decided[0]?.decision).toBe("stands");
    expect(JSON.stringify(got)).not.toContain("olive");
    expect(JSON.stringify(got)).not.toContain("noor");
  });
});

// Review scenarios (provenance-panel fix round). The fold applies a row whatever its clock says.
// The panel must keep every applied row, order it as the fold did, and mark the column write that still stands.
describe("cardProvenance review scenarios", () => {
  const A = "a000000000000001:1";
  const B = "a000000000000001:2";
  const colsA = [
    { id: "todo", name: "To do", role: "todo" as const },
    { id: "review", name: "In review", role: "review" as const },
    { id: "done", name: "Done", role: "done" as const },
  ];
  const colsB = [
    { id: "todo", name: "To do", role: "todo" as const },
    { id: "ship", name: "Shipped", role: "done" as const },
  ];
  const ctx: CardContext = { boards: new Map([[A, { id: A, columns: colsA }], [B, { id: B, columns: colsB }]]) };
  const provCols = (a = colsA, b = colsB): ProvenanceColumn[] => [
    ...a.map((c) => ({ ...c, board: A })), ...b.map((c) => ({ ...c, board: B })),
  ];
  const hid = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);
  let n = 40;
  function make(who: Author, board: unknown, o: { thread?: string; ts?: number } = {}): OpEvent {
    n += 1;
    const id = `${who.node}:${n}`;
    return {
      id, origin: who.node, seq: n, ts: o.ts ?? 1_700_000_000_000 + n * 1000, h: hid(id), author: who, text: "op",
      ...(o.thread ? { thread: o.thread } : {}), board,
    };
  }
  const beaPerson: Author = { handle: "bea", node: BEA };

  test("P1: a move to done signed at ts -1 is still the decision", () => {
    const root = make(alex, { v: 1, op: "card", rev: 0, board: A, title: "Pick", column: "todo" });
    const done = make(maren, { v: 1, op: "card", rev: 1, after: refOf(root), column: "done" }, { thread: root.id, ts: -1 });
    const card = foldCard(root, [done], ctx);
    expect(card).not.toBeNull();
    expect(card?.column).toBe("done");
    const got = cardProvenance(card?.timeline ?? [], provCols());
    expect(got.decided.map((a) => a.author.handle)).toEqual(["maren"]);
    expect(got.decided[0]?.ts).toBe(-1);
    expect(got.decided[0]?.decision).toBe("stands");
    expect(got.decided[0]?.id).toBe(done.id);
  });

  test("P1b: a later ts -1 done move stands, and the reopened one is superseded, in fold order", () => {
    const root = make(alex, { v: 1, op: "card", rev: 0, board: A, title: "Pick", column: "todo" });
    const marenDone = make(maren, { v: 1, op: "card", rev: 1, after: refOf(root), column: "done" }, { thread: root.id });
    const alexReopen = make(alex, { v: 1, op: "card", rev: 2, after: refOf(marenDone), column: "todo" }, { thread: root.id });
    const beaDone = make(beaPerson, { v: 1, op: "card", rev: 3, after: refOf(alexReopen), column: "done" }, { thread: root.id, ts: -1 });
    const card = foldCard(root, [marenDone, alexReopen, beaDone], ctx);
    expect(card?.column).toBe("done");
    const got = cardProvenance(card?.timeline ?? [], provCols());
    expect(got.decided.map((a) => a.author.handle)).toEqual(["maren", "bea"]);
    expect(got.decided.map((a) => a.decision)).toEqual(["superseded", "stands"]);
    expect(got.decided[1]?.ts).toBe(-1);
    expect(got.decided[1]?.id).toBe(beaDone.id);
    expect(got.shaped.map((a) => a.columnId)).toEqual(["todo"]);
  });

  test("P8: a backdated standing done move stays last, because the fold applied it last", () => {
    const root = make(alex, { v: 1, op: "card", rev: 0, board: A, title: "Pick", column: "todo" });
    const marenDone = make(maren, { v: 1, op: "card", rev: 1, after: refOf(root), column: "done" }, { thread: root.id });
    const alexReopen = make(alex, { v: 1, op: "card", rev: 2, after: refOf(marenDone), column: "todo" }, { thread: root.id });
    const beaDone = make(beaPerson, { v: 1, op: "card", rev: 3, after: refOf(alexReopen), column: "done" }, { thread: root.id, ts: root.ts + 1 });
    const card = foldCard(root, [marenDone, alexReopen, beaDone], ctx);
    expect(card?.column).toBe("done");
    const got = cardProvenance(card?.timeline ?? [], provCols());
    expect(got.decided.map((a) => a.author.handle)).toEqual(["maren", "bea"]);
    expect(got.decided.map((a) => a.decision)).toEqual(["superseded", "stands"]);
    expect(got.decided[1]!.ts).toBeLessThan(got.decided[0]!.ts);
  });

  test("a later write to a column the card's board does not have reopens the earlier decision", () => {
    const root = make(alex, { v: 1, op: "card", rev: 0, board: A, title: "Pick", column: "todo" });
    const done = make(maren, { v: 1, op: "card", rev: 1, after: refOf(root), column: "done" }, { thread: root.id });
    // "ship" is a done column on board B and is not a column on A, where the card still is.
    const elsewhere = make(beaPerson, { v: 1, op: "card", rev: 2, after: refOf(done), column: "ship" }, { thread: root.id });
    const card = foldCard(root, [done, elsewhere], ctx);
    expect(card?.board).toBe(A);
    expect(card?.column).toBe("ship");
    expect(shownColumn(colsA, card?.column ?? "")).toBe("todo");
    const got = cardProvenance(card?.timeline ?? [], provCols());
    expect(got.decided.map((a) => a.author.handle)).toEqual(["maren"]);
    expect(got.decided.map((a) => a.decision)).toEqual(["reopened"]);
    expect(got.shaped.some((a) => a.id === elsewhere.id && a.field === "column" && a.columnId === "ship")).toBe(true);
    expect(got.decided.some((a) => a.decision === "stands")).toBe(false);
  });

  test("P3: a reopened card has no standing decision", () => {
    const root = make(alex, { v: 1, op: "card", rev: 0, board: A, title: "Pick", column: "todo" });
    const done = make(maren, { v: 1, op: "card", rev: 1, after: refOf(root), column: "done" }, { thread: root.id });
    const reopen = make(alex, { v: 1, op: "card", rev: 2, after: refOf(done), column: "todo" }, { thread: root.id });
    const card = foldCard(root, [done, reopen], ctx);
    expect(card?.column).toBe("todo");
    const got = cardProvenance(card?.timeline ?? [], provCols());
    expect(got.decided.map((a) => a.author.handle)).toEqual(["maren"]);
    expect(got.decided.map((a) => a.decision)).toEqual(["reopened"]);
    expect(got.decided.some((a) => a.decision === "stands")).toBe(false);
    expect(got.shaped.map((a) => a.columnId)).toEqual(["todo"]);
  });

  test("P3b: a done move that lost the place register is reopened, not the decision", () => {
    const root = make(alex, { v: 1, op: "card", rev: 0, board: A, title: "Pick", column: "todo" });
    // Same parent: same rank. Fold order is machine then sequence, so maren's review applies after bea's done move.
    const beaDone = make(beaPerson, { v: 1, op: "card", rev: 1, after: refOf(root), column: "done" }, { thread: root.id, ts: 1_800_000_000_000 });
    const marenReview = make(maren, { v: 1, op: "card", rev: 1, after: refOf(root), column: "review" }, { thread: root.id, ts: 1_700_000_000_500 });
    const card = foldCard(root, [beaDone, marenReview], ctx);
    expect(card?.column).toBe("review");
    const got = cardProvenance(card?.timeline ?? [], provCols());
    expect(got.decided.map((a) => a.author.handle)).toEqual(["bea"]);
    expect(got.decided[0]?.decision).toBe("reopened");
    expect(got.shaped.map((a) => a.columnId)).toEqual(["review"]);
  });

  test("a later title edit does not clear the standing done move", () => {
    const root = make(alex, { v: 1, op: "card", rev: 0, board: A, title: "Pick", column: "todo" });
    const done = make(maren, { v: 1, op: "card", rev: 1, after: refOf(root), column: "done" }, { thread: root.id, ts: 1_900_000_000_000 });
    const title = make(beaPerson, { v: 1, op: "card", rev: 2, after: refOf(done), title: "Pick the font" }, { thread: root.id, ts: 1_600_000_000_000 });
    const card = foldCard(root, [done, title], ctx);
    expect(card?.column).toBe("done");
    const got = cardProvenance(card?.timeline ?? [], provCols());
    expect(got.decided.map((a) => a.decision)).toEqual(["stands"]);
    expect(got.decided[0]?.id).toBe(done.id);
    expect(got.shaped.map((a) => a.id)).toEqual([title.id]);
    expect(title.ts).toBeLessThan(done.ts);
  });

  test("P2: a column id the card's own board does not have is shaping, even when another board calls it done", () => {
    const root = make(alex, { v: 1, op: "card", rev: 0, board: B, title: "Pick", column: "todo" });
    const mv = make(beaPerson, { v: 1, op: "card", rev: 1, after: refOf(root), column: "done" }, { thread: root.id });
    const card = foldCard(root, [mv], ctx);
    expect(card?.board).toBe(B);
    expect(shownColumn(colsB, card?.column ?? "")).toBe("todo");
    const got = cardProvenance(card?.timeline ?? [], provCols());
    expect(got.decided).toEqual([]);
    expect(got.shaped.some((a) => a.id === mv.id && a.field === "column" && a.columnId === "done")).toBe(true);
    expect(got.shaped.find((a) => a.id === mv.id)?.columnName).toBeUndefined();
  });

  test("a column write with no board is judged on the card's board, not on every board that shares the id", () => {
    const cols: ProvenanceColumn[] = [
      { id: "col", name: "Done", role: "done", board: A },
      { id: "col", name: "To do", role: "todo", board: B },
    ];
    const got = cardProvenance([
      entry(alex, "create", { effective_rev: 0, changes: { title: "Pick", board: A, column: "todo" } }),
      entry(maren, "op", { effective_rev: 1, changes: { column: "col" } }),
    ], cols);
    expect(got.decided.map((a) => a.author.handle)).toEqual(["maren"]);
    expect(got.decided[0]?.decision).toBe("stands");
    expect(got.decided[0]?.columnName).toBe("Done");
    expect(got.shaped.filter((a) => a.field === "column")).toEqual([]);
  });

  test("an applied board write moves later column writes onto that board; an ignored one does not", () => {
    const cols: ProvenanceColumn[] = [
      { id: "col", name: "To do", role: "todo", board: A },
      { id: "col", name: "Shipped", role: "done", board: B },
    ];
    const moved = cardProvenance([
      entry(alex, "create", { effective_rev: 0, changes: { title: "Pick", board: A, column: "todo" } }),
      entry(maren, "op", { effective_rev: 1, changes: { board: B } }),
      entry(beaPerson, "op", { effective_rev: 2, changes: { column: "col" } }),
    ], cols);
    // Board B has no "todo", so the board-only move shows the card in B's only column, which is done.
    expect(moved.decided.map((a) => [a.author.handle, a.decision, a.columnName])).toEqual([
      ["maren", "superseded", "Shipped"],
      ["bea", "stands", "Shipped"],
    ]);
    expect(moved.decided[1]?.columnId).toBe("col");

    const ignored = cardProvenance([
      entry(alex, "create", { effective_rev: 0, changes: { title: "Pick", board: A, column: "todo" } }),
      entry(maren, "op", { effective_rev: 1, ignored: "unknown_board", changes: { board: B } }),
      entry(beaPerson, "op", { effective_rev: 2, changes: { column: "col" } }),
    ], cols);
    expect(ignored.decided).toEqual([]);
    expect(ignored.shaped.filter((a) => a.field === "column").map((a) => a.columnName)).toEqual(["To do"]);
  });

  test("rows at the same rank follow machine then numeric sequence, not the signed clock or a string id", () => {
    const nine = entry(alex, "op", { id: `${ALEX}:9`, effective_rev: 1, ts: 9_000, changes: { title: "nine" } });
    const ten = entry(alex, "op", { id: `${ALEX}:10`, effective_rev: 1, ts: 1_000, changes: { title: "ten" } });
    const got = cardProvenance([
      entry(alex, "create", { effective_rev: 0, changes: { title: "Pick" } }),
      ten,
      nine,
    ], COLS);
    expect(got.shaped.map((a) => a.id)).toEqual([`${ALEX}:9`, `${ALEX}:10`]);
  });

  test("an agent-signed done move is kept as that agent's act and can stand", () => {
    const root = make(alex, { v: 1, op: "card", rev: 0, board: A, title: "Pick", column: "todo" });
    const mv = make(bea, { v: 1, op: "card", rev: 1, after: refOf(root), column: "done" }, { thread: root.id });
    const card = foldCard(root, [mv], ctx);
    const got = cardProvenance(card?.timeline ?? [], provCols());
    expect(got.decided.map((a) => a.author)).toEqual([bea]);
    expect(got.decided[0]?.author.agent).toBe("builder");
    expect(got.decided[0]?.decision).toBe("stands");
  });

  test("changing a column's role reclassifies that move the next time it is read", () => {
    const root = make(alex, { v: 1, op: "card", rev: 0, board: A, title: "Pick", column: "todo" });
    const toReview = make(maren, { v: 1, op: "card", rev: 1, after: refOf(root), column: "review" }, { thread: root.id });
    const card = foldCard(root, [toReview], ctx);
    const flipped = colsA.map((c) => c.id === "review" ? { ...c, role: "done" as const } : c.id === "done" ? { ...c, role: "review" as const } : c);
    const got = cardProvenance(card?.timeline ?? [], provCols(flipped));
    expect(got.decided.map((a) => a.author.handle)).toEqual(["maren"]);
    expect(got.decided[0]?.decision).toBe("stands");
    expect(got.decided[0]?.columnName).toBe("In review");
  });

  test("a board-only move is a placement, so the standing decision matches the card's board and column", () => {
    // The column was set at creation. Moving only the board lands it on a done column. That move stands.
    const root = make(alex, { v: 1, op: "card", rev: 0, board: A, title: "Pick", column: "ship" });
    const onto = make(beaPerson, { v: 1, op: "card", rev: 1, after: refOf(root), board: B }, { thread: root.id });
    const landed = foldCard(root, [onto], ctx);
    expect(landed?.board).toBe(B);
    expect(landed?.column).toBe("ship");
    expect(shownColumn(colsB, landed?.column ?? "")).toBe("ship");
    const stood = cardProvenance(landed?.timeline ?? [], provCols());
    expect(stood.decided.map((a) => a.id)).toEqual([onto.id]);
    expect(stood.decided[0]?.author.handle).toBe("bea");
    expect(stood.decided[0]?.columnId).toBe("ship");
    expect(stood.decided[0]?.columnName).toBe("Shipped");
    expect(stood.decided[0]?.decision).toBe("stands");
    expect(stood.shaped.some((a) => a.field === "column")).toBe(false);

    // A done move, then a board-only move onto a board that does not have that column. The card shows in To do.
    const created = make(alex, { v: 1, op: "card", rev: 0, board: A, title: "Pick", column: "todo" });
    const decided = make(maren, { v: 1, op: "card", rev: 1, after: refOf(created), column: "done" }, { thread: created.id });
    const away = make(beaPerson, { v: 1, op: "card", rev: 2, after: refOf(decided), board: B }, { thread: created.id });
    const left = foldCard(created, [decided, away], ctx);
    expect(left?.board).toBe(B);
    expect(left?.column).toBe("done");
    expect(shownColumn(colsB, left?.column ?? "")).toBe("todo");
    const cleared = cardProvenance(left?.timeline ?? [], provCols());
    expect(cleared.decided.map((a) => a.author.handle)).toEqual(["maren"]);
    expect(cleared.decided.map((a) => a.decision)).toEqual(["reopened"]);
    expect(cleared.decided.some((a) => a.decision === "stands")).toBe(false);
    expect(cleared.shaped.some((a) => a.id === away.id)).toBe(false);

    // The same column id is done on the board the card lands on. The board move is the last placement, so it stands.
    const stillDone = cardProvenance(left?.timeline ?? [], provCols(colsA, [
      ...colsB,
      { id: "done", name: "Finished", role: "done" },
    ]));
    expect(stillDone.decided.map((a) => [a.author.handle, a.decision, a.columnName])).toEqual([
      ["maren", "superseded", "Done"],
      ["bea", "stands", "Finished"],
    ]);
    expect(stillDone.decided[1]?.id).toBe(away.id);
    expect(stillDone.decided[1]?.columnId).toBe("done");

    // A column write the old board does not have is shaping. Moving onto the board where that id is done decides it.
    const wrote = make(maren, { v: 1, op: "card", rev: 1, after: refOf(created), column: "ship" }, { thread: created.id });
    const hop = make(olive, { v: 1, op: "card", rev: 2, after: refOf(wrote), board: B }, { thread: created.id });
    const hopped = foldCard(created, [wrote, hop], ctx);
    expect(hopped?.column).toBe("ship");
    expect(hopped?.board).toBe(B);
    const placed = cardProvenance(hopped?.timeline ?? [], provCols());
    expect(placed.shaped.some((a) => a.id === wrote.id && a.field === "column" && a.columnId === "ship")).toBe(true);
    expect(placed.decided.map((a) => [a.author.handle, a.decision, a.columnName])).toEqual([["olive", "stands", "Shipped"]]);

    // The landing board does not have the card's column id, and the column it shows the card in is done.
    const onlyDone: ProvenanceColumn[] = [
      { id: "todo", name: "To do", role: "todo", board: A },
      { id: "only", name: "Shipped", role: "done", board: B },
    ];
    expect(shownColumn([{ id: "only", name: "Shipped", role: "done" }], "todo")).toBe("only");
    const bare = cardProvenance([
      entry(alex, "create", { effective_rev: 0, changes: { title: "Pick", board: A, column: "todo" } }),
      entry(maren, "op", { effective_rev: 1, changes: { board: B } }),
    ], onlyDone);
    expect(bare.decided.map((a) => [a.author.handle, a.decision, a.columnId, a.columnName])).toEqual([
      ["maren", "stands", "only", "Shipped"],
    ]);
    expect(bare.shaped.some((a) => a.field === "column")).toBe(false);
  });
});

describe("provenanceTimeKind", () => {
  const now = 1_700_000_000_000;

  test("an unusable clock is unshown, a stamp inside a day ahead is ahead, and the exact bound is one day", () => {
    expect(provenanceTimeKind(-1, now)).toBe("unshown");
    expect(provenanceTimeKind(Number.NaN, now)).toBe("unshown");
    expect(provenanceTimeKind(1.5, now)).toBe("unshown");
    expect(provenanceTimeKind(PROVENANCE_MAX_TS + 1, now)).toBe("unshown");
    expect(provenanceTimeKind(now + PROVENANCE_FUTURE_MS + 1, now)).toBe("unshown");
    expect(provenanceTimeKind(now + PROVENANCE_FUTURE_MS, now)).toBe("ahead");
    expect(provenanceTimeKind(now + 1, now)).toBe("ahead");
    expect(provenanceTimeKind(now, now)).toBe("shown");
    expect(provenanceTimeKind(now - 60_000, now)).toBe("shown");
    expect(provenanceTimeKind(0, now)).toBe("shown");
    expect(provenanceTimeKind(PROVENANCE_MAX_TS, PROVENANCE_MAX_TS)).toBe("shown");
    expect(provenanceTimeKind(now, Number.NaN)).toBe("shown");
  });
});
