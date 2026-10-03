import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { Schedules } from "../../src/daemon/orchestrator/schedules.ts";
import { withScheduleClock } from "../helpers/talkie-retry-clock.ts";
import { PeerCallError, type PeerClient } from "../../src/daemon/peer-client.ts";
import { HttpError } from "../../src/daemon/http.ts";
import { SCHEDULE_CHANNEL, nextRuns } from "../../src/protocol/talkie-schedule.ts";
import { loadScheduleClaims, saveScheduleClaims } from "../../src/daemon/orchestrator/schedule-claims.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });

function authority() {
  const node = tnode("alex");
  const { team, create } = createTeam(node);
  const wall = { value: now() };
  setSystemTime(new Date(wall.value));
  const core = makeCore(node, team, cleanups, { clock: () => wall.value });
  core.ingest(create, "local");
  core.emit("channel.upsert", { name: "general" });
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex"] });
  const runner = { valid: () => true, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} };
  const schedules = new Schedules(core, runner);
  const schedule = schedules.add({ name: "Job", cron: "*/5 * * * *", task: { prompt: "check" } }, "alex");
  const lead = new Leadership({ core, preferred: () => core.nodeId, lost: () => {}, now: () => wall.value });
  const epoch = lead.grant(core.nodeId).epoch;
  wall.value = schedule.next_run! + 1_000;
  setSystemTime(new Date(wall.value));
  return { core, wall, schedules, schedule, lead, epoch };
}

test("progress binds every put to a claim and advances only on a new claimed run", () => {
  const { core, schedules, schedule, lead, epoch } = authority();
  const run = randomUUID();
  const slot = schedule.next_run!;
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot, run, epoch }).claimed).toBe(true);
  const holds = (node: string, value: number) => lead.holds(node, value);
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...schedule, run_id: run, next_run: slot + 20 * 60_000 } } }, holds);
  const accepted = schedules.get(schedule.id);
  expect(accepted.next_run).toBe(nextRuns(schedule.cron, slot, 1)[0]!);
  schedules.progress(core.nodeId, { epoch, run_id: run, change: { op: "put",
    schedule: { ...accepted, next_run: accepted.next_run! + 60 * 60_000, last_result: "done" } } }, holds);
  expect(schedules.get(schedule.id).next_run).toBe(accepted.next_run);
  expect(schedules.get(schedule.id).last_result).toBe("done");
  const forged = { ...accepted, run_id: randomUUID() };
  core.emit("msg.post", { text: "walkie-talkie-schedule:v1:" + JSON.stringify({
    op: "put", term: core.authorityLeaseTerm, after: null, rev: 3, schedule: forged }) }, { channel: SCHEDULE_CHANNEL });
  expect(() => schedules.progress(core.nodeId, { epoch, run_id: forged.run_id, change: { op: "put",
    schedule: { ...forged, last_result: "unclaimed" } } }, holds)).toThrow("authority-accepted claim");
});

test("progress derives last_run from the claimed slot despite a future value in the payload", () => {
  const { core, schedules, schedule, lead, epoch } = authority();
  const run = randomUUID();
  const slot = schedule.next_run!;
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot, run, epoch }).claimed).toBe(true);
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...schedule, run_id: run, last_run: slot + 365 * 24 * 60 * 60_000 } } },
  (node, value) => lead.holds(node, value));
  expect(schedules.get(schedule.id).last_run).toBe(slot);
});

test("older same-run progress cannot replace newer result or erase capacity checks", () => {
  const { core, schedules, schedule, lead, epoch } = authority();
  const run = randomUUID();
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: schedule.next_run!, run, epoch }).claimed).toBe(true);
  const holds = (node: string, value: number) => lead.holds(node, value);
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...schedule, run_id: run } } }, holds, 100);
  const started = schedules.get(schedule.id);
  schedules.progress(core.nodeId, { epoch, run_id: run, change: { op: "put",
    schedule: { ...started, last_result: "later", capacity_checked_at: { alex: 100 } } } }, holds, 200);
  const updated = schedules.get(schedule.id);
  expect(() => schedules.progress(core.nodeId, { epoch, run_id: run, change: { op: "put",
    schedule: { ...started, last_result: "early" } } }, holds, 100)).toThrow();
  expect(schedules.get(schedule.id)).toEqual(updated);
  schedules.progress(core.nodeId, { epoch, run_id: run, change: { op: "put",
    schedule: { ...updated, last_result: "newer", capacity_checked_at: undefined } } }, holds, 300);
  expect(schedules.get(schedule.id).capacity_checked_at).toEqual({ alex: 100 });
  const sameTime = schedules.get(schedule.id);
  schedules.progress(core.nodeId, { epoch, run_id: run, change: { op: "put",
    schedule: { ...sameTime, last_result: "first" } } }, holds, 400, "first-wire");
  schedules.progress(core.nodeId, { epoch, run_id: run, change: { op: "put",
    schedule: { ...schedules.get(schedule.id), last_result: "final" } } }, holds, 400, "final-wire");
  expect(() => schedules.progress(core.nodeId, { epoch, run_id: run, change: { op: "put",
    schedule: { ...sameTime, last_result: "first" } } }, holds, 400, "first-wire")).toThrow();
  expect(schedules.get(schedule.id).last_result).toBe("final");
});

