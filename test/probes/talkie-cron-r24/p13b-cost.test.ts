// P13b: time the authority's progress() for a completion (priorRunProgress full scan) as the channel grows.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { makeWorld } from "./world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
const PREFIX = "walkie-talkie-schedule:v1:";
const hr = () => Number(process.hrtime.bigint()) / 1e6;

test("P13b progress() completion cost vs channel size (real store, real routes)", async () => {
  const w = await makeWorld(cleanups, { names: ["alex", "mira"] });
  const { nodes, pref, at } = w;
  const alex = nodes.alex!, mira = nodes.mira!;
  pref.v = mira.core.nodeId;
  const x = alex.s.add({ name: "Sweep", cron: "*/5 * * * *", task: { prompt: "SEND" } }, "alex");
  w.syncAll();
  const timings: { kind: string; ms: number }[] = [];
  const queries: string[] = [];
  const origCount = alex.core.store.channelEventCount.bind(alex.core.store);
  alex.core.store.channelEventCount = (ch: string) => { const t = hr(); const n = origCount(ch); queries.push(`count:${(hr()-t).toFixed(1)}ms`); return n; };
  const origQuery = alex.core.store.queryEvents.bind(alex.core.store);
  alex.core.store.queryEvents = (f: any) => { const t = hr(); const rows = origQuery(f); if (f.channel === w.L.SCHEDULE_CHANNEL) queries.push(`${rows.length}:${(hr()-t).toFixed(1)}ms`); return rows; };
  const orig = alex.s.progress.bind(alex.s);
  alex.s.progress = (...a: any[]) => { const t = hr(); try { return orig(...a); } finally { const c = a[1].change; timings.push({ kind: c.op === "put" ? (c.completion_run ? "completion" : "put") : c.op, ms: hr() - t }); } };
  let filled = 0;
  const out: string[] = [];
  const completionCosts: number[] = [];
  let slotTime = x.next_run! + 2_000;
  for (const target of [0, 10_000, 30_000]) {
    while (filled < target) {
      const sch = { ...x, id: "44444444-4444-4444-8444-444444444444", name: "Filler", run_id: "33333333-3333-4333-8333-333333333333", last_run: 1_700_000_000_000 + filled, next_run: 1_700_000_300_000 + filled, last_result: "Board refresh finished: summarized 14 cards, 3 moved, 2 blocked. ".repeat(4), failures: 0, progress_rev: 5, progress_at: 1_700_000_000_000 };
      alex.core.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, after: null, epoch: 0, rev: 1_000 + filled, completion_run: "33333333-3333-4333-8333-333333333333", completion_claim: { term: 0, seq: filled + 1, generation: 0 }, request_key: "a".repeat(64), schedule: sch }) }, { channel: w.L.SCHEDULE_CHANNEL }); filled++; }
    at(Math.max(slotTime, w.view(alex, x.id).next_run! + 2_000)); slotTime = w.wall.value;
    const before = mira.turns.length;
    await w.stepNode(mira);
    expect(mira.turns.length).toBe(before + 1);
    mira.replies.set(`turn-${mira.turns.at(-1)!.run}`, { text: "ok", ok: true });
    timings.length = 0; queries.length = 0;
    await w.stepNode(mira);
    completionCosts.push(timings.find((timing) => timing.kind === "completion")!.ms);
    expect(queries.filter((query) => /^\d+:/.test(query)).every((query) => Number(query.split(":")[0]) < 100)).toBe(true);
    out.push(`rows=${alex.core.store.channelEventCount(w.L.SCHEDULE_CHANNEL)} completion progress() = ${timings.map((t) => `${t.kind}:${t.ms.toFixed(1)}ms`).join(",")} queries=${queries.join("|")}`);
  }
  console.log("P13b\n  " + out.join("\n  "));
  expect(completionCosts[2]!).toBeLessThan(completionCosts[1]! * 5 + 5);
  expect(w.audit()).toEqual([]);
}, 120_000);
