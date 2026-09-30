// R15 attack 3: (term, seq) fold. A replica receives the whole team history (roster chain, both terms' schedule
// changes, a reset, a removal) in random orders. After EVERY arrival the incremental cache (readSchedules) must equal a
// full fold of exactly the rows the replica holds, and the final state must equal the successor authority's view.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Schedules, foldSchedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import type { Core } from "../../src/daemon/core.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore, settle } from "../../test/helpers/core.ts";
import { createTeam, now, tnode } from "../../test/helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
const idle = { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} };
function allEvents(core: Core): Event[] {
  return core.store.queryEvents({ limit: 1_000_000 }).map((row) => JSON.parse(row.json) as Event);
}
function fullFold(core: Core) {
  const rows = core.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 2_147_483_647 });
  const events = rows.map((row) => { const e = JSON.parse(row.json) as Event & { body: { text: string } };
    return { body: { text: e.body.text }, author: e.author, origin: row.origin, seq: row.seq, ts: row.ts ?? undefined,
      verifiedAtIngest: !!e.author?.node && !!row.origin }; });
  return foldSchedules(events, core.authorityClaimTerms);
}
const view = (list: { id: string; name: string; enabled: boolean; cron: string; next_run: number | null }[]) =>
  JSON.stringify(list.map((s) => [s.id.slice(0, 8), s.name, s.enabled, s.cron, s.next_run]));
function rng(seed: number) { return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }

test("P4 cached fold equals a full fold after every arrival, across a handover, in 25 random orders", async () => {
  const a = tnode("alex"), b = tnode("bea"), r = tnode("rex");
  const { team, create } = createTeam(a);
  setSystemTime(new Date(now()));
  const A = makeCore(a, team, cleanups);
  A.ingest(create, "local");
  for (const n of [b, r]) {
    A.emit("team.member", { login: n.login, handle: n.handle, role: "owner" });
    A.emit("team.node", { node_id: n.keys.nodeId, login: n.login, hostname: n.hostname, pubkey: n.keys.pubkey, ip: "127.0.0.1" });
  }
  A.emit("channel.upsert", { name: "general" });
  A.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "bea", "rex"] });
  const sA = new Schedules(A, idle);
  const s1 = sA.add({ name: "One", cron: "*/5 * * * *", task: { prompt: "1" } }, "alex");
  const s2 = sA.add({ name: "Two", cron: "*/10 * * * *", task: { prompt: "2" } }, "alex");
  const s3 = sA.add({ name: "Three", cron: "0 * * * *", task: { prompt: "3" } }, "alex");
  sA.edit(s1.id, { name: "One edited" });
  sA.remove(s2.id);
  const B = makeCore(b, team, cleanups);
  feed(B, allEvents(A).sort((x, y) => x.seq - y.seq));
  A.emit("team.authority", { node_id: B.nodeId });
  feed(B, allEvents(A).filter((e) => e.origin === A.nodeId).sort((x, y) => x.seq - y.seq));
  expect(B.isAuthority()).toBe(true);
  const sB = new Schedules(B, idle);
  sB.edit(s1.id, { enabled: false });
  const s4 = sB.add({ name: "Four", cron: "*/15 * * * *", task: { prompt: "4" } }, "bea");
  sB.remove(s3.id);
  sB.reset(s1.id, Date.now());
  sB.edit(s4.id, { cron: "*/20 * * * *" });
  const truth = view(readSchedules(B));
  expect(truth).toBe(view(fullFold(B)));
  console.log("P4 successor authority view:", truth);

  const history = [...allEvents(A), ...allEvents(B).filter((e) => e.origin === B.nodeId)];
  const unique = [...new Map(history.map((e) => [e.id, e])).values()];
  let mismatches = 0, steps = 0;
  const firstBad: string[] = [];
  for (let seed = 1; seed <= 25; seed++) {
    const rand = rng(seed * 7919);
    const order = [...unique].sort(() => rand() - 0.5);
    const R = makeCore(r, team, cleanups);
    for (const e of order) {
      R.ingest(e, "remote");
      await settle(R);
      const cached = view(readSchedules(R)), full = view(fullFold(R));
      steps++;
      if (cached !== full) { mismatches++; if (firstBad.length < 3) firstBad.push(`seed ${seed} after ${e.id}: cached=${cached} full=${full}`); }
    }
    const final = view(readSchedules(R));
    if (final !== truth) { mismatches++; if (firstBad.length < 3) firstBad.push(`seed ${seed} final ${final} != ${truth}`); }
  }
  console.log(`P4 steps=${steps} mismatches=${mismatches} ${firstBad.join(" | ")}`);
  expect(mismatches).toBe(0);
}, 120_000);
