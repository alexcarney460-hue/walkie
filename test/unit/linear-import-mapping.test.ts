// LINEAR-IMPORT-1: the pure Linear → Walkie mapping (columns, labels, people, bodies cut to the board-op cap, digests,
// prefixes, similarity, durations) and the sync decision table.
import { describe, expect, test } from "bun:test";
import { boardBodyFits, CardOp, MAX_BOARD_OP_BYTES } from "../../src/protocol/projects/schema.ts";
import { spreadKeys } from "../../src/protocol/projects/position.ts";
import { extOf } from "../../src/protocol/projects/batch.ts";
import type { LIssue, LState } from "../../src/integrations/linear-import/api.ts";
import { issueFilter } from "../../src/integrations/linear-import/api.ts";
import {
  bodyBudget, bodyOf, cutJson, digestOf, IMPORT_COLUMNS, labelsOf, memberFor, normTitle, parseDuration, parseMapUsers, placeOf, prefixFor,
  similar, stateForRole, titleOf,
} from "../../src/integrations/linear-import/mapping.ts";
import { conflictNote, decide, type Fields } from "../../src/integrations/linear-import/sync.ts";
import { columnForRole, parentFirst, walkieFields } from "../../src/integrations/linear-import/service.ts";

function issue(over: Partial<LIssue> = {}): LIssue {
  return {
    id: "iss-1", identifier: "KES-1", title: "Pricing page", url: "https://linear.app/kestrel/issue/KES-1", description: "Body.",
    priority: 0, estimate: null, dueDate: null, createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-02T10:00:00.000Z",
    completedAt: null, canceledAt: null, state: { id: "s1", name: "Todo", type: "unstarted" }, labels: { nodes: [] }, assignee: null,
    creator: { name: "Maren Okafor" }, parent: null, project: { id: "p1" }, team: { id: "t1", key: "KES", name: "Kestrel" },
    comments: { nodes: [] }, history: { nodes: [] }, ...over,
  };
}

describe("columns", () => {
  test("by state type; review by name; closed ones archived in Canceled", () => {
    expect(placeOf({ type: "backlog", name: "Backlog" })).toEqual({ column: "backlog", role: "backlog", archived: false });
    expect(placeOf({ type: "unstarted", name: "Todo" }).column).toBe("todo");
    expect(placeOf({ type: "triage", name: "Triage" }).column).toBe("todo");
    expect(placeOf({ type: "started", name: "In Progress" }).column).toBe("doing");
    expect(placeOf({ type: "started", name: "Code review" }).column).toBe("review");
    expect(placeOf({ type: "completed", name: "Done" })).toEqual({ column: "done", role: "done", archived: false });
    expect(placeOf({ type: "canceled", name: "Canceled" })).toEqual({ column: "canceled", role: "cancelled", archived: true });
    expect(placeOf({ type: "duplicate", name: "Duplicate" }).archived).toBe(true);
    expect(IMPORT_COLUMNS.map((c) => c.id)).toEqual(["backlog", "todo", "doing", "review", "done", "canceled"]);
  });

  test("back to Linear: the team's first state of the type by position; review = a started state named review", () => {
    const st = (id: string, name: string, type: string, position: number): LState => ({ id, name, type, position, team: { id: "t1", key: "KES" } });
    const states = [st("r", "In Review", "started", 3), st("p", "In Progress", "started", 2), st("b", "Backlog", "backlog", 0), st("t", "Todo", "unstarted", 1),
      st("d", "Done", "completed", 4), st("c", "Canceled", "canceled", 5)];
    expect(stateForRole("active", states)?.id).toBe("p");
    expect(stateForRole("review", states)?.id).toBe("r");
    expect(stateForRole("todo", states)?.id).toBe("t");
    expect(stateForRole("done", states)?.id).toBe("d");
    expect(stateForRole("cancelled", states)?.id).toBe("c");
    expect(stateForRole("review", states.filter((s) => s.id !== "r"))?.id).toBe("p");
    expect(stateForRole("done", [])).toBeNull();
  });

  test("a board without the role's column falls back (canceled → backlog)", () => {
    const cols = IMPORT_COLUMNS.filter((c) => c.id !== "canceled");
    expect(columnForRole({ columns: cols }, "cancelled")).toBe("backlog");
    expect(columnForRole({ columns: IMPORT_COLUMNS }, "cancelled")).toBe("canceled");
    expect(columnForRole({ columns: cols.filter((c) => c.role !== "review") }, "review")).toBe("doing");
  });
});

