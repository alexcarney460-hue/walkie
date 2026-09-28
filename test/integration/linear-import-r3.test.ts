// Audit round 3 (Codex r2 FAIL) regressions. Every daemon, credential and Linear workspace here is a disposable fixture.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { selectionOf, type PlanOptions } from "../../src/integrations/linear-import/plan.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { FakeLinear, type FProject, type FTeam } from "../helpers/fake-linear.ts";

const KEY = "fake-linear-round-three-key";
let cluster: Cluster, alex: TestNode, lin: FakeLinear, team: FTeam, project: FProject;

beforeEach(async () => {
  lin = new FakeLinear();
  team = lin.team("AUD", "Audit");
  project = lin.project(team, "Audit project");
  cluster = new Cluster();
  alex = await cluster.add({ name: "alex", login: "alex@example.com", linearImport: { url: lin.serve(), tickMs: 3_600_000 } });
  await alex.client().init("acme", "alex");
});
afterEach(async () => { await cluster.close(); lin.stop(); });

async function run(options: Partial<PlanOptions> = {}) {
  const { plan } = await alex.client().linearImportPlan({ options, key: KEY });
  const { job } = await alex.client().linearImportRun({ selection: selectionOf(plan), key: KEY });
  const done = await waitFor(async () => {
    const s = await alex.client().linearImportStatus();
    return s.job?.id === job.id && !["running", "waiting"].includes(s.job.state) ? s.job : null;
  }, { timeoutMs: 60_000, what: "import" });
  expect(done.state).toBe("done");
  return { plan, job: done };
}
async function cards(channel: string) {
  alex.d.projects.flushAll();
  return (await alex.client().project(channel)).cards;
}
const sync = (two_way = true) => alex.client().linearSync({ key: KEY, two_way });
const OLD = "2020-01-01T00:00:00.000Z";

test("HIGH 1: a column fallback on the Walkie board is recorded as shown, so two-way sync never writes it to Linear", async () => {
  // An earlier import's board without an In review column; one adopted card, one new issue, both In Review in Linear.
  const columns = [{ id: "backlog", name: "Backlog", role: "backlog" }, { id: "todo", name: "To do", role: "todo" },
    { id: "doing", name: "Doing", role: "active" }, { id: "done", name: "Done", role: "done" }] as const;
  const { project: target } = await alex.client().createProject({ name: "Legacy", prefix: "LEG", columns });
  const adopted = lin.issue(team, project, "Adopted in review", "In Review");
  await alex.client().createTask({ project: "LEG", title: `[${adopted.identifier}] Adopted in review`, column: "todo" });
  const fresh = lin.issue(team, project, "New in review", "In Review");
  await run();
  const list = await cards(target.channel);
  expect(list.map((c) => c.column).sort()).toEqual(["doing", "doing"]); // the board's fallback for review
  for (const id of [adopted.id, fresh.id]) expect(alex.d.linearImport.state().cards[id]?.snap?.w.place).toBe("active");
  lin.update(adopted.identifier, () => ({ description: "unrelated edit" }));
  lin.update(fresh.identifier, () => ({ description: "unrelated edit" }));
  const res = (await sync()).result;
  expect(res.to_linear).toBe(0);
  expect(lin.count("WalkieImportSetState")).toBe(0);
  expect([adopted, fresh].map((i) => i.state.name)).toEqual(["In Review", "In Review"]);
});

test("HIGH 2: issues read by a pass whose batch failed are read again after the watermark moved past them", async () => {
  const issue = lin.issue(team, project, "Rename me", "Todo", { updatedAt: OLD });
  const { job } = await run();
  const channel = job.projects[0]!.channel;
  lin.update(issue.identifier, () => ({ title: "Renamed in Linear" }));
  const added = lin.issue(team, project, "Created during the outage", "Todo");
  const core = alex.d.core;
  const emit = core.emit.bind(core);
  core.emit = ((kind: string, ...rest: unknown[]) => {
    if (kind === "msg.post") throw new Error("disk full (test)");
    return (emit as (...a: unknown[]) => unknown)(kind, ...rest);
  }) as typeof core.emit;
  try {
    expect((await sync(false)).result.errors).toHaveLength(1);
  } finally { core.emit = emit; }
  expect(alex.d.linearImport.state().sync.retry?.sort()).toEqual([issue.id, added.id].sort());
  // Both changes now lie before the watermark minus the overlap: only the retry list can bring them back.
  issue.updatedAt = OLD;
  added.updatedAt = OLD;
  const res = (await sync(false)).result;
  expect(res.errors).toEqual([]);
  expect(res.updated).toBe(1);
  expect(res.created).toBe(1);
  expect((await cards(channel)).map((c) => c.title).sort()).toEqual([`[${added.identifier}] Created during the outage`, `[${issue.identifier}] Renamed in Linear`].sort());
  expect(alex.d.linearImport.state().sync.retry).toEqual([]);
});

test("MEDIUM 3: cancel and daemon shutdown stop a running two-way sync before its next Linear write", async () => {
  const issues = ["One", "Two", "Three"].map((t) => lin.issue(team, project, t, "Todo", { updatedAt: OLD }));
  const { job } = await run();
  const channel = job.projects[0]!.channel;
  await alex.client().batch(channel, (await cards(channel)).map((c) => ({ op: "update", card: c.id, column: "done" })));
  const watermark = alex.d.linearImport.state().sync.watermark;
  const answer = lin.answer.bind(lin);
  let stopper: () => void = () => alex.d.linearImport.cancel();
  lin.answer = (query, vars) => {
    const r = answer(query, vars);
    if (query.includes("mutation WalkieImportSetState")) stopper();
    return r;
  };
  try {
    await expect(sync()).rejects.toMatchObject({ code: "cancelled" });
    expect(lin.count("WalkieImportSetState")).toBe(1);
    expect(alex.d.linearImport.state().sync.watermark).toBe(watermark);
    // The same through shutdown (stop), on the production path.
    stopper = () => alex.d.linearImport.stop();
    await sync().catch(() => undefined);
    expect(lin.count("WalkieImportSetState")).toBe(2);
  } finally { lin.answer = answer; }
  await alex.restart();
  const res = (await sync()).result;
  expect(res.to_linear).toBe(1);
  expect(issues.every((i) => i.state.type === "completed")).toBe(true);
  expect(lin.count("WalkieImportSetState")).toBe(3);
});

test("MEDIUM 5: a team-filtered plan imports and syncs only that team's issues, also from a shared project", async () => {
  const other = lin.team("OTH", "Other");
  const shared = lin.project(team, "Shared", { teams: { nodes: [team, other] } });
  lin.issue(team, shared, "Ours", "Todo");
  lin.issue(other, shared, "Theirs", "Todo");
  const { plan, job } = await run({ team: "AUD", projects: ["Shared"] });
  expect(plan.projects.flatMap((p) => p.issues.map((i) => i.title))).toEqual(["Ours"]);
  expect(job.errors).toEqual([]);
  expect(job.created).toBe(1);
  const channel = job.projects.find((p) => p.name === "Shared")!.channel;
  lin.issue(other, shared, "Theirs, later", "Todo");
  lin.issue(team, shared, "Ours, later", "Todo");
  const res = (await sync(false)).result;
  expect(res.created).toBe(1);
  expect((await cards(channel)).map((c) => c.title.replace(/^\[[A-Z]+-\d+\] /, "")).sort()).toEqual(["Ours", "Ours, later"]);
});
