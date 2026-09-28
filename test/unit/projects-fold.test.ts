// WALKIE-PROJECTS-1: the board fold is a pure function of the set of posts (any arrival order gives the same board),
// per-field last-writer-wins over ranks from causal parents (`after`), with per-op permissions; plus keys, meters,
// positions, agent association and the CSV export's formula guard.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assignKeys, boardMeter, foldBoards, foldCard, foldProject, refOf, sumMeters, type CardContext, type FoldEnv, type OpEvent,
} from "../../src/protocol/projects/fold.ts";
import { associate, keysIn } from "../../src/protocol/projects/assoc.ts";
import { keyBetween, keysAfter } from "../../src/protocol/projects/position.ts";
import { csvCell } from "../../src/protocol/projects/format.ts";
import { BoardOpSchema, DEFAULT_COLUMNS, type Column } from "../../src/protocol/projects/schema.ts";
import type { Role } from "../../src/protocol/schemas.ts";

// ---- a tiny deterministic world -----------------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(xs: readonly T[], r: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

const NODES = { alex: "a000000000000001", kira: "b000000000000002", arvid: "c000000000000003" } as const;
type Who = keyof typeof NODES;
const ROLES: Record<Who, Role> = { alex: "owner", kira: "member", arvid: "member" };
const seqs: Record<string, number> = {};
let clock = 1_700_000_000_000;
const hashOf = (id: string) => createHash("sha256").update(`sig-${id}`).digest("hex").slice(0, 16);

function post(who: Who, board: unknown, opts: { thread?: string; agent?: string; ts?: number; text?: string; hidden?: boolean; origin?: string } = {}): OpEvent {
  const origin = opts.origin ?? NODES[who];
  const seq = (seqs[origin] = (seqs[origin] ?? 0) + 1);
  clock += 1000;
  const id = `${origin}:${seq}`;
  return {
    id, origin, seq, ts: opts.ts ?? clock, h: hashOf(id),
    author: { handle: who, node: origin, ...(opts.agent ? { agent: opts.agent } : {}) },
    ...(opts.thread ? { thread: opts.thread } : {}), text: opts.text ?? "op", ...(board !== undefined ? { board } : {}),
    ...(opts.hidden ? { hidden: true } : {}),
  };
}

/** An op on `root`'s entity that names `parent` (the head its author saw) as its parent. */
function op(who: Who, root: OpEvent, parent: OpEvent, fields: Record<string, unknown>, opts: { agent?: string; ts?: number; hidden?: boolean; origin?: string } = {}): OpEvent {
  const kind = (root.board as { op: string }).op;
  return post(who, { v: 1, rev: 1, op: kind, after: refOf(parent), ...fields }, { thread: root.id, ...opts });
}

const env: FoldEnv = { creator: "alex", roleOf: (ev) => ROLES[ev.author.handle as Who] ?? null };

/** Everything the fold derives, as plain data (for equality across permutations). */
function foldAll(posts: readonly OpEvent[]) {
  const project = foldProject(posts, env);
  const boards = foldBoards(posts, env, project);
  const ctx: CardContext = { boards: new Map(boards.map((b) => [b.id, b])) };
  const byThread = new Map<string, OpEvent[]>();
  for (const p of posts) if (p.thread) byThread.set(p.thread, [...(byThread.get(p.thread) ?? []), p]);
  const cards = posts.filter((p) => !p.thread).map((root) => foldCard(root, byThread.get(root.id) ?? [], ctx)).filter((c) => c !== null)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const keys = assignKeys(cards.map((c) => ({ id: c.id, ts: c.created_at, n: c.n_proposed })));
  return { project, boards, cards, keys: [...keys.entries()].sort() };
}

