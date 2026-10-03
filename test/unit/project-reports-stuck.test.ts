// PROJECT-REPORTS-1: a project whose reports keep failing (the model never writes a usable one, or the post is refused)
// pauses on its own after GIVE_UP_AFTER tries, until it changes again, instead of making every hour's turn run for it and
// keeping the duty alive (and the model busy) through a sibling that changes now and then. Stuck projects wait behind the
// ones that have not failed, and a run that delivered something, or whose only failures are projects it paused, is not a
// failure of the duty itself, so a crowd of stuck projects cannot pause the duty and with it a live project's reports.
import { afterEach, describe, expect, test } from "bun:test";
import { prepareFor } from "../../src/daemon/orchestrator/host.ts";
import { Schedules, type ScheduleRunner } from "../../src/daemon/orchestrator/schedules.ts";
import { readReportFailures, REPORT_FAILURES_META } from "../../src/daemon/orchestrator/report-times.ts";
import { noteReportFailure } from "../../src/daemon/orchestrator/report-times.ts";
import { prepareProjectReports } from "../../src/daemon/projects/status-report.ts";
import { updateCard, updateProject } from "../../src/daemon/projects/service.ts";
import type { PreparedTurn, SkippedTurn } from "../../src/daemon/orchestrator/prepared.ts";
import { GIVE_UP_AFTER, summarizeRun } from "../../src/protocol/projects/status-report.ts";
import { reportsWorld } from "../helpers/project-reports.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const H = 3_600_000;
const BODY = "**On track:** things happened this hour in the project.\n\n## Done\n- Something.";
const block = (channel: string, body: string) => `<status-report project="${channel}">\n${body}\n</status-report>`;
const turn = (r: PreparedTurn | SkippedTurn): PreparedTurn => {
  if ("skip" in r) throw new Error(`expected a turn, got a skip: ${r.skip}`);
  return r;
};
const sheetsIn = (r: PreparedTurn): string[] => [...r.evidence.matchAll(/=== PROJECT (p-[0-9a-f]{8}) ===/g)].map((m) => m[1] as string);

/** One hourly run for the world: the next time it is due, prepared, and the model's reply (`reply(prepared)`) delivered. */
async function run(t: ReturnType<typeof reportsWorld>, reply: (r: PreparedTurn) => string) {
  t.tick(H);
  const r = await prepareProjectReports(t.deps, () => true);
  if ("skip" in r) return { skipped: r.skip, projects: [] as string[], outcome: null };
  return { skipped: null, projects: sheetsIn(r), outcome: r.finish?.({ text: reply(r), ok: true }, t.wall()) ?? null };
}
const none = () => "I could not write that report.";
/** The status reports posted in a project's channel. */
const reportsPosted = (t: ReturnType<typeof reportsWorld>, channel: string): number =>
  t.core.store.queryEvents({ channel, kinds: ["msg.post"], limit: 200 }).filter((r) => (JSON.parse(r.json) as { body: { status_report?: unknown } }).body.status_report !== undefined).length;

