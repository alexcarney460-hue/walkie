import { afterEach, expect, test } from "bun:test";
import { Schedules, foldSchedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { SCHEDULE_CHANNEL, type Schedule } from "../../src/protocol/talkie-schedule.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const idle = { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} };
const prefix = "walkie-talkie-schedule:v1:";
const id = "11111111-1111-4111-8111-111111111111";
const base: Schedule = { id, name: "Check", cron: "*/5 * * * *", task: { prompt: "check" }, enabled: true,
  created_by: "alex", last_run: null, next_run: 36_000_000, last_result: null, failures: 0, run_id: null };
const term = (authority: string, ceiling: number | null = null) => ({ authority, after: null, floor: 0, ceiling });
const post = (origin: string, seq: number, change: unknown) =>
  ({ origin, seq, ts: seq, body: { text: prefix + JSON.stringify(change) } });

test("B1/B2 authority changes survive term handover; other owner and agent raw posts are ignored", () => {
  const a = "a".repeat(16), b = "b".repeat(16), k = "c".repeat(16);
  const terms = [term(a, 20), { ...term(b), after: "transfer:20" }];
  const posts = [post(a, 1, { op: "put", term: 0, rev: 0, schedule: base }),
    post(a, 2, { op: "put", term: 0, rev: 1, schedule: { ...base, enabled: false, next_run: null } }),
    post(k, 3, { op: "put", term: 0, rev: 2, schedule: { ...base, name: "owner raw" } }),
    { ...post(k, 4, { op: "put", term: 0, rev: 3, schedule: { ...base, name: "agent raw" } }),
      author: { handle: "mira", agent: "claude-code" } },
    post(b, 1, { op: "put", term: 1, after: "transfer:20", rev: 2, schedule: { ...base, name: "successor", enabled: false, next_run: null } }),
    post(b, 2, { op: "put", term: 1, after: "wrong transfer", rev: 99, schedule: { ...base, name: "wrong transfer" } }),
    post(a, 20, { op: "put", term: 0, rev: 9, schedule: { ...base, name: "outside window" } })];
  const expected = [{ ...base, name: "successor", enabled: false, next_run: null }];
  expect(foldSchedules(posts, terms)).toEqual(expected);
  expect(foldSchedules([...posts].reverse(), terms)).toEqual(expected);
});

test("B1 removed id cannot be resurrected in a successor term", () => {
  const a = "a".repeat(16), b = "b".repeat(16);
  expect(foldSchedules([post(a, 1, { op: "put", term: 0, rev: 0, schedule: base }),
    post(a, 2, { op: "remove", term: 0, rev: 1, id }),
    post(b, 1, { op: "put", term: 1, after: "transfer:10", rev: 2, schedule: base })],
  [term(a, 10), { ...term(b), after: "transfer:10" }])).toEqual([]);
});

test("B3 delayed non-authority put cannot evict an accepted schedule", () => {
  const a = "a".repeat(16), k = "c".repeat(16);
  const accepted = Array.from({ length: 20 }, (_, n) => post(a, n + 1, { op: "put", term: 0, rev: 0,
    schedule: { ...base, id: "00000000-0000-4000-8000-" + String(n + 1).padStart(12, "0") } }));
  const delayed = post(k, 1, { op: "put", term: 0, rev: 0, schedule: { ...base, name: "evict" } });
  const result = foldSchedules([delayed, ...accepted], [term(a)]);
  expect(result).toHaveLength(20);
  expect(result.some((s) => s.name === "evict")).toBe(false);
});

test("B1 demotion and machine revocation never change existing schedules", () => {
  const a = tnode("alex"), k = tnode("mira");
  const { team, create } = createTeam(a);
  const core = makeCore(a, team, cleanups);
  core.ingest(create, "local");
  core.emit("team.member", { login: k.login, handle: k.handle, role: "owner" });
  core.emit("team.node", { node_id: k.keys.nodeId, login: k.login, hostname: k.hostname,
    pubkey: k.keys.pubkey, ip: "127.0.0.1" });
  core.emit("channel.upsert", { name: "general" });
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "mira"] });
  const schedules = new Schedules(core, idle);
  const one = schedules.add({ name: "Nightly", cron: "*/5 * * * *", task: { prompt: "check" } }, "alex");
  schedules.edit(one.id, { enabled: false });
  const before = readSchedules(core);
  core.emit("team.member", { login: k.login, handle: k.handle, role: "member" });
  expect(readSchedules(core)).toEqual(before);
  core.emit("team.member", { login: k.login, handle: k.handle, role: "owner" });
  expect(readSchedules(core)).toEqual(before);
  core.emit("team.member", { login: k.login, handle: k.handle, role: "member" });
  core.emit("team.node", { node_id: k.keys.nodeId, login: k.login, hostname: k.hostname,
    pubkey: k.keys.pubkey, ip: "127.0.0.1", revoked: true });
  expect(readSchedules(core)).toEqual(before);
});

