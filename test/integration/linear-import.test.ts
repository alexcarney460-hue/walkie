// LINEAR-IMPORT-1 (ALE-5390): one-command Linear migration across two daemons, against a fake Linear GraphQL server
// over real HTTP. alex (owner, roster authority) imports; bob (member) must fold the same boards from the replicated
// posts. Covers: dry run (agents allowed), people-only runs and batches, the batch's atomicity and budget, idempotent
// re-runs, recovery from the signed log when the map is lost, resume after a daemon stop mid-import, one-way and
// two-way sync with the conflict rule, new issues, the schedule, and that the key never leaves.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient, WalkieError } from "../../src/client/index.ts";
import type { CardView } from "../../src/protocol/projects/schema.ts";
import { selectionOf, type Plan } from "../../src/integrations/linear-import/plan.ts";
import { assignKeys, foldBoards, foldCard, foldProject, type OpEvent } from "../../src/protocol/projects/fold.ts";
import { opEventOf } from "../../src/daemon/projects/db.ts";
import { Cluster, TEST_LIMITS, waitFor, type TestNode } from "../helpers/cluster.ts";
import { FakeLinear, type FProject, type FTeam } from "../helpers/fake-linear.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

const KEY = "fake-linear-key-7c1e9b2d4a";
const CLI = join(import.meta.dir, "../../src/cli/main.ts");

let c: Cluster;
let alex: TestNode, bob: TestNode;
let lin: FakeLinear;
let url: string;
let team: FTeam, web: FProject, api: FProject, old: FProject;
let keyFile: string;

async function walkie(node: TestNode, args: string[], env: Record<string, string> = {}) {
  return runAsPerson([process.execPath, CLI, ...args], { PATH: process.env.PATH ?? "", NO_COLOR: "1", HOME: process.env.HOME ?? "/tmp", WALKIE_HOME: node.home, WALKIE_SOCKET: node.socket, ...env }, 60_000);
}

const agentOf = (n: TestNode) => new WalkieClient({ socket: n.socket, agent: "cc-import", timeoutMs: 30_000 });

async function cards(n: TestNode, channel: string): Promise<CardView[]> {
  n.d.projects.flushAll();
  return (await n.client().project(channel, { deleted: true })).cards;
}

/** A board as plain data (for replica comparison). */
async function board(n: TestNode, channel: string): Promise<string> {
  const list = await cards(n, channel);
  return JSON.stringify(list.sort((a, b) => a.n - b.n).map((x) => [x.key, x.title, x.column, x.pos, x.state, x.labels.join(","), x.assignee, x.estimate, x.due, x.comments]));
}

async function converged(channel: string): Promise<string> {
  let last = "";
  await waitFor(async () => {
    const [a, b] = await Promise.all([board(alex, channel), board(bob, channel)]);
    last = `${a.slice(0, 200)}\n${b.slice(0, 200)}`;
    return a === b && a !== "[]" ? a : null;
  }, { timeoutMs: 30_000, what: `bob converges on ${channel} (${last})` });
  return board(alex, channel);
}

async function runJob(n: TestNode, plan: Plan, key: { key?: string; key_file?: string } = { key: KEY }) {
  const { job } = await n.client().linearImportRun({ selection: selectionOf(plan), ...key });
  const done = await waitFor(async () => {
    const s = await n.client().linearImportStatus();
    return s.job && s.job.id === job.id && s.job.state !== "running" && s.job.state !== "waiting" ? s.job : null;
  }, { timeoutMs: 60_000, what: "import job finishes" });
  return done;
}

function cardOf(list: CardView[], ident: string): CardView {
  const x = list.find((c) => c.title.startsWith(`[${ident}]`));
  if (!x) throw new Error(`no card for ${ident}`);
  return x;
}

