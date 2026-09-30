import { afterEach, expect, setSystemTime, test } from "bun:test";
import { makeWorld } from "./world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });

test("an unresolved run is cleared once the authority starts a later run, with one note", async () => {
  const w = await makeWorld(cleanups, { names: ["alex", "mira"] });
  const alex = w.nodes.alex!, mira = w.nodes.mira!;
  w.pref.v = mira.core.nodeId;
  const schedule = alex.s.add({ name: "Sweep", cron: "*/5 * * * *", task: { prompt: "SEND" } }, "alex");
  w.syncAll();
  w.at(schedule.next_run! + 2_000);
  await w.stepNode(mira);
  const first = w.view(mira, schedule.id);
  const active = (mira.s as any).active.get(schedule.id);
  mira.core.store.setMeta("schedule_completion_unresolved", JSON.stringify([{
    id: schedule.id, name: schedule.name, run: first.run_id, slot: first.last_run, claim: active.claim,
  }]));
  expect(mira.s.status()).toContain("unresolved");
  (mira.s as any).active.clear();
  w.at(first.next_run! + 2_000);
  await w.stepNode(mira);
  expect(w.view(alex, schedule.id).run_id).not.toBe(first.run_id);
  expect(mira.s.status()).toBeNull();
  expect(mira.s.status()).toBeNull();
  const notes = mira.core.store.queryEvents({ channel: "general", kinds: ["msg.post"], limit: 100 })
    .filter((row: any) => JSON.parse(row.json).body.text.includes("unresolved completion"));
  expect(notes).toHaveLength(1);
});
