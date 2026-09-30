// S7: lead wall-clock step backwards while a completion retry is pending (retry schedule uses wall clock).
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { makeWorld, iso } from "./world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
const isCompletion = (i: any) => i.path === "schedule-progress" && i.body.change.completion_run;

test("S7a: lead clock steps back 1h after a failed completion attempt; network heals immediately", async () => {
  const w = await makeWorld(cleanups, { names: ["alex", "mira"] });
  const { nodes, pref, at, net } = w;
  const alex = nodes.alex!, mira = nodes.mira!;
  pref.v = mira.core.nodeId;
  const x = alex.s.add({ name: "Sweep", cron: "*/5 * * * *", task: { prompt: "SEND" } }, "alex");
  w.syncAll();
  at(x.next_run! + 2_000);
  await w.stepNode(mira);
  const turn = `turn-${mira.turns[0]!.run}`;
  net.plan = (i) => (isCompletion(i) ? "req-lost" : "ok");
  mira.replies.set(turn, { text: "finished OK", ok: true });
  await w.stepNode(mira);                         // attempt 1 fails at real time T
  net.plan = () => "ok";                          // network heals immediately
  const T = w.wall.value;
  // lead's clock steps back 1 hour (NTP/manual correction): its own ticks now see now = T - 1h + elapsed
  let lead_now = T - 3_600_000;
  for (let i = 0; i < 40; i++) { lead_now += 15_000; at(T + (i + 1) * 15_000); await mira.lead.acquire(); await mira.s.tick(lead_now); }
  console.log("S7a 10 min later: authority:", w.show(alex, x.id), "| completions:", w.completions().length, "| turns:", mira.turns.length,
    "| progress calls after heal:", net.log.filter((l) => l.path === "schedule-progress").length);
  expect(w.audit()).toEqual([]);
  expect(w.completions()).toHaveLength(1);
});