test("a clock correction does not reject progress based on the latest authority revision", () => {
  const { core, schedules, schedule, lead, epoch } = authority();
  const run = randomUUID();
  const holds = (node: string, value: number) => lead.holds(node, value);
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: schedule.next_run!, run, epoch }).claimed).toBe(true);
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...schedule, run_id: run } } }, holds, 500);
  const started = schedules.get(schedule.id);
  schedules.progress(core.nodeId, { epoch, run_id: run, change: { op: "put",
    schedule: { ...started, last_result: "after correction" } } }, holds, 100);
  const corrected = schedules.get(schedule.id);
  expect(corrected.last_result).toBe("after correction");
  expect(corrected.progress_at).toBe(100);
  expect(corrected.progress_rev).toBeGreaterThan(started.progress_rev!);
  expect(() => schedules.progress(core.nodeId, { epoch, run_id: run, change: { op: "put",
    schedule: { ...started, last_result: "stale snapshot" } } }, holds, 600)).toThrow("older run progress");
});

test("an older accepted claim cannot replace the current run", () => {
  const { core, schedules, schedule, lead, epoch, wall } = authority();
  const holds = (node: string, value: number) => lead.holds(node, value);
  const first = randomUUID();
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: schedule.next_run!, run: first, epoch }).claimed).toBe(true);
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put", schedule: { ...schedule, run_id: first } } }, holds);
  const afterFirst = schedules.get(schedule.id);
  wall.value = afterFirst.next_run! + 1_000;
  setSystemTime(new Date(wall.value));
  const second = randomUUID();
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: afterFirst.next_run!, run: second, epoch }).claimed).toBe(true);
  schedules.progress(core.nodeId, { epoch, run_id: first, change: { op: "put", schedule: { ...afterFirst, run_id: second, last_result: "new" } } }, holds);
  const current = schedules.get(schedule.id);
  expect(() => schedules.progress(core.nodeId, { epoch, run_id: second, change: { op: "put",
    schedule: { ...current, run_id: first, last_result: "replayed" } } }, holds)).toThrow();
  expect(schedules.get(schedule.id)).toEqual(current);
});

test("progress seeds an acknowledged predecessor claim before the first new-term claim", () => {
  const { core, schedules, schedule, lead, epoch } = authority();
  const run = randomUUID();
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: schedule.next_run!, run, epoch }).claimed).toBe(true);
  core.store.deleteMeta("orchestrator_claims");
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...schedule, run_id: run, last_result: "completed" } } },
  (node, value) => lead.holds(node, value));
  expect(schedules.get(schedule.id).run_id).toBe(run);
  expect(schedules.get(schedule.id).last_result).toBeNull();
  schedules.progress(core.nodeId, { epoch, run_id: run, change: { op: "put", completion_run: run,
    schedule: { ...schedules.get(schedule.id), last_result: "completed" } } },
  (node, value) => lead.holds(node, value));
  expect(schedules.get(schedule.id).last_result).toBe("completed");
  expect(schedules.get(schedule.id).last_run).toBe(schedule.next_run);
});

test("progress fills a partial claim store before accepting an acknowledged run", () => {
  const { core, schedules, schedule, lead, epoch, wall } = authority();
  const first = randomUUID();
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: schedule.next_run!, run: first, epoch }).claimed).toBe(true);
  const holds = (node: string, value: number) => lead.holds(node, value);
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...schedule, run_id: first } } }, holds);
  const started = schedules.get(schedule.id);
  wall.value = started.next_run! + 1_000;
  setSystemTime(new Date(wall.value));
  const second = randomUUID();
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: started.next_run!, run: second, epoch }).claimed).toBe(true);
  saveScheduleClaims(core, core.authorityLeaseTerm, loadScheduleClaims(core, core.authorityLeaseTerm).filter((c) => c.run === first));
  schedules.progress(core.nodeId, { epoch, run_id: first, change: { op: "put",
    schedule: { ...started, run_id: second } } }, holds);
  expect(schedules.get(schedule.id).run_id).toBe(second);
});

test("an accepted run-now claim enforces cooldown before progress persists", () => {
  const { core, schedule, lead, epoch, wall } = authority();
  const first = lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: wall.value,
    run: randomUUID(), epoch, run_now: true });
  expect(first.claimed).toBe(true);
  wall.value += 2_000;
  setSystemTime(new Date(wall.value));
  const second = lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: wall.value,
    run: randomUUID(), epoch, run_now: true });
  expect(second).toEqual({ claimed: false, reason: "just_ran" });
});

test("a transient completion write failure retries the consumed result on a later tick", async () => {
  const { core, schedule, lead, epoch, wall } = authority();
  let replies = 0;
  const runner = { valid: () => true, epoch: () => epoch,
    claim: async (id: string, slot: number, run: string) => lead.claimFromPeer(core.nodeId, { schedule: id, slot, run, epoch }),
    turn: () => "turn", reply: () => ++replies === 1 ? { text: "finished", ok: true } : null,
    interrupt: () => {} };
  const schedules = new Schedules(core, runner);
  withScheduleClock(schedules);
  await schedules.tick(wall.value);
  expect(schedules.get(schedule.id).run_id).not.toBeNull();
  const emit = core.emit.bind(core);
  let fail = true;
  core.emit = ((kind: Parameters<typeof core.emit>[0], body: Parameters<typeof core.emit>[1], opts: Parameters<typeof core.emit>[2]) => {
    if (fail && kind === "msg.post" && "text" in body &&
      String(body.text).includes('"last_result":"finished"')) {
      fail = false;
      throw new Error("transient write failure");
    }
    return emit(kind, body, opts);
  }) as typeof core.emit;
  await schedules.tick(wall.value);
  expect(schedules.get(schedule.id).last_result).toBeNull();
  await schedules.tick(wall.value + 15_000);
  expect(schedules.get(schedule.id).last_result).toBe("finished");
  expect(replies).toBe(1);
});