beforeAll(async () => {
  lin = new FakeLinear();
  url = lin.serve();
  team = lin.team("KES", "Kestrel");
  lin.users.push({ id: "u-alex", name: "Alex Example", displayName: "alex", email: "alex@example.com", active: true });
  web = lin.project(team, "Website relaunch", { initiatives: { nodes: [{ name: "Growth" }] } });
  api = lin.project(team, "Public API");
  old = lin.project(team, "Old CRM migration", { state: "completed", completedAt: lin.now() });
  const alexUser = { id: "u-alex", name: "Alex Example", displayName: "alex", email: "alex@example.com" };
  const ghost = { id: "u-ghost", name: "Ghost Contractor", displayName: "ghost", email: "ghost@elsewhere.example" };
  lin.issue(team, web, "Pricing page copy", "Todo", { assignee: alexUser, labels: { nodes: [{ name: "copy" }] }, priority: 2, estimate: 3, dueDate: "2026-10-15" });
  const parent = lin.issue(team, web, "Checkout redesign", "In Progress", { assignee: ghost });
  lin.issue(team, web, "Checkout: address form", "In Review", { parent: { id: parent.id, identifier: parent.identifier } });
  lin.issue(team, web, "Hero video", "Backlog", { description: "é".repeat(20_000), comments: { nodes: [{ body: "Needs the final cut.", createdAt: lin.now(), user: { name: "Maren Okafor" } }] }, history: { nodes: [{ createdAt: lin.now(), actor: { name: "Maren Okafor" }, fromState: { name: "Todo" }, toState: { name: "Backlog" }, fromAssignee: null, toAssignee: null }] } });
  lin.issue(team, web, "Hero  video!", "Backlog"); // a near-duplicate title
  lin.issue(team, web, "Cookie banner", "Done", { completedAt: lin.now() });
  lin.issue(team, web, "Legacy footer", "Canceled", { canceledAt: lin.now() });
  lin.issue(team, api, "Rate limits", "Todo");
  lin.issue(team, api, "Webhooks v2", "In Progress");
  lin.issue(team, api, "Old SDK cleanup", "Backlog", { updatedAt: "2026-01-02T00:00:00.000Z" }); // stale
  lin.issue(team, null, "Loose idea without a project", "Todo");
  lin.issue(team, old, "CRM leftovers", "Todo");

  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", linearImport: { url, tickMs: 3_600_000 } });
  bob = await c.add({ name: "bob", login: "bob@example.com", hostname: "bobs-mbp", linearImport: { url, tickMs: 3_600_000 } });
  await alex.client().init("acme", "alex");
  await alex.client().invite("bob@example.com", "bob", "member");
  expect((await bob.client().join(alex.peerAddr)).admitted).toBe(true);
  const dir = mkdtempSync("/tmp/walkie-lk-");
  keyFile = join(dir, "linear.key");
  writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
}, 60_000);

afterAll(async () => {
  await c.close();
  lin.stop();
});

let plan: Plan;
let webCh = "";
let apiCh = "";

