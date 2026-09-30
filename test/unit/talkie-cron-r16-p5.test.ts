// R15 attack 2 (visibility): a member's machine holds #talkie-schedules only as ordinary restricted stubs, forever.
// Schedules.status() uses uncoveredAuthority(), which treats any stub as "catching up". What does a member's
// dashboard status say while the authority is healthy?
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Schedules } from "../../src/daemon/orchestrator/schedules.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { stubOf } from "../../src/protocol/header.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { makeCore } from "../../test/helpers/core.ts";
import { createTeam, now, tnode } from "../../test/helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
const idle = { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} };

test("P5 a member's status does not show authority catch-up", () => {
  const a = tnode("alex"), m = tnode("mia");
  const { team, create } = createTeam(a);
  setSystemTime(new Date(now()));
  const A = makeCore(a, team, cleanups);
  A.ingest(create, "local");
  A.emit("team.member", { login: m.login, handle: m.handle, role: "member" });
  A.emit("team.node", { node_id: m.keys.nodeId, login: m.login, hostname: m.hostname, pubkey: m.keys.pubkey, ip: "127.0.0.1" });
  A.emit("channel.upsert", { name: "general" });
  A.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex"] });
  const sA = new Schedules(A, idle);
  sA.add({ name: "Job", cron: "*/5 * * * *", task: { prompt: "x" } }, "alex");
  const M = makeCore(m, team, cleanups);
  const events = A.store.queryEvents({ limit: 1000 }).map((r) => JSON.parse(r.json) as Event).sort((x, y) => x.seq - y.seq);
  for (const e of events) M.ingest((e.channel === SCHEDULE_CHANNEL ? stubOf(e) : e) as Event, "remote");
  const sM = new Schedules(M, idle);
  console.log(`P5 authority status=${JSON.stringify(sA.status())} | member status=${JSON.stringify(sM.status())} | member list=${sM.list().length}`);
  expect(sA.status()).toBe(null);
  expect(sM.status()).toBeNull();
});
