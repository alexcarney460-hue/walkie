// Audit r1 regressions. Every daemon and credential here is a disposable fixture.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient } from "../../src/client/index.ts";
import { selectionOf, type Selection } from "../../src/integrations/linear-import/plan.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { FakeLinear, type FProject, type FTeam } from "../helpers/fake-linear.ts";

const KEY = "fake-linear-round-two-key";
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

async function run(edit: (s: Selection) => Selection = (s) => s): Promise<string> {
  const { plan } = await alex.client().linearImportPlan({ options: {}, key: KEY });
  const { job } = await alex.client().linearImportRun({ selection: edit(selectionOf(plan)), key: KEY });
  const done = await waitFor(async () => {
    const s = await alex.client().linearImportStatus();
    return s.job?.id === job.id && !["running", "waiting"].includes(s.job.state) ? s.job : null;
  }, { timeoutMs: 60_000, what: "audit import" });
  expect(done.state).toBe("done");
  expect(done.errors).toEqual([]);
  return alex.d.linearImport.state().projects[project.id]!.channel;
}
async function cards(channel: string) {
  alex.d.projects.flushAll();
  return (await alex.client().project(channel)).cards;
}
const sync = () => alex.client().linearSync({ key: KEY, two_way: true });

test("205 moves survive the per-project cap, restart and unrelated Linear edits", async () => {
  for (let n = 0; n < 205; n++) lin.issue(team, project, `Task ${n}`, "Todo", { updatedAt: "2020-01-01T00:00:00.000Z" });
  const channel = await run();
  await alex.client().batch(channel, (await cards(channel)).map((c) => ({ op: "update", card: c.id, column: "done" })));
  expect((await sync()).result.to_linear).toBe(200);
  await alex.restart(); // the remaining five are older than the overlap, so only pending Walkie changes fetch them
  expect((await sync()).result.to_linear).toBe(5);
  expect(lin.issues.filter((i) => i.state.type === "completed")).toHaveLength(205);
  for (const issue of lin.issues) lin.update(issue.identifier, () => ({ description: "Unrelated edit" }));
  expect((await sync()).result.updated).toBe(0);
  expect((await cards(channel)).filter((c) => c.column !== "done")).toHaveLength(0);
}, 120_000);

test.each([
  ["review", "In Review", "Todo", "active"],
  ["backlog", "Backlog", "In Progress", "todo"],
] as const)("%s fallback records the returned Linear role and keeps the Walkie move", async (column, missing, initial, role) => {
  const issue = lin.issue(team, project, "Fallback", initial);
  lin.states = lin.states.filter((s) => s.name !== missing);
  const channel = await run();
  const card = (await cards(channel))[0]!;
  await alex.client().updateTask(card.id, { column });
  expect((await sync()).result.to_linear).toBe(1);
  expect(alex.d.linearImport.state().cards[issue.id]?.snap?.l.place).toBe(role);
  lin.update(issue.identifier, () => ({ description: "Unrelated edit" }));
  const again = (await sync()).result;
  expect(again.to_linear).toBe(0);
  expect(again.updated).toBe(0);
  expect((await cards(channel))[0]!.column).toBe(column);
});

test("a missing workflow state keeps the old snapshot and retries after it is restored", async () => {
  const issue = lin.issue(team, project, "No completed state", "Todo", { updatedAt: "2020-01-01T00:00:00.000Z" });
  const channel = await run();
  const before = alex.d.linearImport.state().cards[issue.id];
  await alex.client().updateTask((await cards(channel))[0]!.id, { column: "done" });
  const states = lin.states;
  lin.states = states.filter((s) => s.type !== "completed");
  expect((await sync()).result.errors).toHaveLength(1);
  expect(alex.d.linearImport.state().cards[issue.id]).toEqual(before);
  lin.states = states;
  expect((await sync()).result.to_linear).toBe(1);
  expect(issue.state.type).toBe("completed");
});

