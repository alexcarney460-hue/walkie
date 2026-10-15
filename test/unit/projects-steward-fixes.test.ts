import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldCard, refOf, type OpEvent } from "../../src/protocol/projects/fold.ts";
import { DEFAULT_COLUMNS, type CardView, type ProjectView, type TimelineEntry } from "../../src/protocol/projects/schema.ts";
import { planSteward, type StewardCard, type StewardInput } from "../../src/protocol/projects/steward.ts";
import { history } from "../../src/protocol/projects/steward-core.ts";
import { gather, privatePhrasesFor, type StewardSource } from "../../src/daemon/projects/steward-gather.ts";
import { cardAction, comment, type WriteCtx } from "../../src/daemon/projects/service.ts";
import { runSteward, type StewardDeps } from "../../src/daemon/projects/steward-run.ts";
import { reportsWorld } from "../helpers/project-reports.ts";

const now = 1_800_000_000_000;
const person = { handle: "alex", node: "n" };
const card: StewardCard = {
  id: "n:1", key: "PUB-1", ref: "PUB-1-11111111", title: "Public work", board: "n:2", column: "doing",
  state: "open", assignee: "@alex", blocked: false, blocked_reason: null, created_at: now - 40 * 24 * 3_600_000,
  created_by: person, updated_at: now - 3_600_000,
};

test("an old done comment cannot close work resumed by a later person edit", () => {
  const timeline: TimelineEntry[] = [
    { id: "a000000000000001:1", ts: now - 30 * 24 * 3_600_000, kind: "comment", author: person, text: "Done: old release" },
    { id: "a000000000000001:2", ts: now - 3_600_000, kind: "op", author: person, changes: { body: "New work remains" } },
  ];
  const input: StewardInput = {
    now, prefix: "PUB", steward: "on", boards: [{ id: card.board, columns: DEFAULT_COLUMNS }], cards: [card],
    evidence: new Map([[card.id, { agents: [], branches: [], linear: null, timeline }]]), staleHours: 24,
    owners: ["alex"], agentsCanClose: true,
  };
  expect(planSteward(input).moves).toEqual([]);
  const confirmed = { ...input, evidence: new Map([[card.id, { agents: [], branches: [], linear: null, timeline: [...timeline,
    { id: "a000000000000001:3", ts: now - 30 * 60_000, kind: "comment" as const, author: person, text: "Done: new work shipped" },
  ] }]]) };
  expect(planSteward(confirmed).moves.map((move) => move.rule)).toEqual(["done"]);
});

test("same-millisecond comments are not evidence after a person edit", () => {
  const edit: TimelineEntry = { id: "edit", ts: now - 3_600_000, kind: "op", author: person, changes: { body: "Work resumed" } };
  const done: TimelineEntry = { id: "done", ts: edit.ts, kind: "comment", author: person, text: "Done: shipped" };
  expect(history([edit, done], card, ["alex"]).lastComment).toBeNull();
  expect(history([done, edit], card, ["alex"]).lastComment).toBeNull();
  expect(history([{ ...done, id: "a000000000000001:2" }, { ...edit, id: "a000000000000001:3" }], card, ["alex"]).lastComment).toBeNull();
});

