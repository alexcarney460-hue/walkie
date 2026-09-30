// S9: owner pauses from the authority; the lead's view is a few seconds stale; the lead's next claim is refused and it writes a "Claim rejected" note.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { makeWorld } from "./world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });

test("S9: stale lead vs owner pause overwrites last_result with a bogus note", async () => {
  const w = await makeWorld(cleanups, { names: ["alex", "mira"] });
  const { nodes, pref, at } = w;
  const alex = nodes.alex!, mira = nodes.mira!;
  pref.v = mira.core.nodeId;
  const x = alex.s.add({ name: "Sweep", cron: "*/5 * * * *", task: { prompt: "SEND" } }, "alex");
  w.syncAll();
  at(x.next_run! + 2_000);
  await w.stepNode(mira);
  mira.replies.set(`turn-${mira.turns[0]!.run}`, { text: "real result of the last run", ok: true });
  await w.stepNode(mira);
  console.log("S9 before pause:", w.show(alex, x.id));
  alex.s.edit(x.id, { enabled: false });      // owner pauses on the authority; NOT yet replicated to the lead
  const due = w.view(mira, x.id).next_run!;
  at(due + 1_000);
  await w.stepNode(mira);                      // stale lead: schedule looks due and enabled
  console.log("S9 after stale lead tick:", w.show(alex, x.id));
  console.log("S9 note posts:", w.changePosts().filter((c: any) => c.op === "note").map((c: any) => c.text));
  expect(w.view(alex, x.id).last_result).toBe("real result of the last run");
  expect(w.changePosts().filter((c: any) => c.op === "note")).toHaveLength(0);
});