describe("dry run", () => {
  test("an agent may plan: projects, columns, flags; nothing is written", async () => {
    const before = alex.d.core.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n;
    const res = await agentOf(alex).linearImportPlan({ options: { stale_days: 60 }, key: KEY });
    plan = res.plan;
    expect(alex.d.core.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(before);
    const names = plan.projects.map((p) => p.name);
    expect(names).toContain("Website relaunch");
    expect(names).toContain("Kestrel: no project");
    const w = plan.projects.find((p) => p.name === "Website relaunch")!;
    expect(w.folder).toBe("Growth"); // initiative
    expect(w.prefix).toBe("WR");
    expect(w.include).toBe(true);
    // open issues only by default: Done and Canceled are not read
    expect(w.counts).toEqual({ backlog: 2, todo: 1, doing: 1, review: 1, done: 0, canceled: 0 });
    expect(w.issues.find((i) => i.title === "Hero  video!")?.flags.some((f) => f.startsWith("duplicate_of:"))).toBe(true);
    expect(w.issues.find((i) => i.title === "Pricing page copy")?.assignee).toBe("alex");
    expect(plan.unmapped_users).toEqual(["Ghost Contractor"]);
    const a = plan.projects.find((p) => p.name === "Public API")!;
    expect(a.issues.find((i) => i.title === "Old SDK cleanup")?.flags).toContain("stale");
    const o = plan.projects.find((p) => p.name === "Old CRM migration")!;
    expect(o.flags).toContain("completed");
    expect(o.include).toBe(false);
    expect(lin.calls.every((x) => x.auth === KEY)).toBe(true);
  });

  test("with --include-closed the done and canceled issues are planned too", async () => {
    const { plan: p } = await alex.client().linearImportPlan({ options: { include_closed: true, projects: ["Website relaunch"] }, key: KEY });
    expect(p.projects.map((x) => x.name)).toEqual(["Website relaunch"]);
    expect(p.projects[0]!.counts.done).toBe(1);
    expect(p.projects[0]!.counts.canceled).toBe(1);
  });

  test("no key anywhere: 409 with how to give one; a bad key file: 400 naming the problem, never its content", async () => {
    await expect(alex.client().linearImportPlan({ options: {} })).rejects.toMatchObject({ code: "not_configured" });
    const loose = join(mkdtempSync("/tmp/walkie-lk-"), "k");
    writeFileSync(loose, KEY, { mode: 0o644 });
    chmodSync(loose, 0o644);
    const err = await alex.client().linearImportPlan({ options: {}, key_file: loose }).catch((e: WalkieError) => e);
    expect(err).toBeInstanceOf(WalkieError);
    expect((err as WalkieError).message).toContain("accessible to other users");
    expect((err as WalkieError).message).not.toContain(KEY);
  });
});

describe("people only", () => {
  test("an agent can't start an import, sync, schedule it or write a batch", async () => {
    const ag = agentOf(alex);
    await expect(ag.linearImportRun({ selection: selectionOf(plan), key: KEY })).rejects.toMatchObject({ status: 403 });
    await expect(ag.linearSync({ key: KEY })).rejects.toMatchObject({ status: 403 });
    await expect(ag.linearSyncSettings({ enabled: true })).rejects.toMatchObject({ status: 403 });
    const under = new WalkieClient({ socket: alex.socket, underAgent: true });
    await expect(under.linearImportRun({ selection: selectionOf(plan), key: KEY })).rejects.toMatchObject({ status: 403 });
  });
});

describe("import", () => {
  test("a person imports the plan: projects, columns, labels, assignees, parents, bodies, digests; bob folds the same boards", async () => {
    const job = await runJob(alex, plan);
    expect(job.state).toBe("done");
    expect(job.errors).toEqual([]);
    expect(job.created).toBe(9); // 5 web + 3 api + 1 without a project (Old CRM is unticked; Done/Canceled not read)
    const projects = (await alex.client().projects()).projects;
    const w = projects.find((p) => p.name === "Website relaunch")!;
    webCh = w.channel;
    apiCh = projects.find((p) => p.name === "Public API")!.channel;
    expect(w.prefix).toBe("WR");
    expect(w.folder).toBe("Growth");
    expect(w.boards[0]!.columns.map((x) => x.name)).toEqual(["Backlog", "To do", "In progress", "In review", "Done", "Canceled"]);
    expect(projects.some((p) => p.name === "Old CRM migration")).toBe(false);
    const list = await cards(alex, webCh);
    const pricing = cardOf(list, "KES-1");
    expect(pricing.column).toBe("todo");
    expect(pricing.labels).toEqual(["copy", "linear", "high"]);
    expect(pricing.assignee).toBe("@alex");
    expect(pricing.estimate).toBe(3);
    expect(pricing.due).toBe("2026-10-15");
    expect(pricing.body).toContain("https://linear.app/kestrel/issue/KES-1");
    const checkout = cardOf(list, "KES-2");
    expect(checkout.column).toBe("doing");
    expect(checkout.assignee).toBeNull();
    expect(checkout.body).toContain("Assignee in Linear: Ghost Contractor");
    const child = cardOf(list, "KES-3");
    expect(child.column).toBe("review");
    expect(child.body).toContain(`Parent: KES-2 (${checkout.key}`);
    const hero = cardOf(list, "KES-4");
    expect(hero.body).toContain("[cut: the full description is in Linear");
    expect(hero.comments).toBe(1); // the history + comments digest
    // Every post is an ordinary board op within the 16 KB cap.
    const sizes = alex.d.core.store.db.query<{ n: number }, [string]>("SELECT length(CAST(body AS BLOB)) AS n FROM events WHERE channel = ? AND json_extract(body, '$.board.op') = 'card'").all(webCh);
    expect(Math.max(...sizes.map((s) => s.n))).toBeLessThanOrEqual(16_384);
    const a = await converged(webCh);
    expect(a).toContain("KES-4");
    await converged(apiCh);
  });

  test("the card roots carry ext (ignored by the fold): bob's board is the same without reading it", async () => {
    const roots = alex.d.core.store.db.query<{ e: string }, [string]>("SELECT json_extract(body, '$.board.ext.id') AS e FROM events WHERE channel = ? AND thread IS NULL AND json_extract(body, '$.board.op') = 'card'").all(webCh);
    expect(roots.every((r) => typeof r.e === "string" && r.e.startsWith("iss-kes-"))).toBe(true);
  });

  test("fold determinism: the imported posts fold to the same board in any order", () => {
    const rows = alex.d.core.store.db.query<{ json: string; status: string }, [string]>("SELECT json, status FROM events WHERE channel = ? AND kind = 'msg.post'").all(webCh);
    const evs = rows.map((r) => opEventOf(r.json, r.status !== "ok"));
    const env = alex.d.projects.env(webCh);
    const fold = (xs: OpEvent[]): string => {
      const p = foldProject(xs, env);
      const boards = foldBoards(xs, env, p);
      const ctx = { boards: new Map(boards.map((b) => [b.id, b])) };
      const folded = xs.filter((x) => !x.thread && (x.board as { op?: string } | undefined)?.op === "card")
        .map((r) => foldCard(r, xs.filter((x) => x.thread === r.id), ctx)).filter((x) => x !== null);
      const keys = assignKeys(folded.map((x) => ({ id: x.id, ts: x.created_at, n: x.n_proposed })));
      return JSON.stringify(folded.map((x) => [x.id, keys.get(x.id), x.title, x.column, x.pos, x.state, x.labels, x.comments]).sort());
    };
    const base = fold(evs);
    expect(base).toContain("[KES-1]");
    for (let k = 0; k < 8; k++) {
      const shuffled = [...evs].map((e) => ({ e, r: Math.random() })).sort((a, b) => a.r - b.r).map((x) => x.e);
      expect(fold(shuffled)).toBe(base);
    }
  });

  test("re-running creates nothing twice and updates only what Linear changed", async () => {
    lin.update("KES-1", () => ({ title: "Pricing page copy (v2)" }));
    const events = alex.d.core.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n;
    const { plan: again } = await alex.client().linearImportPlan({ options: {}, key: KEY });
    expect(again.totals.creates).toBe(0);
    const job = await runJob(alex, again);
    expect(job.created).toBe(0);
    expect(job.updated).toBe(1);
    const after = alex.d.core.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n;
    expect(after - events).toBe(1); // one card op, nothing else
    expect(cardOf(await cards(alex, webCh), "KES-1").title).toBe("[KES-1] Pricing page copy (v2)");
  });

  test("a lost import map: the next run finds its cards in the signed log (ext), no duplicates", async () => {
    alex.d.linearImport.resetState();
    const { plan: again } = await alex.client().linearImportPlan({ options: {}, key: KEY });
    expect(again.totals.creates).toBe(0);
    expect(again.projects.find((p) => p.name === "Website relaunch")?.target?.channel).toBe(webCh);
    const job = await runJob(alex, again);
    expect(job.created).toBe(0);
    expect((await cards(alex, webCh)).length).toBe(5);
    expect(Object.keys(alex.d.linearImport.state().cards).length).toBe(9);
  });
});

describe("adoption of an earlier import", () => {
  test("an earlier script import is adopted by its [KEY-n] cards (this person's only), never duplicated", async () => {
    const leg = lin.team("LEG", "Legacy");
    const lp = lin.project(leg, "Legacy board");
    const i1 = lin.issue(leg, lp, "First legacy", "Todo");
    const i2 = lin.issue(leg, lp, "Second legacy", "In Progress");
    const i3 = lin.issue(leg, lp, "Third legacy", "Backlog");
    const { project } = await alex.client().createProject({ name: "legacy board (script)", prefix: "LEGS" });
    await alex.client().createTask({ project: "LEGS", title: `[${i1.identifier}] First legacy`, column: "todo" });
    await alex.client().createTask({ project: "LEGS", title: `[${i2.identifier}] Second legacy`, column: "doing" });
    await waitFor(() => { bob.d.projects.flushAll(); return (bob.d.projects.project(project.channel)?.boards.length ?? 0) > 0; }, { timeoutMs: 20_000, what: "bob sees the project and its board" });
    await bob.client().createTask({ project: project.channel, title: `[${i3.identifier}] Third legacy`, column: "backlog" }); // a teammate's look-alike
    await waitFor(async () => (await cards(alex, project.channel)).length === 3, { timeoutMs: 20_000, what: "alex has bob's card" });
    const { plan: p } = await alex.client().linearImportPlan({ options: { team: "LEG" }, key: KEY });
    const legacy = p.projects.find((x) => x.name === "Legacy board")!;
    expect(legacy.target?.channel).toBe(project.channel);
    expect(legacy.flags).toContain("adopt:2");
    expect(legacy.issues.filter((i) => i.existing).map((i) => i.identifier).sort()).toEqual([i1.identifier, i2.identifier].sort());
    const job = await runJob(alex, p);
    expect(job.created).toBe(1); // only i3: bob's look-alike is not trusted as alex's import
    const list = await cards(alex, project.channel);
    expect(list.length).toBe(4);
    expect(list.filter((x) => x.title.startsWith(`[${i1.identifier}]`)).length).toBe(1);
    expect(list.filter((x) => x.title.startsWith(`[${i3.identifier}]`)).length).toBe(2);
    expect(alex.d.linearImport.state().cards[i1.id]?.card).toBe(list.find((x) => x.title.startsWith(`[${i1.identifier}]`))!.id);
  });
});

describe("the board ops batch", () => {
  test("atomic: a batch with one bad op signs nothing", async () => {
    const seq = alex.d.core.store.allocatedSelfSeq(alex.d.nodeId);
    const ops = [
      { op: "create", title: "one", column: "todo" }, { op: "create", title: "two", column: "todo" },
      { op: "create", title: "three", column: "no-such-column" },
    ];
    await expect(alex.client().batch(apiCh, ops)).rejects.toMatchObject({ status: 400 });
    expect(alex.d.core.store.allocatedSelfSeq(alex.d.nodeId)).toBe(seq);
    const res = await alex.client().batch(apiCh, [...ops.slice(0, 2), { op: "comment", card: "#0", text: "first comment" }]);
    expect(res.batch.created.map((x) => x.key)).toEqual(["PA-4", "PA-5"]);
    expect(res.batch.comments[0]!.card).toBe(res.batch.created[0]!.id);
    expect(res.batch.events).toBe(3);
  });

  test("atomic inside the transaction too: a failure signing op 2 of 3 leaves no post, no card, no push; the seqs are reused", async () => {
    const core = alex.d.core;
    const seq = core.store.allocatedSelfSeq(alex.d.nodeId);
    const count = () => core.store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE channel = ?").get(apiCh)!.n;
    const before = count();
    const real = core.emit.bind(core);
    let n = 0;
    core.emit = ((kind: string, body: unknown, opts: unknown) => {
      if (kind === "msg.post" && ++n === 2) throw new Error("disk full (test)");
      return (real as (k: string, b: unknown, o: unknown) => unknown)(kind, body, opts);
    }) as typeof core.emit;
    try {
      const ops = ["x1", "x2", "x3"].map((title) => ({ op: "create", title, column: "todo" }));
      await expect(alex.client().batch(apiCh, ops)).rejects.toMatchObject({ status: 500 });
    } finally {
      core.emit = real;
    }
    expect(core.store.allocatedSelfSeq(alex.d.nodeId)).toBe(seq);
    expect(count()).toBe(before);
    expect((await cards(alex, apiCh)).some((x) => x.title === "x1")).toBe(false);
    const res = await alex.client().batch(apiCh, [{ op: "create", title: "y1", column: "todo" }]);
    expect(res.batch.created[0]!.id).toBe(`${alex.d.nodeId}:${seq + 1}`);
    await waitFor(async () => (await cards(bob, apiCh)).some((x) => x.title === "y1"), { timeoutMs: 20_000, what: "bob gets y1" });
    expect((await cards(bob, apiCh)).some((x) => x.title === "x1")).toBe(false);
  });

  test("the import budget: a batch beyond it answers 429 with retry_after_s, and nothing is signed", async () => {
    const small = await c.add({ name: "carol", login: "carol@example.com", hostname: "carol-mbp", limits: { ...TEST_LIMITS, importWrite: { capacity: 3, perSecond: 0.01 } } });
    await alex.client().invite("carol@example.com", "carol", "member");
    expect((await small.client().join(alex.peerAddr)).admitted).toBe(true);
    await waitFor(() => { small.d.projects.flushAll(); return (small.d.projects.project(apiCh)?.boards.length ?? 0) > 0; }, { timeoutMs: 20_000, what: "carol sees the project and its board" });
    const ops = Array.from({ length: 4 }, (_, i) => ({ op: "create", title: `c${i}`, column: "todo" }));
    const err = await small.client().batch(apiCh, ops).catch((e: WalkieError) => e);
    expect(err).toMatchObject({ status: 429, code: "rate_limited" });
    expect(((err as WalkieError & { details?: Record<string, unknown> }).message)).toContain("retry in");
    const ok = await small.client().batch(apiCh, ops.slice(0, 3));
    expect(ok.batch.created.length).toBe(3);
  });
});

describe("sync", () => {
  test("one-way: Linear moves and renames reach the card; bob sees it", async () => {
    lin.move("KES-2", "In Review");
    lin.update("KES-8", () => ({ title: "Rate limits per key" }));
    const { result } = await alex.client().linearSync({ key: KEY });
    expect(result.updated).toBe(2);
    expect(result.to_linear).toBe(0);
    expect(cardOf(await cards(alex, webCh), "KES-2").column).toBe("review");
    await waitFor(async () => cardOf(await cards(bob, apiCh), "KES-8").title === "[KES-8] Rate limits per key", { timeoutMs: 20_000, what: "bob sees the rename" });
  });

  test("a card moved in Walkie stays put one-way; two-way sets the Linear state (and only for mapped cards)", async () => {
    const card = cardOf(await cards(alex, apiCh), "KES-9");
    await alex.client().updateTask(card.id, { column: "done" });
    const before = lin.count("WalkieImportSetState");
    await alex.client().linearSync({ key: KEY });
    expect(lin.count("WalkieImportSetState")).toBe(before);
    expect(lin.issues.find((i) => i.identifier === "KES-9")?.state.name).toBe("In Progress");
    const { result } = await alex.client().linearSync({ key: KEY, two_way: true });
    expect(result.to_linear).toBe(1);
    expect(lin.issues.find((i) => i.identifier === "KES-9")?.state.name).toBe("Done");
    // stable: a second pass writes nothing more
    const again = await alex.client().linearSync({ key: KEY, two_way: true });
    expect(again.result.to_linear).toBe(0);
    expect(again.result.updated).toBe(0);
  });

  test("both sides changed: the latest change wins and the card gets a note", async () => {
    const card = cardOf(await cards(alex, webCh), "KES-5");
    await alex.client().updateTask(card.id, { column: "doing" }); // Walkie, now
    lin.setNow(new Date(Date.now() + 60_000).toISOString());
    lin.move("KES-5", "Todo"); // Linear, a minute later
    const { result } = await alex.client().linearSync({ key: KEY, two_way: true });
    expect(result.conflicts).toBe(1);
    const after = cardOf(await cards(alex, webCh), "KES-5");
    expect(after.column).toBe("todo");
    const detail = await alex.client().task(after.id);
    expect(detail.timeline.some((t) => t.kind === "comment" && (t.text ?? "").includes("changed on both sides"))).toBe(true);
  });

  test("a new Linear issue in an imported project becomes a card; an unticked one never does", async () => {
    lin.issue(team, api, "GraphQL gateway", "Todo");
    const { result } = await alex.client().linearSync({ key: KEY });
    expect(result.created).toBe(1);
    expect(cardOf(await cards(alex, apiCh), "KES-13").column).toBe("todo");
  });

  test("the schedule needs a key it can keep; it syncs when due and records the result", async () => {
    await expect(alex.client().linearSyncSettings({ enabled: true })).rejects.toMatchObject({ code: "not_configured" });
    const { sync } = await alex.client().linearSyncSettings({ enabled: true, interval_min: 5, key_file: keyFile });
    expect(sync).toMatchObject({ enabled: true, key: "key_file", interval_min: 5 });
    lin.move("KES-1", "In Progress");
    await alex.d.linearImport.tick(Date.now() + 10 * 60_000);
    expect(cardOf(await cards(alex, webCh), "KES-1").column).toBe("doing");
    const s = await alex.client().linearImportStatus();
    expect(s.sync.last_result).toContain("updated 1");
    expect(JSON.stringify(s)).not.toContain(KEY);
    await alex.client().linearSyncSettings({ enabled: false });
  });
});

describe("resume and secrecy", () => {
  test("a daemon stopped mid-import resumes without duplicates", async () => {
    const t2 = lin.team("OPS", "Operations");
    const p1 = lin.project(t2, "Fleet");
    const p2 = lin.project(t2, "Depots");
    for (let i = 0; i < 30; i++) lin.issue(t2, p1, `Fleet task ${i}`, "Todo");
    for (let i = 0; i < 30; i++) lin.issue(t2, p2, `Depot task ${i}`, "Backlog");
    const { plan: p } = await alex.client().linearImportPlan({ options: { team: "OPS" }, key: KEY });
    let release!: () => void;
    const reached = new Promise<void>((r) => { lin.onGate = r; });
    lin.gate = new Promise<void>((r) => { release = r; });
    lin.gateOp = "WalkieImportIssuesFull";
    lin.gateWhen = (v) => JSON.stringify(v).includes(p1.id); // plan order: Depots, then Fleet
    await alex.client().linearImportRun({ selection: selectionOf(p), key: KEY });
    await reached;
    await alex.restart(); // Depots imported, Fleet in flight
    release();
    lin.gate = null;
    const { job } = await alex.client().linearImportResume({ key: KEY });
    const done = await waitFor(async () => { const s = await alex.client().linearImportStatus(); return s.job?.id === job.id && s.job.state === "done" ? s.job : null; }, { timeoutMs: 60_000, what: "resume" });
    expect(done.created).toBe(30); // only Fleet: Depots was imported before the stop
    const projects = (await alex.client().projects()).projects;
    for (const name of ["Fleet", "Depots"]) {
      const ch = projects.find((x) => x.name === name)!.channel;
      const list = await cards(alex, ch);
      expect(list.length).toBe(30);
      expect(new Set(list.map((x) => x.title)).size).toBe(30);
    }
  }, 120_000);

  test("the key never reaches a response, the import map, the log or the signed log", async () => {
    lin.echoAuth = true;
    lin.failWith = 401;
    const err = await alex.client().linearImportPlan({ options: {}, key: KEY }).catch((e: WalkieError) => e);
    lin.failWith = null;
    lin.echoAuth = false;
    expect(err).toBeInstanceOf(WalkieError);
    expect((err as WalkieError).message).not.toContain(KEY);
    const map = readFileSync(join(alex.home, "linear-import.json"), "utf8");
    expect(map).not.toContain(KEY);
    expect(map).toContain(keyFile); // the schedule keeps the path only
    const log = existsSync(join(alex.home, "logs", "daemon.log")) ? readFileSync(join(alex.home, "logs", "daemon.log"), "utf8") : "";
    expect(log).not.toContain(KEY);
    const signed = alex.d.core.store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE json LIKE ?").get(`%${KEY}%`)?.n;
    expect(signed).toBe(0);
  });
});

describe("CLI", () => {
  test("dry run writes an editable plan; --plan imports what is still ticked; agents are refused the run", async () => {
    const t3 = lin.team("MKT", "Marketing");
    const pa = lin.project(t3, "Launch video");
    const pb = lin.project(t3, "Newsletter");
    lin.issue(t3, pa, "Storyboard", "Todo");
    lin.issue(t3, pb, "September issue", "Todo");
    const dir = mkdtempSync("/tmp/walkie-plan-");
    const out = join(dir, "plan.json");
    const dry = await walkie(alex, ["import", "linear", "--dry-run", "--team", "MKT", "--key-file", keyFile, "-o", out]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("Launch video");
    expect(dry.out).toContain("plan written to");
    expect(existsSync(out.replace(/\.json$/, ".txt"))).toBe(true);
    const edited = JSON.parse(readFileSync(out, "utf8")) as Plan;
    edited.projects = edited.projects.map((p) => (p.name === "Newsletter" ? { ...p, include: false } : p));
    writeFileSync(out, JSON.stringify(edited));
    const agent = await walkie(alex, ["import", "linear", "--plan", out, "--yes", "--key-file", keyFile], { CLAUDECODE: "1" });
    expect(agent.code).not.toBe(0);
    expect(agent.err + agent.out).toContain("agents can't");
    const run = await walkie(alex, ["import", "linear", "--plan", out, "--yes", "--key-file", keyFile]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("imported in");
    const names = (await alex.client().projects()).projects.map((p) => p.name);
    expect(names).toContain("Launch video");
    expect(names).not.toContain("Newsletter");
    const st = await walkie(alex, ["import", "linear", "--status"]);
    expect(st.out).toContain("Linear import");
    expect(st.out + st.err).not.toContain(KEY);
  }, 120_000);
});