test("a same-millisecond old done comment cannot close work resumed by a later person edit through the fold", () => {
  const origin = "a000000000000001";
  const board = `${origin}:9`;
  const root: OpEvent = { id: `${origin}:1`, origin, seq: 1, ts: now - 2 * 3_600_000, h: "1111111111111111", author: person,
    text: "op", board: { v: 1, rev: 0, op: "card", board, title: card.title, column: "doing", assignee: "@alex", n: 1 } };
  const edit: OpEvent = { id: `${origin}:2`, origin, seq: 2, ts: now - 3_600_000, h: "2222222222222222", author: person,
    thread: root.id, text: "op", board: { v: 1, rev: 1, op: "card", after: refOf(root), body: "Work resumed" } };
  const comment: OpEvent = { id: "b000000000000002:1", origin: "b000000000000002", seq: 1, ts: edit.ts,
    h: "3333333333333333", author: person, thread: root.id, text: "Done: old release" };
  const folded = foldCard(root, [comment, edit], { boards: new Map([[board, { id: board, columns: [...DEFAULT_COLUMNS] }]]) });
  expect(folded?.timeline.map((event) => event.kind)).toEqual(["create", "op", "comment"]);
  const input: StewardInput = { now, prefix: "PUB", steward: "on", boards: [{ id: board, columns: DEFAULT_COLUMNS }],
    cards: [{ ...card, id: root.id, board, created_at: root.ts, updated_at: edit.ts }],
    evidence: new Map([[root.id, { agents: [], branches: [], linear: null, timeline: folded?.timeline ?? [] }]]),
    staleHours: 24, owners: ["alex"], agentsCanClose: true };
  expect(planSteward(input).moves).toEqual([]);
});

test("a same-origin done comment after a person edit counts at the same millisecond", () => {
  const origin = "a000000000000001";
  const board = `${origin}:9`;
  const root: OpEvent = { id: `${origin}:1`, origin, seq: 1, ts: now - 2 * 3_600_000, h: "1111111111111111", author: person,
    text: "op", board: { v: 1, rev: 0, op: "card", board, title: card.title, column: "doing", assignee: "@alex", n: 1 } };
  const edit: OpEvent = { id: `${origin}:2`, origin, seq: 2, ts: now - 3_600_000, h: "2222222222222222", author: person,
    thread: root.id, text: "op", board: { v: 1, rev: 1, op: "card", after: refOf(root), body: "Work resumed" } };
  const comment: OpEvent = { id: `${origin}:3`, origin, seq: 3, ts: edit.ts, h: "3333333333333333", author: person,
    thread: root.id, text: "Done: new work shipped" };
  const folded = foldCard(root, [comment, edit], { boards: new Map([[board, { id: board, columns: [...DEFAULT_COLUMNS] }]]) });
  expect(folded?.timeline.map((event) => event.kind)).toEqual(["create", "op", "comment"]);
  const input: StewardInput = { now, prefix: "PUB", steward: "on", boards: [{ id: board, columns: DEFAULT_COLUMNS }],
    cards: [{ ...card, id: root.id, board, created_at: root.ts, updated_at: edit.ts }],
    evidence: new Map([[root.id, { agents: [], branches: [], linear: null, timeline: folded?.timeline ?? [] }]]),
    staleHours: 24, owners: ["alex"], agentsCanClose: true };
  expect(planSteward(input).moves.map((move) => move.rule)).toEqual(["done"]);
});

test("a later person edit from another machine defeats a clock-skewed done comment", () => {
  const origin = "a000000000000001";
  const board = `${origin}:9`;
  const root: OpEvent = { id: `${origin}:1`, origin, seq: 1, ts: now - 2 * 3_600_000, h: "1111111111111111", author: person,
    text: "op", board: { v: 1, rev: 0, op: "card", board, title: card.title, column: "doing", assignee: "@alex", n: 1 } };
  const comment: OpEvent = { id: `${origin}:2`, origin, seq: 2, ts: now - 1_000, h: "2222222222222222", author: person,
    thread: root.id, text: "Done: old release" };
  const edit: OpEvent = { id: "b000000000000002:3", origin: "b000000000000002", seq: 3, ts: now - 4_000,
    h: "3333333333333333", author: person, thread: root.id, text: "op",
    board: { v: 1, rev: 1, op: "card", after: refOf(root), body: "New work remains" } };
  const folded = foldCard(root, [comment, edit], { boards: new Map([[board, { id: board, columns: [...DEFAULT_COLUMNS] }]]) });
  expect(folded?.body).toBe("New work remains");
  const input: StewardInput = { now, prefix: "PUB", steward: "on", boards: [{ id: board, columns: DEFAULT_COLUMNS }],
    cards: [{ ...card, id: root.id, board, created_at: root.ts, updated_at: edit.ts }],
    evidence: new Map([[root.id, { agents: [], branches: [], linear: null, timeline: folded?.timeline ?? [] }]]),
    staleHours: 24, owners: ["alex"], agentsCanClose: true };
  expect(planSteward(input).moves).toEqual([]);
});

