// H2: authority sequence order preserves a new schedule after a high-revision removal.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Schedules, foldSchedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { MAX_SCHEDULES, SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore, reopen } from "../../test/helpers/core.ts";
import { createTeam, now, tnode } from "../../test/helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
const idle = { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} };

test("H2 at the cap: remove an edited schedule, add a new one -> authority, replica and restart keep it", () => {
  const a = tnode("alex"), k = tnode("mira");
  const { team, create } = createTeam(a);
  setSystemTime(new Date(now()));
  const A = makeCore(a, team, cleanups);
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
  for (let n = 0; n < MAX_SCHEDULES; n++)
    ids.push(sA.manage({ op: "add", ...actor(), input: { name: `Job ${String(n).padStart(2, "0")}`, cron: "*/5 * * * *", task: { prompt: `job ${n}` } } }).schedule!.id);
  // Job 00 is edited three times (rev 3), then removed (rev 4); the person adds "New job" (rev 0) in the freed place.
  for (let i = 0; i < 3; i++) sA.manage({ op: "edit", id: ids[0]!, ...actor(), input: { name: `Job 00 v${i}` } });
  const removed = sA.manage({ op: "remove", id: ids[0]!, ...actor() });
  const added = sA.manage({ op: "add", ...actor(), input: { name: "New job", cron: "*/5 * * * *", task: { prompt: "NEW JOB" } } });
  const onAuthority = readSchedules(A).map((s) => s.name);
  console.log(`H2 remove -> ${JSON.stringify(removed.removed)}; add returned ${JSON.stringify(added.schedule?.name)}; authority (incremental cache) lists ${onAuthority.length}, has New job: ${onAuthority.includes("New job")}`);
  // A replica that folds the same signed posts in full.
  const K = makeCore(k, team, cleanups);
  feed(K, [create, ...roster]);
  const posts = A.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 100_000 }).map((r) => JSON.parse(r.json) as Event).sort((x, y) => x.seq - y.seq);
  feed(K, [...posts, ...A.store.queryEvents({ limit: 100_000 }).map((r) => JSON.parse(r.json) as Event).filter((e) => e.kind === "team.authority")]);
  const onReplica = readSchedules(K).map((s) => s.name);
  console.log(`H2 replica K lists ${onReplica.length}, has New job: ${onReplica.includes("New job")}`);
  const full = foldSchedules(posts.map((e) => ({ body: e.body as { text: string }, origin: e.origin, seq: e.seq, ts: e.ts })), A.authorityClaimTerms).map((s) => s.name);
  console.log(`H2 full fold of the same posts lists ${full.length}, has New job: ${full.includes("New job")}`);
  const A2 = reopen(A, a);
  const afterRestart = readSchedules(A2).map((s) => s.name);
  console.log(`H2 authority after daemon restart lists ${afterRestart.length}, has New job: ${afterRestart.includes("New job")}`);
  let edit = "";
  try { new Schedules(A2, idle).manage({ op: "edit", id: added.schedule!.id, ...actor(), input: { enabled: false } }); edit = "ok"; }
  catch (err) { edit = String(err).slice(0, 120); }
  console.log(`H2 editing the "added" schedule after restart: ${edit}`);
  expect(onAuthority.includes("New job")).toBe(true);
  expect(onReplica.includes("New job")).toBe(true);
  expect(onReplica).toEqual(onAuthority);
  expect(full).toEqual(onAuthority);
  expect(afterRestart.includes("New job")).toBe(true);
  expect(afterRestart).toEqual(onAuthority);
  expect(edit).toBe("ok");
});
