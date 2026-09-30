import { afterEach, expect, test } from "bun:test";
import "../../src/daemon/orchestrator/schedule-routes.ts";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { Schedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import type { PeerClient } from "../../src/daemon/peer-client.ts";
import { verifyScheduleManagement, type SignedScheduleManagement } from "../../src/daemon/orchestrator/schedule-forward.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const idle = { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} };

test("B6 a newly promoted owner reads and forwards an audited pause to the authority", async () => {
  const alex = tnode("alex"), hina = tnode("hina");
  const { team, create } = createTeam(alex);
  const authority = makeCore(alex, team, cleanups);
  authority.ingest(create, "local");
  authority.emit("channel.upsert", { name: "general" });
  authority.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex"] });
  const manager = new Schedules(authority, idle);
  const schedule = manager.add({ name: "Check", cron: "*/5 * * * *", task: { prompt: "check" } }, "alex");
  authority.emit("team.member", { login: hina.login, handle: hina.handle, role: "owner" });
  authority.emit("team.node", { node_id: hina.keys.nodeId, login: hina.login, hostname: hina.hostname,
    pubkey: hina.keys.pubkey, ip: "127.0.0.1" });
  expect(await manager.ensureChannel()).toBe(true);
  const owner = makeCore(hina, team, cleanups);
  const events = authority.store.queryEvents({ limit: 1000 }).map((row) => JSON.parse(row.json))
    .sort((a, b) => a.seq - b.seq);
  feed(owner, events);
  expect(readSchedules(owner).map((item) => item.id)).toContain(schedule.id);
  registerHost(owner, { schedules: new Schedules(owner, idle) } as OrchestratorHost);
  const client = { addrOf: () => ({ ip: "127.0.0.1", port: 9000 }),
    scheduleManage: async (_address: unknown, request: SignedScheduleManagement) =>
      manager.manage(verifyScheduleManagement(authority, owner.nodeId, request), owner.nodeId) } as unknown as PeerClient;
  const path = `/v1/orchestrator/schedules/${schedule.id}`;
  const req = new Request(`http://localhost${path}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  const before = authority.store.channelEventCount("general");
  const response = await dispatch({ core: owner, client, req, url: new URL(req.url), via: "cli", listener: "unix",
    noTimeout: () => {} } as RouteCtx);
  expect(response.status).toBe(200);
  expect(readSchedules(authority)[0]?.enabled).toBe(false);
  expect(authority.store.channelEventCount("general")).toBe(before + 1);
});