test("same-origin event sequence proves a comment follows an edit despite clock skew", () => {
  const edit: TimelineEntry = { id: "a000000000000001:2", ts: now - 1_000, kind: "op", author: person, changes: { body: "Work resumed" } };
  const done: TimelineEntry = { id: "a000000000000001:3", ts: now - 4_000, kind: "comment", author: person, text: "Done: shipped" };
  expect(history([edit, done], card, ["alex"]).lastComment?.id).toBe(done.id);
});

test("a causal later person move from a slower clock overrides the steward move", () => {
  const origin = "a000000000000001";
  const board = `${origin}:9`;
  const root: OpEvent = { id: `${origin}:1`, origin, seq: 1, ts: now - 40 * 3_600_000, h: "1111111111111111", author: person,
    text: "op", board: { v: 1, rev: 0, op: "card", board, title: card.title, column: "doing", assignee: "@alex", n: 1 } };
  const steward: OpEvent = { id: `${origin}:2`, origin, seq: 2, ts: now - 7 * 3_600_000, h: "2222222222222222",
    author: { ...person, agent: "steward" }, thread: root.id, text: "op",
    board: { v: 1, rev: 1, op: "card", after: refOf(root), column: "done" } };
  const personMove: OpEvent = { id: "b000000000000002:3", origin: "b000000000000002", seq: 3,
    ts: steward.ts - 3_600_000, h: "3333333333333333", author: person, thread: root.id, text: "op",
    board: { v: 1, rev: 2, op: "card", after: refOf(steward), column: "review" } };
  const folded = foldCard(root, [personMove, steward], {
    boards: new Map([[board, { id: board, columns: [...DEFAULT_COLUMNS] }]]),
    steward: (event) => event.author.agent === "steward",
  });
  expect(folded?.column).toBe("review");
  const input: StewardInput = { now, prefix: "PUB", steward: "on", boards: [{ id: board, columns: DEFAULT_COLUMNS }],
    cards: [{ ...card, id: root.id, board, column: "review", created_at: root.ts, updated_at: steward.ts }],
    evidence: new Map([[root.id, { agents: [], branches: [{ repo: "/repo", branch: "lane/pub-1", own_commits: 1,
      last_commit_at: now - 20 * 3_600_000, merged_into: "release" }], linear: null, timeline: folded?.timeline ?? [] }]]),
    staleHours: 24, owners: ["alex"], agentsCanClose: true };
  expect(history(folded?.timeline ?? [], input.cards[0] as StewardCard, ["alex"]).last?.id).toBe(personMove.id);
  expect(planSteward(input).moves).toEqual([]);
  expect(planSteward(input).held[0]?.reason).toContain("a person moved it after the steward did");
});

test("moves from different origins without fold positions leave the steward held", () => {
  const timeline: TimelineEntry[] = [
    { id: "a000000000000001:2", ts: now - 8 * 3_600_000, kind: "op", author: { ...person, agent: "steward" }, changes: { column: "done" } },
    { id: "b000000000000002:3", ts: now - 9 * 3_600_000, kind: "op", author: person, changes: { column: "review" } },
  ];
  const input: StewardInput = { now, prefix: "PUB", steward: "on", boards: [{ id: card.board, columns: DEFAULT_COLUMNS }],
    cards: [{ ...card, column: "review" }], evidence: new Map([[card.id, { agents: [], branches: [{ repo: "/repo",
      branch: "lane/pub-1", own_commits: 1, last_commit_at: now - 20 * 3_600_000, merged_into: "release" }],
      linear: null, timeline }]]), staleHours: 24, owners: ["alex"], agentsCanClose: true };
  expect(planSteward(input).moves).toEqual([]);
  expect(planSteward(input).held[0]?.reason).toContain("no established order");
});