function scenario(seed: number): OpEvent[] {
  const r = rng(seed);
  const posts: OpEvent[] = [];
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const root = post("alex", { v: 1, rev: 0, op: "project", name: "Web", prefix: "WEB", folder: "Acme" });
  posts.push(root);
  const b1 = post("alex", { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS });
  const b2 = post("kira", { v: 1, rev: 0, op: "board", name: "Bugs", columns: DEFAULT_COLUMNS.slice(0, 3) });
  posts.push(b1, b2);
  const who: Who[] = ["alex", "kira", "arvid"];
  // Ops per entity so far: a new op names a random one as its parent (authors that have seen different heads).
  const known = new Map<string, OpEvent[]>([[root.id, [root]], [b1.id, [b1]], [b2.id, [b2]]]);
  const cards: OpEvent[] = [];
  for (let i = 0; i < 6; i++) {
    const w = who[i % 3] as Who;
    const c = post(w, { v: 1, rev: 0, op: "card", board: i % 2 ? b2.id : b1.id, title: `card ${i}`, column: "todo", n: 1 + (i % 4) }, i === 4 ? { agent: "cc-1" } : {});
    cards.push(c);
    known.set(c.id, [c]);
    posts.push(c);
  }
  const add = (entity: OpEvent, ev: OpEvent) => { known.set(entity.id, [...(known.get(entity.id) ?? []), ev]); posts.push(ev); };
  for (let i = 0; i < 60; i++) {
    const w = pick(who);
    const agent = r() < 0.3 ? "cc-" + Math.floor(r() * 3) : undefined;
    const ts = r() < 0.2 ? clock - Math.floor(r() * 50_000) : undefined; // some backdated
    const x = r();
    if (x < 0.1) {
      const parent = r() < 0.05 ? { ...root, h: "0000000000000000" } : pick(known.get(root.id) ?? [root]); // a wrong hash: waits forever
      add(root, op(w, root, parent, { name: `Web ${i}` }, { ...(agent ? { agent } : {}), ...(ts ? { ts } : {}) }));
    } else if (x < 0.15) {
      const b = r() < 0.5 ? b1 : b2;
      add(b, op(w, b, pick(known.get(b.id) ?? [b]), { name: `B ${i}` }));
    } else if (x < 0.25) {
      posts.push(post(w, undefined, { thread: pick(cards).id, text: `comment ${i}` }));
    } else {
      const card = pick(cards);
      const fields = pick([
        { column: pick(["todo", "doing", "review", "done", "backlog"]), pos: keyBetween(null, null) },
        { assignee: r() < 0.5 ? `@${pick(who)}` : `@kira/kiras-mbp/cc-${Math.floor(r() * 3)}` },
        { title: `renamed ${i}` },
        { state: r() < 0.5 ? "deleted" : "open" },
        { blocked: r() < 0.5, blocked_reason: r() < 0.5 ? "waiting on API" : null },
        { labels: ["bug", `l${i}`] },
        { board: r() < 0.5 ? b1.id : b2.id, column: "todo" },
      ] as Record<string, unknown>[]);
      const noParent = r() < 0.05;
      const ev = noParent
        ? post(w, { v: 1, rev: 1, op: "card", ...fields }, { thread: card.id, ...(agent ? { agent } : {}) })
        : op(w, card, pick(known.get(card.id) ?? [card]), fields, { ...(agent ? { agent } : {}), ...(ts ? { ts } : {}), ...(r() < 0.1 ? { hidden: true } : {}) });
      add(card, ev);
    }
  }
  return posts;
}

describe("convergence", () => {
  test("any permutation of the same posts folds to the same project, boards, cards and keys (property, 40 worlds x 25 orders)", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const posts = scenario(seed);
      const want = JSON.stringify(foldAll(posts));
      const r = rng(seed * 7919);
      for (let k = 0; k < 25; k++) expect(JSON.stringify(foldAll(shuffle(posts, r)))).toBe(want);
    }
  }, 60_000);

  test("a prefix of the posts (a replica that is behind) folds without throwing, and catching up gives the full result", () => {
    const posts = scenario(99);
    const full = JSON.stringify(foldAll(posts));
    const r = rng(5);
    const mixed = shuffle(posts, r);
    for (let n = 0; n <= mixed.length; n += 7) foldAll(mixed.slice(0, n));
    expect(JSON.stringify(foldAll(mixed))).toBe(full);
  });
});

