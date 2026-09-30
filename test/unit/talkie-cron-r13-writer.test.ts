// R12 attack 1 + 5: the fold trusts a schedule put by channel membership alone. A released pre.9 daemon's POST /v1/post
// has no talkie-schedules guard (git show v0.2.0-pre.9:src/daemon/local-routes.ts:549-562): it calls exactly
// core.emit("msg.post", { text }, { channel }). Here K.emit(...) / H.emit(...) is that call on another machine.
// Real Cores; A = owner + roster authority + WalkieTalkie lease holder at HEAD.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { Schedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { applyRequest, signRequest } from "../../src/daemon/requests.ts";
import { MAX_SCHEDULES, SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { feed, makeCore, statusOf } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const PREFIX = "walkie-talkie-schedule:v1:";
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function team(opts: { squat?: boolean } = {}) {
  const a = tnode("alex"), k = tnode("mira"), h = tnode("hina");
  const { team, create } = createTeam(a);
  const minute = Math.floor(now() / 300_000) * 300_000 + 10 * 60_000;
  const wall = { value: minute + 10_000 };
  setSystemTime(new Date(wall.value));
  const A = makeCore(a, team, cleanups, { clock: () => wall.value });
  A.ingest(create, "local");
  const out = [
    A.emit("team.member", { login: k.login, handle: k.handle, role: "owner" }),
    A.emit("team.node", { node_id: k.keys.nodeId, login: k.login, hostname: k.hostname, pubkey: k.keys.pubkey, ip: "127.0.0.1" }),
    A.emit("team.member", { login: h.login, handle: h.handle, role: "member" }),
    A.emit("team.node", { node_id: h.keys.nodeId, login: h.login, hostname: h.hostname, pubkey: h.keys.pubkey, ip: "127.0.0.1" }),
    A.emit("channel.upsert", { name: "general" }),
  ];
  const K = makeCore(k, team, cleanups, { clock: () => wall.value });
  const H = makeCore(h, team, cleanups, { clock: () => wall.value });
  feed(K, [create, ...out]); feed(H, [create, ...out]);
  let squat = null;
  if (opts.squat) {
    // A plain member asks the authority for a NEW channel named talkie-schedules (POST /v1/channels, requestAllowed: a
    // member may create a new public channel). No reserved-name check exists for this name.
    squat = applyRequest(A, signRequest(H, "channel.upsert", { name: SCHEDULE_CHANNEL }));
  } else {
    out.push(A.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "mira"] }));
  }
  const tail = squat ? [squat] : [out.at(-1)!];
  feed(K, tail); feed(H, tail);
  let mono = 0;
  const lead = new Leadership({ core: A, preferred: () => A.nodeId, lost: () => {}, now: () => wall.value, monoNow: () => mono });
  mono = 34_000;
  const epoch = lead.grant(A.nodeId).epoch;
  return { A, K, H, k, wall, minute, lead, epoch };
}

function rawPut(id: string, cron: string, prompt: string, nextRun: number, by = "mira") {
  return PREFIX + JSON.stringify({ op: "put", schedule: { id, name: `Injected ${id.slice(-4)}`, cron, task: { prompt },
    enabled: true, created_by: by, last_run: null, next_run: nextRun, last_result: null, failures: 0, run_id: null } });
}

function runnerFor(A: ReturnType<typeof team>["A"], lead: Leadership, epoch: number, turns: string[], ready: { v: boolean }) {
  return {
    valid: () => true,
    claim: async (id: string, slot: number, run: string, runNow?: boolean) =>
      lead.claimFromPeer(A.nodeId, { schedule: id, slot, run, epoch, ...(runNow ? { run_now: true } : {}) }),
    turn: (prompt: string, id: string) => { turns.push(prompt); return `turn-${id}`; },
    reply: () => ready.v ? { text: "done", ok: true } : null,
    interrupt: () => {},
  };
}

async function runMinutes(s: Schedules, wall: { value: number }, minute: number, ready: { v: boolean }, n: number) {
  for (let i = 0; i < n; i++) {
    wall.value = minute + i * 60_000 + 10_000; setSystemTime(new Date(wall.value));
    ready.v = false;
    await s.tick(wall.value);
    ready.v = true;
    wall.value += 20_000; setSystemTime(new Date(wall.value));
    await s.tick(wall.value);
  }
}

