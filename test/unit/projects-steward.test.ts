// FO-6 board steward: each rule from fixtures, the person-move pin, the override and grace holds, the per-run cap,
// the matchers, and the fold: the steward's move of a person's card applies under fold 9 and is an ordinary (ignored)
// op on a pre.6 fold; a project op carrying `steward` parses on a pre.6 schema, which keeps its other fields.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { foldCard, foldProject, refOf, type OpEvent } from "../../src/protocol/projects/fold.ts";
import { CardOp, DEFAULT_COLUMNS, ProjectOp, type TimelineEntry } from "../../src/protocol/projects/schema.ts";
import {
  AGENT_GRACE_MS, isStewardAuthor, PIN_MS, planSteward, STEWARD_AGENT,
  type BranchEvidence, type CardEvidence, type LiveAgent, type StewardCard, type StewardInput,
} from "../../src/protocol/projects/steward.ts";
import { cardNamedIn, commentSignal, indexCards, laneCodes, linearKeyOf } from "../../src/protocol/projects/steward-match.ts";
import { blockingPeer, STEWARD_MIN_VERSION, versionAtLeast } from "../../src/daemon/projects/steward-run.ts";

const H = 3_600_000;
const NOW = 1_800_000_000_000;
const BOARD = "a000000000000001:2";

let n = 0;
function card(title: string, column: string, extra: Partial<StewardCard> = {}): StewardCard {
  n++;
  return {
    id: `a000000000000001:${100 + n}`, key: `WR-${n}`, ref: `WR-${n}-0000000${n % 10}`, title, board: BOARD, column, state: "open",
    assignee: null, blocked: false, blocked_reason: null, created_at: NOW - 48 * H, created_by: { handle: "alex", node: "a000000000000001", agent: "lead" },
    updated_at: NOW - 48 * H, ...extra,
  };
}
// kira and alex are owners in these fixtures (their agents' word counts on any card); bob is a member.
const builder = (title: string): LiveAgent => ({ address: "@kira/kiras-mbp/codex-1", handle: "kira", agent: "codex-1", text: title, auditor: false });
const auditor = (title: string): LiveAgent => ({ address: "@alex/atlas/cc-2", handle: "alex", agent: "cc-2", text: title, auditor: true });
const bobAgent = (title: string, auditorToo = false): LiveAgent => ({ address: "@bob/bobs-mbp/bob-x", handle: "bob", agent: "bob-x", text: title, auditor: auditorToo });
const branch = (name: string, own: number, at: number | null, merged: string | null = null): BranchEvidence => ({ repo: "/r", branch: name, own_commits: own, last_commit_at: at, merged_into: merged });
const cmt = (text: string, ts: number, agent = "cc-orch", handle = "alex"): TimelineEntry => ({ id: `c${ts}${handle}`, ts, author: { handle, node: "n", agent }, kind: "comment", text });
const move = (column: string, ts: number, agent?: string): TimelineEntry => ({
  id: `m${ts}`, ts, author: { handle: "alex", node: "n", ...(agent ? { agent } : {}) }, kind: "op", changes: { column, pos: "i" },
});

function input(cards: StewardCard[], ev: Record<string, Partial<CardEvidence>>, extra: Partial<StewardInput> = {}): StewardInput {
  const evidence = new Map<string, CardEvidence>();
  for (const c of cards) evidence.set(c.id, { agents: [], branches: [], linear: null, timeline: [], ...(ev[c.id] ?? {}) });
  return {
    now: NOW, prefix: "WR", steward: "on", boards: [{ id: BOARD, columns: [...DEFAULT_COLUMNS] }], cards, evidence, staleHours: 24,
    owners: ["alex", "kira"], agentsCanClose: true, ...extra,
  };
}

