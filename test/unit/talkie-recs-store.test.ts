// TALKIE-OPS-1 in the daemon: recommendations as signed posts, read back through the channels a member can see. A real core and
// board index for alex (owner, the lead), and members whose own daemons receive what alex's holds, so who sees what is the
// platform's channel rule, not a fake. Reconciling: made once, kept while true, retired when not, never repeated, capped.
import { afterEach, describe, expect, test } from "bun:test";
import { answerRec, createRec, mayAnswer, openRecs, readRecs, recChannels, reconcile, forgetRecs, supersedeRec, viewOf, type Desired } from "../../src/daemon/orchestrator/recs.ts";
import { DISMISS_COOLDOWN_MS, APPROVED_COOLDOWN_MS, MAX_NEW_PER_RUN, MAX_OPEN_PER_PROJECT, MAX_OPEN_TOTAL, REC_TTL_MS, READ_WINDOW_MS, recKey } from "../../src/protocol/talkie-recs.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { recsWorld } from "../helpers/talkie-recs.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const H = 3_600_000;
const events = (t: ReturnType<typeof recsWorld>): number => t.core.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;
const want = (t: ReturnType<typeof recsWorld>, channel: string, recs: Parameters<typeof t.moveRec>[0][], over = {}): Desired[] => recs.map((c) => ({ rec: t.moveRec(c, over), channel }));

describe("a recommendation is a signed post", () => {
  test("a team one is in its project's channel as WalkieTalkie, in words an older peer can show", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    const c = t.card(p, "Fix the login page");
    const id = createRec(t.deps, t.moveRec(c), p.channel);
    const event = JSON.parse(t.core.store.getRow(id)?.json as string);
    expect(event).toMatchObject({ channel: p.channel, author: { handle: "alex", agent: "orchestrator" }, kind: "msg.post" });
    expect(event.body.text).toBe("WalkieTalkie recommends: Move “Fix the login page” to review");
    expect(event.body.talkie_rec).toMatchObject({ v: 1, op: "create", key: recKey.move(c.id, "review"), audience: "team" });
    expect(readRecs(t.deps)).toMatchObject([{ id, status: "pending", project: p.channel, channel: p.channel, audience: "team", kind: "move_card" }]);
  });

  test("an owners-only one is in the owner-only schedule channel, and names its project", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Ops", "OPS", { off: true, private: true });
    const c = t.card(p, "Plan the layoffs");
    const id = createRec(t.deps, t.ownersRec(p, c), p.channel);
    expect(JSON.parse(t.core.store.getRow(id)?.json as string).channel).toBe(SCHEDULE_CHANNEL);
    expect(readRecs(t.deps)).toMatchObject([{ id, audience: "owners", project: p.channel, channel: SCHEDULE_CHANNEL }]);
    expect(viewOf(t.deps, readRecs(t.deps)[0]!).project_name).toBe("Ops");
  });

  test("a team recommendation with no project to go in is refused, and a machine's goes to the owners", () => {
    const t = recsWorld(cleanups);
    const step = { key: recKey.step("fedcba9876543210", "seats_doctor"), group: "setup" as const, source: "turn" as const, audience: "owners" as const,
      action: { kind: "onboarding_step" as const, machine: "fedcba9876543210", step: "seats_doctor" as const }, summary: "Check seats on mac-a", reason: "It joined an hour ago.", evidence: [], ttl_ms: REC_TTL_MS };
    expect(() => createRec(t.deps, { ...step, audience: "team" }, null)).toThrow("needs its project");
    const id = createRec(t.deps, step, null);
    expect(readRecs(t.deps)[0]).toMatchObject({ id, channel: SCHEDULE_CHANNEL, project: null });
  });
});