test("a refused mutation keeps the old snapshot and retries outside the overlap", async () => {
  const issue = lin.issue(team, project, "Refused mutation", "Todo", { updatedAt: "2020-01-01T00:00:00.000Z" });
  const channel = await run();
  const before = alex.d.linearImport.state().cards[issue.id];
  await alex.client().updateTask((await cards(channel))[0]!.id, { column: "done" });
  const answer = lin.answer.bind(lin);
  lin.answer = (query, vars) => query.includes("mutation WalkieImportSetState")
    ? { issueUpdate: { success: false, issue: null } } : answer(query, vars);
  expect((await sync()).result.errors).toHaveLength(1);
  expect(alex.d.linearImport.state().cards[issue.id]).toEqual(before);
  lin.answer = answer;
  expect((await sync()).result.to_linear).toBe(1);
  expect(issue.state.type).toBe("completed");
});

test("cancelling after one Linear write leaves the remaining record pending for the next pass", async () => {
  const issues = ["First", "Second"].map((title) => lin.issue(team, project, title, "Todo", { updatedAt: "2020-01-01T00:00:00.000Z" }));
  const channel = await run();
  await alex.client().batch(channel, (await cards(channel)).map((c) => ({ op: "update", card: c.id, column: "done" })));
  const service = alex.d.linearImport;
  const before = service.state().cards[issues[1]!.id];
  const ctrl = new AbortController();
  const counters = { created: 0, updated: 0, unchanged: 0, comments: 0, skipped: 0, events: 0, to_linear: 0 };
  const answer = lin.answer.bind(lin);
  lin.answer = (query, vars) => {
    const result = answer(query, vars);
    if (query.includes("mutation WalkieImportSetState")) ctrl.abort();
    return result;
  };
  try {
    await service["applyIssues"]({ channel, projectKey: project.id, teamId: team.id }, structuredClone(issues), {
      create: true, twoWay: true, api: { fetch: lin.fetch, key: KEY, secrets: () => [KEY] }, states: lin.states,
      explicit: new Map(), walkie: service["walkieSide"](), signal: ctrl.signal, counters, errors: [],
    });
  } finally { lin.answer = answer; }
  expect(counters.to_linear).toBe(1);
  expect(service.state().cards[issues[1]!.id]).toEqual(before);
  expect((await sync()).result.to_linear).toBe(1);
  expect(lin.issues.every((i) => i.state.type === "completed")).toBe(true);
});

test("a fallback already equal to Linear is acknowledged without a mutation or a later bounce", async () => {
  const issue = lin.issue(team, project, "Already started", "In Progress");
  lin.states = lin.states.filter((s) => s.name !== "In Review");
  const channel = await run();
  await alex.client().updateTask((await cards(channel))[0]!.id, { column: "review" });
  expect((await sync()).result.to_linear).toBe(0);
  expect(lin.count("WalkieImportSetState")).toBe(0);
  expect(alex.d.linearImport.state().cards[issue.id]?.snap).toMatchObject({ l: { place: "active" }, w: { place: "review" } });
  expect((await sync()).result.updated).toBe(0);
  expect((await cards(channel))[0]!.column).toBe("review");
});