describe("ranks from causal parents", () => {
  const board = post("alex", { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS });
  const ctx: CardContext = { boards: new Map([[board.id, { id: board.id, columns: DEFAULT_COLUMNS as Column[] }]]) };
  const card = post("kira", { v: 1, rev: 0, op: "card", board: board.id, title: "T", column: "todo" });

  test("an op that saw another out-ranks it; fields written by different ops merge", () => {
    const b = op("alex", card, card, { title: "first", labels: ["x"] });
    const a = op("kira", card, b, { title: "second" });
    const s = foldCard(card, [a, b], ctx);
    expect(s?.title).toBe("second");
    expect(s?.labels).toEqual(["x"]);
    expect(s?.head).toBe(refOf(a));
  });

  test("resurrection is impossible: backdated or future-dated ops arriving later never lift an old op (round-2 Codex M2, Opus M1)", () => {
    const evil = op("arvid", card, card, { title: "pinned" }, { ts: card.ts + 999_000_000 }); // far future
    expect(foldCard(card, [evil], ctx)?.title).toBe("pinned");
    const fix = op("kira", card, evil, { title: "fixed" });
    expect(foldCard(card, [evil, fix], ctx)?.title).toBe("fixed");
    const back1 = op("arvid", card, card, { labels: ["a"] }, { ts: card.ts + 1 });
    const back2 = op("arvid", card, back1, { body: "b" }, { ts: card.ts + 2 });
    const s = foldCard(card, [back2, fix, back1, evil], ctx);
    expect(s?.title).toBe("fixed");
    expect(s?.body).toBe("b");
  });

  test("an accepted op built on one that was later hidden keeps its rank (round-3 Opus HIGH, D1 / R3-F)", () => {
    // Alex labels; Carol (arvid here) edits on top; Bob (kira) builds on Carol's; then Carol's op is hidden (her removal
    // reached the chain after the authority caught up). Bob's accepted edit must stand, everywhere.
    const a = op("alex", card, card, { title: "alex early" });
    const carol = op("arvid", card, a, { labels: ["c"] });
    const bob = op("kira", card, carol, { title: "bob's real fix", column: "doing" });
    const hiddenCarol = { ...carol, hidden: true };
    const s = foldCard(card, [a, hiddenCarol, bob], ctx);
    expect(s?.title).toBe("bob's real fix");
    expect(s?.column).toBe("doing");
    expect(s?.labels).toEqual([]); // the hidden op applies nothing
    expect(s?.timeline.some((t) => t.ignored === "waiting_for_parent")).toBe(false);
    const next = op("alex", card, bob, { estimate: 3 });
    expect(foldCard(card, [next, bob, hiddenCarol, a], ctx)).toMatchObject({ title: "bob's real fix", estimate: 3 });
    // A parent never received at all still waits.
    expect(foldCard(card, [a, bob], ctx)?.title).toBe("alex early");
  });

  test("one person, two machines: the correction that saw the earlier edit wins, whichever machine sorts first (round-4 Opus HIGH, P1/D4)", () => {
    for (const [first, second] of [["ffffffffffffff01", "0000000000000002"], ["0000000000000002", "ffffffffffffff01"]] as const) {
      const a = op("kira", card, card, { title: "draft" }, { origin: first });
      const b = op("kira", card, a, { title: "fixed" }, { origin: second });
      expect(foldCard(card, [b, a], ctx)?.title).toBe("fixed");
      const c = op("kira", card, b, { title: "fixed again" }, { origin: second }); // same machine follow-up: rank +0, seq orders
      expect(foldCard(card, [c, a, b], ctx)?.title).toBe("fixed again");
    }
  });

  test("P6 (Opus r5): an op naming a hidden parent with an inflated signed rev gets its rank from the chain only", () => {
    const L = op("arvid", card, card, { labels: ["c"] }, { hidden: true });
    const honestOps: OpEvent[] = [];
    let head: OpEvent = card;
    for (let i = 1; i <= 5; i++) { head = op(i % 2 ? "kira" : "alex", card, head, { title: `honest ${i}` }); honestOps.push(head); }
    const X = post("arvid", { v: 1, rev: 1_000_000_000, op: "card", after: refOf(L), title: "pwned", column: "done" }, { thread: card.id });
    const s = foldCard(card, [L, ...honestOps, X], ctx);
    expect(s?.title).toBe("honest 5"); // X ranks from its chain (L's rank, +0 on L's own machine) whatever it claims
    expect(s?.timeline.find((t) => t.id === X.id)?.effective_rev).toBe(1);
  });

  test("P7 (Opus r5): an op naming a parent with a wrong signature hash never applies, on any replica", () => {
    const L = op("arvid", card, card, { labels: ["c"] }, { hidden: true });
    const k = op("kira", card, L, { title: "kira" });
    const X = post("alex", { v: 1, rev: 1_000_000_000, op: "card", after: `${L.id}#0000000000000000`, title: "forged-parent" }, { thread: card.id });
    for (const order of [[L, k, X], [X, k, L], [k, X, L]]) {
      const s = foldCard(card, order, ctx);
      expect(s?.title).toBe("kira");
      expect(s?.timeline.find((t) => t.id === X.id)?.ignored).toBe("waiting_for_parent");
    }
  });

  test("P8 (Opus r5): honest authors, one member's ops later hidden: every arrival order folds the same (600 worlds x 10 orders)", () => {
    const r = rng(777);
    const who: Who[] = ["kira", "alex", "arvid"];
    for (let trial = 0; trial < 600; trial++) {
      const t: OpEvent[] = [];
      for (let i = 0; i < 20; i++) {
        const lag = Math.floor(r() * 3);
        const view = t.slice(0, Math.max(0, t.length - lag)).map((e) => (i >= 12 && e.author.handle === "arvid" ? { ...e, hidden: true } : e));
        const s = foldCard(card, view, ctx);
        const w = i < 12 && i % 2 === 0 ? "arvid" : who[Math.floor(r() * 2)] as Who;
        const fields = r() < 0.5 ? { title: `${w}-${i}` } : { column: ["todo", "doing", "done"][Math.floor(r() * 3)] };
        t.push(post(w, { v: 1, rev: (s?.rev ?? 0) + 1, op: "card", after: s?.head, ...fields }, { thread: card.id }));
      }
      const hid = t.map((e) => (e.author.handle === "arvid" ? { ...e, hidden: true } : e));
      const want = JSON.stringify(foldCard(card, hid, ctx));
      for (let p = 0; p < 10; p++) expect(JSON.stringify(foldCard(card, shuffle(hid, r), ctx))).toBe(want);
    }
  }, 120_000);

  test("padding with one's own follow-ups gains no rank against a concurrent edit (round-3 LOW)", () => {
    const one = op("arvid", card, card, { title: "arvid" });
    let head = one;
    const pad: OpEvent[] = [one];
    for (let i = 0; i < 20; i++) { head = op("arvid", card, head, { body: `pad ${i}` }); pad.push(head); }
    const kira = op("kira", card, card, { title: "kira" });
    // Whatever the tie-break says for one op, twenty own follow-ups say the same.
    expect(foldCard(card, [...pad, kira], ctx)?.title).toBe(foldCard(card, [one, kira], ctx)?.title);
    expect(foldCard(card, [...pad, kira], ctx)?.rev).toBe(1);
  });

  test("a chain of one member's own ops doesn't pin a field: the next op that saw it wins", () => {
    let head = card;
    const chain: OpEvent[] = [];
    for (let i = 0; i < 20; i++) { head = op("arvid", card, head, { title: `spam ${i}` }); chain.push(head); }
    expect(foldCard(card, chain, ctx)?.title).toBe("spam 19");
    const fix = op("kira", card, head, { title: "fixed" });
    expect(foldCard(card, [...chain, fix], ctx)?.title).toBe("fixed");
  });

  test("an op naming a parent that hasn't arrived (or a wrong signature hash) waits and changes nothing", () => {
    const parent = op("alex", card, card, { title: "p" });
    const child = op("kira", card, parent, { title: "child" });
    const s = foldCard(card, [child], ctx);
    expect(s?.title).toBe("T");
    expect(s?.timeline.find((t) => t.id === child.id)?.ignored).toBe("waiting_for_parent");
    expect(foldCard(card, [child, parent], ctx)?.title).toBe("child");
    const forged = op("kira", card, { ...parent, h: "ffffffffffffffff" }, { title: "forged" });
    expect(foldCard(card, [parent, forged], ctx)?.title).toBe("p");
  });

  test("equal ranks break by origin, then seq as a number (:10 after :9)", () => {
    const ops: OpEvent[] = [];
    for (let i = 0; i < 10; i++) ops.push(op("kira", card, card, { title: `t${i}` }, { ts: card.ts + 5 }));
    expect(ops.at(-1)?.seq).toBeGreaterThan(9);
    expect(foldCard(card, [...ops].reverse(), ctx)?.title).toBe("t9");
  });

  test("board, column and position move together as one register", () => {
    const m1 = op("kira", card, card, { column: "doing", pos: "m" });
    const m2 = op("alex", card, m1, { column: "review" });
    const s = foldCard(card, [m1, m2], ctx);
    expect(s?.column).toBe("review");
    expect(s?.pos).toBe("m"); // m2 carried no pos: the register keeps m1's
  });
});