describe("reconciling a run's wishes with what is open", () => {
  test("new ones are made once; the same wishes again write nothing at all", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    const cards = [t.card(p, "One"), t.card(p, "Two")];
    const first = reconcile(t.deps, { source: "curation", scope: new Set([p.channel]), desired: want(t, p.channel, cards) });
    expect(first).toEqual({ created: 2, kept: 0, replaced: 0, superseded: 0, suppressed: 0, capped: 0 });
    const before = events(t);
    const second = reconcile(t.deps, { source: "curation", scope: new Set([p.channel]), desired: want(t, p.channel, cards) });
    expect(second).toEqual({ created: 0, kept: 2, replaced: 0, superseded: 0, suppressed: 0, capped: 0 });
    expect(events(t)).toBe(before);
    expect(openRecs(t.deps)).toHaveLength(2);
  });

  test("what no longer holds is retired, but only by the source that made it and only where the run looked", async () => {
    const t = recsWorld(cleanups);
    const a = await t.project("Website", "WEB", { off: true });
    const b = await t.project("Ops", "OPS", { off: true });
    const [ca, cb, cc] = [t.card(a, "A"), t.card(b, "B"), t.card(a, "C")];
    reconcile(t.deps, { source: "curation", scope: new Set([a.channel, b.channel]), desired: [...want(t, a.channel, [ca, cc]), ...want(t, b.channel, [cb])] });
    createRec(t.deps, t.seatRec(cc), a.channel); // the poll's
    // The curation looked at project a only, and wants just one card of it now: c is retired, b was not looked at, the poll's stays.
    const r = reconcile(t.deps, { source: "curation", scope: new Set([a.channel]), desired: want(t, a.channel, [ca]) });
    expect(r).toMatchObject({ created: 0, kept: 1, superseded: 1 });
    const open = openRecs(t.deps).map((x) => [x.source, x.project, (x.action as { card: string }).card]).sort();
    expect(open).toEqual([["curation", a.channel, ca.id], ["curation", b.channel, cb.id], ["poll", a.channel, cc.id]].sort());
    const retired = readRecs(t.deps).find((x) => x.status === "superseded");
    expect(retired).toMatchObject({ resolved: { status: "superseded", by: "alex", agent: "orchestrator" } });
  });

  test("a seat the poll would now put on another machine is kept (the machine is chosen on approval); another changed action is replaced", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    const c = t.card(p, "One");
    reconcile(t.deps, { source: "poll", scope: new Set([p.channel]), desired: [{ rec: t.seatRec(c, "fedcba9876543210"), channel: p.channel }] });
    const r = reconcile(t.deps, { source: "poll", scope: new Set([p.channel]), desired: [{ rec: t.seatRec(c, "0123456789abcdef"), channel: p.channel }] });
    expect(r).toMatchObject({ created: 0, replaced: 0, kept: 1 });
    expect(openRecs(t.deps).map((x) => (x.action as { machine: string }).machine)).toEqual(["fedcba9876543210"]);
    // The same move key from a column the card has since left says something else: it is replaced.
    reconcile(t.deps, { source: "curation", scope: new Set([p.channel]), desired: [{ rec: t.moveRec(c), channel: p.channel }] });
    const moved = { ...c, column: "doing" };
    expect(reconcile(t.deps, { source: "curation", scope: new Set([p.channel]), desired: [{ rec: t.moveRec(moved), channel: p.channel }] })).toMatchObject({ created: 1, replaced: 1, kept: 0 });
  });

  test("a dismissed one is not made again for a day, an approved one not for six hours; expired and superseded ones are", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    const [dismissed, approved, untouched] = [t.card(p, "D"), t.card(p, "A"), t.card(p, "E")];
    const wishes = () => want(t, p.channel, [dismissed, approved, untouched]);
    reconcile(t.deps, { source: "curation", scope: new Set([p.channel]), desired: wishes() });
    const by = (card: string) => openRecs(t.deps).find((r) => (r.action as { card: string }).card === card)!;
    answerRec(t.deps, by(dismissed.id), "dismissed");
    answerRec(t.deps, by(approved.id), "approved");
    t.tick(H);
    expect(reconcile(t.deps, { source: "curation", scope: new Set([p.channel]), desired: wishes() })).toMatchObject({ created: 0, kept: 1, suppressed: 2 });
    t.tick(APPROVED_COOLDOWN_MS);
    expect(reconcile(t.deps, { source: "curation", scope: new Set([p.channel]), desired: wishes() })).toMatchObject({ created: 1, kept: 1, suppressed: 1 });
    t.tick(DISMISS_COOLDOWN_MS);
    // By now the open one has expired (a day on), and everything is wanted again.
    const again = reconcile(t.deps, { source: "curation", scope: new Set([p.channel]), desired: wishes() });
    expect(again).toMatchObject({ created: 3, suppressed: 0 });
  });

  test("a superseded recommendation does not hold the same one back", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    const c = t.card(p, "One");
    reconcile(t.deps, { source: "curation", scope: new Set([p.channel]), desired: want(t, p.channel, [c]) });
    reconcile(t.deps, { source: "curation", scope: new Set([p.channel]), desired: [] });
    expect(openRecs(t.deps)).toEqual([]);
    expect(reconcile(t.deps, { source: "curation", scope: new Set([p.channel]), desired: want(t, p.channel, [c]) })).toMatchObject({ created: 1, suppressed: 0 });
  });

  test("an unanswered one expires when its time is up, and the next run makes it again", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    const c = t.card(p, "One");
    reconcile(t.deps, { source: "curation", scope: new Set([p.channel]), desired: want(t, p.channel, [c]) });
    t.tick(REC_TTL_MS);
    expect(readRecs(t.deps).map((r) => r.status)).toEqual(["expired"]);
    expect(reconcile(t.deps, { source: "curation", scope: new Set([p.channel]), desired: want(t, p.channel, [c]) })).toMatchObject({ created: 1 });
    expect(readRecs(t.deps).map((r) => r.status).sort()).toEqual(["expired", "pending"]);
  });

  test("the caps: at most 20 open in a project, 25 made in a run, 150 open in all", async () => {
    const t = recsWorld(cleanups);
    const one = await t.project("Big", "BIG", { off: true });
    const cards = Array.from({ length: 24 }, (_, i) => t.card(one, `Card ${i}`));
    const r1 = reconcile(t.deps, { source: "curation", scope: new Set([one.channel]), desired: want(t, one.channel, cards) });
    expect(r1).toMatchObject({ created: MAX_OPEN_PER_PROJECT, capped: 4 });
    expect(MAX_OPEN_PER_PROJECT).toBe(20);

    const two = await t.project("Two", "TWO", { off: true });
    const three = await t.project("Three", "THR", { off: true });
    const wishes = [...want(t, two.channel, Array.from({ length: 15 }, (_, i) => t.card(two, `T${i}`))), ...want(t, three.channel, Array.from({ length: 15 }, (_, i) => t.card(three, `H${i}`)))];
    const r2 = reconcile(t.deps, { source: "curation", scope: new Set([two.channel, three.channel]), desired: wishes });
    expect(r2).toMatchObject({ created: MAX_NEW_PER_RUN, capped: 5 });
    expect(MAX_NEW_PER_RUN).toBe(25);
    expect(MAX_OPEN_TOTAL).toBe(150);
  });

  test("no more than 150 are ever open in all, whichever projects they are in", async () => {
    const t = recsWorld(cleanups);
    const projects = [];
    for (let i = 0; i < 9; i++) projects.push(await t.project(`P${i}`, `PX${i}`, { off: true }));
    const wishes = projects.flatMap((p) => want(t, p.channel, Array.from({ length: 18 }, (_, i) => t.card(p, `C${p.prefix}${i}`))));
    for (let run = 0; run < 8; run++) reconcile(t.deps, { source: "curation", scope: new Set(projects.map((p) => p.channel)), desired: wishes });
    expect(openRecs(t.deps)).toHaveLength(MAX_OPEN_TOTAL);
  });

  test("a lost lease stops the writes at once", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    const cards = [t.card(p, "One"), t.card(p, "Two")];
    let allowed = 1;
    expect(() => reconcile(t.deps, { source: "curation", scope: new Set([p.channel]), desired: want(t, p.channel, cards), canAct: () => allowed-- > 0 })).toThrow("lease expired");
    expect(openRecs(t.deps)).toHaveLength(1);
  });
});