test("a failed local completion transaction retries without counting a failure twice", async () => {
  const { core, schedule, lead, epoch, wall } = authority();
  const schedules = new Schedules(core, { valid: () => true, epoch: () => epoch,
    claim: async (id, slot, run) => lead.claimFromPeer(core.nodeId, { schedule: id, slot, run, epoch }),
    turn: () => "turn", reply: () => ({ text: "failed", ok: false }), interrupt: () => {} });
  withScheduleClock(schedules);
  await schedules.tick(wall.value);
  const emit = core.emit.bind(core);
  let fail = true;
  core.emit = ((kind: Parameters<typeof core.emit>[0], body: Parameters<typeof core.emit>[1], opts: Parameters<typeof core.emit>[2]) => {
    const event = emit(kind, body, opts);
    if (fail && kind === "msg.post" && "text" in body && String(body.text).includes('"last_result":"failed"')) {
      fail = false;
      throw new Error("acknowledgement lost");
    }
    return event;
  }) as typeof core.emit;
  await schedules.tick(wall.value);
  expect(schedules.get(schedule.id).failures).toBe(0);
  await schedules.tick(wall.value + 15_000);
  expect(schedules.get(schedule.id).failures).toBe(1);
  const completions = core.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 1000 })
    .filter((row) => JSON.parse(row.json).body.text.includes('"last_result":"failed"'));
  expect(completions).toHaveLength(1);
});

test("a later start retains an authority-committed failure after every completion acknowledgement is lost", async () => {
  const { core, schedule, lead, epoch, wall } = authority();
  const holds = (node: string, value: number) => lead.holds(node, value);
  const schedules = new Schedules(core, { valid: () => true, epoch: () => epoch,
    claim: async (id, slot, run) => lead.claimFromPeer(core.nodeId, { schedule: id, slot, run, epoch }),
    turn: () => "turn", reply: () => ({ text: "failed", ok: false }), interrupt: () => {} });
  withScheduleClock(schedules);
  await schedules.tick(wall.value);
  const stale = schedules.get(schedule.id);
  const originalProgress = schedules.progress.bind(schedules);
  let lost = 0;
  schedules.progress = ((...args: Parameters<Schedules["progress"]>) => {
    const response = originalProgress(...args);
    if (args[1].change.op === "put" && args[1].change.completion_run) {
      lost++;
      throw new Error("completion acknowledgement lost");
    }
    return response;
  }) as Schedules["progress"];
  for (let i = 0; i < 18; i++) await schedules.tick(wall.value + i * 15_000);
  // The lead sees its completion recorded in its own copy of the log after the first lost acknowledgement and stops
  // retrying (WALK-78); before, it spent all five attempts and left an unresolved marker for the status read to clear.
  expect(lost).toBe(1);
  expect(schedules.get(schedule.id).failures).toBe(1);
  expect(schedules.get(schedule.id).last_result).toBe("failed");
  expect(schedules.status()).toBeNull(); // the recorded completion leaves no unresolved marker
  wall.value = stale.next_run! + 1_000;
  setSystemTime(new Date(wall.value));
  const second = randomUUID();
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: stale.next_run!, run: second, epoch }).claimed).toBe(true);
  originalProgress(core.nodeId, { epoch, run_id: stale.run_id, change: { op: "put",
    schedule: { ...stale, run_id: second } } }, holds);
  expect(schedules.get(schedule.id)).toMatchObject({ run_id: second, failures: 1, last_result: "failed" });
});

test("a reset permits a reused run UUID to record a new completion", () => {
  const { core, schedules, schedule, lead, epoch, wall } = authority();
  const run = randomUUID();
  const holds = (node: string, value: number) => lead.holds(node, value);
  const finish = (snapshot: typeof schedule, result: string) => schedules.progress(core.nodeId, {
    epoch, run_id: run, change: { op: "put", completion_run: run,
      schedule: { ...snapshot, last_result: result } } }, holds);
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: schedule.next_run!, run, epoch }).claimed).toBe(true);
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...schedule, run_id: run } } }, holds);
  finish(schedules.get(schedule.id), "first completion");
  expect(schedules.get(schedule.id).last_result).toBe("first completion");
  const reset = schedules.reset(schedule.id, wall.value + 60_000);
  wall.value = reset.next_run! + 1_000;
  setSystemTime(new Date(wall.value));
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: reset.next_run!, run, epoch }).claimed).toBe(true);
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...reset, run_id: run } } }, holds);
  finish(schedules.get(schedule.id), "second completion");
  expect(schedules.get(schedule.id).last_result).toBe("second completion");
});