describe("matchers", () => {
  test("lane codes come from the title's leading code; issue keys and plain words are not codes", () => {
    expect(laneCodes("[ALE-5369] MERGE-6H-a: money chain")).toEqual(["merge-6h-a"]);
    expect(laneCodes("FO-6 BOARD-STEWARD: orchestrator moves cards")).toEqual(["fo-6"]);
    expect(laneCodes("[ALE-5267] WALKIE-SEATS-1: start agents")).toEqual(["walkie-seats-1", "seats-1"]);
    expect(laneCodes("[ALE-5106] ALE-5096: canonicalize")).toEqual([]);
    expect(laneCodes("W1A: Build unified platform shell")).toEqual([]);
    expect(laneCodes("v0.2.0-pre.5 hotfix")).toEqual([]);
    expect(linearKeyOf("[ALE-5156] BACKCHANNEL-1: plan")).toBe("ALE-5156");
    expect(linearKeyOf("BACKCHANNEL-1 [ALE-5156]")).toBeNull();
  });

  test("a text names a card by reference, by key, else by the longest matching code", () => {
    const a = { id: "1", key: "SP-1", short: "aaaaaaaa", title: "ONB-2: onboarding" };
    const b = { id: "2", key: "SP-2", short: "bbbbbbbb", title: "ONB-2-F1: onboarding fixes" };
    const idx = indexCards("SP", [a, b]);
    expect(cardNamedIn("lane/onb-2-f1-cx2", idx)?.id).toBe("2");
    expect(cardNamedIn("lane/onb-2", idx)?.id).toBe("1");
    expect(cardNamedIn("Opus audit ONB-2", idx)?.id).toBe("1");
    expect(cardNamedIn("working on SP-2", idx)?.id).toBe("2");
    expect(cardNamedIn("see SP-9-aaaaaaaa", idx)?.id).toBe("1");
    expect(cardNamedIn("lane/onboarding-x", idx)).toBeNull();
    expect(cardNamedIn("xonb-2", idx)).toBeNull();
  });

  test("comment signals", () => {
    expect(commentSignal("Done: merged into release-pre5")).toBe("done");
    expect(commentSignal("not done yet, merged tomorrow")).not.toBe("done");
    expect(commentSignal("Codex r1: FAIL, 3 HIGH")).toBe("fail");
    expect(commentSignal("Built (4536c7c). Audits r1 running: Opus + Codex")).toBe("review");
    expect(commentSignal("clerk8: review placed - x-s1 on ATLAS")).toBe("review");
    expect(commentSignal("builder could not authenticate; OAuth session expired")).toBe("error");
    expect(commentSignal("Scope notes for the lane")).toBeNull();
  });
});

