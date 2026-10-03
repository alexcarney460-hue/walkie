// WALK-78: the accepted TALKIE-CRON limits from the final pre.10 review, each as a regression test on the N-node world
// (real authority and leads, lossy requests and acknowledgements, a lagging copy of the schedules). The probes are the
// review's: (5) s2 S2e, (6) s3, (8) s6 S6b, (9) s1c. Every test also asserts the at-most-once audit: no slot executed
// twice or without an accepted claim.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { makeWorld, type NetInfo, type World, type WorldNode } from "../helpers/talkie-cron-world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
const isCompletion = (i: NetInfo) => i.path === "schedule-progress" && !!i.body.change.completion_run;
const pauseNotes = (w: World, n: WorldNode) => w.generalPosts(n).filter((t) => t.includes("paused after three failures"));
const supersessionNotes = (w: World, n: WorldNode) => w.generalPosts(n).filter((t) => t.includes("superseded by later runs"));

// mira leads, a five-minute schedule's first slot is due, and mira has claimed it and started the run.
async function running(opts: { wireLost?: boolean; names?: string[]; failures?: number } = {}) {
  const w = await makeWorld(cleanups, { ...(opts.wireLost ? { wireLost: true } : {}), ...(opts.names ? { names: opts.names } : {}) });
  const alex = w.nodes.alex!, mira = w.nodes.mira!;
  w.pref.v = mira.core.nodeId;
  const x = alex.s.add({ name: "Sweep", cron: "*/5 * * * *", task: { prompt: "SEND" } }, "alex");
  if (opts.failures) w.forgePut(x.id, { failures: opts.failures });
  w.syncAll();
  w.at(x.next_run! + 2_000);
  await w.stepNode(mira);
  const run = mira.turns[0]!.run;
  return { w, x, alex, mira, run, turn: `turn-${run}` };
}

// ---------------------------------------------------------------------------------------------------------------------
// (5) A captured completion's copy of the schedule is never refreshed: an owner edit between attempts made every retry
// 403 and the failed run's count and result were lost.
// ---------------------------------------------------------------------------------------------------------------------

test("(5) an owner rename between a completion's attempts no longer loses the failed run's count and result", async () => {
  const { w, x, alex, mira, turn } = await running();
  w.net.plan = (i) => (isCompletion(i) ? "req-lost" : "ok");
  mira.replies.set(turn, { text: "boom", ok: false });
  await w.stepNode(mira); // captured with failure count 1; the first attempt never reaches the authority
  alex.s.edit(x.id, { name: "Renamed while partitioned" });
  w.syncAll(); // the lead's own copy now carries the rename, its captured completion does not
  w.net.plan = () => "ok";
  await w.advance(120_000, { step: 15_000 });
  const refusals = w.net.log.filter((l) => l.path === "schedule-progress" && l.result.startsWith("403"));
  expect(refusals).toEqual([]);
  expect(w.completions()).toHaveLength(1);
  const row = w.view(alex, x.id)!;
  expect(row.name).toBe("Renamed while partitioned");
  expect(row.failures).toBe(1);
  expect(row.last_result).toBe("boom");
  expect(mira.s.status()).toBeNull();
  expect(w.held(mira).size).toBe(0);
  expect(w.audit()).toEqual([]);
});

test("(5) an owner pause between a completion's attempts is kept: the result is recorded and the schedule stays paused", async () => {
  const { w, x, alex, mira, turn } = await running();
  w.net.plan = (i) => (isCompletion(i) ? "req-lost" : "ok");
  mira.replies.set(turn, { text: "finished OK", ok: true });
  await w.stepNode(mira);
  alex.s.edit(x.id, { enabled: false });
  w.syncAll();
  w.net.plan = () => "ok";
  await w.advance(120_000, { step: 15_000 });
  expect(w.completions()).toHaveLength(1);
  const row = w.view(alex, x.id)!;
  expect(row.enabled).toBe(false);
  expect(row.next_run).toBeNull();
  expect(row.last_result).toBe("finished OK");
  expect(mira.s.status()).toBeNull();
  expect(w.audit()).toEqual([]);
});

test("(5) a lost acknowledgement then an owner edit is still acknowledged as the same completion (stable signed content)", async () => {
  const { w, x, alex, mira, turn } = await running();
  let lost = true;
  w.net.plan = (i) => (isCompletion(i) && lost ? (lost = false, "ack-lost") : "ok");
  mira.replies.set(turn, { text: "finished OK", ok: true });
  await w.stepNode(mira);
  expect(w.completions()).toHaveLength(1);
  alex.s.edit(x.id, { name: "Renamed", cron: "0 * * * *" });
  const before = w.changePosts().length;
  await w.advance(30_000, { step: 5_000 });
  expect(w.completions()).toHaveLength(1);
  expect(w.changePosts().length).toBe(before);
  expect(mira.s.status()).toBeNull();
  expect(w.view(alex, x.id)!.name).toBe("Renamed");
  expect(w.audit()).toEqual([]);
});