test("a new authority term permits a reused run UUID to record a new completion", () => {
  const a = tnode("alex"), b = tnode("bea");
  const { team, create } = createTeam(a);
  const wall = { value: now() };
  setSystemTime(new Date(wall.value));
  const core = makeCore(a, team, cleanups, { clock: () => wall.value });
  core.ingest(create, "local");
  core.emit("team.member", { login: b.login, handle: b.handle, role: "owner" });
  core.emit("team.node", { node_id: b.keys.nodeId, login: b.login, hostname: b.hostname,
    pubkey: b.keys.pubkey, ip: "127.0.0.1" });
  core.emit("channel.upsert", { name: "general" });
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "bea"] });
  const idle = { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} };
  const schedules = new Schedules(core, idle);
  const schedule = schedules.add({ name: "Job", cron: "*/5 * * * *", task: { prompt: "check" } }, "alex");
  const lead = new Leadership({ core, preferred: () => core.nodeId, lost: () => {}, now: () => wall.value });
  const epoch = lead.grant(core.nodeId).epoch;
  wall.value = schedule.next_run! + 1_000;
  setSystemTime(new Date(wall.value));
  const run = randomUUID();
  const holds = (node: string, value: number) => lead.holds(node, value);
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: schedule.next_run!, run, epoch }).claimed).toBe(true);
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...schedule, run_id: run } } }, holds);
  schedules.progress(core.nodeId, { epoch, run_id: run, change: { op: "put", completion_run: run,
    schedule: { ...schedules.get(schedule.id), last_result: "old term" } } }, holds);
  core.emit("team.authority", { node_id: b.keys.nodeId });
  const successor = makeCore(b, team, cleanups, { clock: () => wall.value });
  feed(successor, core.store.queryEvents({ limit: 1000 }).map((row) => JSON.parse(row.json))
    .sort((x, y) => x.seq - y.seq));
  expect(successor.authorityLeaseTerm).toBe(1);
  const nextSchedules = new Schedules(successor, idle);
  const mono = { value: 34_000 };
  const nextLead = new Leadership({ core: successor, preferred: () => successor.nodeId,
    lost: () => {}, now: () => wall.value, monoNow: () => mono.value });
  nextLead.grant(successor.nodeId);
  const nextHolds = (node: string, value: number) => nextLead.holds(node, value);
  const prior = nextSchedules.get(schedule.id);
  wall.value = prior.next_run! + 1_000;
  mono.value += 5 * 60_000;
  setSystemTime(new Date(wall.value));
  let nextEpoch = nextLead.grant(successor.nodeId).epoch;
  expect(nextLead.claimFromPeer(successor.nodeId, { schedule: schedule.id, slot: prior.next_run!,
    run, epoch: nextEpoch }).claimed).toBe(true);
  expect(() => nextSchedules.progress(successor.nodeId, { epoch: nextEpoch, run_id: run,
    change: { op: "put", completion_run: run, schedule: { ...prior, last_result: "old retry" } } }, nextHolds))
    .toThrow("new claim needs a start put");
  nextSchedules.progress(successor.nodeId, { epoch: nextEpoch, run_id: run, change: { op: "put",
    schedule: { ...prior, run_id: run, last_run: wall.value } } }, nextHolds);
  expect(nextSchedules.get(schedule.id).last_run).toBe(prior.next_run);
  nextSchedules.progress(successor.nodeId, { epoch: nextEpoch, run_id: run, change: { op: "put", completion_run: run,
    schedule: { ...nextSchedules.get(schedule.id), last_result: "new term" } } }, nextHolds);
  expect(nextSchedules.get(schedule.id).last_result).toBe("new term");
  const reset = nextSchedules.reset(schedule.id, wall.value + 60_000);
  wall.value = reset.next_run! + 1_000;
  mono.value += 5 * 60_000;
  setSystemTime(new Date(wall.value));
  nextEpoch = nextLead.grant(successor.nodeId).epoch;
  const nextClaim = nextLead.claimFromPeer(successor.nodeId, { schedule: schedule.id, slot: reset.next_run!,
    run, epoch: nextEpoch });
  expect(nextClaim.claimed).toBe(true);
  nextSchedules.progress(successor.nodeId, { epoch: nextEpoch, run_id: null, change: { op: "put",
    schedule: { ...reset, run_id: run } } }, nextHolds);
  nextSchedules.progress(successor.nodeId, { epoch: nextEpoch, run_id: run, change: { op: "put", completion_run: run,
    schedule: { ...nextSchedules.get(schedule.id), last_result: "after reset" } } }, nextHolds);
  expect(nextSchedules.get(schedule.id).last_result).toBe("after reset");
});

test("unresolved status retains every run and clears a matching signed completion", () => {
  const { core, schedules, schedule, lead, epoch } = authority();
  const run = randomUUID();
  const holds = (node: string, value: number) => lead.holds(node, value);
  const accepted = lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: schedule.next_run!, run, epoch });
  expect(accepted.claimed).toBe(true);
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...schedule, run_id: run } } }, holds);
  const entries = [{ id: schedule.id, name: schedule.name, run, claim: accepted.claim },
    ...Array.from({ length: 24 }, (_, i) => ({ id: randomUUID(), name: `Other ${i}`, run: randomUUID() }))];
  core.store.setMeta("schedule_completion_unresolved", JSON.stringify(entries));
  expect(schedules.status()).toContain(`run ${run}`);
  expect(schedules.status()).toContain("1 unresolved run");
  schedules.progress(core.nodeId, { epoch, run_id: run, change: { op: "put", completion_run: run,
    schedule: { ...schedules.get(schedule.id), last_result: "arrived" } } }, holds);
  expect(schedules.status()).toBeNull();
  expect(JSON.parse(core.store.getMeta("schedule_completion_unresolved")!)).toHaveLength(0);
});