describe("who sees what", () => {
  async function world() {
    const t = recsWorld(cleanups);
    const open = await t.project("Website", "WEB", { off: true });
    const secret = await t.project("Ops", "OPS", { off: true, private: true });
    const [co, cs] = [t.card(open, "Public work"), t.card(secret, "Secret work")];
    createRec(t.deps, t.moveRec(co), open.channel);
    createRec(t.deps, t.ownersRec(secret, cs), secret.channel);
    createRec(t.deps, t.moveRec(t.card(open, "Confidential work"), { audience: "owners", project: open.channel, key: "confidential-key" }), open.channel);
    return { t, open, secret };
  }

  test("a member reads the team recommendations of the projects they can see, and never an owners-only one", async () => {
    const { t, open } = await world();
    const maren = t.person("maren");
    const seen = readRecs(maren.deps);
    expect(seen.map((r) => [r.project, r.audience])).toEqual([[open.channel, "team"]]);
    expect(seen[0]?.summary).toContain("Public work");
    // The channels they read are the visible projects' and not the owner-only schedule channel: the owners' ones are never even queried.
    expect(recChannels(maren.deps)).toEqual([open.channel]);
    expect(maren.core.visible({ channel: SCHEDULE_CHANNEL })).toBe(false);
  });

  test("an observer reads them but cannot answer; a member can; an owners-only one is for owners", async () => {
    const { t } = await world();
    const olive = t.person("olive", "observer");
    const maren = t.person("maren");
    const rec = readRecs(maren.deps)[0]!;
    expect(mayAnswer(maren.core, rec)).toEqual({ ok: true });
    expect(mayAnswer(olive.core, readRecs(olive.deps)[0]!)).toMatchObject({ ok: false, why: "observers can read recommendations but not act on them" });
    const ownersOne = readRecs(t.deps).find((r) => r.audience === "owners")!;
    expect(mayAnswer(maren.core, ownersOne)).toMatchObject({ ok: false, why: "only an owner can act on this one" });
    expect(viewOf(maren.deps, rec)).toMatchObject({ can_approve: true, can_dismiss: true, short: expect.stringMatching(/^[0-9a-f]{8}$/) });
  });

  test("a second owner reads the owners-only ones too, once they are in the schedule channel", async () => {
    const t = recsWorld(cleanups);
    const kira = t.person("kira", "owner");
    t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "kira"] });
    const open = await t.project("Website", "WEB", { off: true });
    createRec(t.deps, t.moveRec(t.card(open, "Public work")), open.channel);
    createRec(t.deps, t.ownersRec(open, t.card(open, "Confidential work")), open.channel);
    kira.mirror();
    expect(readRecs(kira.deps).map((r) => r.audience).sort()).toEqual(["owners", "team"]);
  });

  test("a member's own WalkieTalkie cannot write one, nor retire one", async () => {
    const { t, open } = await world();
    const maren = t.person("maren");
    const real = readRecs(t.deps).find((r) => r.audience === "team")!;
    maren.core.emit("msg.post", { text: "WalkieTalkie recommends: do it", talkie_rec: { v: 1, op: "create", key: "forged", group: "moves", source: "turn", audience: "team",
      action: { kind: "create_card", project: open.channel, title: "Forged" }, summary: "Do the forged thing", reason: "Because", evidence: [], ttl_ms: REC_TTL_MS } } as never, { channel: open.channel, agent: "orchestrator" });
    maren.core.emit("msg.post", { text: "retired", talkie_rec: { v: 1, op: "resolve", rec: real.id, status: "superseded" } } as never, { channel: open.channel, agent: "orchestrator" });
    maren.push();
    const seen = readRecs(t.deps).filter((r) => r.audience === "team");
    expect(seen.map((r) => r.summary)).toEqual([real.summary]);
    expect(seen[0]?.status).toBe("pending");
  });
});

