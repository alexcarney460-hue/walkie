// R14: schedules(c) refuses via === "phone" ("schedules are managed from this machine only"). The add/edit/remove
// routes now call schedules(c) only on the authority; a non-authority owner machine forwards before any phone check.
// Same harness as test/unit/talkie-schedule-forwarding.test.ts, with via: "phone". Nothing in the repo is modified.
import { afterEach, expect, test } from "bun:test";
import "../../src/daemon/orchestrator/schedule-routes.ts";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { Schedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import type { PeerClient } from "../../src/daemon/peer-client.ts";
import type { ScheduleManagement } from "../../src/protocol/talkie-management.ts";
import { feed, makeCore } from "../../test/helpers/core.ts";
import { createTeam, tnode } from "../../test/helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const idle = { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} };

test("H5 phone management is refused on both authority and forwarding owner", async () => {
  const alex = tnode("alex"), hina = tnode("hina");
  const { team, create } = createTeam(alex);
  const authority = makeCore(alex, team, cleanups);
  authority.ingest(create, "local");
  authority.emit("team.member", { login: hina.login, handle: hina.handle, role: "owner" });
  authority.emit("team.node", { node_id: hina.keys.nodeId, login: hina.login, hostname: hina.hostname, pubkey: hina.keys.pubkey, ip: "127.0.0.1" });
  authority.emit("channel.upsert", { name: "general" });
  authority.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "hina"] });
  const manager = new Schedules(authority, idle);
  registerHost(authority, { schedules: manager } as OrchestratorHost);
  const owner = makeCore(hina, team, cleanups);
  feed(owner, authority.store.queryEvents({ limit: 1000 }).map((row) => JSON.parse(row.json)).sort((a, b) => a.seq - b.seq));
  registerHost(owner, { schedules: new Schedules(owner, idle) } as OrchestratorHost);
  const client = { addrOf: () => ({ ip: "127.0.0.1", port: 9000 }),
    scheduleManage: async (_address: unknown, request: ScheduleManagement) => manager.manage(request) } as unknown as PeerClient;
  const post = async (core: typeof owner, name: string) => {
    const req = new Request("http://localhost/v1/orchestrator/schedules", { method: "POST",
      body: JSON.stringify({ name, cron: "*/5 * * * *", task: { prompt: "from the phone" } }) });
    try { const r = await dispatch({ core, client, req, url: new URL(req.url), via: "phone", listener: "tcp", noTimeout: () => {} } as unknown as RouteCtx); return r.status; }
    catch (err) { return `${(err as { status?: number }).status} ${(err as Error).message}`; }
  };
  const onAuthority = await post(authority, "Phone on authority");
  const viaOwner = await post(owner, "Phone via hina's machine");
  console.log("H5 phone add on the authority:", onAuthority, "| phone add via a non-authority owner machine:", viaOwner,
    "| authority lists:", JSON.stringify(readSchedules(authority).map((s) => s.name)));
  expect(String(onAuthority)).toContain("403");
  expect(String(viaOwner)).toContain("403");
});