test("an oldest unknown completion stays visible after 100 later outcomes reconcile", async () => {
  const { core, schedules, schedule, lead, epoch, wall } = authority();
  const later = schedules.add({ name: "Later", cron: "*/5 * * * *", task: { prompt: "check" } }, "alex");
  const holds = (node: string, value: number) => lead.holds(node, value);
  const failing = new Schedules(core, { valid: () => true, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} });
  withScheduleClock(failing);
  const emit = core.emit.bind(core);
  core.emit = ((...args: Parameters<typeof core.emit>) => {
    if (args[0] === "msg.post" && "text" in args[1] && String(args[1].text).includes('"completion_run"'))
      throw new Error("completion unavailable");
    return emit(...args);
  }) as typeof core.emit;
  const complete = failing as unknown as { complete: (record: typeof later,
    current: { run: string; turn: string; claim: NonNullable<ReturnType<typeof lead.claimFromPeer>["claim"]> },
    reply: { text: string; ok: boolean }, at: number) => Promise<void> };
  const startAndFail = async (id: string): Promise<string> => {
    const current = schedules.get(id);
    wall.value = Math.max(wall.value, current.next_run! + 1_000);
    setSystemTime(new Date(wall.value));
    const run = randomUUID();
    const accepted = lead.claimFromPeer(core.nodeId, { schedule: id, slot: current.next_run!, run, epoch });
    expect(accepted.claimed).toBe(true);
    schedules.progress(core.nodeId, { epoch, run_id: current.run_id, change: { op: "put",
      schedule: { ...current, run_id: run } } }, holds);
    const active = { run, turn: "failed", claim: accepted.claim! };
    for (let attempt = 0; attempt < 5; attempt++)
      await complete.complete(failing.get(id), active, { text: "failed", ok: false }, wall.value + attempt * 120_000);
    return run;
  };
  const oldestRun = await startAndFail(schedule.id);
  let laterRun = "";
  for (let i = 0; i < 100; i++) laterRun = await startAndFail(later.id);
  expect(JSON.parse(core.store.getMeta("schedule_completion_unresolved")!)).toHaveLength(2);
  expect(failing.unresolvedPage().entries.some((entry) => entry.run === oldestRun)).toBe(true);
  expect(failing.status()).toContain("2 unresolved runs");
  core.emit = emit;
  schedules.progress(core.nodeId, { epoch, run_id: laterRun, change: { op: "put", completion_run: laterRun,
    schedule: { ...schedules.get(later.id), last_result: "reconciled" } } }, holds);
  expect(failing.status()).toContain(`run ${oldestRun}`);
  expect(failing.status()).toContain("1 unresolved run");
  expect(failing.unresolvedPage().total).toBe(1);
});

test("a legacy count-only overflow remains visible after retained entries reconcile", () => {
  const { core, schedules } = authority();
  core.store.setMeta("schedule_completion_unresolved_overflow", "1");
  expect(schedules.status()).toContain("1 older schedule completion outcome");
  expect(new Schedules(core, { valid: () => true, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} }).status()).toContain("need review");
});

test("removed schedules clear unresolved outcomes with one durable general note", () => {
  const { core, schedules, schedule } = authority();
  const posts: string[] = [];
  const emit = core.emit.bind(core);
  core.emit = ((...args: Parameters<typeof core.emit>) => {
    if (args[0] === "msg.post" && args[2]?.channel === "general") posts.push((args[1] as { text: string }).text);
    return emit(...args);
  }) as typeof core.emit;
  core.store.setMeta("schedule_completion_unresolved", JSON.stringify([
    { id: schedule.id, name: schedule.name, run: randomUUID() },
  ]));
  schedules.remove(schedule.id);
  expect(schedules.unresolvedPage().total).toBe(0);
  expect(new Schedules(core, { valid: () => true, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} }).unresolvedPage().total).toBe(0);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain("superseded");
});

test("repeated add fail remove cycles leave no unresolved growth", () => {
  const { core, schedules } = authority();
  for (let i = 0; i < 120; i++) {
    const added = schedules.add({ name: `Cycle ${i}`, cron: "*/5 * * * *", task: { prompt: "check" } }, "alex");
    core.store.setMeta("schedule_completion_unresolved", JSON.stringify([
      ...JSON.parse(core.store.getMeta("schedule_completion_unresolved") ?? "[]") as unknown[],
      { id: added.id, name: added.name, run: randomUUID() },
    ]));
    schedules.remove(added.id);
    schedules.unresolvedPage();
  }
  expect(JSON.parse(core.store.getMeta("schedule_completion_unresolved")!)).toEqual([]);
});

test("clock and lease failures precede unresolved completion status", () => {
  const { core, schedules, schedule, lead, epoch } = authority();
  const run = randomUUID();
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: schedule.next_run!, run, epoch }).claimed).toBe(true);
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...schedule, run_id: run } } }, (node, value) => lead.holds(node, value));
  core.store.setMeta("schedule_completion_unresolved", JSON.stringify([
    { id: schedule.id, name: schedule.name, run },
  ]));
  const clock = new Schedules(core, { valid: () => false,
    leaseFailure: () => new PeerCallError(409, "clock_skew", "clock offset 600000 ms"),
    claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} });
  const status = clock.status()!;
  expect(status).toContain("clock is 10 min off");
  expect(status).toContain("unresolved");
  expect(status.indexOf("clock")).toBeLessThan(status.indexOf("Completion"));
});