describe("permissions", () => {
  const root = post("alex", { v: 1, rev: 0, op: "project", name: "P", prefix: "PP" });
  const board = post("alex", { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS });
  const ctx: CardContext = { boards: new Map([[board.id, { id: board.id, columns: DEFAULT_COLUMNS as Column[] }]]) };

  test("only a person deletes or restores a card", () => {
    const card = post("kira", { v: 1, rev: 0, op: "card", board: board.id, title: "T", column: "todo" });
    const byAgent = op("kira", card, card, { state: "deleted" }, { agent: "cc-1" });
    const s = foldCard(card, [byAgent], ctx);
    expect(s?.state).toBe("open");
    expect(s?.timeline.find((t) => t.id === byAgent.id)?.ignored).toBe("person_only");
    const byPerson = op("kira", card, card, { state: "deleted" });
    expect(foldCard(card, [byPerson], ctx)?.state).toBe("deleted");
  });

  test("an agent can't move or reassign a person's card, but can an agent's", () => {
    const mine = post("kira", { v: 1, rev: 0, op: "card", board: board.id, title: "T", column: "todo", assignee: "@kira" });
    expect(foldCard(mine, [op("arvid", mine, mine, { column: "doing" }, { agent: "cc-9" })], ctx)?.column).toBe("todo");
    const agents = post("kira", { v: 1, rev: 0, op: "card", board: board.id, title: "T", column: "todo", assignee: "@kira/kiras-mbp/cc-2" });
    expect(foldCard(agents, [op("arvid", agents, agents, { column: "doing" }, { agent: "cc-9" })], ctx)?.column).toBe("doing");
  });

  test("a removed creator is no admin", () => {
    const kiras = post("kira", { v: 1, rev: 0, op: "project", name: "K", prefix: "KK" });
    const rename = op("kira", kiras, kiras, { name: "K2" });
    expect(foldProject([kiras, rename], { creator: "kira", roleOf: () => "removed" })?.name).toBe("K");
  });

  test("the project belongs to the channel's creator; a second root or a non-admin's settings change is ignored", () => {
    const other = post("kira", { v: 1, rev: 0, op: "project", name: "Hijack", prefix: "HJ" }, { ts: root.ts - 10_000 });
    const byMember = op("kira", root, root, { name: "Renamed" });
    const byAgent = op("alex", root, root, { name: "Agent" }, { agent: "cc-1" });
    const p = foldProject([other, root, byMember, byAgent], env);
    expect(p?.id).toBe(root.id);
    expect(p?.name).toBe("P");
    expect(p?.timeline.filter((t) => t.ignored === "not_admin").length).toBe(2);
    expect(foldProject([root, op("alex", root, root, { name: "Owner" })], env)?.name).toBe("Owner");
    // A member who created the channel is the project's admin.
    const kiras = post("kira", { v: 1, rev: 0, op: "project", name: "K", prefix: "KK" });
    expect(foldProject([kiras, op("kira", kiras, kiras, { name: "K2" })], { ...env, creator: "kira" })?.name).toBe("K2");
  });

  test("an agent creates a project and boards for its person (fold 8); its settings and board changes are ignored", () => {
    const byAgent = post("alex", { v: 1, rev: 0, op: "project", name: "Agent", prefix: "AG" }, { agent: "cc-1" });
    const p = foldProject([byAgent, op("alex", byAgent, byAgent, { name: "Agent 2" }, { agent: "cc-1" })], env);
    expect([p?.id, p?.creator, p?.name]).toEqual([byAgent.id, "alex", "Agent"]);
    expect(p?.timeline.map((t) => t.ignored ?? "ok")).toEqual(["ok", "not_admin"]);
    expect(foldProject([byAgent, op("alex", byAgent, byAgent, { name: "Person" })], env)?.name).toBe("Person");
    // Only the channel creator's (the person or the person's agent): another member's agent can't take it.
    const kirasAgent = post("kira", { v: 1, rev: 0, op: "project", name: "Hijack", prefix: "HJ" }, { agent: "cc-2", ts: byAgent.ts - 10_000 });
    expect(foldProject([kirasAgent, byAgent], env)?.id).toBe(byAgent.id);
    // Any member's agent can add a board; changing it stays a person's (its creator's person, an owner, the project creator).
    const agentBoard = post("kira", { v: 1, rev: 0, op: "board", name: "Agent board", columns: DEFAULT_COLUMNS }, { agent: "cc-2" });
    const renamedByAgent = op("kira", agentBoard, agentBoard, { name: "by agent" }, { agent: "cc-2" });
    const b1 = foldBoards([root, board, agentBoard, renamedByAgent], env, foldProject([root], env)).find((b) => b.id === agentBoard.id);
    expect([b1?.name, b1?.created_by.agent, b1?.timeline.at(-1)?.ignored]).toEqual(["Agent board", "cc-2", "not_admin"]);
    const renamedByKira = op("kira", agentBoard, agentBoard, { name: "by kira" });
    expect(foldBoards([root, agentBoard, renamedByKira], env, foldProject([root], env)).find((b) => b.id === agentBoard.id)?.name).toBe("by kira");
  });

  test("a card on a board the project doesn't have is not shown", () => {
    const stray = post("kira", { v: 1, rev: 0, op: "card", board: "f000000000000009:1", title: "T", column: "todo" });
    expect(foldCard(stray, [], ctx)).toBeNull();
  });

  test("the schema refuses malformed ops (a bad address, an overlong title, a rev past the cap, a bad parent)", () => {
    expect(BoardOpSchema.safeParse({ v: 1, rev: 1, op: "card", assignee: "kira" }).success).toBe(false);
    expect(BoardOpSchema.safeParse({ v: 1, rev: 1, op: "card", title: "x".repeat(201) }).success).toBe(false);
    expect(BoardOpSchema.safeParse({ v: 1, rev: 2_000_000_000, op: "card" }).success).toBe(false);
    expect(BoardOpSchema.safeParse({ v: 1, rev: 1, op: "card", after: "nope" }).success).toBe(false);
    expect(BoardOpSchema.safeParse({ v: 1, rev: 1, op: "board", columns: [{ id: "a", name: "A", role: "todo" }, { id: "a", name: "B", role: "done" }] }).success).toBe(false);
  });
});

