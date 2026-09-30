// N7c (two real Cores: alex = roster authority where the person edits; hina = WalkieTalkie holder, correct clock).
// The person edits the prompt on alex; alex's clock then steps back 2 h; hina's next claim gets clock_error and alex
// signs the clock-error note. Does every node still see the person's edit? Then the person resets per the alert.
import { afterEach, expect, test } from "bun:test";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { Schedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { SCHEDULE_CHANNEL, nextRuns } from "../../src/protocol/talkie-schedule.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const PREFIX = "walkie-talkie-schedule:v1:";
const MIN = 60_000, HOUR = 60 * MIN;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const since = new Map<string, number>();
function sync(from: ReturnType<typeof makeCore>, to: ReturnType<typeof makeCore>) {
  const key = `${from.nodeId}>${to.nodeId}`;
  const rows = from.store.queryEvents({ limit: 100_000 }).filter((r) => r.origin === from.nodeId && r.seq > (since.get(key) ?? 0))
    .sort((a, b) => a.seq - b.seq);
  for (const r of rows) { to.ingest(JSON.parse(r.json), "remote"); since.set(key, r.seq); }
}

test("N7c HEAD authority clock-error note vs the person's recent edit", () => {
  const a = tnode("alex"), h = tnode("hina");
  const { team, create } = createTeam(a);
  const S0 = Math.floor(now() / 300_000) * 300_000 + 24 * HOUR;
  const wallA = { value: now() + 1000 }, wallH = { value: now() + 1000 };
  const A = makeCore(a, team, cleanups, { clock: () => wallA.value });
  A.ingest(create, "local");
  A.emit("team.member", { login: h.login, handle: h.handle, role: "owner" });
  A.emit("team.node", { node_id: h.keys.nodeId, login: h.login, hostname: h.hostname, pubkey: h.keys.pubkey, ip: "127.0.0.1" });
  A.emit("channel.upsert", { name: "general" });
  A.emit("channel.upsert", { name: SCHEDULE_CHANNEL });
  const schedule = { id: ID, name: "Check", cron: "*/5 * * * *", task: { prompt: "OLD PROMPT: delete stale branches" }, enabled: true,
    created_by: a.handle, last_run: null, next_run: S0, last_result: null, failures: 0, run_id: null };
  A.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule }) }, { channel: SCHEDULE_CHANNEL });
  const H = makeCore(h, team, cleanups, { clock: () => wallH.value });
  feed(H, [create]); sync(A, H);
  let mono = 0;
  const lead = new Leadership({ core: A, preferred: () => H.nodeId, lost: () => {}, now: () => wallA.value, monoNow: () => mono });
  mono = 34_000;
  const epoch = lead.grant(H.nodeId).epoch;
  for (let slot = S0, n = 1; slot <= S0 + 30 * MIN; slot += 5 * MIN, n++) {
    wallA.value = slot; wallH.value = slot;
    const s = readSchedules(H).find((x) => x.id === ID)!;
    expect(lead.claimFromPeer(H.nodeId, { schedule: ID, slot, run: uuid(n), epoch }).claimed).toBe(true);
    A.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule: {
      ...s, run_id: uuid(n), last_run: slot, next_run: nextRuns(s.cron, slot, 1)[0]! } }) }, { channel: SCHEDULE_CHANNEL });
    sync(H, A); sync(A, H);
  }
  // Person edits the prompt on alex at S0+32m (the edit put carries the full current schedule).
  wallA.value = S0 + 32 * MIN; wallH.value = S0 + 32 * MIN;
  const cur = readSchedules(A).find((x) => x.id === ID)!;
  A.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule: { ...cur, task: { prompt: "NEW PROMPT: report only, never delete" } } }) }, { channel: SCHEDULE_CHANNEL });
  sync(A, H);
  console.log("N7c HEAD after edit: alex sees", JSON.stringify(readSchedules(A)[0]!.task), "hina sees", JSON.stringify(readSchedules(H)[0]!.task));
  // alex's clock steps back 2 h; hina (correct clock) claims the due slot S0+35m.
  wallA.value = S0 + 34 * MIN - 2 * HOUR; wallH.value = S0 + 35 * MIN;
  const r = lead.claimFromPeer(H.nodeId, { schedule: ID, slot: S0 + 35 * MIN, run: uuid(60), epoch });
  sync(A, H);
  console.log("N7c HEAD hina claim:", JSON.stringify(r), "| alex sees", JSON.stringify(readSchedules(A)[0]?.task), "| hina sees", JSON.stringify(readSchedules(H)[0]?.task));
  // alex's clock is corrected; the person resets per the #general alert.
  wallA.value = S0 + 40 * MIN;
  new Schedules(A, { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} }).reset(ID, wallA.value);
  sync(A, H);
  console.log("N7c HEAD after reset: alex sees", JSON.stringify(readSchedules(A)[0]?.task), "| hina sees", JSON.stringify(readSchedules(H)[0]?.task));
  expect(readSchedules(H)[0]?.task).toEqual({ prompt: "NEW PROMPT: report only, never delete" });
});