test("cursor paging keeps later unresolved identities after a prior row resolves", () => {
  const { core, schedules, schedule, lead, epoch, wall } = authority();
  const rows = [schedule,
    schedules.add({ name: "Two", cron: "*/5 * * * *", task: { prompt: "check" } }, "alex"),
    schedules.add({ name: "Three", cron: "*/5 * * * *", task: { prompt: "check" } }, "alex")];
  const entries = rows.map((row) => {
    wall.value = Math.max(wall.value, row.next_run! + 1_000);
    setSystemTime(new Date(wall.value));
    const run = randomUUID();
    expect(lead.claimFromPeer(core.nodeId, { schedule: row.id, slot: row.next_run!, run, epoch }).claimed).toBe(true);
    schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put",
      schedule: { ...row, run_id: run } } }, (node, value) => lead.holds(node, value));
    return { id: row.id, name: row.name, run };
  });
  core.store.setMeta("schedule_completion_unresolved", JSON.stringify(entries));
  const first = schedules.unresolvedPage(undefined, 1);
  expect(first.entries).toHaveLength(1);
  expect(first.next_cursor).toBeTruthy();
  schedules.remove(first.entries[0]!.id);
  const rest = schedules.unresolvedPage(first.next_cursor!, 100);
  expect(rest.entries).toHaveLength(2);
  expect(new Set([...first.entries, ...rest.entries].map((entry) => entry.id)).size).toBe(3);
  expect(rest.next_cursor).toBeNull();
  expect(() => schedules.unresolvedPage(undefined, 101)).toThrow("invalid");
  expect(() => schedules.unresolvedPage("invalid", 1)).toThrow("invalid");
});

test("hard-failure append reconciles stale rows and deduplicates the same claimed run", async () => {
  const { core, schedules, schedule, lead, epoch, wall } = authority();
  const run = randomUUID();
  const accepted = lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: schedule.next_run!, run, epoch });
  expect(accepted.claimed).toBe(true);
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...schedule, run_id: run } } }, (node, value) => lead.holds(node, value));
  core.store.setMeta("schedule_completion_unresolved", JSON.stringify(Array.from({ length: 150 }, () => ({
    id: schedule.id, name: schedule.name, run: randomUUID(),
  }))));
  const failing = new Schedules(core, { valid: () => true, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} });
  withScheduleClock(failing);
  const emit = core.emit.bind(core);
  core.emit = ((...args: Parameters<typeof core.emit>) => {
    if (args[0] === "msg.post" && "text" in args[1] && String(args[1].text).includes('"completion_run"'))
      throw new Error("completion unavailable");
    return emit(...args);
  }) as typeof core.emit;
  const complete = failing as unknown as { complete: (record: typeof schedule,
    active: { run: string; turn: string; claim: NonNullable<typeof accepted.claim> },
    reply: { text: string; ok: boolean }, at: number) => Promise<void> };
  for (let cycle = 0; cycle < 2; cycle++) {
    const active = { run, turn: "failed", claim: accepted.claim! };
    for (let attempt = 0; attempt < 5; attempt++)
      await complete.complete(failing.get(schedule.id), active, { text: "failed", ok: false }, wall.value + attempt * 120_000);
    expect(JSON.parse(core.store.getMeta("schedule_completion_unresolved")!)).toHaveLength(1);
  }
});

test("paging a resolved completion clears stale local failure before status", () => {
  const { core, schedules, schedule, lead, epoch } = authority();
  const run = randomUUID();
  const accepted = lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: schedule.next_run!, run, epoch });
  expect(accepted.claimed).toBe(true);
  const holds = (node: string, value: number) => lead.holds(node, value);
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...schedule, run_id: run } } }, holds);
  core.store.setMeta("schedule_completion_unresolved", JSON.stringify([
    { id: schedule.id, name: schedule.name, run, claim: accepted.claim },
  ]));
  const reader = new Schedules(core, { valid: () => true, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} });
  (reader as unknown as { completionStatus: Map<string, { id: string; run: string; message: string }> })
    .completionStatus.set(`${schedule.id}:${run}`, { id: schedule.id, run, message: "schedule completion write failed" });
  schedules.progress(core.nodeId, { epoch, run_id: run, change: { op: "put", completion_run: run,
    schedule: { ...schedules.get(schedule.id), last_result: "done" } } }, holds);
  expect(reader.unresolvedPage().total).toBe(0);
  expect(reader.status()).toBeNull();
});

test("persistent completion failures have a retry bound and release later slots", async () => {
  const { core, schedule, lead, epoch, wall } = authority();
  const warnings: string[] = [];
  core.log.warn = ((code: string) => { warnings.push(code); }) as typeof core.log.warn;
  let turns = 0;
  let reply: { text: string; ok: boolean } | null = { text: "failed", ok: false };
  const schedules = new Schedules(core, { valid: () => true, epoch: () => epoch,
    claim: async (id, slot, run) => lead.claimFromPeer(core.nodeId, { schedule: id, slot, run, epoch }),
    turn: () => `turn-${++turns}`, reply: () => reply, interrupt: () => {} });
  withScheduleClock(schedules);
  await schedules.tick(wall.value);
  core.store.setMeta("schedule_completion_unresolved", JSON.stringify(Array.from({ length: 100 }, () => ({
    id: schedule.id, name: schedule.name, run: schedules.get(schedule.id).run_id, local_id: randomUUID(),
  }))));
  const emit = core.emit.bind(core);
  let attempts = 0;
  core.emit = ((kind: Parameters<typeof core.emit>[0], body: Parameters<typeof core.emit>[1], opts: Parameters<typeof core.emit>[2]) => {
    if (kind === "msg.post" && "text" in body && String(body.text).includes('"last_result":"failed"')) {
      attempts++;
      throw new Error("persistent write failure");
    }
    return emit(kind, body, opts);
  }) as typeof core.emit;
  for (let i = 0; i < 18; i++) await schedules.tick(wall.value + i * 15_000);
  expect(attempts).toBe(5);
  expect(JSON.parse(core.store.getMeta("schedule_completion_unresolved")!)).toHaveLength(2);
  expect(core.store.getMeta("schedule_completion_unresolved_overflow")).toBeNull();
  const firstPage = schedules.unresolvedPage(undefined, 1);
  expect(schedules.unresolvedPage(firstPage.next_cursor!, 1).entries).toHaveLength(1);
  expect(schedules.unresolvedPage(firstPage.next_cursor!, 1).total).toBe(2);
  expect(() => schedules.unresolvedPage("invalid")).toThrow("invalid");
  expect(warnings.filter((code) => code === "schedule_completion_unresolved")).toHaveLength(1);
  expect(schedules.status()).toContain("unresolved");
  expect(new Schedules(core, { valid: () => true, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} }).status()).toContain("unresolved");
  reply = null;
  wall.value = schedules.get(schedule.id).next_run! + 1_000;
  setSystemTime(new Date(wall.value));
  await schedules.tick(wall.value);
  expect(turns).toBe(2);
  expect(schedules.get(schedule.id).next_run).toBeGreaterThan(schedule.next_run!);
});