test("a private release ref is scrubbed before a git completion comment is planned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steward-private-ref-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", dir, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
    });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  };
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "base"), "base"); git("add", "base"); git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "lane/pub-1");
    writeFileSync(join(dir, "work"), "work"); git("add", "work"); git("commit", "-q", "-m", "work");
    git("checkout", "-q", "main"); git("checkout", "-q", "-b", "release-SecretPlans");
    git("merge", "-q", "--no-ff", "-m", "merge", "lane/pub-1");
    const project = { prefix: "PUB", paths: [], boards: [{ id: card.board, state: "active", columns: DEFAULT_COLUMNS }], automations: { agents_can_close: true } } as unknown as ProjectView;
    const privateProject = { channel: "p-private", state: "active", private: true, name: "SecretPlans", prefix: "PRIVATE" } as ProjectView;
    const source: StewardSource = {
      project: async () => project,
      cards: async () => [{ ...card, column: "review", short: "11111111" } as CardView],
      timeline: async () => [], agents: async () => [], owners: async () => ["alex"], linear: async () => null,
      privatePhrases: async (target) => privatePhrasesFor(target, [project, privateProject], async () => []),
    };
    const gathered = await gather(source, "PUB", { now, repos: [dir], staleHours: 24 });
    const planned = planSteward(gathered.input).moves[0];
    expect(planned?.rule).toBe("done");
    expect(planned?.comment).not.toContain("SecretPlans");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unseen private title in a git release ref stays out of a public comment", async () => {
  const project = { prefix: "PUB", paths: [], boards: [{ id: card.board, state: "active", columns: DEFAULT_COLUMNS }],
    automations: { agents_can_close: true } } as unknown as ProjectView;
  const source: StewardSource = {
    project: async () => project,
    cards: async () => [{ ...card, column: "review", short: "11111111" } as CardView],
    timeline: async () => [], agents: async () => [], owners: async () => ["alex"], linear: async () => null,
    privatePhrases: async () => ({ phrases: [], prefixes: [] }),
  };
  const dir = mkdtempSync(join(tmpdir(), "steward-unseen-ref-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", dir, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
    });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  };
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "base"), "base"); git("add", "base"); git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "lane/pub-1");
    writeFileSync(join(dir, "work"), "work"); git("add", "work"); git("commit", "-q", "-m", "work");
    git("checkout", "-q", "main"); git("checkout", "-q", "-b", "release-SecretPlans");
    git("merge", "-q", "--no-ff", "-m", "merge", "lane/pub-1");
    const gathered = await gather(source, "PUB", { now, repos: [dir], staleHours: 24 });
    const planned = planSteward(gathered.input).moves[0];
    expect(planned?.rule).toBe("done");
    expect(planned?.comment).not.toContain("SecretPlans");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unseen private title in a git branch stays out of a review comment", () => {
  const input: StewardInput = { now, prefix: "PUB", steward: "on", boards: [{ id: card.board, columns: DEFAULT_COLUMNS }],
    cards: [{ ...card, column: "doing" }],
    evidence: new Map([[card.id, { agents: [{ address: "@alex/box/audit", handle: "alex", agent: "audit", text: "PUB-1", auditor: true }],
      branches: [{ repo: "/fixture", branch: "lane/pub-1-SecretPlans", own_commits: 1, last_commit_at: now - 3_600_000, merged_into: null }],
      linear: null, timeline: [] }]]), staleHours: 24, owners: ["alex"], agentsCanClose: true };
  const planned = planSteward(input).moves[0];
  expect(planned?.rule).toBe("review");
  expect(planned?.comment).not.toContain("SecretPlans");
});