describe("rules", () => {
  test("doing: a live builder named by the lane code moves a todo card; an audit agent alone does not", () => {
    const c1 = card("FO-6 BOARD-STEWARD: steward", "todo");
    const c2 = card("POOL-REAL-1: team compute", "backlog");
    const p = planSteward(input([c1, c2], { [c1.id]: { agents: [builder("FO-6 board steward builder")] }, [c2.id]: { agents: [auditor("Opus audit POOL-REAL-1")] } }));
    expect(p.moves.map((m) => [m.key, m.rule, m.from, m.to])).toEqual([[c1.key, "doing", "todo", "doing"]]);
    expect(p.moves[0]?.evidence[0]).toContain("@kira/kiras-mbp/codex-1");
    expect(p.moves[0]?.comment).toContain("Board steward: moved");
  });

  test("doing: a builder on a review card (a fix round) moves it back to in progress", () => {
    const c = card("AP-PAYMENTS-1: payments", "review");
    const p = planSteward(input([c], { [c.id]: { agents: [builder("lane/ap-payments-1-f4")] } }));
    expect(p.moves.map((m) => [m.rule, m.to])).toEqual([["doing", "doing"]]);
  });

  test("review: own commits + no builder + a review request (or an audit agent)", () => {
    const asked = card("LOG-2: logs", "doing");
    const audited = card("LOG-3: logs", "doing");
    const building = card("LOG-4: logs", "doing");
    const noCommits = card("LOG-5: logs", "doing");
    const p = planSteward(input([asked, audited, building, noCommits], {
      [asked.id]: { branches: [branch("lane/log-2", 3, NOW - 2 * H)], timeline: [cmt("Built. Audits r1 running: Opus", NOW - 2 * H)] },
      [audited.id]: { branches: [branch("lane/log-3", 2, NOW - 3 * H)], agents: [auditor("Opus audit LOG-3")] },
      [building.id]: { branches: [branch("lane/log-4", 2, NOW - 3 * H)], agents: [builder("lane/log-4")], timeline: [cmt("review requested", NOW - H)] },
      [noCommits.id]: { branches: [branch("lane/log-5", 0, null)], timeline: [cmt("review requested", NOW - H)] },
    }));
    expect(p.moves.map((m) => [m.key, m.rule, m.to])).toEqual([[asked.key, "review", "review"], [audited.key, "review", "review"]]);
    // A review request followed by a FAIL verdict is a fix round, not a review.
    const failed = card("LOG-6: logs", "doing");
    const q = planSteward(input([failed], { [failed.id]: { branches: [branch("lane/log-6", 2, NOW - 3 * H)], timeline: [cmt("review placed", NOW - 3 * H), cmt("Opus r1: FAIL, 1 HIGH", NOW - 2 * H)] } }));
    expect(q.moves).toEqual([]);
  });

  test("done: merged own commits, Linear Done, or an explicit done comment; not with newer unmerged work; ambiguous with a builder", () => {
    const merged = card("SEC-1: headers", "review");
    const linear = card("[ALE-1] SEC-2: headers", "doing");
    const said = card("SEC-3: headers", "todo");
    const newer = card("SEC-4: headers", "review");
    const busy = card("[ALE-2] SEC-5: headers", "doing");
    const forked = card("SEC-6: headers", "review");
    const p = planSteward(input([merged, linear, said, newer, busy, forked], {
      [merged.id]: { branches: [branch("lane/sec-1", 4, NOW - 5 * H, "main")] },
      [linear.id]: { linear: { key: "ALE-1", state: "Done", state_type: "completed" } },
      [said.id]: { timeline: [cmt("Done: shipped in v0.2.0-pre.5", NOW - 2 * H)] },
      [newer.id]: { branches: [branch("lane/sec-4", 4, NOW - 9 * H, "main"), branch("lane/sec-4-f1", 2, NOW - 3 * H, null)] },
      [busy.id]: { linear: { key: "ALE-2", state: "Done", state_type: "completed" }, agents: [builder("lane/sec-5")] },
      // A fresh branch with no work of its own is an ancestor of main, but that is not merged work.
      [forked.id]: { branches: [branch("lane/sec-6", 0, null, null)] },
    }));
    expect(p.moves.map((m) => [m.key, m.rule, m.to])).toEqual([[merged.key, "done", "done"], [linear.key, "done", "done"], [said.key, "done", "done"]]);
    expect(p.moves[0]?.evidence[0]).toContain("merged into main");
    expect(p.moves[1]?.evidence[0]).toBe("Linear ALE-1 is Done");
    expect(p.ambiguous.map((a) => a.key)).toEqual([busy.key]);
  });

  test("stale: no agent, commits or activity for N hours -> todo with the owner pinged; the last error -> blocked; unknown commits -> nothing", () => {
    const quiet = card("DATA-1: rooms", "doing", { assignee: "@kira/kiras-mbp/codex-1" });
    const errored = card("DATA-2: rooms", "doing");
    const unknown = card("DATA-3: rooms", "doing");
    const recent = card("DATA-4: rooms", "doing");
    const p = planSteward(input([quiet, errored, unknown, recent], {
      [quiet.id]: { branches: [branch("lane/data-1", 2, NOW - 40 * H)] },
      [errored.id]: { timeline: [cmt("builder could not authenticate; OAuth session expired", NOW - 30 * H)] },
      [unknown.id]: { branches: null },
      [recent.id]: { branches: [branch("lane/data-4", 2, NOW - 3 * H)] },
    }));
    expect(p.moves.map((m) => [m.key, m.rule, m.to ?? null, m.blocked_reason ? "blocked" : null, m.ping])).toEqual([
      [quiet.key, "stale", "todo", null, ["kira"]],
      [errored.key, "stale", null, "blocked", ["alex"]],
    ]);
    expect(p.moves[0]?.comment).toContain("@kira: please check");
    expect(p.moves[1]?.blocked_reason).toContain("could not authenticate");
  });

  test("duplicates are flag-only in every case (round 3): same author or not, a comment, never an archive; done twins and person restores left alone", () => {
    const old = card("[ALE-7] SITE-2: landing", "todo");
    const dup = card("[ALE-7] SITE-2: landing page", "todo", { created_at: NOW - 10 * H });
    const p = planSteward(input([old, dup], {}));
    expect(p.moves.map((m) => [m.key, m.rule, m.to ?? null, m.blocked_reason ?? null, m.duplicate_of])).toEqual([[dup.key, "duplicate", null, null, old.ref]]);
    expect(p.moves[0]?.comment).toContain(`walkie task archive ${dup.key}`);
    // A member pre-creates a card carrying the import's Linear key: the real import is never archived, only linked.
    const planted = card("[ALE-8] anything", "todo", { created_at: NOW - 30 * H, created_by: { handle: "bob", node: "b", agent: "bob-x" } });
    const imported = card("[ALE-8] SITE-3: pricing", "todo", { created_at: NOW - 20 * H });
    const q = planSteward(input([planted, imported], {}));
    expect(q.moves.map((m) => [m.key, m.rule, m.to ?? null, m.duplicate_of])).toEqual([[imported.key, "duplicate", null, planted.ref]]);
    // ... and once linked, not again.
    const linked = planSteward(input([planted, imported], { [imported.id]: { timeline: [cmt(`Board steward: looks like a duplicate of ${planted.ref}`, NOW - H, STEWARD_AGENT)] } }));
    expect(linked.moves).toEqual([]);
    // Its older twin is done: no duplicate.
    const shipped = card("Deploy staging", "done");
    const again = card("Deploy staging", "todo", { created_at: NOW - 5 * H });
    expect(planSteward(input([shipped, again], {})).moves).toEqual([]);
    // A person restored the newer one: never flagged again.
    const a = card("Deploy prod", "todo");
    const b = card("Deploy prod", "todo", { created_at: NOW - 5 * H });
    const restore: TimelineEntry = { id: "r1", ts: NOW - 30 * H, author: { handle: "alex", node: "n" }, kind: "op", changes: { state: "open" } };
    const r = planSteward(input([a, b], { [b.id]: { timeline: [restore] } }));
    expect([r.moves, r.held.map((x) => x.key)]).toEqual([[], [b.key]]);
  });

  test("evidence spoofing (fix round 2, Opus HIGH 2): a member's agent's comment or status is not evidence on someone else's card", () => {
    const mine = card("OWN-1: alex's plan", "backlog", { assignee: "@alex" });
    const said = card("OWN-2: alex's plan", "todo", { assignee: "@alex" });
    const p = planSteward(input([mine, said], {
      [mine.id]: { agents: [bobAgent(`whatever ${mine.key}`)] },
      [said.id]: { timeline: [cmt("done", NOW - 2 * H, "bob-agent", "bob")] },
    }));
    expect(p.moves).toEqual([]);
    // The card's own assignee (bob's agent on bob's card) and people still count.
    const bobs = card("OWN-3: bob's", "backlog", { assignee: "@bob" });
    const byPerson = card("OWN-4: x", "todo");
    const q = planSteward(input([bobs, byPerson], {
      [bobs.id]: { agents: [bobAgent("OWN-3 build")] },
      [byPerson.id]: { timeline: [{ id: "p", ts: NOW - 2 * H, author: { handle: "bob", node: "b" }, kind: "comment", text: "done, shipped" }] },
    }));
    expect(q.moves.map((m) => [m.key, m.rule])).toEqual([[bobs.key, "doing"], [byPerson.key, "done"]]);
  });

  test("associations come only from a trusted title: a member's agent retitling a card to a Done issue closes nothing (Codex HIGH 1)", () => {
    const c = card("[ALE-9] SEC-9: x", "doing");
    const retitle: TimelineEntry = { id: "t1", ts: NOW - 30 * H, author: { handle: "bob", node: "b", agent: "bob-x" }, kind: "op", changes: { title: "[ALE-9] SEC-9: x" } };
    const ev = { linear: { key: "ALE-9", state: "Done", state_type: "completed" }, branches: [branch("lane/sec-9", 2, NOW - 30 * H, "main")] };
    expect(planSteward(input([c], { [c.id]: { ...ev, timeline: [retitle] } })).moves).toEqual([]);
    expect(planSteward(input([c], { [c.id]: ev })).moves.map((m) => m.rule)).toEqual(["done"]);
  });

  test("incomplete branch coverage: no stale and no git-merge done decision rests on it (Codex MED 7)", () => {
    const quiet = card("DATA-7: rooms", "doing");
    const merged = card("DATA-8: rooms", "review");
    const p = planSteward(input([quiet, merged], {
      [quiet.id]: { branches: [], branchesComplete: false },
      [merged.id]: { branches: [branch("lane/data-8", 3, NOW - 5 * H, "main")], branchesComplete: false },
    }));
    expect(p.moves).toEqual([]);
  });

  test("duplicates are per board; overlapping groups flag against the oldest card (Codex HIGH 2)", () => {
    const other = "a000000000000001:3";
    const a = card("Deploy dev", "todo");
    const b = card("Deploy dev", "todo", { board: other, created_at: NOW - 5 * H });
    const boards = [{ id: BOARD, columns: [...DEFAULT_COLUMNS] }, { id: other, columns: [...DEFAULT_COLUMNS] }];
    expect(planSteward(input([a, b], {}, { boards })).moves).toEqual([]);
    // Three cards on one Linear issue, two with the same title: both newer ones are flagged against the oldest.
    const x = card("[ALE-20] Z: one", "todo");
    const y = card("[ALE-20] Z: one", "todo", { created_at: NOW - 20 * H });
    const z = card("[ALE-20] Z: two", "todo", { created_at: NOW - 10 * H });
    const p = planSteward(input([x, y, z], {}));
    expect(p.moves.map((m) => [m.key, m.duplicate_of, m.to ?? null]).sort()).toEqual([[y.key, x.ref, null], [z.key, x.ref, null]].sort());
  });

  test("agents_can_close off: a done move on a comment alone is left to a person; git or Linear evidence still moves it", () => {
    const said = card("CLOSE-1: x", "doing");
    const linear = card("[ALE-3] CLOSE-2: x", "doing");
    const p = planSteward(input([said, linear], {
      [said.id]: { timeline: [cmt("Done: merged", NOW - 2 * H)] },
      [linear.id]: { linear: { key: "ALE-3", state: "Done", state_type: "completed" } },
    }, { agentsCanClose: false }));
    expect(p.moves.map((m) => m.key)).toEqual([linear.key]);
    expect(p.held.map((h) => h.key)).toEqual([said.key]);
  });

  test("a person's move pins the card for 24 h; a person undoing the steward holds it; another agent's move gets an hour", () => {
    const pinned = card("PIN-1: x", "todo");
    const expired = card("PIN-2: x", "todo");
    const undone = card("PIN-3: x", "todo");
    const agentMoved = card("PIN-4: x", "todo");
    const stewardMoved = card("PIN-5: x", "todo");
    const agents = (t: string) => ({ agents: [builder(t)] });
    const p = planSteward(input([pinned, expired, undone, agentMoved, stewardMoved], {
      [pinned.id]: { ...agents("pin-1"), timeline: [move("todo", NOW - 2 * H)] },
      [expired.id]: { ...agents("pin-2"), timeline: [move("todo", NOW - PIN_MS - H)] },
      [undone.id]: { ...agents("pin-3"), timeline: [move("doing", NOW - 50 * H, STEWARD_AGENT), move("todo", NOW - 30 * H)] },
      [agentMoved.id]: { ...agents("pin-4"), timeline: [move("todo", NOW - AGENT_GRACE_MS / 2, "cc-orch")] },
      // Another machine's steward moved it back 2 h ago (different evidence): no flip-flop within the cooldown.
      [stewardMoved.id]: { ...agents("pin-5"), timeline: [move("todo", NOW - 2 * H, STEWARD_AGENT)] },
    }));
    expect(p.moves.map((m) => m.key)).toEqual([expired.key]);
    expect(p.held.map((h) => [h.key, h.reason.split(":")[0]])).toEqual([
      [pinned.key, "pinned"], [undone.key, "a person moved it after the steward did (30 h ago); the steward leaves it"], [agentMoved.key, "agent cc-orch moved it under an hour ago"],
      [stewardMoved.key, "the steward moved it 2 h ago"],
    ]);
  });

  test("the per-run cap defers the rest", () => {
    const cards = Array.from({ length: 5 }, (_, i) => card(`CAP-${i + 1}: x`, "todo"));
    const ev = Object.fromEntries(cards.map((c, i) => [c.id, { agents: [builder(`cap-${i + 1}`)] }]));
    const p = planSteward(input(cards, ev, { maxMoves: 3 }));
    expect([p.moves.length, p.deferred]).toEqual([3, 2]);
  });
});