test("completion write errors appear in owner status and recovery clears them", async () => {
  const { core, lead, epoch, wall } = authority();
  const schedules = new Schedules(core, { valid: () => true, epoch: () => epoch,
    claim: async (id, slot, run) => lead.claimFromPeer(core.nodeId, { schedule: id, slot, run, epoch }),
    turn: () => "turn", reply: () => ({ text: "finished", ok: true }), interrupt: () => {} });
  withScheduleClock(schedules);
  await schedules.tick(wall.value);
  const emit = core.emit.bind(core);
  let fail = true;
  core.emit = ((kind: Parameters<typeof core.emit>[0], body: Parameters<typeof core.emit>[1], opts: Parameters<typeof core.emit>[2]) => {
    if (fail && kind === "msg.post" && "text" in body && String(body.text).includes('"last_result":"finished"')) {
      fail = false;
      throw new PeerCallError(404, "not_found", "no such schedule");
    }
    return emit(kind, body, opts);
  }) as typeof core.emit;
  await schedules.tick(wall.value);
  expect(schedules.status()).toBe("schedule removed at the authority");
  await schedules.tick(wall.value + 15_000);
  expect(schedules.status()).toBeNull();
});

test("progress clamps each lead-written capacity timestamp to authority time", () => {
  const { core, schedules, schedule, lead, epoch, wall } = authority();
  const run = randomUUID();
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: schedule.next_run!, run, epoch }).claimed).toBe(true);
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put", schedule: {
    ...schedule, run_id: run, capacity_checked_at: { mira: 9_000_000_000_000_000, alex: wall.value - 10_000 },
  } } }, (node, value) => lead.holds(node, value));
  expect(schedules.get(schedule.id).capacity_checked_at).toEqual({ mira: wall.value + 5_000, alex: wall.value - 10_000 });
});

test("local not_found during a claim is not reported as an outdated authority", async () => {
  const { core, wall } = authority();
  const schedules = new Schedules(core, { valid: () => true,
    claim: async () => { throw new HttpError(404, "not_found", "schedule removed"); },
    turn: () => "", reply: () => null, interrupt: () => {} });
  await schedules.tick(wall.value);
  expect(schedules.status()).toBeNull();
});

test("an authority's missing schedule has a distinct owner status from a missing route", async () => {
  const { core, wall } = authority();
  const runner = (message: string) => new Schedules(core, { valid: () => true,
    claim: async () => { throw new PeerCallError(404, "not_found", message); },
    turn: () => "", reply: () => null, interrupt: () => {} });
  const removed = runner("no such schedule");
  await removed.tick(wall.value);
  expect(removed.status()).toBe("schedule removed at the authority");
  const oldPeer = runner("not found");
  await oldPeer.tick(wall.value);
  expect(oldPeer.status()).toBe("scheduled duties start when the roster authority runs pre.10; update the authority first");
});

test("an authoritative claim reply clears the previous transport status", async () => {
  const { core, wall } = authority();
  let offline = true;
  const schedules = new Schedules(core, { valid: () => true,
    claim: async () => {
      if (offline) throw new PeerCallError(503, "authority_unreachable", "offline");
      return { claimed: false, reason: "just_ran" as const };
    }, turn: () => "", reply: () => null, interrupt: () => {} });
  await schedules.tick(wall.value);
  expect(schedules.status()).toBe("schedule authority unreachable");
  offline = false;
  await schedules.tick(wall.value);
  expect(schedules.status()).toBe("schedule slot already ran");
});

test("authority refusal codes have distinct owner status", async () => {
  const { core, wall } = authority();
  const messages = {
    stale_run: "schedule run changed at the authority",
    forbidden: "schedule authority refused this lead",
    rate_limited: "schedule authority rate limited this lead",
    just_ran: "schedule slot already ran",
  };
  for (const [code, message] of Object.entries(messages)) {
    const schedules = new Schedules(core, { valid: () => true,
      claim: async () => { throw new PeerCallError(409, code, code); },
      turn: () => "", reply: () => null, interrupt: () => {} });
    await schedules.tick(wall.value);
    expect(schedules.status()).toBe(message);
  }
});