describe("a project that keeps failing", () => {
  test(`is tried ${GIVE_UP_AFTER} times, then waits: nothing is asked of the model for it until it changes`, async () => {
    const t = reportsWorld(cleanups);
    const stuck = await t.project("Stuck", "STK");
    t.card(stuck, "Stuck card");
    for (let n = 1; n <= GIVE_UP_AFTER; n++) {
      const r = await run(t, none);
      expect(r.projects).toEqual([stuck.channel]);
      // The tries before the last are failures of the run; the last is the project's own pause, which the run does not count against the duty.
      expect(r.outcome).toMatchObject({ ok: n === GIVE_UP_AFTER });
    }
    for (let n = 0; n < 5; n++) {
      const r = await run(t, none);
      expect(r.projects).toEqual([]);
      expect(r.skipped).toBe(`No changes since the last report (1 project checked); no model turn. 1 project is paused until it changes: its last ${GIVE_UP_AFTER} reports could not be used.`);
    }
  });

  test("is tried again, once, when it changes, and waits again if that fails too", async () => {
    const t = reportsWorld(cleanups);
    const stuck = await t.project("Stuck", "STK");
    const card = t.card(stuck, "Stuck card");
    for (let n = 1; n <= GIVE_UP_AFTER; n++) await run(t, none);
    expect((await run(t, none)).projects).toEqual([]);
    t.tick();
    updateCard(t.w, card.id, { column: "doing" });
    const again = await run(t, none);
    expect(again.projects).toEqual([stuck.channel]);
    expect(again.outcome).toMatchObject({ ok: true }); // a woken project that fails again pauses again: its own count, not the duty's
    expect((await run(t, none)).projects).toEqual([]);
    updateCard(t.w, card.id, { column: "review" });
    // This time the model writes it: reported, and the project is back to normal for good.
    const ok = await run(t, (r) => block(stuck.channel, BODY));
    expect(ok.projects).toEqual([stuck.channel]);
    expect(ok.outcome).toEqual({ text: "Reported 1 of 1 changed project.", ok: true });
    expect(readReportFailures(t.core).size).toBe(0);
    updateCard(t.w, card.id, { column: "done" });
    expect((await run(t, none)).projects).toEqual([stuck.channel]); // due on its change like any project; failure count starts again
    expect(readReportFailures(t.core).get(stuck.channel)?.n).toBe(1);
  });

  test("is not paused by failures that were not in a row: a delivery in between starts the count again", async () => {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB");
    const card = t.card(web, "Pricing page");
    const move = (column: string) => updateCard(t.w, card.id, { column });
    await run(t, none);
    await run(t, none);
    expect(readReportFailures(t.core).get(web.channel)?.n).toBe(2);
    await run(t, (r) => block(web.channel, BODY)); // a report at last
    expect(readReportFailures(t.core).size).toBe(0);
    for (const column of ["doing", "review", "done"]) {
      move(column);
      const r = await run(t, none);
      expect(r.projects).toEqual([web.channel]); // each change is tried: two failures, then the third, never paused before then
    }
    expect(readReportFailures(t.core).get(web.channel)?.n).toBe(GIVE_UP_AFTER);
    move("todo");
    expect((await run(t, none)).projects).toEqual([web.channel]); // paused, then changed: tried once more
  });

  test("a post that is refused counts as a failure, one switched off while the turn ran does not", async () => {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB");
    const ops = await t.project("Ops", "OPS");
    t.card(web, "Pricing page");
    t.card(ops, "Pager rota");
    const emit = t.core.emit.bind(t.core);
    t.core.emit = ((kind: Parameters<typeof emit>[0], body: Parameters<typeof emit>[1], opts: Parameters<typeof emit>[2]) => {
      if (opts?.channel === web.channel && (body as { status_report?: unknown }).status_report) throw new Error("channel unavailable");
      return emit(kind, body, opts);
    }) as typeof emit;
    t.tick(H);
    const prepared = turn(await prepareProjectReports(t.deps, () => true));
    await updateProject(t.w, ops.channel, { status_report: "off" }); // while the turn runs
    prepared.finish?.({ text: `${block(web.channel, BODY)}\n${block(ops.channel, BODY)}`, ok: true }, t.wall());
    expect(readReportFailures(t.core).get(web.channel)?.n).toBe(1);
    expect(readReportFailures(t.core).has(ops.channel)).toBe(false);
  });

  test("the try that pauses a project is the project's, an earlier try is the run's: only the second kind counts against the duty", async () => {
    const t = reportsWorld(cleanups);
    const old = await t.project("Old", "OLD");
    t.card(old, "Old card");
    await run(t, none);
    await run(t, none); // Old: two failed tries
    const fresh = await t.project("Fresh", "FRS");
    t.card(fresh, "Fresh card");
    const r = await run(t, none); // Old's third try, which pauses it, and Fresh's first
    expect([...r.projects].sort()).toEqual([old.channel, fresh.channel].sort());
    expect(r.outcome).toEqual({
      text: `Reported 0 of 2 changed projects; 1 had no usable report and is tried again next hour; 1 had no report that could be used ${GIVE_UP_AFTER} times in a row and is now paused until it changes.`,
      ok: false,
    });
  });

  test("a run whose every failure paused its project is not a failure of the duty, and says how many were paused; a delivery in the run is not one either", async () => {
    const t = reportsWorld(cleanups);
    const a = await t.project("A", "AAA");
    const b = await t.project("B", "BBB");
    t.card(a, "a card");
    t.card(b, "b card");
    await run(t, none);
    await run(t, none);
    const third = await run(t, none);
    expect(third.outcome).toEqual({ text: `Reported 0 of 2 changed projects; 2 had no report that could be used ${GIVE_UP_AFTER} times in a row and are now paused until they change.`, ok: true });
    // One of them woken and failing again beside one that is delivered: still ok, and the paused one is told apart.
    t.tick();
    const cardA = t.idx.db.cards(a.channel, { states: ["open"], limit: 5 })[0] as { id: string };
    updateCard(t.w, cardA.id, { column: "doing" });
    t.card(b, "another b card");
    const mixed = await run(t, (r) => block(b.channel, BODY));
    expect(mixed.outcome).toMatchObject({ ok: true });
  });

  test("a post that is refused for the third time is a pause too, and a failure that cannot be written down is still the run's failure", async () => {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB");
    t.card(web, "Pricing page");
    const emit = t.core.emit.bind(t.core);
    t.core.emit = ((kind: Parameters<typeof emit>[0], body: Parameters<typeof emit>[1], opts: Parameters<typeof emit>[2]) => {
      if (opts?.channel === web.channel && (body as { status_report?: unknown }).status_report) throw new Error("channel unavailable");
      return emit(kind, body, opts);
    }) as typeof emit;
    const outcomes = [];
    for (let n = 1; n <= GIVE_UP_AFTER; n++) outcomes.push((await run(t, (r) => block(web.channel, BODY))).outcome);
    expect(outcomes.map((o) => o?.ok)).toEqual([false, false, true]);
    expect(outcomes[GIVE_UP_AFTER - 1]?.text).toBe(`Reported 0 of 1 changed project; 1 had no report that could be used ${GIVE_UP_AFTER} times in a row and is now paused until it changes.`);
    // The same project, woken, with a failure cache that cannot be written: nothing is known about its count, so the run fails.
    const setMeta = t.core.store.setMeta.bind(t.core.store);
    t.core.store.setMeta = ((key: string, value: string) => { if (key === REPORT_FAILURES_META) throw new Error("disk full"); return setMeta(key, value); }) as typeof setMeta;
    t.tick();
    updateCard(t.w, (t.idx.db.cards(web.channel, { states: ["open"], limit: 5 })[0] as { id: string }).id, { column: "doing" });
    expect((await run(t, (r) => block(web.channel, BODY))).outcome).toEqual({ text: "Reported 0 of 1 changed project; 1 could not be posted and is tried again next hour.", ok: false });
  });

  test("a delivery that throws before its post goes out is a failed try of that project alone", async () => {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB");
    const ops = await t.project("Ops", "OPS");
    t.card(web, "Pricing page");
    t.card(ops, "Pager rota");
    const project = t.idx.project.bind(t.idx);
    t.idx.project = ((channel: string) => { if (channel === web.channel) throw new Error("index unavailable"); return project(channel); }) as typeof project;
    const r = await run(t, () => `${block(web.channel, BODY)}\n${block(ops.channel, BODY)}`);
    expect(r.outcome).toEqual({ text: "Reported 1 of 2 changed projects; 1 could not be posted and is tried again next hour.", ok: true });
    expect(readReportFailures(t.core).get(web.channel)?.n).toBe(1);
    expect(readReportFailures(t.core).has(ops.channel)).toBe(false);
  });

  test("is forgotten when it is switched off or archived: switched on again, it starts from nothing", async () => {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB");
    t.card(web, "Pricing page");
    await run(t, none);
    await run(t, none);
    expect(readReportFailures(t.core).get(web.channel)?.n).toBe(2);
    await updateProject(t.w, web.channel, { status_report: "off" });
    await run(t, none); // nothing selected: the cache is pruned
    expect(readReportFailures(t.core).size).toBe(0);
    await updateProject(t.w, web.channel, { status_report: "hourly" });
    expect((await run(t, none)).projects).toEqual([web.channel]);
    expect(readReportFailures(t.core).get(web.channel)?.n).toBe(1);
  });

  test("a failure time from a clock that ran ahead is held to this clock: the project wakes on news after now, not after then", async () => {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB");
    const card = t.card(web, "Pricing page");
    for (let n = 0; n < GIVE_UP_AFTER; n++) noteReportFailure(t.core, web.channel, t.wall() + 3 * H);
    expect(readReportFailures(t.core).get(web.channel)).toEqual({ n: GIVE_UP_AFTER, at: t.wall() });
    t.tick();
    updateCard(t.w, card.id, { column: "doing" });
    expect((await run(t, none)).projects).toEqual([web.channel]);
  });

  test("a failure time stored while the clock ran ahead is held to the clock when it is read, and when it is written", async () => {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB");
    t.core.store.setMeta(REPORT_FAILURES_META, JSON.stringify({ [web.channel]: { n: GIVE_UP_AFTER, at: t.wall() + 3 * H } }));
    expect(readReportFailures(t.core).get(web.channel)?.at).toBe(t.wall());
    noteReportFailure(t.core, web.channel, t.wall() + 3 * H);
    expect(JSON.parse(t.core.store.getMeta(REPORT_FAILURES_META) as string)[web.channel]).toEqual({ n: GIVE_UP_AFTER + 1, at: t.wall() });
  });

  test("a cache that cannot be written never undoes a delivery or fails the run", async () => {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB");
    const ops = await t.project("Ops", "OPS");
    t.card(web, "Pricing page");
    t.card(ops, "Pager rota");
    t.tick(H);
    const prepared = turn(await prepareProjectReports(t.deps, () => true));
    const setMeta = t.core.store.setMeta.bind(t.core.store);
    t.core.store.setMeta = ((key: string, value: string) => {
      if (key === REPORT_FAILURES_META) throw new Error("disk full");
      return setMeta(key, value);
    }) as typeof setMeta;
    // web gets its report, ops none: the first is posted whatever the failure cache does, the second still counts as missing.
    const out = prepared.finish?.({ text: block(web.channel, BODY), ok: true }, t.wall());
    expect(out).toEqual({ text: "Reported 1 of 2 changed projects; 1 had no usable report and is tried again next hour.", ok: true });
    const posts = t.core.store.queryEvents({ channel: web.channel, kinds: ["msg.post"], limit: 50 }).map((r) => JSON.parse(r.json) as { body: { status_report?: unknown } });
    expect(posts.filter((e) => e.body.status_report !== undefined)).toHaveLength(1);
  });

  test("the cache is only what it should be: other shapes are ignored, not trusted", async () => {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB");
    for (const junk of ["not json", "[]", '{"p-00000001":{"n":"3","at":1}}', '{"not a channel":{"n":3,"at":1}}', '{"p-00000001":{"n":-1,"at":1}}', '{"p-00000001":{"n":3,"at":1,"x":1}}']) {
      t.core.store.setMeta(REPORT_FAILURES_META, junk);
      expect(readReportFailures(t.core).size).toBe(0);
    }
    t.core.store.setMeta(REPORT_FAILURES_META, JSON.stringify({ [web.channel]: { n: 2, at: 5 } }));
    expect(readReportFailures(t.core).get(web.channel)).toEqual({ n: 2, at: 5 });
  });
});