describe("fields", () => {
  test("labels: Linear's (cleaned, ≤ 32 chars), linear, and the priority; never more than 10", () => {
    const many = { nodes: Array.from({ length: 15 }, (_, i) => ({ name: `label\t${i} ${"x".repeat(40)}` })) };
    const ls = labelsOf({ labels: many, priority: 1 });
    expect(ls.length).toBe(10);
    expect(ls.slice(-2)).toEqual(["linear", "urgent"]);
    expect(ls.every((l) => l.length <= 32 && !/[\t\n]/.test(l))).toBe(true);
    expect(labelsOf({ labels: { nodes: [{ name: "linear" }] }, priority: 0 })).toEqual(["linear"]);
  });

  test("title carries the key and fits 200", () => {
    expect(titleOf({ identifier: "KES-9", title: "  Two   spaces " })).toBe("[KES-9] Two spaces");
    expect(titleOf({ identifier: "KES-9", title: "x".repeat(400) }).length).toBe(200);
  });

  test("people: explicit map, then email = login, then a unique name match; else unmapped", () => {
    const members = [{ handle: "alex", login: "alex@example.com" }, { handle: "kira", login: "-", display_name: "Kira Rowe" }, { handle: "maren", login: "m@x.example" }];
    const explicit = parseMapUsers("@maren=Maren Okafor, kira=K R");
    expect(memberFor({ name: "Maren Okafor" }, members, explicit)).toBe("maren");
    expect(memberFor({ name: "Someone", email: "ALEX@example.com" }, members, new Map())).toBe("alex");
    expect(memberFor({ name: "Kira Rowe" }, members, new Map())).toBe("kira");
    expect(memberFor({ name: "Ghost" }, members, new Map())).toBeNull();
    expect(memberFor({ name: "Zed Quill" }, members, parseMapUsers("@nobody=Zed Quill"))).toBeNull(); // mapped to a non-member: unmapped
    expect(() => parseMapUsers("alex")).toThrow("--map-users");
  });

  test("a body is cut by BYTES so the whole card op stays a board op (multi-byte, quotes, newlines)", () => {
    for (const desc of ["é".repeat(30_000), "\"\n".repeat(20_000), "日本語".repeat(10_000), "plain ".repeat(5_000)]) {
      const i = issue({ description: desc });
      const title = titleOf(i);
      const labels = labelsOf(i);
      const ext = { src: "linear" as const, id: i.id, key: i.identifier };
      const body = bodyOf(i, { unmappedAssignee: "Ghost", parentRef: null, budget: bodyBudget(title, labels, JSON.stringify(ext).length + 16) });
      expect(body).toContain("[cut: the full description is in Linear: https://linear.app/kestrel/issue/KES-1]");
      expect(body.length).toBeLessThanOrEqual(16_000);
      const op = { v: 1, rev: 0, op: "card", board: "0123456789abcdef:12", title, column: "backlog", pos: "i2", n: 1999, body, labels, ext, assignee: "@alex" };
      expect(CardOp.safeParse(op).success).toBe(true);
      expect(boardBodyFits({ text: `New card WR-1999: ${title}`, board: op })).toBe(true);
    }
    expect(bodyOf(issue(), { unmappedAssignee: null, parentRef: "WR-2-1a2b3c4d", budget: MAX_BOARD_OP_BYTES })).toBe(
      "Linear KES-1 · https://linear.app/kestrel/issue/KES-1\nState in Linear: Todo\nCreated 2026-09-01 by Maren Okafor\n\nBody.");
    expect(bodyOf(issue({ parent: { id: "x", identifier: "KES-0" }, priority: 2 }), { unmappedAssignee: null, parentRef: "WR-2-1a2b3c4d", budget: 9_000 }))
      .toContain("Parent: KES-0 (WR-2-1a2b3c4d)");
  });

  test("cutJson never splits a surrogate pair", () => {
    const s = "a😀".repeat(100);
    const cut = cutJson(s, 41);
    expect(new TextEncoder().encode(JSON.stringify(cut)).length).toBeLessThanOrEqual(41);
    expect(cut.endsWith("\uD83D")).toBe(false);
  });

  test("digest: history and comments in order, capped with a pointer; none when empty", () => {
    expect(digestOf(issue())).toBeNull();
    const d = digestOf(issue({
      comments: { nodes: [{ body: "second", createdAt: "2026-09-03T00:00:00Z", user: { name: "B" } }, { body: "first", createdAt: "2026-09-02T00:00:00Z", user: null }] },
      history: { nodes: [{ createdAt: "2026-09-01T12:00:00Z", actor: { name: "A" }, fromState: { name: "Todo" }, toState: { name: "In Progress" }, fromAssignee: null, toAssignee: null }] },
    }))!;
    expect(d).toContain("A: Todo → In Progress");
    expect(d.indexOf("first")).toBeLessThan(d.indexOf("second"));
    const long = digestOf(issue({ comments: { nodes: [{ body: "z".repeat(50_000), createdAt: "2026-09-02T00:00:00Z", user: null }] } }), 12_000)!;
    expect(long.length).toBe(12_000);
    expect(long).toContain("[cut: the rest is in Linear");
  });
});