test("an acknowledged claim with missing progress is reconciled without replacing the prior result", () => {
  const { core, schedules, schedule, lead, epoch, wall } = authority();
  core.emit("msg.post", { text: "walkie-talkie-schedule:v1:" + JSON.stringify({
    op: "put", term: core.authorityLeaseTerm, after: null, rev: 1,
    schedule: { ...schedule, last_result: "prior completed result" } }) }, { channel: SCHEDULE_CHANNEL });
  const slot = schedule.next_run!;
  const first = { schedule: schedule.id, slot, run: randomUUID(), epoch };
  expect(lead.claimFromPeer(core.nodeId, first).claimed).toBe(true);
  wall.value += 15_000;
  setSystemTime(new Date(wall.value));
  expect(lead.claimFromPeer(core.nodeId, { ...first, run: randomUUID() }).reason).toBe("just_ran");
  const recovered = schedules.get(schedule.id);
  expect(recovered.next_run).toBeGreaterThan(wall.value);
  expect(recovered.last_run).toBe(slot);
  expect(recovered.run_id).toBe(first.run);
  expect(recovered.last_result).toBe("prior completed result");
});

test("a run-now claim over an unclaimed due slot reconciles that slot after its start put is lost", () => {
  const { core, schedules, schedule, lead, epoch, wall } = authority();
  const due = schedule.next_run!;
  const manualSlot = wall.value;
  const manualRun = randomUUID();
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: manualSlot,
    run: manualRun, epoch, run_now: true }).claimed).toBe(true);
  wall.value += 15_000;
  setSystemTime(new Date(wall.value));
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: due,
    run: randomUUID(), epoch })).toMatchObject({ claimed: false, reason: "just_ran" });
  expect(schedules.get(schedule.id)).toMatchObject({ run_id: manualRun, last_run: manualSlot });
  expect(schedules.get(schedule.id).next_run).toBeGreaterThan(wall.value);
});

test("ten hours of missed cadence slots require one claim and retain the completed result", async () => {
  const node = tnode("alex");
  const { team, create } = createTeam(node);
  const wall = { value: now() };
  setSystemTime(new Date(wall.value));
  const core = makeCore(node, team, cleanups, { clock: () => wall.value });
  core.ingest(create, "local");
  core.emit("channel.upsert", { name: "general" });
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex"] });
  const lead = new Leadership({ core, preferred: () => core.nodeId, lost: () => {}, now: () => wall.value });
  let claims = 0;
  let turns = 0;
  const schedules = new Schedules(core, {
    valid: () => lead.valid, epoch: () => lead.epoch,
    claim: (id, slot, run, runNow, targets) => { claims++; return lead.claimSchedule(id, slot, run, runNow, targets); },
    turn: () => `turn-${++turns}`, reply: () => ({ text: "completed", ok: true }), interrupt: () => {},
  });
  const schedule = schedules.add({ name: "Every15", cron: "*/15 * * * *", task: { prompt: "check" } }, "alex");
  await lead.acquire();
  wall.value = schedule.next_run! + 10 * 60 * 60_000;
  setSystemTime(new Date(wall.value));
  await lead.acquire();
  await schedules.tick(wall.value);
  await schedules.tick(wall.value);
  const current = schedules.get(schedule.id);
  const posts = core.store.channelEventCount(SCHEDULE_CHANNEL);
  expect(claims).toBe(1);
  expect(turns).toBe(1);
  expect(posts).toBeLessThanOrEqual(6);
  expect(current.next_run).toBeGreaterThan(wall.value);
  expect(current.last_result).toBe("completed");
  lead.stop();
});

test("failed progress write leaves an owner-visible authority error after an accepted claim", async () => {
  const a = tnode("alex"), k = tnode("mira");
  const { team, create } = createTeam(a);
  const wall = { value: now() };
  setSystemTime(new Date(wall.value));
  const A = makeCore(a, team, cleanups, { clock: () => wall.value });
  A.ingest(create, "local");
  A.emit("team.member", { login: k.login, handle: k.handle, role: "owner" });
  A.emit("team.node", { node_id: k.keys.nodeId, login: k.login, hostname: k.hostname,
    pubkey: k.keys.pubkey, ip: "127.0.0.1" });
  A.emit("channel.upsert", { name: "general" });
  A.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "mira"] });
  const idle = { valid: () => true, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} };
  const schedule = new Schedules(A, idle).add({ name: "Job", cron: "*/5 * * * *", task: { prompt: "check" } }, "alex");
  const K = makeCore(k, team, cleanups, { clock: () => wall.value });
  feed(K, A.store.queryEvents({ limit: 100 }).map((row) => JSON.parse(row.json)).sort((x, y) => x.seq - y.seq));
  const client = { addrOf: () => ({ ip: "127.0.0.1", port: 9000 }),
    scheduleProgress: async () => { throw new PeerCallError(0, "unreachable", "connection lost"); } } as unknown as PeerClient;
  let failClaim = true;
  const schedules = new Schedules(K, { valid: () => true, epoch: () => 1,
    claim: async () => { if (failClaim) throw new HttpError(503, "authority_unreachable", "offline"); return true; },
    turn: () => "turn", reply: () => null, interrupt: () => {} }, client);
  wall.value = schedule.next_run! + 1_000;
  setSystemTime(new Date(wall.value));
  await schedules.tick(wall.value);
  expect(schedules.status()).toBe("schedule authority unreachable");
  failClaim = false;
  await schedules.tick(wall.value);
  expect(schedules.status()).toBe("schedule authority unreachable");
  expect(schedules.get(schedule.id).run_id).toBeNull();
});
