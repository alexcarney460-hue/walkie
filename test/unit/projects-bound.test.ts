// Round-6 audits (Opus r6 HIGH "cap6", Codex r6 HIGH): the board-op hidden-row bounds. Only rows whose rejection is
// FINAL (anchored) count toward the per-channel bound and can be reduced to stubs; curable ones are kept (bounded by
// bytes: past that a new one is refused and not stored, so its sender offers it again). Replicas that learn a cure in a
// different order end with the same rows and the same board. Small bounds (Core `boardBounds`) keep this fast; the
// full-size probe (20 005 ops) is the audit's cap6 (docs/audits/2026-09-26-opus-projects-r6.md).
import { afterEach, expect, test } from "bun:test";
import type { Core } from "../../src/daemon/core.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { ProjectsIndex } from "../../src/daemon/projects/index.ts";
import { sigHash } from "../../src/daemon/projects/db.ts";
import { findCard } from "../../src/daemon/projects/service.ts";
import { stubOf } from "../../src/protocol/header.ts";
import { cardRefIn, scrubPrivateKeys } from "../../src/protocol/projects/assoc.ts";
import { DEFAULT_COLUMNS, MAX_BOARD_OP_BYTES, isBoardOp } from "../../src/protocol/projects/schema.ts";
import { shortId } from "../../src/protocol/projects/short.ts";
import type { BodyOf, Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore, reopen, settle, statusOf } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, tnode, type TNode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
const CH = "p-0e1c7ed0";
const ref = (e: Event) => `${e.id}#${sigHash(e.sig)}`;
const withWm = <T>(body: T, wm: Record<string, number>): T => ({ ...body, wm }) as T;

