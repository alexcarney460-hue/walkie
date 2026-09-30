import { afterEach, expect, test } from "bun:test";
import { Schedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { PeerCallError, type PeerClient } from "../../src/daemon/peer-client.ts";
import { HttpError } from "../../src/daemon/http.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function authority() {
  const a = tnode("alex");
  const { team, create } = createTeam(a);
  const core = makeCore(a, team, cleanups);
  core.ingest(create, "local");
  core.emit("channel.upsert", { name: "general" });
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex"] });
  return core;
}

test("LOW-7 stale progress cannot restore a run after reset", () => {
  const core = authority();
  const idle = { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} };
  const schedules = new Schedules(core, idle);
  const added = schedules.add({ name: "Job", cron: "*/5 * * * *", task: { prompt: "x" } }, "alex");
  const oldRun = "22222222-2222-4222-8222-222222222222";
  core.emit("msg.post", { text: "walkie-talkie-schedule:v1:" + JSON.stringify({
    op: "put", term: core.authorityLeaseTerm, after: null, epoch: 0, rev: 1,
    schedule: { ...added, run_id: oldRun } }) }, { channel: SCHEDULE_CHANNEL });
  expect(schedules.get(added.id).run_id).toBe(oldRun);
  schedules.reset(added.id, now());
  const reset = schedules.get(added.id);
  const before = core.store.channelEventCount(SCHEDULE_CHANNEL);
  expect(() => schedules.progress(core.nodeId, { epoch: 1, run_id: oldRun,
    change: { op: "put", schedule: { ...reset, run_id: oldRun, last_result: "stale completion" } } },
    () => true)).toThrow("schedule run changed");
  expect(core.store.channelEventCount(SCHEDULE_CHANNEL)).toBe(before);
  expect(schedules.get(added.id).run_id).toBeNull();
});

test("LOW-3 a replicated removal interrupts the lead's active turn", async () => {
  const core = authority();
  let interrupted = 0;
  const schedules = new Schedules(core, { valid: () => true, claim: async () => true,
    turn: () => "turn-one", reply: () => null, interrupt: () => { interrupted++; } });
  const added = schedules.add({ name: "Job", cron: "*/5 * * * *", task: { prompt: "x" } }, "alex");
  await schedules.runNow(added.id);
  core.emit("msg.post", { text: "walkie-talkie-schedule:v1:" + JSON.stringify({
    op: "remove", id: added.id, term: core.authorityLeaseTerm, after: null, epoch: 0, rev: 2 }) },
  { channel: SCHEDULE_CHANNEL });
  expect(readSchedules(core)).toHaveLength(0);
  await schedules.tick();
  expect(interrupted).toBe(1);
});

test("LOW-4 a failed schedule does not stop the next due schedule", async () => {
  const core = authority();
  let turns = 0;
  const schedules = new Schedules(core, { valid: () => true, claim: async () => true,
    turn: () => "turn-" + ++turns, reply: () => { throw new Error("one reply failed"); }, interrupt: () => {} });
  const first = schedules.add({ name: "A", cron: "*/5 * * * *", task: { prompt: "a" } }, "alex");
  const second = schedules.add({ name: "B", cron: "*/5 * * * *", task: { prompt: "b" } }, "alex");
  await schedules.runNow(first.id);
  core.emit("msg.post", { text: "walkie-talkie-schedule:v1:" + JSON.stringify({
    op: "put", term: core.authorityLeaseTerm, after: null, epoch: 0, rev: 1,
    schedule: { ...second, next_run: Math.floor(Date.now() / 300_000) * 300_000 } }) },
  { channel: SCHEDULE_CHANNEL });
  await expect(schedules.tick()).resolves.toBeUndefined();
  expect(turns).toBe(2);
});

test("LOW-4 an unreachable authority appears in the lead's local status", async () => {
  const core = authority();
  const schedules = new Schedules(core, { valid: () => true,
    claim: async () => { throw new HttpError(503, "authority_unreachable", "offline"); },
    turn: () => "", reply: () => null, interrupt: () => {} });
  const added = schedules.add({ name: "Job", cron: "*/5 * * * *", task: { prompt: "x" } }, "alex");
  core.emit("msg.post", { text: "walkie-talkie-schedule:v1:" + JSON.stringify({
    op: "put", term: core.authorityLeaseTerm, after: null, epoch: 0, rev: 1,
    schedule: { ...added, next_run: Math.floor(Date.now() / 300_000) * 300_000 } }) },
  { channel: SCHEDULE_CHANNEL });
  await expect(schedules.tick()).resolves.toBeUndefined();
  expect(schedules.status()).toBe("schedule authority unreachable");
  schedules.edit(added.id, { cron: "0 0 * * *" });
  await schedules.tick();
  expect(schedules.status()).toBe("schedule authority unreachable");
});

test("LOW-6 a missing defaults route does not abort a tick and sets local status", async () => {
  const a = tnode("alex"), k = tnode("mira");
  const { team, create } = createTeam(a);
  const A = makeCore(a, team, cleanups);
  A.ingest(create, "local");
  A.emit("team.member", { login: k.login, handle: k.handle, role: "owner" });
  A.emit("team.node", { node_id: k.keys.nodeId, login: k.login, hostname: k.hostname,
    pubkey: k.keys.pubkey, ip: "127.0.0.1" });
  A.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "mira"] });
  const K = makeCore(k, team, cleanups);
  feed(K, A.store.queryEvents({ limit: 100 }).map((row) => JSON.parse(row.json)).sort((x, y) => x.seq - y.seq));
  const client = { addrOf: () => ({ ip: "127.0.0.1", port: 9000 }),
    scheduleDefaults: async () => { throw new PeerCallError(404, "not_found", "not found"); } } as unknown as PeerClient;
  const schedules = new Schedules(K, { valid: () => true, epoch: () => 1, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} }, client);
  await expect(schedules.defaults()).rejects.toMatchObject({ code: "authority_outdated" });
  await expect(schedules.tick(now())).resolves.toBeUndefined();
  expect(schedules.status()).toBe("scheduled duties start when the roster authority runs pre.10; update the authority first");
});