// ---- the fold -----------------------------------------------------------------------------------------------------

const hashOf = (id: string) => createHash("sha256").update(`sig-${id}`).digest("hex").slice(0, 16);
let seq = 0;
function ev(handle: string, origin: string, board: unknown, opts: { thread?: string; agent?: string } = {}): OpEvent {
  seq++;
  const id = `${origin}:${seq}`;
  return {
    id, origin, seq, ts: 1_700_000_000_000 + seq * 1000, h: hashOf(id), author: { handle, node: origin, ...(opts.agent ? { agent: opts.agent } : {}) },
    ...(opts.thread ? { thread: opts.thread } : {}), text: "op", board,
  };
}

describe("fold", () => {
  const ALEX = "a000000000000001";
  const KIRA = "b000000000000002";
  const boardId = `${ALEX}:1`;
  const boards = new Map([[boardId, { id: boardId, columns: [...DEFAULT_COLUMNS] }]]);
  const roles: Record<string, string> = { alex: "owner", kira: "member" };
  const steward = (creator: string) => (e: OpEvent) => isStewardAuthor(e.author, roles[e.author.handle] ?? null, creator);

  test("the steward may move a person's card (fold 9); a pre.6 fold ignores it as person_card; nobody may reassign it", () => {
    const root = ev("kira", KIRA, { v: 1, rev: 0, op: "card", board: boardId, title: "Kira's card", column: "todo", assignee: "@kira", n: 1 });
    const mv = ev("alex", ALEX, { v: 1, rev: 1, op: "card", after: refOf(root), column: "doing", pos: "i" }, { thread: root.id, agent: STEWARD_AGENT });
    const now = foldCard(root, [mv], { boards, steward: steward("alex") });
    const pre6 = foldCard(root, [mv], { boards });
    expect(now?.column).toBe("doing");
    expect(pre6?.column).toBe("todo");
    expect(pre6?.timeline.find((t) => t.id === mv.id)?.ignored).toBe("person_card");
    const reassign = ev("alex", ALEX, { v: 1, rev: 1, op: "card", after: refOf(root), column: "doing", assignee: "@alex" }, { thread: root.id, agent: STEWARD_AGENT });
    expect(foldCard(root, [reassign], { boards, steward: steward("alex") })?.timeline.find((t) => t.id === reassign.id)?.ignored).toBe("person_card");
  });

  test("only an owner's (or the project creator's) steward counts; a member's steward agent on another's project does not", () => {
    const root = ev("alex", ALEX, { v: 1, rev: 0, op: "card", board: boardId, title: "Alex's card", column: "todo", assignee: "@alex", n: 2 });
    const mv = ev("kira", KIRA, { v: 1, rev: 1, op: "card", after: refOf(root), column: "doing" }, { thread: root.id, agent: STEWARD_AGENT });
    expect(foldCard(root, [mv], { boards, steward: steward("alex") })?.column).toBe("todo");
    expect(foldCard(root, [mv], { boards, steward: steward("kira") })?.column).toBe("doing");
    const other = ev("alex", ALEX, { v: 1, rev: 1, op: "card", after: refOf(root), column: "doing" }, { thread: root.id, agent: "cc-1" });
    expect(foldCard(root, [other], { boards, steward: steward("alex") })?.column).toBe("todo");
  });

  test("the steward's ops are ordinary card ops a pre.6 schema accepts; `steward` on a project op is dropped there, the rest applies", () => {
    const stewardOp = { v: 1, rev: 3, op: "card", after: `${ALEX}:9#${"0".repeat(16)}`, column: "done", pos: "i" };
    expect(CardOp.strict().safeParse(stewardOp).success).toBe(true);
    const settings = { v: 1, rev: 1, op: "project", steward: "off", name: "Renamed" };
    const pre6 = ProjectOp.omit({ steward: true });
    const parsed = pre6.safeParse(settings);
    expect(parsed.success && parsed.data).toEqual({ v: 1, rev: 1, op: "project", name: "Renamed" });
    const root = ev("alex", ALEX, { v: 1, rev: 0, op: "project", name: "P", prefix: "PP" });
    const off = ev("alex", ALEX, { ...settings, after: refOf(root) }, { thread: root.id });
    const env = { creator: "alex", roleOf: () => "owner" as const };
    const p = foldProject([root, off], env);
    expect([p?.steward, p?.name]).toEqual(["off", "Renamed"]);
    expect(foldProject([root], env)?.steward).toBe("on");
  });
});

