import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PeerClient } from "../../src/daemon/peer-client.ts";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { verifySchedulePeer, type SignedSchedulePeer } from "../../src/daemon/orchestrator/schedule-forward.ts";
import { Schedules } from "../../src/daemon/orchestrator/schedules.ts";
import { withScheduleClock } from "../helpers/talkie-retry-clock.ts";
import { ScheduleProgress } from "../../src/protocol/talkie-management.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
const idle = { valid: () => true, claim: async () => false,
  turn: () => "", reply: () => null, interrupt: () => {} };

test("completion retry after lost acknowledgement and owner edit uses stable signed content", async () => {
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
  const owner = new Schedules(authority, idle);
  const schedule = owner.add({ name: "Job", cron: "*/5 * * * *", task: { prompt: "check" } }, "alex");
  const remote = makeCore(k, team, cleanups, { clock: () => wall.value });
  const sync = () => feed(remote, authority.store.queryEvents({ limit: 100 }).map((row) => JSON.parse(row.json))
    .sort((x, y) => x.seq - y.seq));
  sync();
  const lead = new Leadership({ core: authority, preferred: () => remote.nodeId,
    lost: () => {}, now: () => wall.value });
  const epoch = lead.grant(remote.nodeId).epoch;
  wall.value = schedule.next_run! + 1_000;
  setSystemTime(new Date(wall.value));
  const run = randomUUID();
  const claimed = lead.claimFromPeer(remote.nodeId, { schedule: schedule.id, slot: schedule.next_run!, run, epoch });
  expect(claimed.claimed).toBe(true);
  owner.progress(remote.nodeId, { epoch, run_id: null, change: { op: "put",
    schedule: { ...new Schedules(remote, idle).get(schedule.id), run_id: run } } },
  (node, value) => lead.holds(node, value));
  sync();

  const signatures: string[] = [];
  let loseAck = true;
  const client = { addrOf: () => ({ ip: "127.0.0.1", port: 1 }),
    scheduleProgress: async (_addr: unknown, wire: SignedSchedulePeer) => {
      signatures.push(wire.sig);
      const request = verifySchedulePeer(authority, remote.nodeId, "schedule-progress", wire, ScheduleProgress);
      const event = owner.progress(remote.nodeId, request, (node, value) => lead.holds(node, value), wire.ts, wire.sig);
      if (loseAck) { loseAck = false; throw new Error("acknowledgement lost"); }
      return event;
    } } as unknown as PeerClient;
  const remoteSchedules = new Schedules(remote, { ...idle, epoch: () => epoch }, client);
  withScheduleClock(remoteSchedules);
  const active = { run, turn: "turn", claim: claimed.claim! };
  const complete = remoteSchedules as unknown as { complete: (record: typeof schedule, run: typeof active,
    reply: { text: string; ok: boolean }, at: number) => Promise<void> };
  await complete.complete(remoteSchedules.get(schedule.id), active, { text: "finished", ok: true }, wall.value);
  expect(owner.get(schedule.id).last_result).toBe("finished");
  expect(remoteSchedules.get(schedule.id).last_result).toBeNull();
  owner.edit(schedule.id, { name: "Renamed", cron: "0 * * * *" });
  const count = authority.store.channelEventCount(SCHEDULE_CHANNEL);
  wall.value += 60_000;
  setSystemTime(new Date(wall.value));
  await complete.complete(remoteSchedules.get(schedule.id), active, { text: "ignored", ok: false }, wall.value);
  expect(signatures).toHaveLength(2);
  expect(signatures[1]).not.toBe(signatures[0]);
  expect(authority.store.channelEventCount(SCHEDULE_CHANNEL)).toBe(count);
  expect(owner.get(schedule.id).name).toBe("Renamed");
  expect(remoteSchedules.get(schedule.id).last_result).toBe("finished");
  expect(remoteSchedules.status()).toBeNull();
});
