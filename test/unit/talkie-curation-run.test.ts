// TALKIE-OPS-1, the card curation over a real core and board index: the steward's evidence gathered from the daemon's own boards and
// agents, its plan turned into recommendations, and not one card moved by the duty. A pass that has nothing new writes nothing;
// a big team is worked through oldest-planned first inside a budget; one project that fails does not stop the others.
import { afterEach, describe, expect, test } from "bun:test";
import { CURATION_BUDGET_MS, askTargetOf, prepareCardCuration, type CurationDeps } from "../../src/daemon/orchestrator/curation.ts";
import { createRec, openRecs, readRecs } from "../../src/daemon/orchestrator/recs.ts";
import { comment, updateCard, updateProject } from "../../src/daemon/projects/service.ts";
import type { AgentView } from "../../src/protocol/schemas.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { recsWorld } from "../helpers/talkie-recs.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const H = 3_600_000;

function setup(extra: Partial<CurationDeps> = {}) {
  const t = recsWorld(cleanups);
  const agents: AgentView[] = [];
  const source = { read: (): readonly AgentView[] => agents };
  const deps: CurationDeps = { ...t.deps, agents: () => source.read(), ...extra };
  const run = (canAct: () => boolean = () => true) => prepareCardCuration(deps, canAct);
  const count = (sql: string) => t.core.store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM events WHERE ${sql}`).get()?.n ?? 0;
  const skip = async (canAct?: () => boolean) => ((await run(canAct)) as { skip: string }).skip;
  return { t, agents, source, deps, run, skip, count };
}

describe("the steward's plan, recommended and never applied", () => {
  test("a card reported finished is recommended to Done, and not one card op is written", async () => {
    const { t, skip, count } = setup();
    const p = await t.project("Website", "WEB", { off: true });
    const c = t.card(p, "Fix the login page", { column: "doing" });
    comment(t.w, c.id, "Done: merged into main");
    t.idx.flushAll();
    const ops = count("channel LIKE 'p-%' AND json_extract(body, '$.board') IS NOT NULL");
    const line = await skip();
    expect(count("channel LIKE 'p-%' AND json_extract(body, '$.board') IS NOT NULL")).toBe(ops);
    expect(count("author_agent = 'steward'")).toBe(0);
    expect(t.idx.db.card(c.id)?.column).toBe("doing");
    expect(readRecs(t.deps)).toMatchObject([{
      kind: "move_card", group: "moves", source: "curation", audience: "team", channel: p.channel, status: "pending",
      action: { kind: "move_card", card: c.id, from: "doing", to: "done" },
      summary: "Move “Fix the login page” to Done", reason: "A recent update says it is finished.",
    }]);
    expect(line).toBe("Card curation: checked 1 of 1 project; recommendations 1 new, 0 already open.");
  });

  test("an agent working on a to-do card: recommended to In progress", async () => {
    const { t, agents, skip } = setup();
    const p = await t.project("Website", "WEB", { off: true });
    const c = t.card(p, "Write the onboarding guide");
    agents.push(t.agent("cc-9", c.key));
    await skip();
    expect(openRecs(t.deps)).toMatchObject([{ summary: "Move “Write the onboarding guide” to In progress", reason: "An agent is working on it.", action: { to: "doing" } }]);
  });

  test("a pass that finds the same again writes nothing, and one whose card has moved retires the recommendation", async () => {
    const { t, skip, count } = setup();
    const p = await t.project("Website", "WEB", { off: true });
    const c = t.card(p, "Fix the login page", { column: "doing" });
    comment(t.w, c.id, "Done: merged into main");
    await skip();
    const before = count("1 = 1");
    t.tick(7 * 60_000);
    expect(await skip()).toContain("recommendations 0 new, 1 already open.");
    expect(count("1 = 1")).toBe(before);
    updateCard(t.w, c.id, { column: "done" });
    t.idx.flushAll();
    t.tick(7 * 60_000);
    expect(await skip()).toContain("1 retired");
    expect(openRecs(t.deps)).toEqual([]);
  });

  test("a person's move holds the card against a recommendation for a day (the steward's own pin)", async () => {
    const { t, skip } = setup();
    const p = await t.project("Website", "WEB", { off: true });
    const c = t.card(p, "Fix the login page");
    updateCard(t.w, c.id, { column: "doing" });
    comment(t.w, c.id, "Done: merged into main");
    t.idx.flushAll();
    expect(await skip()).toContain("recommendations 0 new, 0 already open. The steward left 1 held");
  });

  test("a project whose steward is switched off is left alone, and the result says so", async () => {
    const { t, skip } = setup();
    const p = await t.project("Website", "WEB", { off: true });
    const c = t.card(p, "Fix the login page", { column: "doing" });
    comment(t.w, c.id, "Done: merged into main");
    await updateProject(t.w, p.channel, { steward: "off" });
    t.idx.flushAll();
    const line = await skip();
    expect(readRecs(t.deps)).toEqual([]);
    expect(line).toContain("checked 0 of 0 projects");
    expect(line).toContain("1 project has the steward switched off");
  });
});

describe("the bottlenecks the steward does not move", () => {
  test("a card that has waited in review with nobody on it: ask its creator (a person here) to review it", async () => {
    const { t, skip } = setup();
    const p = await t.project("Website", "WEB", { off: true });
    const c = t.card(p, "Check the refund flow");
    updateCard({ ...t.w, agent: "cc-9" }, c.id, { column: "review" });
    t.idx.flushAll();
    t.tick(5 * H);
    await skip();
    expect(openRecs(t.deps)).toMatchObject([{
      kind: "ask_orchestrator", group: "reviews", summary: "Ask alex to review “Check the refund flow”", reason: "It has waited 5 hours for review and nobody is on it.",
      action: { kind: "ask_orchestrator", to: "@alex", topic: "review", card: c.id },
    }]);
  });

  test("an active card with nobody on it and no change for a day: asked about, in the Stalled group", async () => {
    const { t, skip } = setup();
    const p = await t.project("Website", "WEB", { off: true });
    t.card(p, "Migrate the billing job", { column: "doing" });
    t.tick(30 * H);
    await skip();
    expect(openRecs(t.deps)).toMatchObject([{ group: "stalled", summary: "Ask alex about “Migrate the billing job”", reason: expect.stringContaining("Nothing has changed for 30 hours") }]);
  });

  test("a card with a seat recommendation already open is not also asked about", async () => {
    const { t, skip } = setup();
    const p = await t.project("Website", "WEB", { off: true });
    const c = t.card(p, "Check the refund flow");
    updateCard({ ...t.w, agent: "cc-9" }, c.id, { column: "review" });
    t.idx.flushAll();
    t.tick(5 * H);
    createRec(t.deps, t.seatRec(c), p.channel);
    await skip();
    expect(openRecs(t.deps).map((r) => r.kind)).toEqual(["start_seat"]);
  });
});

describe("who may see it", () => {
  test("a confidential card's recommendation, and any card of a private project's, go to the owners' channel", async () => {
    const { t, skip } = setup();
    const open = await t.project("Website", "WEB", { off: true });
    const secret = await t.project("Ops", "OPS", { off: true, private: true });
    const a = t.card(open, "Plan the layoffs", { column: "doing", labels: ["confidential"] });
    const b = t.card(secret, "Rotate the keys", { column: "doing" });
    const c = t.card(open, "Fix the login page", { column: "doing" });
    for (const card of [a, b, c]) comment(t.w, card.id, "Done: merged into main");
    t.idx.flushAll();
    await skip();
    const by = Object.fromEntries(readRecs(t.deps).map((r) => [(r.action as { card: string }).card, [r.audience, r.channel]]));
    expect(by[a.id]).toEqual(["owners", SCHEDULE_CHANNEL]);
    expect(by[b.id]).toEqual(["owners", SCHEDULE_CHANNEL]);
    expect(by[c.id]).toEqual(["team", open.channel]);
  });
});

describe("many projects and one that fails", () => {
  test("a pass over its budget stops and says how many it reached; the next pass takes the ones it did not", async () => {
    const { t, skip, count } = setup({ budgetMs: 0 });
    const events = () => count("1 = 1");
    const projects = [];
    for (let i = 0; i < 3; i++) {
      const p = await t.project(`P${i}`, `PX${i}`, { off: true });
      comment(t.w, t.card(p, `Work ${i}`, { column: "doing" }).id, "Done: merged into main");
      projects.push(p);
    }
    t.idx.flushAll();
    const reached = async () => {
      const line = await skip();
      t.tick(7 * 60_000);
      return line;
    };
    expect(CURATION_BUDGET_MS).toBe(90_000);
    expect(await reached()).toContain("checked 1 of 3 projects, the rest next time; recommendations 1 new");
    expect(openRecs(t.deps).map((r) => r.project)).toEqual([projects[0]!.channel]);
    expect(await reached()).toContain("checked 1 of 3 projects, the rest next time; recommendations 1 new, 0 already open");
    expect(await reached()).toContain("checked 1 of 3 projects, the rest next time; recommendations 1 new, 0 already open");
    expect(openRecs(t.deps)).toHaveLength(3);
    // The fourth pass starts again with the oldest planned (the first project): its recommendation is already open, nothing is written.
    const before = events();
    expect(await reached()).toContain("checked 1 of 3 projects, the rest next time; recommendations 0 new, 1 already open");
    expect(events()).toBe(before);
  });

  test("one project failing is counted and does not stop the others", async () => {
    let calls = 0;
    const { t, source, skip } = setup();
    source.read = () => { if (++calls === 1) throw new Error("boom"); return []; };
    const first = await t.project("First", "FST", { off: true });
    const second = await t.project("Second", "SND", { off: true });
    for (const p of [first, second]) comment(t.w, t.card(p, `Work ${p.prefix}`, { column: "doing" }).id, "Done: merged into main");
    t.idx.flushAll();
    const line = await skip();
    expect(line).toContain("checked 1 of 2 projects (1 failed)");
    expect(openRecs(t.deps).map((r) => r.project)).toEqual([second.channel]);
  });

  test("a lost lease stops the pass before anything is written", async () => {
    const { t, run, count } = setup();
    const p = await t.project("Website", "WEB", { off: true });
    comment(t.w, t.card(p, "Fix the login page", { column: "doing" }).id, "Done: merged into main");
    t.idx.flushAll();
    const before = count("1 = 1");
    await expect(run(() => false)).rejects.toThrow("lease expired");
    expect(count("1 = 1")).toBe(before);
  });
});

describe("who is asked", () => {
  const author = { handle: "alex", node: "fedcba9876543210" };
  test("the reviewer for a review, else the assignee, else the creator; the agent when it is one, else the person", () => {
    const t = recsWorld(cleanups);
    const core = t.core;
    const asked = (card: Partial<{ assignee: string | null; reviewer: string | null; created_by: typeof author & { agent?: string } }>, about: "review" | "status") =>
      askTargetOf(core, { assignee: null, reviewer: null, created_by: author, ...card }, about);
    expect(asked({ reviewer: "@kira/mbp/cc-2", assignee: "@maren" }, "review")).toEqual({ to: "@kira/mbp/cc-2", label: "agent cc-2 for kira" });
    expect(asked({ reviewer: "@kira/mbp/cc-2", assignee: "@maren" }, "status")).toEqual({ to: "@maren", label: "maren" });
    expect(asked({ assignee: "@maren/mbp" }, "status")).toEqual({ to: "@maren", label: "maren" });
    expect(asked({}, "status")).toEqual({ to: "@alex", label: "alex" });
    expect(asked({ created_by: { ...author, agent: "cc-1" } }, "status")).toEqual({ to: "@alex", label: "alex" }); // its machine is not in the roster here: the person
    expect(asked({ assignee: "not an address" }, "status")).toEqual({ to: "@alex", label: "alex" });
  });
});
