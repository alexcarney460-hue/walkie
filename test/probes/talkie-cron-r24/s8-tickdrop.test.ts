// S8: lease lapses in the middle of the tick loop while several schedules hold captured completions.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { makeWorld, iso } from "./world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
const isCompletion = (i: any) => i.path === "schedule-progress" && i.body.change.completion_run;

test("S8: two schedules with captured completions; lease lapses during the first schedule's retry -> second capture retained or dropped?", async () => {
  const w = await makeWorld(cleanups, { names: ["alex", "mira"], wireLost: true });
  const { nodes, pref, at, net } = w;
  const alex = nodes.alex!, mira = nodes.mira!;
  pref.v = mira.core.nodeId;
  const a = alex.s.add({ name: "A", cron: "*/5 * * * *", task: { prompt: "A" } }, "alex");
  const b = alex.s.add({ name: "B", cron: "*/5 * * * *", task: { prompt: "B" } }, "alex");
  w.syncAll();
  at(Math.max(a.next_run!, b.next_run!) + 2_000);
  await w.stepNode(mira);
  expect(mira.turns.length).toBe(2);
  // both runs finish with a failure; the first completion attempts fail (req-lost) so both are captured
  net.plan = (i) => (isCompletion(i) ? "req-lost" : "ok");
  for (const t of mira.turns) mira.replies.set(`turn-${t.run}`, { text: "boom", ok: false });
  await w.stepNode(mira);
  const activeBefore = [...(mira.s as any).active.entries()].map(([id, v]: any) => `${id.slice(0, 4)}:${v.completion ? "captured" : "no-completion"}`);
  console.log("S8 after capture, active:", activeBefore.join(","));
  // next tick after the 15s backoff: during the FIRST schedule's write the clock runs 40s (lease lapses), then it fails
  let bumped = false;
  net.plan = (i) => { if (isCompletion(i) && !bumped) { bumped = true; at(w.wall.value + 40_000); return "req-lost"; } return isCompletion(i) ? "req-lost" : "ok"; };
  at(w.wall.value + 20_000);
  await mira.lead.acquire();
  await mira.s.tick(w.wall.value);
  const activeAfter = [...(mira.s as any).active.entries()].map(([id, v]: any) => `${id.slice(0, 4)}:${v.completion ? "captured" : "no-completion"}`);
  console.log("S8 after the lapsing tick, active:", activeAfter.join(",") || "(none)", "| lease valid:", mira.lead.valid);
  expect(activeAfter).toHaveLength(2);
  // network heals, lease comes back
  net.plan = () => "ok";
  await w.advance(90_000, { step: 15_000 });
  console.log("S8 after heal: authority A:", w.show(alex, a.id), "| B:", w.show(alex, b.id), "| completions:", w.completions().length, "| status:", mira.s.status());
});