test("adoption is selected, person-only, read-only toward Linear and preserves titles", async () => {
  lin.issue(team, project, "Seed", "Todo");
  const excluded = lin.issue(team, project, "Unticked", "Todo");
  const channel = await run((s) => ({ ...s, projects: s.projects.map((p) => ({ ...p, exclude: [excluded.id] })) }));
  const personIssue = lin.issue(team, project, "Person issue", "Todo", { updatedAt: new Date(Date.now() - 60_000).toISOString() });
  const agentIssue = lin.issue(team, project, "Agent issue", "Todo", { updatedAt: new Date(Date.now() - 60_000).toISOString() });
  const person = (await alex.client().createTask({ project: channel, title: `[${personIssue.identifier}] Keep this title`, column: "done" })).task;
  const skipped = (await alex.client().createTask({ project: channel, title: `[${excluded.identifier}] Unticked card`, column: "done" })).task;
  const unmapped = (await alex.client().createTask({ project: channel, title: "Independent card", column: "done" })).task;
  const agent = new WalkieClient({ socket: alex.socket, agent: "cc-audit" });
  const agentCard = (await agent.createTask({ project: channel, title: `[${agentIssue.identifier}] Agent card`, column: "doing" })).task;
  const result = (await sync()).result;
  expect(result.to_linear).toBe(0);
  expect(lin.count("WalkieImportSetState")).toBe(0);
  const state = alex.d.linearImport.state();
  expect(state.cards[excluded.id]).toBeUndefined();
  expect(state.cards[personIssue.id]?.card).toBe(person.id);
  expect(state.cards[agentIssue.id]?.card).not.toBe(agentCard.id);
  const after = await cards(channel);
  expect(after.find((c) => c.id === person.id)).toMatchObject({ title: person.title, column: "todo" });
  expect(after.find((c) => c.id === skipped.id)).toEqual(skipped);
  expect(after.find((c) => c.id === agentCard.id)).toEqual(agentCard);
  expect(after.find((c) => c.id === unmapped.id)).toEqual(unmapped);
  const detail = await alex.client().task(person.id);
  expect(detail.timeline.some((t) => t.kind === "comment" && /first adoption/i.test(t.text ?? ""))).toBe(true);
  expect((await sync()).result.to_linear).toBe(0);
  await alex.client().updateTask(person.id, { column: "done" });
  expect((await sync()).result.to_linear).toBe(1);
});

test("an unticked imported project does not adopt new look-alikes", async () => {
  lin.issue(team, project, "Seed", "Todo");
  const channel = await run();
  await run((s) => ({ ...s, projects: s.projects.map((p) => ({ ...p, include: false })) }));
  const issue = lin.issue(team, project, "Unticked project issue", "Todo");
  const { task } = await alex.client().createTask({ project: channel, title: `[${issue.identifier}] Leave alone`, column: "done" });
  expect((await sync()).result.to_linear).toBe(0);
  expect(alex.d.linearImport.state().cards[issue.id]).toBeUndefined();
  expect((await cards(channel)).find((c) => c.id === task.id)).toEqual(task);
});

test("named agents and under-agent callers are refused on the batch route", async () => {
  const { project: p } = await alex.client().createProject({ name: "Batch", prefix: "BAT" });
  for (const opts of [{ agent: "cc-audit" }, { underAgent: true }]) {
    const agent = new WalkieClient({ socket: alex.socket, ...opts });
    await expect(agent.batch(p.channel, [{ op: "create", title: "Refused", column: "todo" }])).rejects.toMatchObject({ status: 403 });
  }
  expect(await cards(p.channel)).toHaveLength(0);
});

test("agent dry runs refuse arbitrary secret files and accept only the configured Linear key path", async () => {
  const keyFile = join(alex.home, "linear-test.key");
  const other = join(alex.home, "other-test.key");
  writeFileSync(keyFile, KEY, { mode: 0o600 });
  writeFileSync(other, "fake-unrelated-credential", { mode: 0o600 });
  alex.d.integrations.configure("linear", { enabled: true, channel: "general", key_path: keyFile });
  for (const opts of [{ agent: "cc-audit" }, { underAgent: true }]) {
    const agent = new WalkieClient({ socket: alex.socket, ...opts });
    const before = lin.calls.length;
    await expect(agent.linearImportPlan({ options: {}, key_file: other })).rejects.toMatchObject({ status: 403 });
    expect(lin.calls.length).toBe(before);
    await agent.linearImportPlan({ options: {}, key_file: keyFile });
  }
  expect(lin.calls.every((c) => c.auth === KEY)).toBe(true);
});

test("dry runs share a bounded budget even when agent names change", async () => {
  let limited = false;
  for (let n = 0; n < 12; n++) {
    const agent = new WalkieClient({ socket: alex.socket, agent: `cc-plan-${n}` });
    try { await agent.linearImportPlan({ options: {}, key: KEY }); }
    catch (err) { expect(err).toMatchObject({ status: 429, code: "rate_limited" }); limited = true; break; }
  }
  expect(limited).toBe(true);
});
