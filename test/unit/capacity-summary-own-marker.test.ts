// WALK-65/66 review SHOULD-H (option a): a marker this daemon signed while its clock ran fast must not come back, once real
// time reaches its stamp, and hide the live picture. Ported from the reviewer probe RV5 2. Fictional names only.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { lastPostedSummary } from "../../src/daemon/orchestrator/capacity-summary.ts";
import { prepareOrchestrationPoll, type PollDeps } from "../../src/daemon/orchestrator/poll.ts";
import type { AccountView } from "../../src/protocol/accounts.ts";
import type { NodeView } from "../../src/protocol/schemas.ts";
import type { SeatHostView, SeatView } from "../../src/protocol/seats.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { recsWorld } from "../helpers/talkie-recs.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
const H = 3_600_000;
const MIN = 60_000;
const D = 24 * H;
const GIB = 1024 ** 3;
const NODE = "aaaaaaaaaaaaaaaa";
const SUMMARY = "WalkieTalkie fleet capacity";
const statsOf = () => ({ at: Date.now(), mem: { total: 16 * GIB, used: 4 * GIB, free: 8 * GIB, swap_used: 0, pressure: "normal" }, temp_c: null,
  sys: { os: "linux", arch: "x64", cpus: 8, load1: 0.5, cpu_busy_pct: 10 } });
const node = (online = true): NodeView => ({
  node_id: NODE, handle: "maren", hostname: "mac-a", ip: "127.0.0.1", transports: ["tailscale"], online,
  last_seen: Date.now(), rtt_ms: 1, self: false, sync: { behind: 0, last_sync: null }, stats: statsOf(),
}) as unknown as NodeView;
const host = (max = 3): SeatHostView => ({
  node: NODE, hostname: "mac-a", handle: "maren", self: false, allows: true, member: true, channel: `seats-${NODE}`, online: true,
  availability: { state: "available", max, running: 0 },
}) as SeatHostView;
const account = (): AccountView => {
  const usage = { at: Date.now() - 60_000, state: "ok" as const, reason: null, source: "api" as const, until: null,
    windows: [{ kind: "session" as const, used_pct: 10, resets_at: Date.now() + 3 * H, window_s: null, scope: null }] };
  return { key: "maren:claude:aaaaaaaaaaaaaaaaaaaaaaaa", id: "claude", provider: "claude", label: "Claude account", plan: null,
    owners: ["maren"], claimed_by: [], machines: [{ node_id: NODE, hostname: "mac-a", handle: "maren", online: true, self: false, agents: [], usage }],
    usage, usage_host: "mac-a", last_seen: Date.now() };
};
const seat = (i: number): SeatView => ({ id: `s${i}`, host: { node: NODE, hostname: "mac-a", handle: "maren" }, state: "running" }) as unknown as SeatView;
type Fleet = { online: boolean; seats: SeatView[] };
function depsFor(base: { core: PollDeps["core"]; idx: PollDeps["idx"] }, fleet: Fleet): PollDeps {
  return { core: base.core, idx: base.idx, now: () => Date.now(), nodes: () => [node(fleet.online)], seatHosts: () => [host(3)],
    seats: () => fleet.seats, accounts: () => [account()], agents: () => [] } as PollDeps;
}
function texts(core: PollDeps["core"], channel: string): string[] {
  return core.store.queryEvents({ channel, kinds: ["msg.post"], limit: 100_000 })
    .map((r) => JSON.parse(r.json).body?.text as string).filter((s) => typeof s === "string");
}
const summaries = (core: PollDeps["core"]) => [...texts(core, SCHEDULE_CHANNEL), ...texts(core, "general")].filter((s) => s.startsWith(SUMMARY));
const posted = (r: unknown) => ((r as { skip?: string }).skip ?? "").includes("Fleet capacity summary posted") ? "P" : ".";
async function shifted<T>(wall: () => number, offset: number, fn: () => Promise<T> | T): Promise<T> {
  setSystemTime(new Date(wall() + offset));
  try { return await fn(); } finally { setSystemTime(new Date(wall())); }
}
/** Newest summary text by event ts on this core (what the channel reader sees last). */
function newestSummaryLine(core: PollDeps["core"]): string {
  const rows = core.store.db.query<{ json: string }, [string]>(
    "SELECT json FROM events WHERE channel = ? AND kind = 'msg.post' ORDER BY rowid DESC").all(SCHEDULE_CHANNEL);
  for (const row of rows) {
    const text = JSON.parse(row.json).body?.text as string | undefined;
    if (text?.startsWith(SUMMARY)) return text.split("\n").filter((l) => l.startsWith("mac-a")).join(" | ");
  }
  return "(none)";
}