describe("prefixes, duplicates, durations, filters", () => {
  test("prefixes: initials, collision-safe, deterministic", () => {
    expect(prefixFor("Website relaunch", new Set())).toBe("WR");
    expect(prefixFor("Website relaunch", new Set(["WR"]))).toBe("WR2");
    expect(prefixFor("Sequence — Carrier OS (Panther)", new Set())).toBe("SCOP");
    expect(prefixFor("Walkie", new Set())).toBe("WALK");
    expect(prefixFor("Postgres 18 upgrade", new Set())).toBe("PU");
    expect(prefixFor("Agent capacity — 16 concurrent lanes", new Set())).toBe("ACCL");
    expect(prefixFor("—", new Set(), "ALE")).toBe("ALE");
    expect(prefixFor("x", new Set(), "7")).toBe("LIN");
    const taken = new Set<string>();
    for (let i = 0; i < 50; i++) taken.add(prefixFor("Same name", taken));
    expect(taken.size).toBe(50);
    expect([...taken].every((p) => /^[A-Z][A-Z0-9]{1,9}$/.test(p))).toBe(true);
  });

  test("near duplicates: same normalised title, or ≥ 0.85 word overlap with ≥ 4 words", () => {
    expect(similar("Hero video", "hero  VIDEO!")).toBe(true);
    expect(similar("[KES-4] Hero video", "Hero video (KES-9)")).toBe(true);
    expect(similar("Add rate limits to the public API", "Add rate limits to public API")).toBe(true);
    expect(similar("Fix login", "Fix logout")).toBe(false);
    expect(similar("Ship the billing migration dry run", "Ship the billing migration")).toBe(false);
    expect(normTitle("[ALE-12] Fix: ALE-9 again")).toBe("fix again");
  });

  test("durations", () => {
    expect(parseDuration("45d")).toBe(45 * 86_400_000);
    expect(parseDuration("2w")).toBe(14 * 86_400_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(() => parseDuration("soon")).toThrow("duration");
  });

  test("issue filters: closed types out by default (duplicate included), projects or none, team, since, ids", () => {
    expect(issueFilter({})).toEqual({ state: { type: { nin: ["completed", "canceled", "duplicate"] } } });
    expect(issueFilter({ projectIds: "none", teamId: "t", includeClosed: true, since: "2026-01-01T00:00:00Z" }))
      .toEqual({ project: { null: true }, team: { id: { eq: "t" } }, updatedAt: { gt: "2026-01-01T00:00:00Z" } });
    expect(issueFilter({ projectIds: ["a"], ids: ["x"], includeClosed: true })).toEqual({ project: { id: { in: ["a"] } }, id: { in: ["x"] } });
  });

  test("parents come before their children, order otherwise kept", () => {
    const xs = [{ id: "c", parent: { id: "p" } }, { id: "a", parent: null }, { id: "p", parent: { id: "gp" } }, { id: "gp", parent: null }, { id: "loop", parent: { id: "loop" } }];
    expect(parentFirst(xs).map((x) => x.id)).toEqual(["gp", "p", "c", "a", "loop"]);
  });

  test("ext is read strictly; anything malformed is no ext", () => {
    expect(extOf({ ext: { src: "linear", id: "iss-1", key: "KES-1" } })).toEqual({ src: "linear", id: "iss-1", key: "KES-1" });
    expect(extOf({ ext: { src: "linear", id: "a b" } })).toBeNull();
    expect(extOf({ ext: "linear" })).toBeNull();
    expect(extOf({ ext: { src: "jira", id: "1" } })).toBeNull();
    expect(extOf({})).toBeNull();
  });

  test("spread positions: increasing, valid, short for 2 000 cards, after the column's last", () => {
    const keys = spreadKeys("zz", null, 2_000);
    expect(keys.every((k, i) => i === 0 || keys[i - 1]! < k)).toBe(true);
    expect(keys[0]! > "zz").toBe(true);
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(6);
    expect(spreadKeys(null, null, 0)).toEqual([]);
  });
});

describe("sync decisions", () => {
  const base: Fields = { title: "[KES-1] A", place: "todo", labels: ["linear"], estimate: null, due: null, assignee: null };
  const snap = { l: base, w: base };

  test("nothing changed: nothing to do", () => {
    const d = decide({ snap, linear: base, linearAt: 2, walkie: base, walkieAt: 1, twoWay: true });
    expect(d).toMatchObject({ toWalkie: {}, toLinear: null, conflicts: [] });
  });

  test("Linear changed: the card follows", () => {
    const d = decide({ snap, linear: { ...base, place: "active", title: "[KES-1] B" }, linearAt: 2, walkie: base, walkieAt: 1, twoWay: false });
    expect(d.toWalkie).toEqual({ title: "[KES-1] B", place: "active" });
    expect(d.next.w.place).toBe("active");
  });

  test("Walkie changed: kept one-way (and remembered as a divergence); two-way writes the place back, never the title", () => {
    const moved = { ...base, place: "done" as const, title: "[KES-1] renamed in Walkie" };
    const one = decide({ snap, linear: base, linearAt: 1, walkie: moved, walkieAt: 2, twoWay: false });
    expect(one.toLinear).toBeNull();
    expect(one.toWalkie).toEqual({});
    expect(one.next.w.place).toBe("todo"); // still diverged: a later Linear change is judged as a conflict
    const two = decide({ snap, linear: base, linearAt: 1, walkie: moved, walkieAt: 2, twoWay: true });
    expect(two.toLinear).toBe("done");
    expect(two.next.l.place).toBe("done");
    expect(two.next.l.title).toBe("[KES-1] A");
  });

  test("both changed: latest wins, a conflict is reported; equal new values are no conflict", () => {
    const l = { ...base, place: "review" as const };
    const w = { ...base, place: "active" as const };
    const linearLater = decide({ snap, linear: l, linearAt: 5, walkie: w, walkieAt: 4, twoWay: true });
    expect(linearLater.toWalkie).toEqual({ place: "review" });
    expect(linearLater.conflicts).toEqual([{ field: "place", linear: "review", walkie: "active", winner: "linear" }]);
    const walkieLater = decide({ snap, linear: l, linearAt: 4, walkie: w, walkieAt: 5, twoWay: true });
    expect(walkieLater.toLinear).toBe("active");
    expect(walkieLater.conflicts[0]?.winner).toBe("walkie");
    const oneWay = decide({ snap, linear: l, linearAt: 4, walkie: w, walkieAt: 5, twoWay: false });
    expect(oneWay.toLinear).toBeNull();
    expect(oneWay.toWalkie).toEqual({});
    // recorded as agreed: the next pass with the same values does nothing
    const again = decide({ snap: oneWay.next, linear: l, linearAt: 4, walkie: w, walkieAt: 5, twoWay: false });
    expect(again.conflicts).toEqual([]);
    expect(again.toWalkie).toEqual({});
    const same = decide({ snap, linear: l, linearAt: 4, walkie: l, walkieAt: 5, twoWay: true });
    expect(same.conflicts).toEqual([]);
  });

  test("labels compare as sets", () => {
    const d = decide({ snap, linear: { ...base, labels: ["b", "a"] }, linearAt: 2, walkie: { ...base, labels: ["a", "b"] }, walkieAt: 1, twoWay: true });
    expect(d.toWalkie).toEqual({});
  });

  test("first adoption: Linear wins regardless of timestamps, preserves the title, never writes back", () => {
    for (const linearAt of [1, 3]) for (const twoWay of [false, true]) {
      const d = decide({ snap: null, linear: { ...base, title: "Linear title", place: "done" }, linearAt, walkie: base, walkieAt: 2, twoWay });
      expect(d.toWalkie).toEqual({ place: "done" });
      expect(d.toLinear).toBeNull();
      expect(d.conflicts).toEqual([]);
      expect(d.next.w.title).toBe(base.title);
      expect(d.next.l.title).toBe("Linear title");
    }
  });

  test("a Walkie card archived outside done counts as canceled", () => {
    const card = { title: "t", column: "todo", state: "archived", labels: [], estimate: null, due: null, assignee: null } as never;
    expect(walkieFields(card, { columns: IMPORT_COLUMNS }).place).toBe("cancelled");
    const done = { title: "t", column: "done", state: "archived", labels: [], estimate: null, due: null, assignee: null } as never;
    expect(walkieFields(done, { columns: IMPORT_COLUMNS }).place).toBe("done");
  });

  test("the conflict note names both values and the winner", () => {
    const note = conflictNote("WR-3", [{ field: "place", linear: "review", walkie: "active", winner: "linear" }], { linear: Date.parse("2026-09-27T10:00:00Z"), walkie: Date.parse("2026-09-27T09:00:00Z") });
    expect(note).toContain("WR-3 changed on both sides");
    expect(note).toContain(`place: Linear "review", Walkie "active" → kept Linear's`);
  });
});