function team(members: string[] | null) {
  const alex = tnode("alex"), bob = tnode("bob"), carol = tnode("carol"), dave = tnode("dave");
  const { team: t, create } = createTeam(alex);
  const roster: Event[] = [create];
  for (const n of [bob, carol, dave]) roster.push(memberEv(t, alex, n, "member"), nodeEv(t, alex, n));
  roster.push(ev(t, alex, "channel.upsert", { name: CH, project: true, ...(members ? { members } : {}) } as BodyOf<"channel.upsert">));
  const post = (n: TNode, body: Record<string, unknown>, opts: { ts?: number } = {}) =>
    ev(t, n, "msg.post", body as BodyOf<"msg.post">, { channel: CH, ...opts });
  const root = post(alex, { text: "project", board: { v: 1, rev: 0, op: "project", name: "Web", prefix: "WEB" } });
  const board = post(alex, { text: "board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } });
  const card = post(alex, { text: "card", board: { v: 1, rev: 0, op: "card", board: board.id, title: "root", column: "todo", n: 1 } });
  const chainOps = (n: TNode, count: number, first: Event = card, label = n.handle) => {
    const ops: Event[] = [];
    let parent = first;
    for (let i = 1; i <= count; i++) {
      const e = post(n, { text: "op", thread: card.id, board: { v: 1, rev: i, op: "card", after: ref(parent), title: `${label}-${i}` } });
      ops.push(e);
      parent = e;
    }
    return ops;
  };
  return { t, alex, bob, carol, dave, roster, post, root, board, card, chainOps };
}

function replica(self: TNode, t: string, bounds?: { finalCap?: number; curableBytes?: number }) {
  const core = makeCore(self, t, cleanups, bounds ? { boardBounds: bounds } : {});
  const idx = new ProjectsIndex(core, createLogger({}));
  core.onPostChange = (e, change) => idx.onPost(e, change);
  core.onRosterChange = () => idx.rosterChanged();
  return { core, idx };
}

async function drain(core: Core): Promise<void> {
  for (let i = 0; i < 50 && core.busy > 0; i++) { await settle(core); await Bun.sleep(5); }
  await settle(core);
}

/** The board-hidden counters agree with the rows they count. */
function countersHonest(core: Core, origin: string): void {
  const db = core.store.db;
  const rows = db.query<{ fin: number; n: number; b: number }, [string, string]>(
    `SELECT fin, COUNT(*) AS n, COALESCE(SUM(length(CAST(json AS BLOB))), 0) AS b FROM events WHERE origin = ? AND channel = ?
     AND bop = 1 AND status = 'rejected' AND redacted = 0 GROUP BY fin`).all(origin, CH);
  const fin = rows.find((r) => r.fin === 1)?.n ?? 0;
  const curable = rows.find((r) => r.fin === 0)?.b ?? 0;
  expect(core.store.boardHidden(origin, CH)).toEqual({ final_n: fin, curable_bytes: curable });
}

test("Opus r6 cap6: curable hidden board ops past the final bound aren't evicted; a replica that learns the add late converges", async () => {
  const w = team(["alex", "dave", "bob"]);
  const add = ev(w.t, w.alex, "channel.upsert", { name: CH, members: ["alex", "dave", "bob", "carol"] } as BodyOf<"channel.upsert">);
  const ops = w.chainOps(w.carol, 15);
  const titles: Record<string, string | undefined> = {};
  for (const [name, lag] of [["A", true], ["B", false]] as const) {
    const r = replica(w.dave, w.t, { finalCap: 10 });
    feed(r.core, [...w.roster, ...(lag ? [] : [add]), w.root, w.board, w.card]);
    feed(r.core, ops);
    if (lag) {
      expect(statusOf(r.core, (ops[14] as Event).id)).toBe("rejected"); // not_channel_member, curable: kept in full
      expect(r.core.store.getRow((ops[14] as Event).id)?.redacted).toBe(0);
      countersHonest(r.core, w.carol.keys.nodeId);
      feed(r.core, [add]);
    }
    await drain(r.core);
    for (const o of ops) expect(statusOf(r.core, o.id)).toBe("ok");
    countersHonest(r.core, w.carol.keys.nodeId);
    r.idx.flushAll();
    titles[name] = r.idx.foldCardNow(CH, w.card.id)?.state.title;
  }
  expect(titles.A).toBe("carol-15");
  expect(titles.B).toBe("carol-15");
});

test("Codex r6 HIGH: removal then readmission without anchoring: the replica that saw the removal first doesn't evict, and Bob's edit applies on both", async () => {
  const w = team(null);
  const ops = w.chainOps(w.carol, 12);
  const bobEdit = w.post(w.bob, { text: "op", thread: w.card.id, board: { v: 1, rev: 13, op: "card", after: ref(ops[11] as Event), title: "bob's fix" } });
  const removed = memberEv(w.t, w.alex, w.carol, "removed");
  const back = memberEv(w.t, w.alex, w.carol, "member");
  const node = nodeEv(w.t, w.alex, w.carol);
  const titles: Record<string, string | undefined> = {};
  for (const [name, order] of [["A", "removal-first"], ["B", "readmission-first"]] as const) {
    const r = replica(w.dave, w.t, { finalCap: 10 });
    feed(r.core, [...w.roster, w.root, w.board, w.card, removed]);
    await drain(r.core);
    if (order === "removal-first") feed(r.core, [...ops, bobEdit]);
    feed(r.core, [back, node]);
    await drain(r.core);
    if (order === "readmission-first") feed(r.core, [...ops, bobEdit]);
    await drain(r.core);
    for (const o of ops) expect(statusOf(r.core, o.id)).toBe("ok");
    r.idx.flushAll();
    const got = r.idx.foldCardNow(CH, w.card.id)?.state;
    expect(got?.timeline.some((x) => x.ignored === "waiting_for_parent")).toBe(false);
    titles[name] = got?.title;
  }
  expect(titles.A).toBe("bob's fix");
  expect(titles.B).toBe("bob's fix");
});

test("the final bound: anchored rejections beyond the lowest N are reduced, the same rows in any arrival order; ops naming one wait everywhere", async () => {
  const w = team(["alex", "dave", "bob"]); // Carol is never in the project
  const ops = w.chainOps(w.carol, 14);
  const kept = ops[4] as Event, cut = ops[5] as Event;
  const onKept = w.post(w.bob, { text: "op", thread: w.card.id, board: { v: 1, rev: 1, op: "card", after: ref(w.card), title: "bob" } });
  const anchor = ev(w.t, w.alex, "channel.upsert", withWm({ name: "general" } as BodyOf<"channel.upsert">, { [w.carol.keys.nodeId]: w.carol.seq }));
  const bobOnCut = w.post(w.bob, { text: "op", thread: w.card.id, board: { v: 1, rev: 2, op: "card", after: ref(cut), title: "built on a reduced op" } });
  const full: Record<string, string[]> = {};
  const results: Record<string, unknown> = {};
  for (const [name, arrival] of [["in-order", ops], ["reversed", [...ops].reverse()], ["anchor-first", ops]] as const) {
    const r = replica(w.dave, w.t, { finalCap: 5 });
    feed(r.core, [...w.roster, w.root, w.board, w.card, onKept]);
    if (name === "anchor-first") feed(r.core, [anchor]);
    feed(r.core, arrival);
    if (name !== "anchor-first") feed(r.core, [anchor]);
    feed(r.core, [bobOnCut]);
    await drain(r.core);
    countersHonest(r.core, w.carol.keys.nodeId);
    expect(r.core.store.boardHidden(w.carol.keys.nodeId, CH).final_n).toBe(5);
    full[name] = ops.filter((o) => r.core.store.getRow(o.id)?.redacted === 0).map((o) => o.id);
    expect(r.core.store.getRow(cut.id)).toMatchObject({ redacted: 1, status: "junk", reason: "hidden_board_cap" });
    expect(r.core.store.getRow(kept.id)).toMatchObject({ redacted: 0, status: "rejected" });
    r.idx.flushAll();
    const s = r.idx.foldCardNow(CH, w.card.id)?.state;
    results[name] = { title: s?.title, waiting: s?.timeline.filter((x) => x.ignored === "waiting_for_parent").map((x) => x.id) };
  }
  expect(full["in-order"]).toEqual(ops.slice(0, 5).map((o) => o.id));
  expect(full.reversed).toEqual(full["in-order"] as string[]);
  expect(full["anchor-first"]).toEqual(full["in-order"] as string[]);
  expect(results.reversed).toEqual(results["in-order"]);
  expect(results["anchor-first"]).toEqual(results["in-order"]);
  expect(results["in-order"]).toEqual({ title: "bob", waiting: [bobOnCut.id] });
});

test("the curable byte bound: past it a new curable op is refused and not stored; offered again after the cure, it is accepted", async () => {
  const w = team(["alex", "dave", "bob"]);
  const add = ev(w.t, w.alex, "channel.upsert", { name: CH, members: ["alex", "dave", "bob", "carol"] } as BodyOf<"channel.upsert">);
  const ops = w.chainOps(w.carol, 6);
  const size = Buffer.byteLength(JSON.stringify(ops[0]));
  const r = replica(w.dave, w.t, { curableBytes: size * 3 + size / 2 });
  feed(r.core, [...w.roster, w.root, w.board, w.card]);
  const res = ops.map((o) => r.core.ingest(o, "remote"));
  expect(res.slice(0, 3).map((x) => x.status)).toEqual(["rejected", "rejected", "rejected"]);
  expect(res.slice(3).map((x) => x.reason)).toEqual(["board_hidden_full", "board_hidden_full", "board_hidden_full"]);
  expect(r.core.store.getRow((ops[3] as Event).id)).toBeNull();
  countersHonest(r.core, w.carol.keys.nodeId);
  feed(r.core, [add]);
  await drain(r.core);
  expect(r.core.ingest(ops[3] as Event, "remote").status).toBe("accepted"); // the sender offers the rest again
  feed(r.core, ops.slice(4));
  for (const o of ops) expect(statusOf(r.core, o.id)).toBe("ok");
  countersHonest(r.core, w.carol.keys.nodeId);
  r.idx.flushAll();
  expect(r.idx.foldCardNow(CH, w.card.id)?.state.title).toBe("carol-6");
});

test("a board op the caps reduced is restored by a full copy while its rejection is curable; a final one stays reduced", async () => {
  const w = team(["alex", "dave", "bob"]);
  const add = ev(w.t, w.alex, "channel.upsert", { name: CH, members: ["alex", "dave", "bob", "carol"] } as BodyOf<"channel.upsert">);
  const [op] = w.chainOps(w.carol, 1) as [Event];
  const r = replica(w.dave, w.t);
  feed(r.core, [...w.roster, w.root, w.board, w.card, op]);
  r.core.store.replaceWithStub(stubOf(op), "junk", "hidden_board_cap"); // what an older build's eviction left
  expect(r.core.ingest(op, "remote")).toEqual({ status: "rejected", reason: "not_channel_member" });
  expect(r.core.store.getRow(op.id)).toMatchObject({ redacted: 0, status: "rejected" });
  feed(r.core, [add]);
  await drain(r.core);
  expect(statusOf(r.core, op.id)).toBe("ok");

  const w2 = team(["alex", "dave", "bob"]);
  const [op2] = w2.chainOps(w2.carol, 1) as [Event];
  const anchor = ev(w2.t, w2.alex, "channel.upsert", withWm({ name: "general" } as BodyOf<"channel.upsert">, { [w2.carol.keys.nodeId]: w2.carol.seq }));
  const r2 = replica(w2.dave, w2.t);
  feed(r2.core, [...w2.roster, w2.root, w2.board, w2.card, anchor, op2]);
  r2.core.store.replaceWithStub(stubOf(op2), "junk", "hidden_board_cap");
  expect(r2.core.ingest(op2, "remote").status).toBe("duplicate");
  expect(r2.core.store.getRow(op2.id)?.redacted).toBe(1);
});

test("only schema-valid board ops of at most 16 KB are board ops: others fall under the general cap and the fold ignores them", async () => {
  const w = team(null);
  const big = w.post(w.carol, { text: "x".repeat(MAX_BOARD_OP_BYTES), thread: w.card.id, board: { v: 1, rev: 1, op: "card", after: ref(w.card), title: "too big" } });
  const junk = w.post(w.carol, { text: "x", board: { v: 1, op: "card", junk: "y" } });
  expect(isBoardOp(big)).toBe(false);
  expect(isBoardOp(junk)).toBe(false);
  const r = replica(w.dave, w.t);
  feed(r.core, [...w.roster, w.root, w.board, w.card, big, junk]);
  feed(r.core, [memberEv(w.t, w.alex, w.carol, "removed")]);
  await drain(r.core);
  expect(r.core.store.hiddenCount(w.carol.keys.nodeId)).toBe(2); // counted by the general cap
  expect(r.core.store.boardHidden(w.carol.keys.nodeId, CH)).toEqual({ final_n: 0, curable_bytes: 0 });
  r.idx.flushAll();
  expect(r.idx.foldCardNow(CH, w.card.id)?.state.title).toBe("root");
});

test("references: 8-hex short ids resolve whatever the key or prefix became; bare keys a card held before are ambiguous; refs follow keys", async () => {
  const w = team(null);
  const r = replica(w.dave, w.t);
  const cardPost = (title: string, n: number, ts?: number) =>
    w.post(w.bob, { text: title, board: { v: 1, rev: 0, op: "card", board: w.board.id, title, column: "todo", n } }, ts ? { ts } : {});
  // Codex r6 M3: X and A propose 2 (X first), so A shows as 3; C, created before A, arrives later proposing 3.
  const x = cardPost("X", 2);
  const cTs = x.ts + 1;
  const a = cardPost("A", 2);
  const c = cardPost("C", 3, cTs);
  feed(r.core, [...w.roster, w.root, w.board, w.card, x, a]);
  r.idx.flushAll();
  const before = r.idx.db.card(a.id);
  expect(before?.key).toBe("WEB-3");
  const savedRef = before?.ref as string;
  expect(savedRef).toBe(`WEB-3-${shortId(a.id)}`);
  feed(r.core, [c]);
  r.idx.flushAll();
  const after = r.idx.db.card(a.id);
  expect(after?.key).toBe("WEB-4");
  expect(after?.ref).toBe(`WEB-4-${shortId(a.id)}`); // Codex r6 LOW: the reference follows the key
  const ctx = { core: r.core, idx: r.idx };
  expect(findCard(ctx, savedRef).card.id).toBe(a.id); // resolved by its short id; shown with its current key
  expect(findCard(ctx, savedRef).card.key).toBe("WEB-4");
  expect(() => findCard(ctx, "WEB-3")).toThrow(/could mean 2 cards/); // C holds 3 now, A held it before
  expect(() => findCard(ctx, "WEB-2")).toThrow(/could mean 2 cards/); // X holds it, A proposed it
  // Codex r6 M5: renaming the prefix keeps references (and old bare keys) resolving.
  const rename = w.post(w.alex, { text: "rename", thread: w.root.id, board: { v: 1, rev: 1, op: "project", after: ref(w.root), prefix: "NEW" } });
  feed(r.core, [rename]);
  r.idx.flushAll();
  expect(findCard(ctx, savedRef).card.id).toBe(a.id);
  expect(findCard(ctx, `NEW-4-${shortId(a.id)}`).card.id).toBe(a.id);
  expect(findCard(ctx, "WEB-4").card.id).toBe(a.id);
  expect(() => findCard(ctx, "WEB-4-00000000")).toThrow(/no card/);
});

test("reference parsing and masking: exactly 8 hex; a private reference is masked whole", () => {
  expect(cardRefIn("web-12-feed-parser")).toBe("WEB-12");
  expect(cardRefIn("feature/web-12-deadbeef-login")).toBe("WEB-12-deadbeef");
  expect(cardRefIn("web-12-deadbeef0")).toBe("WEB-12");
  expect(cardRefIn("web-12-2024-report")).toBe("WEB-12");
  const s = scrubPrivateKeys({ title: "on SECRET-12-9b36abcd now", repo: "x/SECRET-12-9b36abcd", activity: "SECRET-12-feed-parser" }, ["SECRET"]);
  expect(JSON.stringify(s)).not.toContain("9b36abcd");
  expect(s.title).toBe(`on ${"*".repeat("SECRET-12-9b36abcd".length)} now`);
  // A hex-looking slug word right after the key goes with it (fail closed); the rest of the slug stays.
  expect(s.activity).toBe(`${"*".repeat("SECRET-12-feed".length)}-parser`);
  const any = scrubPrivateKeys({ title: "on SECRET-12-9b36abcd" }, [], { anyKey: true });
  expect(any.title).not.toContain("9b36abcd");
});

test("masking takes the whole hex run after a private key, whatever its length or the next character (round-7 audit)", () => {
  const stars = (t: string) => "*".repeat(t.length);
  for (const opts of [{}, { anyKey: true }]) {
    const prefixes = "anyKey" in opts ? [] : ["SECRET", "WEB"];
    const m = (title: string) => scrubPrivateKeys({ title }, prefixes, opts).title;
    // Leaked before: the exact-8 group backtracked to the bare key and left the short id readable.
    expect(m("SECRET-12-9b36abcd2")).toBe(stars("SECRET-12-9b36abcd2"));
    expect(m("SECRET-12-9b36abc")).toBe(stars("SECRET-12-9b36abc"));
    expect(m("SECRET-12-9b36abcd2x")).toBe(`${stars("SECRET-12-9b36abcd2")}x`);
    // A reference followed by a slug: the reference goes whole, the slug stays.
    expect(m("web-12-deadbeef-x")).toBe(`${stars("web-12-deadbeef")}-x`);
    expect(m("feat/web-12-deadbeef-login")).toBe(`feat/${stars("web-12-deadbeef")}-login`);
    // A canonical reference inside a sentence.
    expect(m("fixing SECRET-12-9b36abcd, then lunch")).toBe(`fixing ${stars("SECRET-12-9b36abcd")}, then lunch`);
    // No hex after the dash: only the key.
    expect(m("SECRET-12-xyz")).toBe(`${stars("SECRET-12")}-xyz`);
    for (const t of [("SE" + "CRET-12-9b36abcd2"), ("SE" + "CRET-12-9b36abc"), "web-12-deadbeef-x"]) {
      expect(m(`see ${t} now`)).not.toMatch(/9b36|deadbeef/);
    }
  }
  // task / branch naming a private reference are still dropped.
  const dropped: Record<string, unknown> = scrubPrivateKeys({ task: "SECRET-12-9b36abcd2", branch: "web-12-deadbeef-x", title: "t" }, ["SECRET", "WEB"]);
  expect(dropped).toEqual({ title: "t" });
});

const finOf = (core: Core, id: string) => core.store.db.query<{ fin: number }, [string]>("SELECT fin FROM events WHERE id = ?").get(id)?.fin;

test("round-7 audit: a crash between the chain advance and queuing its re-judge still marks the newly anchored rows final", async () => {
  const w = team(["alex", "dave", "bob"]); // Carol is never in the project: her ops stay rejected
  const ops = w.chainOps(w.carol, 6);
  const anchor = ev(w.t, w.alex, "channel.upsert", withWm({ name: "general" } as BodyOf<"channel.upsert">, { [w.carol.keys.nodeId]: w.carol.seq }));
  const r = replica(w.dave, w.t);
  feed(r.core, [...w.roster, w.root, w.board, w.card, ...ops]);
  await drain(r.core);
  for (const o of ops) expect(finOf(r.core, o.id)).toBe(0); // curable: not anchored yet
  expect(r.core.store.getMeta("reval_pending")).toBe("0");
  // The process dies right after the advance transaction commits, before any re-judge job is queued.
  const reval = (r.core as unknown as { reval: { enqueue: (jobs: unknown) => void } }).reval;
  reval.enqueue = () => { throw new Error("SIGKILL"); };
  feed(r.core, [anchor]);
  expect(statusOf(r.core, anchor.id)).toBe("ok"); // the chain advance committed
  for (const o of ops) expect(finOf(r.core, o.id)).toBe(0); // ...but nothing re-judged the rows it anchored
  expect(r.core.store.getMeta("reval_pending")).toBe("1"); // committed with the advance
  const R = reopen(r.core, w.dave); cleanups.push(() => R.close());
  await drain(R);
  for (const o of ops) expect(finOf(R, o.id)).toBe(1);
  expect(R.store.boardHidden(w.carol.keys.nodeId, CH).final_n).toBe(ops.length);
  countersHonest(R, w.carol.keys.nodeId);
  expect(R.store.getMeta("reval_pending")).toBe("0");
});

test("a channel already over the final bound at startup (a lower bound than the last run's) is reduced once, at startup", async () => {
  const w = team(["alex", "dave", "bob"]);
  const ops = w.chainOps(w.carol, 8);
  const anchor = ev(w.t, w.alex, "channel.upsert", withWm({ name: "general" } as BodyOf<"channel.upsert">, { [w.carol.keys.nodeId]: w.carol.seq }));
  const r = replica(w.dave, w.t, { finalCap: 6 });
  feed(r.core, [...w.roster, w.root, w.board, w.card, anchor, ...ops]);
  await drain(r.core);
  expect(r.core.store.boardHidden(w.carol.keys.nodeId, CH).final_n).toBe(6);
  const R = reopen(r.core, w.dave, { boardBounds: { finalCap: 3 } }); cleanups.push(() => R.close());
  // No re-validation runs at this startup (same validity version, none interrupted): only the startup sweep reduces it.
  expect(R.revalidating).toBe(0);
  await drain(R);
  expect(R.store.boardHidden(w.carol.keys.nodeId, CH).final_n).toBe(6);
  const idx = new ProjectsIndex(R, createLogger({}));
  const refolded: string[] = [];
  R.onPostChange = (e, change) => { refolded.push(e.id); idx.onPost(e, change); };
  expect(R.reduceOverCapBoards()).toBe(1); // as the daemon does at startup, once the index is wired
  expect(refolded.sort()).toEqual(ops.slice(3, 6).map((o) => o.id).sort());
  expect(R.store.boardHidden(w.carol.keys.nodeId, CH).final_n).toBe(3);
  expect(R.reduceOverCapBoards()).toBe(0);
  countersHonest(R, w.carol.keys.nodeId);
  expect(ops.filter((o) => R.store.getRow(o.id)?.redacted === 0).map((o) => o.id)).toEqual(ops.slice(0, 3).map((o) => o.id));
});
