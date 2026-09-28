import { afterEach, expect, spyOn, test } from "bun:test";
import { applyBatch, importBudgetKey } from "../../src/daemon/projects/batch.ts";
import { ProjectsIndex } from "../../src/daemon/projects/index.ts";
import { updateCard, type WriteCtx } from "../../src/daemon/projects/service.ts";
import { BatchReq } from "../../src/protocol/projects/batch.ts";
import type { BodyOf } from "../../src/protocol/schemas.ts";
import { DEFAULT_COLUMNS } from "../../src/protocol/projects/schema.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, ev, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const CH = "p-abcdef12";

function world() {
  const person = tnode("alex");
  const { team, create } = createTeam(person);
  const channel = ev(team, person, "channel.upsert", { name: CH, project: true });
  const project = ev(team, person, "msg.post", { text: "Project", board: { v: 1, rev: 0, op: "project", name: "Batch", prefix: "BAT" } } as BodyOf<"msg.post">, { channel: CH });
  const board = ev(team, person, "msg.post", { text: "Board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } } as BodyOf<"msg.post">, { channel: CH });
  const core = makeCore(person, team, cleanups);
  const idx = new ProjectsIndex(core, core.log);
  cleanups.push(() => idx.stop());
  core.onPostChange = (e, change) => idx.onPost(e, change);
  core.onRosterChange = () => idx.rosterChanged();
  for (const event of [create, channel, project, board]) core.ingest(event, "local");
  idx.flushAll();
  const w = { core, idx, client: {} as WriteCtx["client"], catchUp: async () => {} } satisfies WriteCtx;
  return { w, person, team, board };
}

test("batch schema caps requests, and invalid references fail before signing", () => {
  const { w } = world();
  const op = { op: "create" as const, title: "Card", column: "todo" };
  expect(BatchReq.safeParse({ ops: Array(250).fill(op) }).success).toBe(true);
  expect(BatchReq.safeParse({ ops: Array(251).fill(op) }).success).toBe(false);
  const seq = w.core.store.allocatedSelfSeq(w.core.nodeId);
  expect(() => applyBatch(w, CH, [op, { op: "comment", card: "#1", text: "Bad reference" }])).toThrow("not a card created earlier");
  expect(w.core.store.allocatedSelfSeq(w.core.nodeId)).toBe(seq);
  const result = applyBatch(w, CH, [op, { op: "comment", card: "#0", text: "History" }]);
  expect(result.events).toBe(2);
  expect(result.comments[0]?.card).toBe(result.created[0]?.id);
});

test("a signing rollback refunds the import budget and reuses every sequence", () => {
  const { w } = world();
  const opts = { budgetKey: importBudgetKey(undefined), spec: { capacity: 2, perSecond: 0 } };
  const ops = ["First", "Second"].map((title) => ({ op: "create" as const, title, column: "todo" }));
  const seq = w.core.store.allocatedSelfSeq(w.core.nodeId);
  const emit = w.core.emit.bind(w.core);
  let count = 0;
  const spy = spyOn(w.core, "emit").mockImplementation((...args: Parameters<typeof emit>) => {
    if (++count === 2) throw new Error("test signing failure");
    return emit(...args);
  });
  try { expect(() => applyBatch(w, CH, ops, opts)).toThrow("test signing failure"); }
  finally { spy.mockRestore(); }
  expect(w.core.store.allocatedSelfSeq(w.core.nodeId)).toBe(seq);
  expect(w.core.limiter.available(opts.budgetKey, opts.spec)).toBe(2);
  const result = applyBatch(w, CH, ops, opts);
  expect(result.events).toBe(2);
  expect(result.created[0]?.id).toBe(`${w.core.nodeId}:${seq + 1}`);
  expect(w.core.limiter.available(opts.budgetKey, opts.spec)).toBe(0);
});

test("batch updates match updateCard revisions for roots and local follow-ups", () => {
  const { w } = world();
  const roots = applyBatch(w, CH, ["Batch", "Interactive"].map((title) => ({ op: "create" as const, title, column: "todo" }))).created;
  const revs = () => roots.map((c) => w.core.store.db.query<{ rev: number }, [string]>(
    "SELECT json_extract(body, '$.board.rev') AS rev FROM events WHERE thread = ? ORDER BY seq DESC LIMIT 1").get(c.id)?.rev);
  {
    applyBatch(w, CH, [{ op: "update", card: roots[0]!.id, column: "doing" }]);
    updateCard(w, roots[1]!.id, { column: "doing" });
    expect(revs()).toEqual([1, 1]);
    applyBatch(w, CH, [{ op: "update", card: roots[0]!.id, column: "done" }]);
    updateCard(w, roots[1]!.id, { column: "done" });
    expect(revs()).toEqual([1, 1]);
  }
});

test("ext recovery and title adoption exclude the person's agent-authored roots", () => {
  const { w, person, team, board } = world();
  const root = (agent?: string) => ev(team, person, "msg.post", { text: "Card", board: {
    v: 1, rev: 0, op: "card", board: board.id, title: "[AUD-1] Candidate", column: "todo", n: 1,
    ext: { src: "linear", id: "issue-1", key: "AUD-1" },
  } } as BodyOf<"msg.post">, { channel: CH, ...(agent ? { agent } : {}) });
  const human = root(), agent = root("cc-audit");
  for (const event of [human, agent]) w.core.ingest(event, "local");
  w.idx.flushAll();
  expect(w.idx.db.authoredCardRoots(CH, "alex").map((r) => r.id)).toEqual([human.id]);
  expect(w.idx.db.extRoots("linear", "alex").map((r) => r.id)).toEqual([human.id]);
});

test("reopening through a batch counts toward the board's 2 000 open cards; archiving earlier in the batch frees a place", () => {
  const { w } = world();
  const opts = { budgetKey: importBudgetKey(undefined), spec: { capacity: 10_000, perSecond: 0 } };
  const archived = applyBatch(w, CH, [{ op: "create", title: "Old", column: "todo", state: "archived" }], opts).created[0]!.id;
  let first = "";
  for (let b = 0; b < 8; b++) {
    const res = applyBatch(w, CH, Array.from({ length: 250 }, (_, i) => ({ op: "create" as const, title: `Open ${b}-${i}`, column: "todo" })), opts);
    first ||= res.created[0]!.id;
  }
  const seq = w.core.store.allocatedSelfSeq(w.core.nodeId);
  expect(() => applyBatch(w, CH, [{ op: "update", card: archived, state: "open" }], opts)).toThrow("holds at most 2000 open cards");
  expect(w.core.store.allocatedSelfSeq(w.core.nodeId)).toBe(seq);
  const ok = applyBatch(w, CH, [{ op: "update", card: first, state: "archived" }, { op: "update", card: archived, state: "open" }], opts);
  expect(ok.updated.length).toBe(2);
}, 60_000);