test("(5) the authority builds a completion's row from its own schedule and refuses other progress that differs from it", async () => {
  const { w, x, alex, mira, run } = await running();
  const progress = (change: unknown) => alex.s.progress(mira.core.nodeId, { epoch: mira.lead.epoch, run_id: run, change: change as never },
    (node, epoch) => alex.lead.holds(node, epoch));
  const mine = w.view(mira, x.id)!;
  // progress that is not a completion may not carry other management fields, a rename or a pause
  expect(() => progress({ op: "put", schedule: { ...mine, name: "Hijacked" } })).toThrow("management fields");
  expect(() => progress({ op: "put", schedule: { ...mine, task: { prompt: "EVIL" } } })).toThrow("management fields");
  expect(() => progress({ op: "put", schedule: { ...mine, enabled: false } })).toThrow("management fields");
  // a completion with other management fields and a pause the failure count does not justify records the result only
  progress({ op: "put", completion_run: run,
    schedule: { ...mine, name: "Hijacked", task: { prompt: "EVIL" }, enabled: false, failures: 1, last_result: "boom" } });
  const row = w.view(alex, x.id)!;
  expect(row.name).toBe("Sweep");
  expect(row.task).toEqual({ prompt: "SEND" });
  expect(row.enabled).toBe(true);
  expect(row.failures).toBe(1);
  expect(row.last_result).toBe("boom");
  expect(row.next_run).not.toBeNull();
});