describe("what a run says about it", () => {
  test("a run that delivers or fails says how many projects are paused, in the same plain words", () => {
    const base = { checked: 4, due: 2, reported: 1, missing: 1, deferred: 0 };
    expect(summarizeRun({ ...base, paused: 1 })).toBe(
      `Reported 1 of 2 changed projects; 1 had no usable report and is tried again next hour; 1 project is paused until it changes: its last ${GIVE_UP_AFTER} reports could not be used.`);
    expect(summarizeRun({ ...base, paused: 2 })).toContain(`2 projects are paused until they change: their last ${GIVE_UP_AFTER} reports could not be used.`);
    expect(summarizeRun({ ...base, paused: 0 })).toBe("Reported 1 of 2 changed projects; 1 had no usable report and is tried again next hour.");
    expect(summarizeRun(base)).toBe("Reported 1 of 2 changed projects; 1 had no usable report and is tried again next hour.");
  });

  test("a project this run paused is told apart from one that is tried again", () => {
    const base = { checked: 4, due: 3, reported: 0, missing: 1, deferred: 0 };
    expect(summarizeRun({ ...base, spent: 1 })).toBe(
      `Reported 0 of 3 changed projects; 1 had no usable report and is tried again next hour; 1 had no report that could be used ${GIVE_UP_AFTER} times in a row and is now paused until it changes.`);
    expect(summarizeRun({ ...base, missing: 0, spent: 2 })).toBe(
      `Reported 0 of 3 changed projects; 2 had no report that could be used ${GIVE_UP_AFTER} times in a row and are now paused until they change.`);
    expect(summarizeRun({ ...base, missing: 0, failed: 1, spent: 1, deferred: 1, paused: 2 })).toBe(
      `Reported 0 of 3 changed projects; 1 could not be posted and is tried again next hour; 1 had no report that could be used ${GIVE_UP_AFTER} times in a row and is now paused until it changes; 1 wait for the next hour; 2 projects are paused until they change: their last ${GIVE_UP_AFTER} reports could not be used.`);
    expect(summarizeRun({ ...base, spent: 0 })).toBe(summarizeRun(base));
  });
});