test("B1e replacing a leased lead machine leaves its authority-signed run state intact", () => {
  const a = tnode("alex"), h = tnode("hina");
  const { team, create } = createTeam(a);
  const slot = Math.floor(now() / 300_000) * 300_000 + 300_000;
  const wall = { value: slot - 60_000 };
  const core = makeCore(a, team, cleanups, { clock: () => wall.value });
  core.ingest(create, "local");
  core.emit("team.member", { login: h.login, handle: h.handle, role: "owner" });
  core.emit("team.node", { node_id: h.keys.nodeId, login: h.login, hostname: h.hostname,
    pubkey: h.keys.pubkey, ip: "127.0.0.1" });
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "hina"] });
  core.emit("msg.post", { text: prefix + JSON.stringify({ op: "put", term: 0, after: null,
    schedule: { ...base, next_run: slot } }) }, { channel: SCHEDULE_CHANNEL });
  let mono = 0;
  const lead = new Leadership({ core, preferred: () => h.keys.nodeId, lost: () => {},
    now: () => wall.value, monoNow: () => mono });
  mono = 34_000;
  const epoch = lead.grant(h.keys.nodeId).epoch;
  wall.value = slot;
  const run = "22222222-2222-4222-8222-222222222222";
  expect(lead.claimFromPeer(h.keys.nodeId, { schedule: id, slot, run, epoch }).claimed).toBe(true);
  new Schedules(core, idle).progress(h.keys.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...base, next_run: slot + 300_000, last_run: slot, run_id: run } } },
  (node, term) => lead.holds(node, term));
  const before = readSchedules(core);
  core.emit("team.node", { node_id: h.keys.nodeId, login: h.login, hostname: h.hostname,
    pubkey: h.keys.pubkey, ip: "127.0.0.1", revoked: true });
  expect(readSchedules(core)).toEqual(before);
});

test("B6 channel repair adds a promoted owner and removes a demoted member", async () => {
  const a = tnode("alex"), k = tnode("mira"), h = tnode("hina");
  const { team, create } = createTeam(a);
  const core = makeCore(a, team, cleanups);
  core.ingest(create, "local");
  core.emit("team.member", { login: k.login, handle: k.handle, role: "owner" });
  core.emit("channel.upsert", { name: "general" });
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "mira"] });
  core.emit("team.member", { login: h.login, handle: h.handle, role: "owner" });
  core.emit("team.member", { login: k.login, handle: k.handle, role: "member" });
  expect(await new Schedules(core, idle).ensureChannel()).toBe(true);
  expect(core.roster.channels.get(SCHEDULE_CHANNEL)?.members).toEqual(["alex", "hina"]);
  const firstAlerts = core.store.channelEventCount("general");
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "hina", "mira"] });
  expect(await new Schedules(core, idle).ensureChannel()).toBe(true);
  expect(core.store.channelEventCount("general")).toBe(firstAlerts + 1);
  expect(core.roster.channels.get(SCHEDULE_CHANNEL)?.members).toEqual(["alex", "hina"]);
});