describe("keys, meters, positions", () => {
  test("key collisions: the earliest create keeps its number, the other takes the lowest free number above its proposal", () => {
    const keys = assignKeys([
      { id: "x:2", ts: 20, n: 5 }, { id: "x:1", ts: 10, n: 5 }, { id: "x:3", ts: 30, n: 7 }, { id: "x:4", ts: 40, n: null },
    ]);
    expect(keys.get("x:1")).toBe(5);
    expect(keys.get("x:3")).toBe(7);
    expect(keys.get("x:2")).toBe(6);
    expect(keys.get("x:4")).toBe(1);
  });

  test("a collision loser keeps its number when ordinary cards are created after it (round-4 Codex M4)", () => {
    const a = { id: "a:1", ts: 10, n: 1 }, b = { id: "b:1", ts: 11, n: 1 };
    expect(assignKeys([a, b]).get("b:1")).toBe(2);
    const later = [a, b, { id: "c:1", ts: 20, n: 3 }, { id: "d:1", ts: 30, n: 4 }];
    const k = assignKeys(later);
    expect([k.get("a:1"), k.get("b:1"), k.get("c:1"), k.get("d:1")]).toEqual([1, 2, 3, 4]);
  });

  test("a proposal far past the card's position is renumbered: one card can't poison every later number (Codex HIGH 2)", () => {
    const keys = assignKeys([{ id: "x:1", ts: 10, n: 1 }, { id: "x:2", ts: 20, n: 1_000_000 }, { id: "x:3", ts: 30, n: 3 }]);
    expect(keys.get("x:2")).toBe(2);
    expect(Math.max(...keys.values())).toBeLessThan(200);
  });

  test("a backdated card inserted into create order renumbers nothing but a collision (round-2 Opus M2)", () => {
    const base = Array.from({ length: 30 }, (_, i) => ({ id: `b:${i + 1}`, ts: 100 + i, n: i + 1 }));
    const before = assignKeys(base);
    const edge = assignKeys([...base, { id: "e:1", ts: 1, n: 101 }]); // earliest, at the edge of the slack
    for (const c of base) expect(edge.get(c.id)).toBe(before.get(c.id));
    expect(edge.get("e:1")).toBe(101);
    const thief = assignKeys([...base, { id: "t:1", ts: 1, n: 7 }]); // backdated collision: only b:7 moves
    expect(thief.get("t:1")).toBe(7);
    expect([...base].filter((c) => thief.get(c.id) !== before.get(c.id)).map((c) => c.id)).toEqual(["b:7"]);
  });

  test("meter: cancelled and deleted cards don't count; archived done stays done; points default 1; rollup sums", () => {
    const cols: Column[] = [...DEFAULT_COLUMNS, { id: "wontfix", name: "Won't fix", role: "cancelled" }];
    const cards = [
      { column: "done", state: "open" as const, estimate: 3 },
      { column: "done", state: "archived" as const, estimate: null },
      { column: "doing", state: "open" as const, estimate: 5 },
      { column: "wontfix", state: "open" as const, estimate: 8 },
      { column: "todo", state: "deleted" as const, estimate: 2 },
    ];
    const count = boardMeter(cards, cols, "count");
    expect([count.done, count.counted]).toEqual([2, 3]);
    const points = boardMeter(cards, cols, "points");
    expect([points.done, points.counted]).toEqual([4, 9]);
    expect(points.by_role.cancelled).toBe(8);
    const sum = sumMeters([count, boardMeter([{ column: "todo", state: "open", estimate: null }], cols, "count")], "count");
    expect([sum.done, sum.counted]).toEqual([2, 4]);
  });

  test("positions: a key between any two others sorts between them, over many inserts at the same spot", () => {
    const r = rng(3);
    let keys = keysAfter(null, 5);
    for (let i = 0; i < 400; i++) {
      const at = Math.floor(r() * (keys.length + 1));
      const k = keyBetween(keys[at - 1] ?? null, keys[at] ?? null);
      if (at > 0) expect(k > (keys[at - 1] as string)).toBe(true);
      if (at < keys.length) expect(k < (keys[at] as string)).toBe(true);
      expect(/^[0-9a-z]*[1-9a-z]$/.test(k)).toBe(true);
      keys = [...keys.slice(0, at), k, ...keys.slice(at)];
    }
    expect([...keys].sort()).toEqual(keys);
  });
});