describe("over a day, with the real schedule", () => {
  /** The duty over the real Schedules and the real prepare step, and the model's reply, hour by hour. */
  function duty(t: ReturnType<typeof reportsWorld>) {
    const turns: string[] = [];
    let reply: { text: string; ok: boolean } | null = null;
    const runner: ScheduleRunner = {
      valid: () => true, claim: async () => true,
      prepare: (task, canAct, signal) => prepareFor({ projectReports: (c, s) => prepareProjectReports(t.deps, c, s) }, task, canAct, signal),
      turn: (prompt) => { turns.push(prompt); return `turn-${turns.length}`; },
      reply: () => { const r = reply; reply = null; return r; }, interrupt: () => {},
    };
    const schedules = new Schedules(t.core, runner);
    const s = schedules.add({ name: "Project status reports", cron: "7 * * * *", task: { template: "project-reports" } }, "alex");
    return { schedules, id: s.id, turns, setReply: (r: { text: string; ok: boolean }) => { reply = r; } };
  }

  test("a project that never yields a usable report beside one that changes every third hour: its turns stop after the third", async () => {
    const t = reportsWorld(cleanups);
    const stuck = await t.project("Stuck", "STK");
    const live = await t.project("Live", "LIV");
    t.card(stuck, "Stuck card");
    const liveCard = t.card(live, "Live card");
    const d = duty(t);
    const ran: Array<{ hour: number; has: string[] }> = [];
    let moved = 0;
    for (let h = 0; h <= 12; h++) {
      t.tick(H);
      if (h > 0 && h % 3 === 0) { updateCard(t.w, liveCard.id, { column: ["doing", "review", "done", "todo"][moved++ % 4] as string }); t.tick(1_000); }
      const before = d.turns.length;
      await d.schedules.runNow(d.id, t.wall());
      if (d.turns.length > before) {
        const prompt = d.turns[d.turns.length - 1] as string;
        const has = [stuck, live].filter((p) => prompt.includes(`=== PROJECT ${p.channel} ===`)).map((p) => p.name);
        ran.push({ hour: h, has });
        d.setReply({ text: has.includes("Live") ? block(live.channel, BODY) : "I could not write that report.", ok: true });
        await d.schedules.tick(t.wall() + 1);
      }
    }
    // Hours 0 to 2: the stuck one is tried (three failures); from hour 3 only the live one's changes ask for a turn.
    expect(ran).toEqual([
      { hour: 0, has: ["Stuck", "Live"] }, { hour: 1, has: ["Stuck"] }, { hour: 2, has: ["Stuck"] },
      { hour: 3, has: ["Live"] }, { hour: 6, has: ["Live"] }, { hour: 9, has: ["Live"] }, { hour: 12, has: ["Live"] },
    ]);
    expect(d.turns).toHaveLength(7); // thirteen hourly runs, seven model turns (it was thirteen)
    const after = d.schedules.get(d.id);
    expect([after.enabled, after.failures]).toEqual([true, 0]);
    expect(after.last_result).toContain(`1 project is paused until it changes`);
  });

  /** One hourly run: the clock moves on an hour, the duty runs, and the model (when a turn was asked for) writes a report for each project of `good` that is in the prompt and for no other. */
  async function hour(t: ReturnType<typeof reportsWorld>, d: ReturnType<typeof duty>, good: ReadonlySet<string>) {
    t.tick(H);
    if (!d.schedules.get(d.id).enabled) return { inPrompt: [] as string[], enabled: false, failures: d.schedules.get(d.id).failures, result: "(the duty is paused)" };
    const before = d.turns.length;
    await d.schedules.runNow(d.id, t.wall());
    let inPrompt: string[] = [];
    if (d.turns.length > before) {
      inPrompt = [...(d.turns[d.turns.length - 1] as string).matchAll(/=== PROJECT (p-[0-9a-f]{8}) ===/g)].map((m) => m[1] as string);
      d.setReply({ text: inPrompt.filter((c) => good.has(c)).map((c) => block(c, BODY)).join("\n") || "I could not write that report.", ok: true });
      await d.schedules.tick(t.wall() + 1);
    }
    const after = d.schedules.get(d.id);
    return { inPrompt, enabled: after.enabled, failures: after.failures, result: after.last_result ?? "" };
  }

  test("twelve projects whose reports never work beside a live one (the review's scenario): the live one is reported at the second hour, the duty is never paused, and the stuck ones end up waiting", async () => {
    const t = reportsWorld(cleanups);
    const stuck = [];
    for (let i = 0; i < 12; i++) stuck.push(await t.project(`Stuck ${i}`, `S${String.fromCharCode(65 + i)}X`));
    const live = await t.project("Live", "LIV");
    for (const p of stuck) t.card(p, "A card");
    t.card(live, "Live card");
    const d = duty(t);
    let liveAt = 0;
    const results: string[] = [];
    for (let h = 1; h <= 8; h++) {
      const r = await hour(t, d, new Set([live.channel]));
      if (!liveAt && r.inPrompt.includes(live.channel)) liveAt = h;
      expect(r.enabled).toBe(true);
      expect(r.failures).toBeLessThan(GIVE_UP_AFTER);
      results.push(r.result);
    }
    expect(liveAt).toBe(2); // the first turn takes ten projects, the live one is not among them: the stuck ones that were tried go behind it
    expect(reportsPosted(t, live.channel)).toBe(1);
    for (const p of stuck) expect(readReportFailures(t.core).get(p.channel)?.n).toBe(GIVE_UP_AFTER);
    expect(d.turns).toHaveLength(5); // failed attempts rotate too: all projects are waiting from the sixth hour
    expect(results[5]).toBe(`No changes since the last reports (13 projects checked); no model turn. 12 projects are paused until they change: their last ${GIVE_UP_AFTER} reports could not be used.`);
    expect(d.schedules.get(d.id).failures).toBe(0);
  });

  test("a stuck project that changes every hour costs a turn an hour, but it does not pause the duty and a live sibling is reported the hour it changes", async () => {
    const t = reportsWorld(cleanups);
    const stuck = await t.project("Busy and stuck", "BUS");
    const live = await t.project("Live", "LIV");
    const stuckCard = t.card(stuck, "Busy card");
    const liveCard = t.card(live, "Live card");
    const d = duty(t);
    for (let h = 1; h <= 12; h++) {
      t.tick();
      updateCard(t.w, stuckCard.id, { title: `Busy card ${h}` });
      if (h % 4 === 0) updateCard(t.w, liveCard.id, { title: `Live card ${h}` });
      const r = await hour(t, d, new Set([live.channel]));
      expect(r.enabled).toBe(true);
    }
    expect(reportsPosted(t, live.channel)).toBe(4); // the first hour, and the hours it changed: 4, 8 and 12
    expect(reportsPosted(t, stuck.channel)).toBe(0);
    expect(d.turns).toHaveLength(12);
    expect(d.schedules.get(d.id).failures).toBe(0);
  });

  test("the duty is still paused after three runs in a row that deliver nothing and fail for projects that are not yet paused", async () => {
    const t = reportsWorld(cleanups);
    const first = await t.project("First", "FST");
    t.card(first, "card");
    const d = duty(t);
    const seen: boolean[] = [];
    for (let h = 1; h <= 3; h++) {
      if (h > 1) { const more = await t.project(`Newcomer ${h}`, `NW${h}`); t.card(more, "card"); } // a new project every hour: always one on its first try
      const r = await hour(t, d, new Set());
      seen.push(r.enabled);
    }
    expect(seen).toEqual([true, true, false]);
    expect(d.schedules.get(d.id).last_result).toContain("Paused after three failures.");
  });
});
