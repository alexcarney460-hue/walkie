// Round-4 Codex findings against a Core fed signed events (no network): Codex's exact scenario for the HIGH (an
// accepted edit built on an op that the hidden-row cap later evicts), the arrival-order divergence (a rejected parent
// that arrives last), and zero-rank follow-ups across one person's machines / forged handles.
import { afterEach, expect, test } from "bun:test";
import { createLogger } from "../../src/daemon/logger.ts";
import { ProjectsIndex } from "../../src/daemon/projects/index.ts";
import { sigHash } from "../../src/daemon/projects/db.ts";
import { foldCard, type OpEvent } from "../../src/protocol/projects/fold.ts";
import { DEFAULT_COLUMNS } from "../../src/protocol/projects/schema.ts";
import type { BodyOf, Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore, settle, statusOf } from "../helpers/core.ts";
import { stubOf } from "../../src/protocol/header.ts";
import { createTeam, ev, memberEv, nodeEv, tnode, type TNode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const CH = "p-0e1c7ed0";
const ref = (e: Event) => `${e.id}#${sigHash(e.sig)}`;

function world() {
  const alex = tnode("alex"), bob = tnode("bob"), carol = tnode("carol"), dave = tnode("dave");
  const { team, create } = createTeam(alex);
  const roster: Event[] = [create];
  for (const n of [bob, carol, dave]) roster.push(memberEv(team, alex, n, "member"), nodeEv(team, alex, n));
  roster.push(ev(team, alex, "channel.upsert", { name: "general" }), ev(team, alex, "channel.upsert", { name: CH, project: true }));
  const post = (n: TNode, body: Record<string, unknown>, channel = CH) => ev(team, n, "msg.post", body as BodyOf<"msg.post">, { channel });
  const root = post(alex, { text: "project", board: { v: 1, rev: 0, op: "project", name: "Web", prefix: "WEB" } });
  const board = post(alex, { text: "board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } });
  const card = post(bob, { text: "card", board: { v: 1, rev: 0, op: "card", board: board.id, title: "root", column: "todo", n: 1 } });
  const cardOp = (n: TNode, parent: Event, rev: number, fields: Record<string, unknown>) =>
    post(n, { text: "op", thread: card.id, board: { v: 1, rev, op: "card", after: ref(parent), ...fields } });
  const core = makeCore(dave, team, cleanups);
  const idx = new ProjectsIndex(core, createLogger({}));
  core.onPostChange = (e, change) => idx.onPost(e, change);
  core.onRosterChange = () => idx.rosterChanged();
  return { team, alex, bob, carol, dave, roster, root, board, card, cardOp, post, core, idx };
}

test("Codex r4 HIGH: Carol's 1 000 posts + a label, Bob builds on the label, Carol is removed: the general hidden cap never evicts her board op, and Bob's edit stands", async () => {
  const w = world();
  feed(w.core, [...w.roster, w.root, w.board, w.card]);
  const alexEdit = w.cardOp(w.alex, w.card, 1, { title: "alex early" });
  const posts = Array.from({ length: 1_000 }, (_, i) => w.post(w.carol, { text: `carol ${i}` }, "general"));
  const label = w.cardOp(w.carol, alexEdit, 2, { labels: ["carol"] });
  const bobEdit = w.cardOp(w.bob, label, 3, { title: "bob's accepted fix", column: "doing" });
  feed(w.core, [alexEdit, ...posts, label, bobEdit]);
  w.idx.flushAll();
  expect(w.idx.db.card(w.card.id)).toMatchObject({ title: "bob's accepted fix", column: "doing", labels: ["carol"] });
  // The authority removes Carol without having seen any of it: 1 001 of her rows become hidden. Board ops aren't counted
  // by the general cap (Opus r5): the label stays in full, hidden, and still carries rank.
  feed(w.core, [memberEv(w.team, w.alex, w.carol, "removed")]);
  await settle(w.core);
  await Bun.sleep(20);
  expect(statusOf(w.core, label.id)).toBe("rejected");
  expect(w.core.store.hiddenCount(w.carol.keys.nodeId)).toBe(1_000);
  expect(statusOf(w.core, bobEdit.id)).toBe("ok");
  w.idx.flushAll();
  const card = w.idx.db.card(w.card.id);
  expect(card).toMatchObject({ title: "bob's accepted fix", column: "doing", labels: [] });
  const fresh = w.idx.foldCardNow(CH, w.card.id);
  expect(fresh?.state.timeline.some((t) => t.ignored === "waiting_for_parent")).toBe(false);
  expect(fresh?.state.title).toBe("bob's accepted fix");
});

test("Codex r4 M2: a rejected parent arriving after its child: the stored card matches a fresh fold", async () => {
  const w = world();
  feed(w.core, [...w.roster, w.root, w.board, w.card]);
  const label = w.cardOp(w.carol, w.card, 1, { labels: ["carol"] });
  const bobEdit = w.cardOp(w.bob, label, 2, { title: "Bob accepted fix" });
  feed(w.core, [memberEv(w.team, w.alex, w.carol, "removed")]);
  await settle(w.core);
  feed(w.core, [bobEdit]); // child first: waits for its parent
  w.idx.flushAll();
  expect(w.idx.db.card(w.card.id)?.title).toBe("root");
  feed(w.core, [label]); // the parent arrives, rejected (Carol was removed)
  expect(statusOf(w.core, label.id)).toBe("rejected");
  await Bun.sleep(20);
  w.idx.flushAll();
  expect(w.idx.db.card(w.card.id)?.title).toBe("Bob accepted fix");
  expect(w.idx.foldCardNow(CH, w.card.id)?.state.title).toBe("Bob accepted fix");
});

const opEv = (id: string, origin: string, seq: number, handle: string, board: unknown, extra: Partial<OpEvent> = {}): OpEvent => ({
  id, origin, seq, ts: 1_000 + seq, author: { handle, node: origin }, thread: "a000000000000001:3", text: "op", board, h: `${origin.slice(0, 8)}${String(seq).padStart(8, "0")}`, ...extra,
});

test("Codex r4 M3: Bob edits on one machine, then corrects on his other (lower) machine naming the first: the correction wins", () => {
  const card: OpEvent = opEv("a000000000000001:3", "a000000000000001", 3, "bob", { v: 1, rev: 0, op: "card", board: "a000000000000001:2", title: "root", column: "todo" }, { thread: undefined });
  const ctx = { boards: new Map([["a000000000000001:2", { id: "a000000000000001:2", columns: [...DEFAULT_COLUMNS] }]]) };
  const first = opEv("ffffffffffffffff:1", "ffffffffffffffff", 1, "bob", { v: 1, rev: 1, op: "card", after: `${card.id}#${card.h}`, title: "first" });
  const corrected = opEv("2222222222222222:1", "2222222222222222", 1, "bob", { v: 1, rev: 2, op: "card", after: `${first.id}#${first.h}`, title: "corrected" });
  expect(foldCard(card, [corrected, first], ctx)?.title).toBe("corrected");
});

test("Codex r4 LOW: hidden ops under forged handles from one origin add no rank to that origin's next op", () => {
  const card: OpEvent = opEv("a000000000000001:3", "a000000000000001", 3, "bob", { v: 1, rev: 0, op: "card", board: "a000000000000001:2", title: "root", column: "todo" }, { thread: undefined });
  const ctx = { boards: new Map([["a000000000000001:2", { id: "a000000000000001:2", columns: [...DEFAULT_COLUMNS] }]]) };
  const m = "cccccccccccccccc";
  const f1 = opEv(`${m}:1`, m, 1, "alice", { v: 1, rev: 1, op: "card", after: `${card.id}#${card.h}`, labels: ["x"] }, { hidden: true });
  const f2 = opEv(`${m}:2`, m, 2, "zoe", { v: 1, rev: 2, op: "card", after: `${f1.id}#${f1.h}`, labels: ["y"] }, { hidden: true });
  const last = opEv(`${m}:3`, m, 3, "mallory", { v: 1, rev: 3, op: "card", after: `${f2.id}#${f2.h}`, title: "mallory" });
  const honest = opEv("dddddddddddddddd:1", "dddddddddddddddd", 1, "kira", { v: 1, rev: 1, op: "card", after: `${card.id}#${card.h}`, title: "kira" });
  const s = foldCard(card, [f1, f2, last, honest], ctx);
  expect(s?.timeline.find((t) => t.id === last.id)?.effective_rev).toBe(1); // no rank from the forged-handle chain
  expect(s?.title).toBe("kira"); // equal rank: origin order (dddd… > cccc…)
});

test("D8 (Opus r5): two members, one in a restricted channel where Carol worked offline, the other not: after her removal both keep her board ops and show the same board", async () => {
  const alex = tnode("alex"), carol = tnode("carol"), dave = tnode("dave"), bob = tnode("bob"), kira = tnode("kira"), ann = tnode("ann"), ben = tnode("ben");
  const { team, create } = createTeam(alex);
  const roster: Event[] = [create];
  for (const n of [carol, dave, bob, kira, ann, ben]) roster.push(memberEv(team, alex, n, "member"), nodeEv(team, alex, n));
  roster.push(ev(team, alex, "channel.upsert", { name: "secret", members: ["alex", "carol", "ann"] }));
  roster.push(ev(team, alex, "channel.upsert", { name: CH, project: true }));
  const post = (n: TNode, body: Record<string, unknown>, channel = CH) => ev(team, n, "msg.post", body as BodyOf<"msg.post">, { channel });
  const root = post(alex, { text: "project", board: { v: 1, rev: 0, op: "project", name: "Web", prefix: "WEB" } });
  const board = post(alex, { text: "board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } });
  const card = post(alex, { text: "card", board: { v: 1, rev: 0, op: "card", board: board.id, title: "root", column: "todo", n: 1 } });
  const op = (n: TNode, parent: Event, rev: number, fields: Record<string, unknown>) =>
    post(n, { text: "op", thread: card.id, board: { v: 1, rev, op: "card", after: ref(parent), ...fields } });
  const secret = Array.from({ length: 1_000 }, (_, i) => post(carol, { text: `s${i}` }, "secret"));
  const L1 = op(carol, card, 1, { labels: ["carol-1"] });
  const [hi, lo] = bob.keys.nodeId > kira.keys.nodeId ? [bob, kira] : [kira, bob];
  const K = op(hi, L1, 2, { title: `${hi.handle}: stale (saw only L1)` });
  const D = op(dave, L1, 2, { column: "doing" });
  const L2 = op(carol, D, 3, { labels: ["carol-2"] });
  const X = op(lo, L2, 4, { title: `${lo.handle}: final`, column: "review" });
  const all = [...roster, root, board, card, ...secret, L1, K, D, L2, X];
  const removal = memberEv(team, alex, carol, "removed");
  const boards: string[] = [];
  for (const [self, inSecret] of [[ann, true], [ben, false]] as const) {
    const core = makeCore(self, team, cleanups);
    const idx = new ProjectsIndex(core, createLogger({}));
    core.onPostChange = (e, c) => idx.onPost(e, c);
    core.onRosterChange = () => idx.rosterChanged();
    feed(core, all.map((e) => (!inSecret && e.channel === "secret" ? (stubOf(e) as unknown as Event) : e)));
    feed(core, [removal]);
    await settle(core);
    await Bun.sleep(30);
    idx.flushAll();
    expect([statusOf(core, L1.id), statusOf(core, L2.id)]).toEqual(["rejected", "rejected"]);
    const c = idx.db.card(card.id);
    const fresh = idx.foldCardNow(CH, card.id)?.state;
    expect(`${fresh?.title}/${fresh?.column}`).toBe(`${c?.title}/${c?.column}`);
    boards.push(`${c?.title}/${c?.column}/${c?.labels.join(",")}`);
  }
  expect(boards[0]).toBe(boards[1]);
  expect(boards[0]).toBe(`${lo.handle}: final/review/`);
}, 120_000);