for (const offset of [20 * H, 24 * H]) {
  test(`a lead whose clock ran ${offset / H} h fast posts again when its machine changes after real time reaches the old stamp (RV5 2)`, async () => {
    const w = recsWorld(cleanups);
    const fleet: Fleet = { online: true, seats: [] }; // picture A = online, stamped by the fast clock
    const deps = depsFor({ core: w.core, idx: w.idx }, fleet);
    const start = w.wall();
    await shifted(w.wall, offset, () => prepareOrchestrationPoll(deps, () => true));
    const fastAt = start + offset;
    // Hourly flips after the correction; finish on picture B (offline) shortly before the stamp comes due.
    const hourly: string[] = [];
    let i = 0;
    while (w.wall() + H + MIN < fastAt - 30 * MIN) {
      w.tick(H + MIN);
      fleet.online = !fleet.online;
      hourly.push(posted(await prepareOrchestrationPoll(deps, () => true)));
      i++;
    }
    if (fleet.online) { // make sure the last posted picture is B (offline)
      w.tick(H + MIN);
      fleet.online = false;
      hourly.push(posted(await prepareOrchestrationPoll(deps, () => true)));
    }
    const lastPostedBefore = newestSummaryLine(w.core);
    // The machine comes back online (picture A again, same as the fast stamp) and stays online. Poll every 5 minutes for 6 hours.
    fleet.online = true;
    const fiveMin: string[] = [];
    for (let k = 0; k < 72; k++) {
      w.tick(5 * MIN);
      fiveMin.push(posted(await prepareOrchestrationPoll(deps, () => true)));
    }
    const prev = lastPostedSummary(w.core);
    expect(fiveMin.join("")).toContain("P");
  }, 180_000);
}

test("skipping its own once-fast marker, a lead still sees a later lead's summary and does not repeat it (integration review INT-B)", async () => {
  const w = recsWorld(cleanups);
  const fleet: Fleet = { online: true, seats: [] };
  const alexDeps = depsFor({ core: w.core, idx: w.idx }, fleet);
  const start = w.wall();
  expect(posted(await shifted(w.wall, 20 * H, () => prepareOrchestrationPoll(alexDeps, () => true)))).toBe("P"); // picture A, stamped +20 h
  const bea = w.person("bea", "owner");
  w.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "bea"] });
  bea.mirror();
  w.tick(H + MIN); fleet.online = false;
  expect(posted(await prepareOrchestrationPoll(alexDeps, () => true))).toBe("P"); // alex, corrected: picture B
  w.tick(H + MIN); fleet.online = true; fleet.seats = [seat(1), seat(2)];
  bea.mirror();
  expect(posted(await prepareOrchestrationPoll(depsFor({ core: bea.core, idx: bea.idx }, fleet), () => true))).toBe("P"); // bea: picture C
  bea.push();
  while (w.wall() < start + 20 * H - 5 * MIN) w.tick(H);
  // Real time has reached alex's old stamp; the live picture is still C, which bea already posted.
  expect(posted(await prepareOrchestrationPoll(alexDeps, () => true))).toBe(".");
  expect(summaries(w.core)).toHaveLength(3);
}, 120_000);
