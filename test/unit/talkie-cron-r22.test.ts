import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { Schedules } from "../../src/daemon/orchestrator/schedules.ts";
import { withScheduleClock } from "../helpers/talkie-retry-clock.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
const idle = { valid: () => true, claim: async () => false,
  turn: () => "", reply: () => null, interrupt: () => {} };

test("edited schedule acknowledges only the remote lead's exact committed completion retry", () => {
  const a = tnode("alex"), k = tnode("mira");
  const { team, create } = createTeam(a);
  const wall = { value: now() };
  setSystemTime(new Date(wall.value));
  const authority = makeCore(a, team, cleanups, { clock: () => wall.value });
  authority.ingest(create, "local");
  authority.emit("team.member", { login: k.login, handle: k.handle, role: "owner" });
  authority.emit("team.node", { node_id: k.keys.nodeId, login: k.login, hostname: k.hostname,
    pubkey: k.keys.pubkey, ip: "127.0.0.1" });
  authority.emit("channel.upsert", { name: "general" });
  authority.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "mira"] });
  const schedules = new Schedules(authority, idle);
  const schedule = schedules.add({ name: "Job", cron: "*/5 * * * *", task: { prompt: "check" } }, "alex");
  const remote = makeCore(k, team, cleanups, { clock: () => wall.value });
  feed(remote, authority.store.queryEvents({ limit: 100 }).map((row) => JSON.parse(row.json))
    .sort((x, y) => x.seq - y.seq));
  const remoteSchedules = new Schedules(remote, idle);
  const lead = new Leadership({ core: authority, preferred: () => remote.nodeId,
    lost: () => {}, now: () => wall.value });
  const epoch = lead.grant(remote.nodeId).epoch;
  wall.value = schedule.next_run! + 1_000;
  setSystemTime(new Date(wall.value));
  const run = randomUUID();
  expect(lead.claimFromPeer(remote.nodeId, { schedule: schedule.id, slot: schedule.next_run!, run, epoch }).claimed).toBe(true);
  const holds = (node: string, value: number) => lead.holds(node, value);
  schedules.progress(remote.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...remoteSchedules.get(schedule.id), run_id: run } } }, holds);
  feed(remote, authority.store.queryEvents({ limit: 100 }).map((row) => JSON.parse(row.json))
    .sort((x, y) => x.seq - y.seq));
  const stale = remoteSchedules.get(schedule.id);
  const request = { epoch, run_id: run, change: { op: "put" as const, completion_run: run,
    schedule: { ...stale, last_result: "finished" } } };
  const committed = schedules.progress(remote.nodeId, request, holds, wall.value, "signed-completion");
  schedules.edit(schedule.id, { name: "Renamed", cron: "0 * * * *" });
  const count = authority.store.channelEventCount(SCHEDULE_CHANNEL);
  expect(schedules.progress(remote.nodeId, request, holds, wall.value, "signed-completion")).toEqual(committed);
  expect(authority.store.channelEventCount(SCHEDULE_CHANNEL)).toBe(count);
  expect(schedules.progress(remote.nodeId, request, holds, wall.value,
    "different-signed-completion")).toEqual(committed);
  expect(() => schedules.progress(remote.nodeId, { ...request, change: { ...request.change,
    schedule: { ...request.change.schedule, last_result: "different result" } } }, holds, wall.value,
  "different-signed-completion")).toThrow();
  expect(authority.store.channelEventCount(SCHEDULE_CHANNEL)).toBe(count);
});

test("active run retains accepted claim identity when completion-time lookup fails", async () => {
  const node = tnode("alex");
  const { team, create } = createTeam(node);
  const wall = { value: now() };
  setSystemTime(new Date(wall.value));
  const core = makeCore(node, team, cleanups, { clock: () => wall.value });
  core.ingest(create, "local");
  core.emit("channel.upsert", { name: "general" });
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex"] });
  const schedule = new Schedules(core, idle).add({ name: "Job", cron: "*/5 * * * *", task: { prompt: "check" } }, "alex");
  const lead = new Leadership({ core, preferred: () => core.nodeId, lost: () => {}, now: () => wall.value });
  const epoch = lead.grant(core.nodeId).epoch;
  const schedules = new Schedules(core, {
    valid: () => true, epoch: () => epoch,
    claim: async (id, slot, run) => lead.claimFromPeer(core.nodeId, { schedule: id, slot, run, epoch }),
    turn: (_prompt, run) => run, reply: () => ({ text: "finished", ok: true }), interrupt: () => {},
  });
  wall.value = schedule.next_run! + 1_000;
  setSystemTime(new Date(wall.value));
  await schedules.tick(wall.value);
  const run = schedules.get(schedule.id).run_id;
  expect(run).toBeTruthy();
  const originalClaimEvents = core.store.scheduleClaimEvents.bind(core.store);
  core.store.scheduleClaimEvents = (() => { throw new Error("claim index unavailable"); }) as typeof core.store.scheduleClaimEvents;
  withScheduleClock(schedules);
  const originalEmit = core.emit.bind(core);
  core.emit = ((...args: Parameters<typeof core.emit>) => {
    if (args[0] === "msg.post" && "text" in args[1] &&
      String(args[1].text).includes('"completion_run"')) throw new Error("completion unavailable");
    return originalEmit(...args);
  }) as typeof core.emit;
  for (let attempt = 0; attempt < 5; attempt++) await schedules.tick(wall.value += 120_000);
  const entries = JSON.parse(core.store.getMeta("schedule_completion_unresolved")!);
  expect(entries).toHaveLength(1);
  expect(entries[0].run).toBe(run);
  expect(entries[0].claim).toEqual(expect.objectContaining({ term: 0, seq: expect.any(Number), generation: 0 }));
  core.store.scheduleClaimEvents = originalClaimEvents;
});