describe("older machines (round 3)", () => {
  const T = 1_800_000_000_000;
  const peer = (hostname: string, v: string | undefined, online: boolean, seenHoursAgo: number | null) => ({
    hostname, online, last_seen: seenHoursAgo === null ? null : T - seenHoursAgo * H, ...(v ? { version: v } : {}),
  });

  test("versions: pre.8 is the steward's first; later prereleases and releases count", () => {
    expect(STEWARD_MIN_VERSION).toBe("0.2.0-pre.8");
    expect([versionAtLeast("0.2.0-pre.7", "0.2.0-pre.8"), versionAtLeast("0.2.0-pre.8", "0.2.0-pre.8"), versionAtLeast("0.2.0-pre.10", "0.2.0-pre.8"), versionAtLeast("0.2.0", "0.2.0-pre.8"), versionAtLeast("0.1.9", "0.2.0-pre.8")])
      .toEqual([false, true, true, true, false]);
  });

  test("only machines seen in the last 24 h (or online) hold moves back, with a readable reason", () => {
    expect(blockingPeer([peer("old-laptop", "0.2.0-pre.5", false, 72)], T)).toBeNull();
    expect(blockingPeer([peer("never-seen", undefined, false, null)], T)).toBeNull();
    expect(blockingPeer([peer("kiras-mbp", "0.2.0-pre.5", false, 3)], T)).toBe("waiting for kiras-mbp to upgrade (it runs Walkie 0.2.0-pre.5; this needs 0.2.0-pre.8)");
    expect(blockingPeer([peer("hestia", undefined, true, 0)], T)).toBe("waiting for hestia to report its Walkie version");
    expect(blockingPeer([peer("atlas", "0.2.0-pre.9", true, 0), peer("rel", "0.2.0", true, 0)], T)).toBeNull();
    // Fail closed (Codex r2 HIGH 1): a peer on this build's own (older) version doesn't pass by being equal to it.
    expect(blockingPeer([peer("twin", "0.2.0-pre.5", true, 0)], T)).toBe("waiting for twin to upgrade (it runs Walkie 0.2.0-pre.5; this needs 0.2.0-pre.8)");
  });
});