test("a private project title in agent status never reaches a public board comment", async () => {
  const project = { prefix: "PUB", paths: [], boards: [{ id: card.board, state: "active", columns: DEFAULT_COLUMNS }], automations: { agents_can_close: true } } as unknown as ProjectView;
  const privateProject = { channel: "p-private", state: "active", private: true, name: "Secret plans", prefix: "PRIVATE" } as ProjectView;
  const source: StewardSource = {
    project: async () => project,
    cards: async () => [{ ...card, column: "todo", short: "11111111" } as CardView],
    timeline: async () => [],
    agents: async () => [{ handle: "alex", hostname: "box", agent: "build", effective_state: "working", status: { task: "PRIVATE-9 confidential acquisition | PUB-1" } }],
    owners: async () => ["alex"], linear: async () => null,
    privatePhrases: async (target) => privatePhrasesFor(target, [project, privateProject], async (p) => p === privateProject
      ? [{ ...card, channel: p.channel, key: "PRIVATE-9", title: "PRIVATE-9 confidential acquisition", state: "open" } as CardView]
      : []),
  };
  const result = await gather(source, "PUB", { now, repos: [], staleHours: 24 });
  expect(result.input.evidence.get(card.id)?.agents[0]?.text).not.toContain("confidential acquisition");
  const comment = planSteward(result.input).moves[0]?.comment ?? "";
  expect(comment).toContain("PUB-1");
  expect(comment).not.toContain("confidential acquisition");
  expect(comment).not.toContain("PRIVATE-9");
});

test("private names cannot turn a comment into a done or review signal, but genuine signals keep safe evidence", async () => {
  const project = { prefix: "PUB", paths: [], boards: [{ id: card.board, state: "active", columns: DEFAULT_COLUMNS }], automations: { agents_can_close: true } } as unknown as ProjectView;
  const comments = [
    ["Atlas released: we can start the launch page now", null],
    ["Atlas shipped yesterday, so this card is unblocked. Still a week of work here.", null],
    ["Rotate the vault keys done on the other board; this one has not started", null],
    ["Atlas review is ready for the other board", null],
    ["Done: Atlas launch page shipped", "done"],
    ["Done: Atlas launch and Rotate the vault keys page shipped", "done"],
    [`Done: ${"launch page ".repeat(7)}Atlas shipped`, "done"],
    ["Review requested: Atlas launch page", "review"],
  ] as const;
  for (const [text, expected] of comments) {
    const source: StewardSource = {
      project: async () => project,
      cards: async () => [{ ...card, column: text.toLowerCase().includes("review") ? "todo" : "doing", short: "11111111" } as CardView],
      timeline: async () => [{ id: "comment", ts: now - 2 * 3_600_000, kind: "comment", author: person, text }],
      agents: async () => [], owners: async () => ["alex"], linear: async () => null,
      privatePhrases: async () => ({ phrases: ["Atlas", "Rotate the vault keys"], prefixes: ["ATL"] }),
    };
    const result = await gather(source, "PUB", { now, repos: [], staleHours: 24 });
    const input = text.toLowerCase().includes("review") ? { ...result.input, evidence: new Map([[card.id, {
      ...result.input.evidence.get(card.id)!, branches: [{ repo: "test", branch: "lane/pub-1", own_commits: 1, last_commit_at: now - 3_600_000, merged_into: null }],
    }]]) } : result.input;
    const move = planSteward(input).moves[0];
    expect(move?.rule ?? null).toBe(expected);
    if (expected) {
      expect(move?.comment).not.toContain("Atlas");
      expect(move?.comment).not.toContain("Rotate the vault keys");
      expect(move?.comment).toContain("(private name removed)");
      if (text === "Done: Atlas launch page shipped") expect(move?.comment).toContain('"Done: (private name removed) launch page shipped"');
      if (text === "Review requested: Atlas launch page") expect(move?.comment).toContain('"Review requested: (private name removed) launch page"');
      if (text.includes("launch and")) expect(move?.comment).toContain("launch and");
    }
  }
});