test("A1 a pre.9-style valid-cron raw put from a second owner's machine is ignored", async () => {
  const { A, K, wall, minute, lead, epoch } = team();
  const injected = K.emit("msg.post", { text: rawPut(uuid(1), "*/5 * * * *", "INJECTED: run arbitrary work", minute) },
    { channel: SCHEDULE_CHANNEL });
  feed(A, [injected]);
  console.log("A1 raw put status on authority:", statusOf(A, injected.id));
  console.log("A1 authority fold:", JSON.stringify(readSchedules(A).map((s) => ({ cron: s.cron, task: s.task, by: s.created_by }))));
  const turns: string[] = [], ready = { v: false };
  await runMinutes(new Schedules(A, runnerFor(A, lead, epoch, turns, ready)), wall, minute, ready, 3);
  console.log(`A1 WalkieTalkie turns started over 3 consecutive minutes: ${turns.length}`);
  console.log("A1 first turn prompt:", JSON.stringify(turns[0]?.slice(0, 140)));
  expect(turns.length).toBe(0);
  expect(readSchedules(A)).toEqual([]);
});

test("A1b raw puts exceed MAX_SCHEDULES; a demoted owner (now a plain member) still writes schedule puts", () => {
  const { A, K, k, minute } = team();
  const posts = [];
  for (let n = 10; n < 10 + MAX_SCHEDULES + 5; n++)
    posts.push(K.emit("msg.post", { text: rawPut(uuid(n), "*/5 * * * *", `bulk ${n}`, minute + 5 * 60_000) }, { channel: SCHEDULE_CHANNEL }));
  feed(A, posts);
  console.log(`A1b folded schedules on the authority: ${readSchedules(A).length} (MAX_SCHEDULES=${MAX_SCHEDULES})`);
  expect(readSchedules(A).length).toBe(0);
  const demote = A.emit("team.member", { login: k.login, handle: k.handle, role: "member" });
  feed(K, [demote]);
  const role = [...A.roster.members.values()].find((m) => m.handle === "mira")?.role;
  console.log("A1b mira role after demotion:", role, "| still listed in #talkie-schedules:",
    A.roster.channels.get(SCHEDULE_CHANNEL)?.members?.includes("mira"));
  let status = "";
  try {
    const p = K.emit("msg.post", { text: rawPut(uuid(99), "*/5 * * * *", "FROM A DEMOTED OWNER", minute + 60_000) }, { channel: SCHEDULE_CHANNEL });
    feed(A, [p]);
    status = `accepted locally; authority status ${statusOf(A, p.id)}`;
  } catch (err) { status = `refused locally: ${String(err)}`; }
  console.log("A1b demoted owner raw put:", status, "| folded on authority:", readSchedules(A).some((x) => x.id === uuid(99)));
  expect(readSchedules(A).some((x) => x.id === uuid(99))).toBe(false);
});

test("A1c a plain member squats #talkie-schedules as a PUBLIC channel first; Schedules.ensureChannel accepts it; the member's raw put runs", async () => {
  const { A, H, wall, minute, lead, epoch } = team({ squat: true });
  const ch = A.roster.channels.get(SCHEDULE_CHANNEL);
  console.log("A1c channel after member request:", JSON.stringify({ exists: !!ch, members: ch?.members ?? null }));
  const turns: string[] = [], ready = { v: false };
  const s = new Schedules(A, runnerFor(A, lead, epoch, turns, ready));
  console.log("A1c Schedules.ensureChannel() on the authority:", await s.ensureChannel(), "| members now:", JSON.stringify(A.roster.channels.get(SCHEDULE_CHANNEL)?.members ?? null));
  const p = H.emit("msg.post", { text: rawPut(uuid(7), "*/5 * * * *", "INJECTED BY A PLAIN MEMBER", minute, "hina") }, { channel: SCHEDULE_CHANNEL });
  feed(A, [p]);
  console.log("A1c member raw put status on authority:", statusOf(A, p.id));
  await runMinutes(s, wall, minute, ready, 1);
  console.log(`A1c turns: ${turns.length}`, JSON.stringify(turns[0]?.slice(0, 120)));
  expect(turns.some((t) => t.includes("PLAIN MEMBER"))).toBe(false);
});

test("A1d a squatted public #talkie-schedules is repaired to owner-only and #general is alerted exactly once", async () => {
  const { A, wall, lead, epoch } = team({ squat: true });
  const s = new Schedules(A, runnerFor(A, lead, epoch, [], { v: false }));
  expect(A.roster.channels.get(SCHEDULE_CHANNEL)?.members).toBeUndefined(); // public: no member list
  expect(await s.ensureChannel()).toBe(true);
  expect(A.roster.channels.get(SCHEDULE_CHANNEL)?.members).toEqual(["alex", "mira"]);
  expect(await s.ensureChannel()).toBe(true);
  wall.value += 1;
  const alerts = A.store.queryEvents({ channel: "general", kinds: ["msg.post"], limit: 50 })
    .map((row) => (JSON.parse(row.json) as { body: { text: string } }).body.text)
    .filter((text) => text.includes("refused an unsafe #talkie-schedules"));
  expect(alerts).toHaveLength(1);
});
