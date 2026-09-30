// H4: an agent-authored raw post from the authority node is ignored by the schedule fold.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { Schedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { feed, makeCore } from "../../test/helpers/core.ts";
import { createTeam, ev, now, tnode } from "../../test/helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });

test("H4 an agent-authored raw put signed by the authority node is ignored", async () => {
  const a = tnode("alex");
  const { team, create } = createTeam(a);
  const base = Math.floor(now() / 3_600_000) * 3_600_000 + 3_600_000;
  const wall = { value: base - 60_000 };
  setSystemTime(new Date(wall.value));
  const A = makeCore(a, team, cleanups, { clock: () => wall.value });
  A.ingest(create, "local");
  A.emit("channel.upsert", { name: "general" });
  A.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex"] });
  const schedule = { id: "99999999-9999-4999-8999-999999999999", name: "Injected", cron: "*/5 * * * *",
    task: { prompt: "INJECTED BY AN AGENT WITH AGENT ADMIN OFF" }, enabled: true, created_by: "alex",
    last_run: null, next_run: base, last_result: null, failures: 0, run_id: null };
  const term = A.authorityLeaseTerm, after = A.authorityClaimTerms[term]?.after ?? null;
  const ev = A.emit("msg.post", { text: "walkie-talkie-schedule:v1:" + JSON.stringify({ op: "put", schedule, term, after, epoch: 0, rev: 0 }) },
    { channel: SCHEDULE_CHANNEL, agent: "claude-code" });
  console.log("H4 signed post author:", JSON.stringify(ev.author), "| fold:", JSON.stringify(readSchedules(A).map((s) => s.name)));
  let mono = 34_000;
  const lead = new Leadership({ core: A, preferred: () => A.nodeId, lost: () => {}, now: () => wall.value, monoNow: () => mono });
  const epoch = lead.grant(A.nodeId).epoch;
  const turns: string[] = [];
  const s = new Schedules(A, { valid: () => true, epoch: () => epoch,
    claim: async (id, slot, run) => lead.claimFromPeer(A.nodeId, { schedule: id, slot, run, epoch }),
    turn: (p, id) => { turns.push(p); return `t-${id}`; }, reply: () => null, interrupt: () => {} });
  wall.value = base + 10_000; setSystemTime(new Date(wall.value)); mono += 1;
  await s.tick(wall.value);
  console.log("H4 WalkieTalkie turns:", JSON.stringify(turns.map((t) => t.slice(0, 50))));
  expect(readSchedules(A).some((x) => x.name === "Injected")).toBe(false);
  expect(turns.some((t) => t.includes("INJECTED"))).toBe(false);
});

test("H4 a raw authority-origin post with another person's handle is ignored", () => {
  const a = tnode("alex"), b = tnode("bea");
  const { team, create } = createTeam(a);
  const A = makeCore(a, team, cleanups);
  A.ingest(create, "local");
  A.emit("team.member", { login: b.login, handle: b.handle, role: "owner" });
  A.emit("team.node", { node_id: b.keys.nodeId, login: b.login, hostname: b.hostname,
    pubkey: b.keys.pubkey, ip: "127.0.0.1" });
  A.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "bea"] });
  const B = makeCore(b, team, cleanups);
  feed(B, A.store.queryEvents({ limit: 100 }).map((row) => JSON.parse(row.json)).sort((x, y) => x.seq - y.seq));
  a.seq = A.store.maxSeq(A.nodeId);
  const schedule = { id: "99999999-9999-4999-8999-999999999999", name: "Injected",
    cron: "*/5 * * * *", task: { prompt: "x" }, enabled: true, created_by: "alex",
    last_run: null, next_run: 300_000, last_result: null, failures: 0, run_id: null };
  const post = ev(team, a, "msg.post", { text: "walkie-talkie-schedule:v1:" +
    JSON.stringify({ op: "put", term: 0, after: null, schedule }) }, { channel: SCHEDULE_CHANNEL, handle: "mallory" });
  expect(B.ingest(post, "remote")).toMatchObject({ status: "rejected", reason: "author_handle_mismatch" });
  expect(readSchedules(B)).toEqual([]);
});