test("a stale error is read as written and its blocked reason is safe", async () => {
  const project = { prefix: "PUB", paths: [], boards: [{ id: card.board, state: "active", columns: DEFAULT_COLUMNS }], automations: { agents_can_close: true } } as unknown as ProjectView;
  const source: StewardSource = {
    project: async () => project,
    cards: async () => [{ ...card, short: "11111111" } as CardView],
    timeline: async () => [{ id: "comment", ts: now - 3 * 3_600_000, kind: "comment", author: person, text: "Atlas error: investigation ongoing" }],
    agents: async () => [], owners: async () => ["alex"], linear: async () => null,
    privatePhrases: async () => ({ phrases: ["Atlas error"], prefixes: [] }),
  };
  const gathered = await gather(source, "PUB", { now, repos: [], staleHours: 1 });
  const input = { ...gathered.input, evidence: new Map([[card.id, { ...gathered.input.evidence.get(card.id)!, branches: [] }]]) };
  const move = planSteward(input).moves[0];
  expect(move?.rule).toBe("stale");
  expect(move?.blocked_reason).toContain("(private name removed)");
  expect(move?.comment).not.toContain("Atlas");
});

test("real steward runs ignore an unrelated private release and safely post a genuine completion", async () => {
  const cleanups: (() => void)[] = [];
  const t = reportsWorld(cleanups);
  try {
    const web = await t.project("Website", "WEB", { off: true });
    const priv = await t.project("Atlas", "ATL", { off: true, private: true });
    t.card(priv, "Rotate the vault keys", { column: "doing" });
    const c = t.card(web, "Build the launch page");
    t.idx.flushAll();
    t.tick(3_600_000); cardAction({ ...t.w, agent: "cc-build" } as WriteCtx, c.id, "start");
    t.tick(2 * 3_600_000); comment(t.w, c.id, "Atlas released: we can start the launch page now");
    t.tick(2 * 3_600_000);
    const deps = { core: t.core, idx: t.idx, sync: {}, client: {}, catchUp: async () => {}, peersCapable: () => null } as unknown as StewardDeps;
    const result = await runSteward(deps, web.channel, { caller: "person", dryRun: false });
    t.idx.flushAll();
    expect(result.applied).toEqual([]);
    expect(t.idx.db.card(c.id)?.column).toBe("doing");
    t.tick(3_600_000); comment(t.w, c.id, "Done: Atlas launch page shipped");
    t.tick(3_600_000);
    const completed = await runSteward(deps, web.channel, { caller: "person", dryRun: false });
    t.idx.flushAll();
    expect(completed.applied).toEqual([c.key]);
    expect(t.idx.db.card(c.id)?.column).toBe("done");
    const posted = t.core.store.db.query<{ body: string | null }, [string]>("SELECT body FROM events WHERE channel = ? ORDER BY rowid DESC LIMIT 3").all(web.channel)
      .map((row) => { try { return (JSON.parse(row.body ?? "{}") as { text?: string }).text ?? ""; } catch { return ""; } })
      .find((text) => text.startsWith("Board steward")) ?? "";
    expect(posted).toContain("(private name removed)");
    expect(posted).toContain('"Done: (private name removed) launch page shipped"');
    expect(posted).not.toContain("Atlas");
  } finally {
    for (const clean of cleanups.reverse()) clean();
  }
});

test("audit status is classified as written even when its private title is scrubbed", async () => {
  const project = { prefix: "PUB", paths: [], boards: [{ id: card.board, state: "active", columns: DEFAULT_COLUMNS }], automations: { agents_can_close: true } } as unknown as ProjectView;
  const source: StewardSource = {
    project: async () => project,
    cards: async () => [{ ...card, column: "todo", short: "11111111" } as CardView],
    timeline: async () => [],
    agents: async () => [{ handle: "alex", hostname: "box", agent: "cc-audit", effective_state: "working", status: { task: "PUB-1 Atlas audit" } }],
    owners: async () => ["alex"], linear: async () => null,
    privatePhrases: async () => ({ phrases: ["Atlas audit"], prefixes: [] }),
  };
  const gathered = await gather(source, "PUB", { now, repos: [], staleHours: 24 });
  expect(gathered.input.evidence.get(card.id)?.agents[0]?.auditor).toBe(true);
  expect(gathered.input.evidence.get(card.id)?.agents[0]?.text).not.toContain("Atlas");
});
