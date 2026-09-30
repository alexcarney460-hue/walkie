// H2b: the post-fold cap admits a fresh id after 20 lifetime adds and removals.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Schedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore, reopen } from "../../test/helpers/core.ts";
import { createTeam, now, tnode } from "../../test/helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
const idle = { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} };

test("H2b 20 lifetime adds, 10 removed, then 1 add: present on authority, replica and restart", () => {
  const a = tnode("alex"), k = tnode("mira");
  const { team, create } = createTeam(a);
  const wall = { value: now() + 1_000 };
  const clock = () => { wall.value += 7; setSystemTime(new Date(wall.value)); return wall.value; };
  const A = makeCore(a, team, cleanups, { clock });
  A.ingest(create, "local");
  const roster = [
    A.emit("team.member", { login: k.login, handle: k.handle, role: "owner" }),
    A.emit("team.node", { node_id: k.keys.nodeId, login: k.login, hostname: k.hostname, pubkey: k.keys.pubkey, ip: "127.0.0.1" }),
    A.emit("channel.upsert", { name: "general" }),
    A.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "mira"] }),
  ];
  const sA = new Schedules(A, idle);
  const actor = () => ({ handle: "alex", machine: A.hostname, audit_id: randomUUID() });
  const ids: string[] = [];
  for (let n = 0; n < 20; n++) {
    ids.push(sA.manage({ op: "add", ...actor(), input: { name: `Job ${String(n).padStart(2, "0")}`, cron: "*/5 * * * *", task: { prompt: `job ${n}` } } }).schedule!.id);
    readSchedules(A);
  }
  for (let n = 0; n < 10; n++) { sA.manage({ op: "remove", id: ids[n]!, ...actor() }); readSchedules(A); }
  console.log(`H2b after 20 adds and 10 removals the authority lists ${readSchedules(A).length}`);
  const added = sA.manage({ op: "add", ...actor(), input: { name: "Fresh", cron: "*/5 * * * *", task: { prompt: "FRESH" } } });
  const authority = readSchedules(A).map((s) => s.name);
  console.log(`H2b add returned ${JSON.stringify(added.schedule?.name)}; authority lists ${authority.length}, has Fresh: ${authority.includes("Fresh")}`);
  const K = makeCore(k, team, cleanups, { clock: () => wall.value });
  feed(K, [create, ...roster]);
  feed(K, A.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 100_000 }).map((r) => JSON.parse(r.json) as Event).sort((x, y) => x.seq - y.seq));
  const replica = readSchedules(K).map((s) => s.name);
  console.log(`H2b replica K lists ${replica.length}, has Fresh: ${replica.includes("Fresh")}`);
  const A2 = reopen(A, a);
  const restarted = readSchedules(A2).map((s) => s.name);
  console.log(`H2b authority after restart lists ${restarted.length}, has Fresh: ${restarted.includes("Fresh")}`);
  let again = "";
  try { new Schedules(A2, idle).manage({ op: "add", ...actor(), input: { name: "Fresh 2", cron: "*/5 * * * *", task: { prompt: "FRESH2" } } }); again = `listed after: ${readSchedules(A2).length}, has Fresh 2: ${readSchedules(A2).some((s) => s.name === "Fresh 2")}`; }
  catch (err) { again = String(err).slice(0, 100); }
  console.log(`H2b a second add after restart: ${again}`);
  expect(replica.includes("Fresh")).toBe(true);
  expect(restarted.includes("Fresh")).toBe(true);
  expect(replica).toEqual(authority);
  expect(restarted).toEqual(authority);
});