describe("agent association", () => {
  const projects = [
    { channel: "p-00000001", prefix: "WEB", state: "active", paths: [{ path: "~/work/site" }, { repo: "site" }] },
    { channel: "p-00000002", prefix: "API", state: "active", paths: [{ path: "~/work" }] },
    { channel: "p-00000003", prefix: "OLD", state: "archived", paths: [{ path: "~/work/site/old" }] },
  ];
  const has = (ch: string, n: number) => ch === "p-00000001" && n === 12;
  test("a card key in the task or branch wins; then the longest path prefix; then the repository", () => {
    expect(associate({ task: "WEB-12" }, projects, has)).toEqual({ channel: "p-00000001", key: "WEB-12", via: "key" });
    expect(associate({ branch: "feat/web-12-login" }, projects, has)).toEqual({ channel: "p-00000001", key: "WEB-12", via: "key" });
    expect(associate({ task: "API-99" }, projects, has)).toEqual({ channel: "p-00000002", via: "key" });
    expect(associate({ cwd: "~/work/site/src" }, projects, has)?.channel).toBe("p-00000001");
    expect(associate({ cwd: "~/work/site/old/x" }, projects, has)?.channel).toBe("p-00000001"); // archived projects don't match
    expect(associate({ cwd: "~/work/sitemap" }, projects, has)?.channel).toBe("p-00000002");
    expect(associate({ repo: "Site" }, projects, has)?.channel).toBe("p-00000001");
    expect(associate({ repo: "other" }, projects, has)).toBeNull();
    expect(keysIn("merge FIX-1 then abc-2")).toEqual([{ prefix: "FIX", n: 1, key: "FIX-1" }, { prefix: "ABC", n: 2, key: "ABC-2" }]);
  });
});

test("CSV cells never start a formula and quote what needs quoting", () => {
  expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
  expect(csvCell("-1+2")).toBe("'-1+2");
  expect(csvCell("a,b")).toBe('"a,b"');
  expect(csvCell(["a", "b"])).toBe("a;b");
  expect(csvCell(null)).toBe("");
});