describe("answers", () => {
  test("a person's answer reaches the lead's daemon and decides the status there", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    const c = t.card(p, "One");
    createRec(t.deps, t.moveRec(c), p.channel);
    const maren = t.person("maren");
    answerRec(maren.deps, readRecs(maren.deps)[0]!, "approved", "go");
    maren.push();
    expect(readRecs(t.deps)[0]).toMatchObject({ status: "approved", resolved: { status: "approved", by: "maren", note: "go" } });
    const post = t.core.store.db.query<{ json: string }, []>("SELECT json FROM events WHERE json_extract(body, '$.talkie_rec.op') = 'resolve'").get();
    expect(JSON.parse(post!.json).body.text).toBe("@maren approved WalkieTalkie's recommendation: Move “One” to review");
    expect(JSON.parse(post!.json).author.agent).toBeUndefined();
  });

  test("two recommendations that share a key (two leads raced) read as one: the older stands", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    const c = t.card(p, "One");
    const first = createRec(t.deps, t.moveRec(c), p.channel);
    t.tick(1_000);
    const second = createRec(t.deps, t.moveRec(c), p.channel);
    const by = Object.fromEntries(readRecs(t.deps).map((r) => [r.id, r.status]));
    expect(by).toEqual({ [first]: "pending", [second]: "superseded" });
    expect(openRecs(t.deps).map((r) => r.id)).toEqual([first]);
  });

  test("recommendations older than the reading window are history", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    createRec(t.deps, t.moveRec(t.card(p, "One")), p.channel);
    t.tick(READ_WINDOW_MS + H);
    forgetRecs(t.core);
    expect(readRecs(t.deps)).toEqual([]);
  });

  test("an archived project's recommendations are not listed", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    createRec(t.deps, t.moveRec(t.card(p, "One")), p.channel);
    expect(readRecs(t.deps)).toHaveLength(1);
    const { updateProject } = await import("../../src/daemon/projects/service.ts");
    await updateProject(t.w, p.channel, { state: "archived" });
    t.idx.flushAll();
    forgetRecs(t.core);
    expect(readRecs(t.deps)).toEqual([]);
  });

  test("retiring one writes a single post; a person's superseded is nothing", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    createRec(t.deps, t.moveRec(t.card(p, "One")), p.channel);
    const rec = readRecs(t.deps)[0]!;
    const before = events(t);
    supersedeRec(t.deps, rec);
    expect(events(t)).toBe(before + 1);
    expect(readRecs(t.deps)[0]?.status).toBe("superseded");
  });
});