test("claimless fallback entries stay distinct and cannot be cleared by an old signed completion", async () => {
  const node = tnode("alex");
  const { team, create } = createTeam(node);
  const wall = { value: now() };
  setSystemTime(new Date(wall.value));
  const core = makeCore(node, team, cleanups, { clock: () => wall.value });
  core.ingest(create, "local");
  core.emit("channel.upsert", { name: "general" });
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex"] });
  const schedules = new Schedules(core, idle);
  const schedule = schedules.add({ name: "Job", cron: "*/5 * * * *", task: { prompt: "check" } }, "alex");
  const lead = new Leadership({ core, preferred: () => core.nodeId, lost: () => {}, now: () => wall.value });
  const epoch = lead.grant(core.nodeId).epoch;
  const holds = (member: string, value: number) => lead.holds(member, value);
  const run = randomUUID();
  const fail = schedules as unknown as { complete: (record: typeof schedule,
    active: { run: string; turn: string }, reply: { text: string; ok: boolean }, at: number) => Promise<void> };
  withScheduleClock(schedules);
  const originalEmit = core.emit.bind(core);
  let blockCompletions = true;
  core.emit = ((...args: Parameters<typeof core.emit>) => {
    if (blockCompletions && args[0] === "msg.post" && "text" in args[1] &&
      String(args[1].text).includes('"completion_run"')) throw new Error("completion unavailable");
    return originalEmit(...args);
  }) as typeof core.emit;
  const exhaust = async (result: string) => {
    const active = { run, turn: result };
    for (let attempt = 0; attempt < 5; attempt++)
      await fail.complete(schedules.get(schedule.id), active, { text: result, ok: true }, wall.value + attempt * 120_000);
  };
  wall.value = schedule.next_run! + 1_000;
  setSystemTime(new Date(wall.value));
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: schedule.next_run!, run, epoch }).claimed).toBe(true);
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...schedule, run_id: run } } }, holds);
  const originalClaimEvents = core.store.scheduleClaimEvents.bind(core.store);
  core.store.scheduleClaimEvents = (() => { throw new Error("claim index unavailable"); }) as typeof core.store.scheduleClaimEvents;
  await exhaust("first");
  const firstLocalId = JSON.parse(core.store.getMeta("schedule_completion_unresolved")!)[0].local_id;
  core.store.scheduleClaimEvents = originalClaimEvents;
  blockCompletions = false;
  schedules.progress(core.nodeId, { epoch, run_id: run, change: { op: "put", completion_run: run,
    schedule: { ...schedules.get(schedule.id), last_result: "first" } } }, holds);
  const reset = schedules.reset(schedule.id, wall.value + 60_000);
  wall.value = reset.next_run! + 1_000;
  setSystemTime(new Date(wall.value));
  expect(lead.claimFromPeer(core.nodeId, { schedule: schedule.id, slot: reset.next_run!, run, epoch }).claimed).toBe(true);
  schedules.progress(core.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...reset, run_id: run } } }, holds);
  core.store.scheduleClaimEvents = (() => { throw new Error("claim index unavailable"); }) as typeof core.store.scheduleClaimEvents;
  blockCompletions = true;
  await exhaust("second");
  const entries = JSON.parse(core.store.getMeta("schedule_completion_unresolved")!);
  expect(entries).toHaveLength(1);
  expect(entries[0].local_id).toBeTruthy();
  expect(entries[0].local_id).not.toBe(firstLocalId);
  expect(entries.every((entry: { claim?: unknown }) => !entry.claim)).toBe(true);
  expect(schedules.status()).toContain("1 unresolved run");
  expect(JSON.parse(core.store.getMeta("schedule_completion_unresolved")!)).toEqual(entries);
  core.store.scheduleClaimEvents = originalClaimEvents;
});