test("(5) a completion that pauses after three failures still pauses the schedule", async () => {
  const { w, x, alex, mira, turn } = await running({ failures: 2 });
  w.syncAll();
  mira.replies.set(turn, { text: "boom", ok: false });
  await w.stepNode(mira);
  const row = w.view(alex, x.id)!;
  expect(row.enabled).toBe(false);
  expect(row.next_run).toBeNull();
  expect(row.failures).toBe(3);
  expect(row.last_result).toContain("Paused after three failures.");
  expect(pauseNotes(w, mira)).toHaveLength(1);
  expect(w.audit()).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// (6) A captured completion was held in memory forever when another node became lead, or dropped silently when a newer run
// started.
// ---------------------------------------------------------------------------------------------------------------------

test("(6) a held completion shows why it is held, then is reported as superseded once a newer run started elsewhere", async () => {
  const { w, x, alex, mira, run, turn } = await running({ wireLost: true });
  const bea = w.nodes.bea!;
  // mira can no longer reach the authority (its lease renewals included); its first completion attempt is lost
  w.net.plan = (i) => (i.from === "mira" ? "req-lost" : "ok");
  mira.replies.set(turn, { text: "boom", ok: false });
  await w.stepNode(mira);
  expect(w.held(mira).size).toBe(1);
  // the lease moves to bea, mira's expires: it holds the result and says so
  w.pref.v = bea.core.nodeId;
  w.autoReply(bea);
  await w.advance(60_000, { step: 10_000, syncEach: true });
  expect(mira.lead.valid).toBe(false);
  expect(w.held(mira).size).toBe(1);
  expect(mira.s.status()).toContain("held until this machine leads again");
  expect(supersessionNotes(w, mira)).toEqual([]);
  // bea runs the next slot, mira's partition heals but it does not lead again
  w.net.plan = () => "ok";
  await w.advance(6 * 60_000, { step: 15_000, syncEach: true });
  expect(bea.turns.length).toBeGreaterThan(0);
  expect(mira.lead.valid).toBe(false);
  expect(w.held(mira).size).toBe(0);
  const unresolved = JSON.parse(mira.core.store.getMeta("schedule_completion_unresolved") ?? "[]") as unknown[];
  expect(unresolved).toEqual([]);
  expect(mira.superseded.size).toBe(1);
  w.syncAll();
  const notes = supersessionNotes(w, alex);
  expect(notes).toHaveLength(1);
  // #general (every member reads it) gets the run id only; the result excerpt goes to the owner-only schedule channel
  expect(notes[0]).toContain(`run ${run.slice(0, 8)}`);
  expect(notes[0]).not.toContain("boom");
  expect(w.generalPosts(alex).filter((t) => t.includes("boom"))).toEqual([]);
  expect(w.scheduleNotes(alex).filter((t) => t.includes(`run ${run.slice(0, 8)} "boom"`))).toHaveLength(1);
  // a standby keeps its last lease failure in its status; nothing about the result remains
  expect(mira.s.status() ?? "").not.toMatch(/held|unresolved/);
  expect(w.view(alex, x.id)!.failures).toBe(0); // the failed run never counted: bea's run is the newer state
  expect(w.audit()).toEqual([]);
});

test("(6) a held completion the authority never recorded and no newer run replaced stays held and visible", async () => {
  const { w, x, alex, mira, turn } = await running({ wireLost: true });
  const bea = w.nodes.bea!;
  w.net.plan = (i) => (i.from === "mira" ? "req-lost" : "ok");
  mira.replies.set(turn, { text: "boom", ok: false });
  await w.stepNode(mira);
  w.pref.v = bea.core.nodeId;
  // the schedule is paused, so no newer run will ever replace it
  alex.s.edit(x.id, { enabled: false });
  await w.advance(10 * 60_000, { step: 15_000, syncEach: true });
  expect(w.held(mira).size).toBe(1);
  expect(mira.s.status()).toContain("held until this machine leads again");
  expect(w.audit()).toEqual([]);
});

test("(6) a completion held for an hour without the lead becomes a listed unresolved run, which a later run then reports", async () => {
  const { w, x, alex, mira, turn } = await running({ wireLost: true });
  const bea = w.nodes.bea!;
  w.net.plan = (i) => (i.from === "mira" ? "req-lost" : "ok");
  mira.replies.set(turn, { text: "boom", ok: false });
  await w.stepNode(mira);
  w.pref.v = bea.core.nodeId;
  alex.s.edit(x.id, { enabled: false }); // nothing will replace it
  await w.advance(50 * 60_000, { step: 60_000, syncEach: true });
  expect(w.held(mira).size).toBe(1);
  expect(mira.s.unresolvedPage().total).toBe(0);
  await w.advance(15 * 60_000, { step: 60_000, syncEach: true });
  expect(w.held(mira).size).toBe(0);
  const page = mira.s.unresolvedPage();
  expect(page.total).toBe(1);
  expect(page.entries[0]).toMatchObject({ id: x.id, name: "Sweep", result: "boom" });
  expect(mira.s.status()).toContain("unresolved");
  // the owner resumes the schedule: bea's next run supersedes the entry, which one note reports
  alex.s.edit(x.id, { enabled: true });
  w.autoReply(bea);
  await w.advance(10 * 60_000, { step: 30_000, syncEach: true });
  expect(mira.s.unresolvedPage().total).toBe(0); // the read reconciles it and posts the note
  w.syncAll();
  expect(supersessionNotes(w, alex)).toHaveLength(1);
  expect(w.audit()).toEqual([]);
});

test("(6) a superseded completion is reported on the lead that holds it even when its own lease is intact", async () => {
  // the lead is valid but its copy shows another run (a reset): the captured completion cannot be recorded
  const { w, x, alex, mira, turn } = await running();
  w.net.plan = (i) => (isCompletion(i) ? "req-lost" : "ok");
  mira.replies.set(turn, { text: "boom", ok: false });
  await w.stepNode(mira);
  expect(w.held(mira).size).toBe(1);
  w.net.plan = () => "ok";
  alex.s.reset(x.id, w.wall.value);
  w.syncAll();
  await w.advance(30_000, { step: 15_000 });
  expect(w.held(mira).size).toBe(0);
  expect(mira.superseded.size).toBe(1);
  w.syncAll();
  expect(supersessionNotes(w, alex)).toHaveLength(1);
  expect(w.audit()).toEqual([]);
});

test("(6) a schedule an owner removed drops its held completion without a note", async () => {
  const { w, x, alex, mira, turn } = await running();
  w.net.plan = (i) => (isCompletion(i) ? "req-lost" : "ok");
  mira.replies.set(turn, { text: "boom", ok: false });
  await w.stepNode(mira);
  w.net.plan = () => "ok";
  alex.s.remove(x.id);
  w.syncAll();
  await w.advance(30_000, { step: 15_000 });
  expect(w.held(mira).size).toBe(0);
  expect(supersessionNotes(w, mira)).toEqual([]);
});

// Messages are stored out of order per sender: the copy can hold the authority's later messages (a newer run's start)
// without the completion message that came before them. Absence is only known once the copy is complete through them.
// The review's probe C: the authority recorded a pausing completion (acknowledgement lost), the owner resumed, another
// lead started a newer run, and mira has received only the authority's messages after the completion.
async function recordedBeforeLaterMessages() {
  const ctx = await running({ wireLost: true, failures: 2 });
  const { w, x, alex, mira, turn } = ctx;
  const cy = w.nodes.cy!;
  w.net.plan = (i) => (i.from !== "mira" ? "ok" : isCompletion(i) ? "ack-lost" : "req-lost");
  mira.replies.set(turn, { text: "boom", ok: false });
  await w.stepNode(mira); // the pause is recorded at alex, the acknowledgement is lost
  expect(w.completions()).toHaveLength(1);
  alex.s.edit(x.id, { enabled: true }); // the owner saw the pause and resumed
  w.syncFrom(alex, cy);
  w.pref.v = cy.core.nodeId;
  w.autoReply(cy);
  for (let i = 0; i < 40; i++) { w.at(w.wall.value + 15_000); await w.stepNode(alex); await w.stepNode(cy); }
  expect(cy.turns.length).toBeGreaterThan(0);
  const completion = w.completions(alex)[0]!;
  const rest = w.eventsOf(alex).filter((e: { origin: string; seq: number }) => e.origin === alex.core.nodeId && e.seq > completion.seq);
  expect(rest.length).toBeGreaterThan(0);
  const deliverRest = () => { for (const e of rest) mira.core.ingest(e, "remote"); };
  return { ...ctx, completion, deliverRest };
}

test("(6) a held completion the authority recorded is not reported superseded while the completion message has not arrived", async () => {
  const { w, x, alex, mira, run, deliverRest } = await recordedBeforeLaterMessages();
  deliverRest();
  expect(w.view(mira, x.id)!.run_id).not.toBe(run); // the newer run's start is here, the completion is not
  await mira.s.tick(w.wall.value);
  expect(mira.lead.valid).toBe(false);
  expect(mira.superseded.size).toBe(0);
  expect(supersessionNotes(w, mira)).toEqual([]);
  expect(w.held(mira).size).toBe(1);
  expect(mira.s.status() ?? "").toContain("held");
  w.syncAll(); // the completion arrives
  await mira.s.tick(w.wall.value);
  expect(w.held(mira).size).toBe(0);
  w.syncAll();
  expect(pauseNotes(w, alex)).toHaveLength(1);
  expect(supersessionNotes(w, alex)).toEqual([]);
  expect(w.audit()).toEqual([]);
});

test("(6) an unresolved entry whose completion message has not arrived stays listed, then announces its pause", async () => {
  const { w, x, alex, mira, run, completion, deliverRest } = await recordedBeforeLaterMessages();
  (mira.s as unknown as { active: Map<string, unknown> }).active.delete(x.id);
  mira.core.store.setMeta("schedule_completion_unresolved", JSON.stringify([{ id: x.id, name: "Sweep", run, slot: x.next_run,
    claim: completion.completion_claim, pause: "boom\nPaused after three failures.", result: "boom Paused after three failures." }]));
  deliverRest();
  expect(w.view(mira, x.id)!.run_id).not.toBe(run);
  expect(mira.s.unresolvedPage().total).toBe(1); // nothing proves the completion absent: not superseded
  expect(supersessionNotes(w, mira)).toEqual([]);
  w.syncAll();
  expect(mira.s.unresolvedPage().total).toBe(0);
  w.syncAll();
  expect(pauseNotes(w, alex)).toHaveLength(1);
  expect(supersessionNotes(w, alex)).toEqual([]);
});

test("(6) a completion the whole authority log proves absent is still reported superseded", async () => {
  // the same shape with the completion truly never recorded: mira has every authority message
  const { w, alex, mira, run, turn } = await running({ wireLost: true });
  const bea = w.nodes.bea!;
  w.net.plan = (i) => (i.from === "mira" ? "req-lost" : "ok");
  mira.replies.set(turn, { text: "boom", ok: false });
  await w.stepNode(mira);
  w.pref.v = bea.core.nodeId;
  w.autoReply(bea);
  await w.advance(8 * 60_000, { step: 15_000, syncEach: true });
  expect(mira.superseded.size).toBe(1);
  w.syncAll();
  expect(supersessionNotes(w, alex)).toHaveLength(1);
  expect(w.completions().some((c: { completion_run: string }) => c.completion_run === run)).toBe(false);
});

test("(9) a pause found recorded while #general is missing waits and is announced once the channel is back", async () => {
  const { w, alex, mira, turn } = await running({ failures: 2 });
  w.net.plan = (i) => (i.from !== "mira" ? "ok" : isCompletion(i) ? "ack-lost" : "ok");
  mira.replies.set(turn, { text: "boom", ok: false });
  const channels = mira.core.roster.channels as unknown as Map<string, unknown>;
  const general = channels.get("general")!;
  channels.delete("general");
  await w.stepNode(mira); // recorded at alex, acknowledgement lost
  w.syncAll();
  await w.stepNode(mira); // mira finds it recorded in its own copy while #general is missing
  expect(w.held(mira).size).toBe(0);
  expect(pauseNotes(w, alex)).toEqual([]);
  expect(JSON.parse(mira.core.store.getMeta("schedule_completion_unresolved")!)).toHaveLength(1);
  channels.set("general", general);
  await w.advance(60_000, { step: 15_000, syncEach: true });
  expect(pauseNotes(w, alex)).toHaveLength(1);
  expect(JSON.parse(mira.core.store.getMeta("schedule_completion_unresolved")!)).toEqual([]);
  w.syncAll();
  expect(pauseNotes(w, alex)).toHaveLength(1);
  expect(w.audit()).toEqual([]);
});

// The review's probe E: this machine leads again while its copy of the authority's messages has a lasting gap, so a
// held completion cannot be proven absent. The schedule must keep running on it; the completion waits in the unresolved list.
test("(6) a lead whose copy of the authority's messages has a lasting gap keeps running the schedule", async () => {
  const w = await makeWorld(cleanups, { wireLost: true });
  const alex = w.nodes.alex!, mira = w.nodes.mira!, cy = w.nodes.cy!;
  w.pref.v = mira.core.nodeId;
  const x = alex.s.add({ name: "Sweep", cron: "*/5 * * * *", task: { prompt: "SEND" } }, "alex");
  w.syncAll();
  w.at(x.next_run! + 2_000);
  await w.stepNode(mira);
  const run = mira.turns[0]!.run;
  w.net.plan = (i) => (i.from !== "mira" ? "ok" : "req-lost"); // mira's completion never reaches the authority; its lease lapses
  mira.replies.set(`turn-${run}`, { text: "boom", ok: false });
  await w.stepNode(mira);
  w.pref.v = cy.core.nodeId;
  w.autoReply(cy);
  for (let i = 0; i < 40; i++) { w.at(w.wall.value + 15_000); await w.stepNode(alex); await w.stepNode(cy); w.syncFrom(alex, cy); w.syncFrom(cy, alex); }
  // mira receives every message except one earlier authority message: a gap below the newest change that never closes
  const alexId = alex.core.nodeId;
  const have = new Set(w.eventsOf(mira).map((e: { id: string }) => e.id));
  const withheld = w.eventsOf(alex).find((e: { id: string; origin: string }) => e.origin === alexId && !have.has(e.id))!;
  expect(withheld).toBeDefined();
  const deliver = () => {
    for (const n of [alex, cy, w.nodes.bea!]) for (const e of w.eventsOf(n)) if (e.id !== withheld.id) mira.core.ingest(e, "remote");
  };
  deliver();
  expect(w.view(mira, x.id)!.run_id).not.toBe(run);
  w.net.plan = () => "ok";
  w.pref.v = mira.core.nodeId;
  w.autoReply(mira);
  const before = mira.turns.length;
  for (let i = 0; i < 4 * 30; i++) { w.at(w.wall.value + 15_000); await w.stepNode(alex); await w.stepNode(mira); deliver(); }
  expect(mira.turns.length - before).toBeGreaterThanOrEqual(3); // it kept running instead of waiting for the missing message
  expect(w.held(mira).size).toBe(0);
  expect(mira.core.store.vvOf(alexId)).toBeLessThan(withheld.seq); // the gap is still there
  expect(mira.s.unresolvedPage().entries.map((e) => e.run)).toContain(run); // listed, not declared superseded
  expect(supersessionNotes(w, mira)).toEqual([]);
  // the missing message finally arrives: the entry is settled as superseded, with its note
  mira.core.ingest(withheld, "remote");
  await mira.s.tick(w.wall.value);
  w.syncAll();
  expect(mira.s.unresolvedPage().entries.map((e) => e.run)).not.toContain(run);
  expect(supersessionNotes(w, alex).some((t) => t.includes(`run ${run.slice(0, 8)}`))).toBe(true);
  expect(w.audit()).toEqual([]);
}, 120_000);

// ---------------------------------------------------------------------------------------------------------------------
// (8) edit() could set next_run onto a slot a lead had already started, and nothing repaired it.
// ---------------------------------------------------------------------------------------------------------------------

test("(8) an owner edit in the claim-skew window of an already started slot moves next_run past it", async () => {
  const w = await makeWorld(cleanups, { names: ["alex", "mira"] });
  const alex = w.nodes.alex!, mira = w.nodes.mira!;
  w.pref.v = mira.core.nodeId;
  const x = alex.s.add({ name: "Sweep", cron: "*/5 * * * *", task: { prompt: "SEND" } }, "alex");
  w.syncAll();
  const S1 = x.next_run!;
  w.at(S1 - 3_000); // this authority reads three seconds before the slot the lead is about to start
  await mira.lead.acquire();
  await mira.s.tick(S1); // the lead's clock is ahead: it claims and starts S1
  expect(w.view(alex, x.id)!.last_run).toBe(S1);
  w.at(S1 - 2_000);
  alex.s.edit(x.id, { name: "Renamed" });
  const edited = w.view(alex, x.id)!;
  expect(edited.last_run).toBe(S1);
  expect(edited.next_run!).toBeGreaterThan(S1);
  // the schedule keeps running: later slots are claimed
  w.autoReply(mira);
  w.syncAll();
  await w.advance(30 * 60_000, { step: 15_000, syncEach: true });
  expect(mira.turns.length).toBeGreaterThan(2);
  expect(w.view(alex, x.id)!.last_run!).toBeGreaterThan(S1);
  expect(w.audit()).toEqual([]);
});

test("(8) a next_run already left on a started slot is repaired by the next refused claim and the schedule resumes", async () => {
  const w = await makeWorld(cleanups, { names: ["alex", "mira"] });
  const alex = w.nodes.alex!, mira = w.nodes.mira!;
  w.pref.v = mira.core.nodeId;
  const x = alex.s.add({ name: "Sweep", cron: "*/5 * * * *", task: { prompt: "SEND" } }, "alex");
  w.syncAll();
  w.autoReply(mira);
  w.at(x.next_run! + 2_000);
  await w.stepNode(mira);
  const S1 = x.next_run!;
  expect(w.view(alex, x.id)!.last_run).toBe(S1);
  // the state an older authority's edit left behind
  w.forgePut(x.id, { next_run: S1 });
  w.syncAll();
  expect(w.view(alex, x.id)!.next_run).toBe(S1);
  await w.advance(2 * 60_000, { step: 15_000, syncEach: true });
  const repaired = w.view(alex, x.id)!;
  expect(repaired.next_run!).toBeGreaterThan(repaired.last_run!);
  await w.advance(20 * 60_000, { step: 15_000, syncEach: true });
  expect(mira.turns.length).toBeGreaterThan(2);
  expect(w.view(alex, x.id)!.last_run!).toBeGreaterThan(S1);
  expect(w.audit()).toEqual([]);
});

test("(8) the repair never lets a slot run twice: claims for the started slot are still refused", async () => {
  const w = await makeWorld(cleanups, { names: ["alex", "mira"] });
  const alex = w.nodes.alex!, mira = w.nodes.mira!;
  w.pref.v = mira.core.nodeId;
  const x = alex.s.add({ name: "Sweep", cron: "*/5 * * * *", task: { prompt: "SEND" } }, "alex");
  w.syncAll();
  w.at(x.next_run! + 2_000);
  await w.stepNode(mira);
  const S1 = x.next_run!;
  w.forgePut(x.id, { next_run: S1 });
  w.syncAll();
  const turns = mira.turns.length;
  const verdict = await mira.lead.claimSchedule(x.id, S1, randomUUID());
  expect(verdict).toMatchObject({ claimed: false, reason: "just_ran" });
  expect(mira.turns.length).toBe(turns);
  expect(w.view(alex, x.id)!.next_run!).toBeGreaterThan(S1);
  const again = await mira.lead.claimSchedule(x.id, S1, randomUUID());
  expect(again).toMatchObject({ claimed: false, reason: "just_ran" });
  expect(w.audit()).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// (9) The "paused after three failures" post went out only after an observed successful write: a pause the authority
// committed, whose acknowledgements were lost, was never announced.
// ---------------------------------------------------------------------------------------------------------------------

test("(9) a pause the authority recorded but never acknowledged is announced once, by a lead that no longer leads", async () => {
  const { w, x, alex, mira, turn } = await running({ wireLost: true, failures: 2 });
  const bea = w.nodes.bea!;
  // mira's completion reaches the authority (the pause is committed) but the acknowledgement is lost; its lease lapses too
  w.net.plan = (i) => (i.from !== "mira" ? "ok" : isCompletion(i) ? "ack-lost" : "req-lost");
  mira.replies.set(turn, { text: "boom", ok: false });
  await w.stepNode(mira);
  expect(w.completions()).toHaveLength(1);
  expect(w.view(alex, x.id)!.enabled).toBe(false);
  expect(pauseNotes(w, mira)).toEqual([]);
  w.pref.v = bea.core.nodeId;
  await w.advance(90_000, { step: 10_000, syncEach: true });
  expect(mira.lead.valid).toBe(false);
  expect(w.held(mira).size).toBe(0);
  w.syncAll();
  const posts = pauseNotes(w, alex);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain("Paused after three failures.");
  expect(mira.s.status() ?? "").not.toMatch(/held|unresolved/);
  // nothing announces it a second time
  await w.advance(10 * 60_000, { step: 30_000, syncEach: true });
  expect(pauseNotes(w, alex)).toHaveLength(1);
  expect(w.audit()).toEqual([]);
});

test("(9) a pause that is acknowledged on a later attempt is announced exactly once", async () => {
  const { w, x, alex, mira, turn } = await running({ failures: 2 });
  let lost = 2;
  w.net.plan = (i) => (isCompletion(i) && lost > 0 ? (lost--, "ack-lost") : "ok");
  mira.replies.set(turn, { text: "boom", ok: false });
  await w.advance(120_000, { step: 15_000 });
  expect(w.completions()).toHaveLength(1);
  expect(w.view(alex, x.id)!.enabled).toBe(false);
  w.syncAll();
  expect(pauseNotes(w, alex)).toHaveLength(1);
  expect(w.audit()).toEqual([]);
});

test("(9) an unresolved entry for a paused completion announces the pause when its completion turns up recorded", async () => {
  const { w, x, alex, mira, turn } = await running({ failures: 2 });
  // the completion is recorded at the authority but the lead gave up waiting for an answer (its list keeps the run)
  w.net.plan = (i) => (isCompletion(i) ? "ack-lost" : "ok");
  mira.replies.set(turn, { text: "boom", ok: false });
  await w.stepNode(mira);
  const [completion] = w.completions();
  expect(completion).toBeDefined();
  const active = (mira.s as unknown as { active: Map<string, unknown> }).active;
  active.delete(x.id);
  const entry = { id: x.id, name: "Sweep", run: completion!.completion_run, slot: x.next_run, claim: completion!.completion_claim,
    pause: "boom\nPaused after three failures." };
  mira.core.store.setMeta("schedule_completion_unresolved", JSON.stringify([entry]));
  w.net.plan = () => "ok";
  w.syncAll();
  expect(mira.s.unresolvedPage().total).toBe(0); // the status read reconciles it
  expect(JSON.parse(mira.core.store.getMeta("schedule_completion_unresolved")!)).toEqual([]);
  w.syncAll();
  expect(pauseNotes(w, alex)).toHaveLength(1);
  expect(mira.s.status()).toBeNull();
  w.syncAll();
  expect(pauseNotes(w, alex)).toHaveLength(1);
});

test("(9) an unresolved entry that did not pause clears without any post", async () => {
  const { w, x, alex, mira, turn } = await running();
  w.net.plan = (i) => (isCompletion(i) ? "ack-lost" : "ok");
  mira.replies.set(turn, { text: "boom", ok: false });
  await w.stepNode(mira);
  const [completion] = w.completions();
  (mira.s as unknown as { active: Map<string, unknown> }).active.delete(x.id);
  mira.core.store.setMeta("schedule_completion_unresolved", JSON.stringify([
    { id: x.id, name: "Sweep", run: completion!.completion_run, slot: x.next_run, claim: completion!.completion_claim }]));
  w.syncAll();
  expect(mira.s.status()).toBeNull();
  expect(pauseNotes(w, alex)).toEqual([]);
});

test("(9) an unresolved pause waits for #general instead of being dropped, and announces when the channel is there", async () => {
  const { w, x, alex, mira, turn } = await running({ failures: 2 });
  w.net.plan = (i) => (isCompletion(i) ? "ack-lost" : "ok");
  mira.replies.set(turn, { text: "boom", ok: false });
  await w.stepNode(mira);
  const [completion] = w.completions();
  (mira.s as unknown as { active: Map<string, unknown> }).active.delete(x.id);
  mira.core.store.setMeta("schedule_completion_unresolved", JSON.stringify([
    { id: x.id, name: "Sweep", run: completion!.completion_run, slot: x.next_run, claim: completion!.completion_claim,
      pause: "boom\nPaused after three failures." }]));
  w.syncAll();
  const channels = mira.core.roster.channels as unknown as Map<string, unknown>;
  const general = channels.get("general")!;
  channels.delete("general");
  expect(mira.s.status()).toContain("unresolved"); // kept: nothing could be posted
  expect(JSON.parse(mira.core.store.getMeta("schedule_completion_unresolved")!)).toHaveLength(1);
  channels.set("general", general);
  expect(mira.s.status()).toBeNull();
  w.syncAll();
  expect(pauseNotes(w, alex)).toHaveLength(1);
});

// ---------------------------------------------------------------------------------------------------------------------
// The TALKIE-CRON MEDs accepted at the final lane tips: unresolved paging route and CLI, unbounded metadata per failure,
// offset paging skips (already fixed on the base; the route and CLI have their own tests), the legacy overflow ack
// (WALK-83). Bounded metadata is proven here across many runs.
// ---------------------------------------------------------------------------------------------------------------------

test("the unresolved list stays bounded however many runs failed: old runs collapse into one coalesced note", async () => {
  const { w, x, alex, mira } = await running();
  w.syncAll(); // mira holds every authority message, so nothing is still to arrive
  const runs = Array.from({ length: 500 }, () => randomUUID());
  mira.core.store.setMeta("schedule_completion_unresolved", JSON.stringify(runs.map((run, i) => (
    { id: x.id, name: "Sweep", run, local_id: randomUUID(), result: `result ${i}` }))));
  expect(mira.s.unresolvedPage().total).toBe(0);
  expect(JSON.parse(mira.core.store.getMeta("schedule_completion_unresolved")!)).toEqual([]);
  w.syncAll();
  const notes = supersessionNotes(w, alex);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("500 unresolved completions");
  // #general names the newest ten by run id and counts the rest, with no result text at all
  expect(notes[0]).toContain("490 more");
  expect(notes[0]).toContain(`run ${runs[499]!.slice(0, 8)}`);
  expect(notes[0]).toContain(`run ${runs[490]!.slice(0, 8)}`);
  expect(notes[0]).not.toContain(`run ${runs[489]!.slice(0, 8)}`);
  expect(notes[0]).not.toContain("result ");
  expect(notes[0]).toContain("owners can read their results in talkie-schedules");
  expect(notes[0]!.length).toBeLessThan(1_000);
  // the owner-only schedule channel carries the same ten with their excerpts
  const detail = w.scheduleNotes(alex);
  expect(detail).toHaveLength(1);
  expect(detail[0]).toContain(`run ${runs[499]!.slice(0, 8)} "result 499"`);
  expect(detail[0]).toContain(`run ${runs[490]!.slice(0, 8)} "result 490"`);
  expect(detail[0]).toContain("(490 more not shown)");
  expect(detail[0]!.length).toBeLessThan(3_000);
});

test("a machine that cannot post the detail to the schedule channel still posts the #general note", async () => {
  const { w, x, alex, mira } = await running();
  w.syncAll();
  const emit = mira.core.emit.bind(mira.core);
  mira.core.emit = ((kind: Parameters<typeof emit>[0], body: Parameters<typeof emit>[1], opts?: Parameters<typeof emit>[2]) => {
    if (opts?.channel === "talkie-schedules" && "text" in body && !String(body.text).startsWith("walkie-talkie-")) throw new Error("not a member");
    return emit(kind, body, opts);
  }) as typeof emit;
  mira.core.store.setMeta("schedule_completion_unresolved", JSON.stringify([{ id: x.id, name: "Sweep", run: randomUUID(), local_id: randomUUID(), result: "secret-ish result" }]));
  expect(mira.s.unresolvedPage().total).toBe(0);
  w.syncAll();
  const notes = supersessionNotes(w, alex);
  expect(notes).toHaveLength(1);
  expect(notes[0]).not.toContain("owners can read");
  expect(notes[0]).not.toContain("secret-ish");
  expect(w.scheduleNotes(alex)).toEqual([]);
});

test("the superseded runs waiting for their note are stored apart from the notes, which an older build still reads", async () => {
  const { w, x, alex, mira } = await running();
  w.syncAll();
  const channels = mira.core.roster.channels as unknown as Map<string, unknown>;
  const general = channels.get("general")!;
  channels.delete("general"); // the note has to wait
  mira.core.store.setMeta("schedule_completion_unresolved", JSON.stringify([1, 2, 3].map((i) => (
    { id: x.id, name: "Sweep", run: randomUUID(), local_id: randomUUID(), result: `result ${i}` }))));
  expect(mira.s.unresolvedPage().total).toBe(0);
  // the pre-WALK-78 shape of the stored notes: a strict record without the runs
  const OlderNotes = z.record(z.object({ name: z.string(), last_posted_at: z.number().int().nonnegative().safe(),
    pending: z.number().int().nonnegative().safe(), waiting_for_channel: z.boolean().optional() }).strict());
  const notes = JSON.parse(mira.core.store.getMeta("schedule_completion_supersession_notes")!);
  expect(OlderNotes.safeParse(notes).success).toBe(true);
  expect(notes[x.id].pending).toBe(3);
  expect(JSON.parse(mira.core.store.getMeta("schedule_completion_supersession_runs")!)[x.id]).toHaveLength(3);
  channels.set("general", general);
  await mira.s.tick(w.wall.value); // the tick posts what waited
  w.syncAll();
  expect(supersessionNotes(w, alex)).toHaveLength(1);
  expect(w.scheduleNotes(alex)).toHaveLength(1);
  expect(JSON.parse(mira.core.store.getMeta("schedule_completion_supersession_runs")!)).toEqual({});
  expect(OlderNotes.safeParse(JSON.parse(mira.core.store.getMeta("schedule_completion_supersession_notes")!)).success).toBe(true);
});
