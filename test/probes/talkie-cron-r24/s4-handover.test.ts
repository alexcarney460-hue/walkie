// S4: authority handover interleavings with the completion path.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { makeWorld, iso } from "./world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
const isCompletion = (i: any) => i.path === "schedule-progress" && i.body.change.completion_run;

async function running(o: { wireLost: boolean }) {
  const w = await makeWorld(cleanups, { wireLost: o.wireLost });
  const { nodes, pref, at } = w;
  const alex = nodes.alex!, mira = nodes.mira!;
  pref.v = mira.core.nodeId;
  const x = alex.s.add({ name: "Sweep", cron: "*/5 * * * *", task: { prompt: "SEND" } }, "alex");
  alex.core.emit("msg.post", { text: "walkie-talkie-schedule:v1:" + JSON.stringify({ op: "put", term: 0, after: null, epoch: 0, rev: 1, schedule: { ...x, failures: 2 } }) }, { channel: w.L.SCHEDULE_CHANNEL });
  w.syncAll();
  at(x.next_run! + 2_000);
  await w.stepNode(mira);
  return { w, x, alex, mira, bea: nodes.bea!, run: mira.turns[0]!.run, turn: `turn-${mira.turns[0]!.run}` };
}

for (const wireLost of [false, true]) {
  test(`S4a commit at alex (ack lost) -> authority transfer alex->bea -> retry at bea acknowledged [wireLost=${wireLost}]`, async () => {
    const { w, x, alex, mira, bea, turn } = await running({ wireLost });
    let lost = true;
    w.net.plan = (i) => (isCompletion(i) && lost ? (lost = false, "ack-lost") : "ok");
    mira.replies.set(turn, { text: "boom", ok: false });
    await w.stepNode(mira);
    console.log(`S4a[${wireLost}] committed at alex:`, w.show(alex, x.id), "| mira view:", w.show(mira, x.id));
    // transfer to bea, DO NOT sync events to mira (mira keeps a stale view until the retry)
    alex.core.emit("team.authority", { node_id: bea.core.nodeId });
    w.syncFrom(alex, bea);
    expect(bea.core.isAuthority()).toBe(true);
    w.syncFrom(alex, mira);        // mira learns of the transfer (roster) - events flow; the completion event too
    w.pref.v = mira.core.nodeId;
    await w.advance(120_000, { step: 10_000 });
    console.log(`S4a[${wireLost}] after retry window: bea view:`, w.show(bea, x.id), "| mira view:", w.show(mira, x.id), "| status:", mira.s.status()?.slice(0, 80));
    console.log(`S4a[${wireLost}] net:`, w.net.log.filter((l) => l.path !== "lease").map((l) => `${l.to}:${l.path}=${l.result}`).join(","));
    expect(w.completions().length).toBe(1);
    expect(w.view(bea, x.id).failures).toBe(3);
  });
}

test("S4b transfer BEFORE first commit; new authority still catching up for 5 minutes: is the legitimate completion lost?", async () => {
  const { w, x, alex, mira, bea, turn } = await running({ wireLost: false });
  w.net.plan = (i) => (isCompletion(i) ? "req-lost" : "ok");   // attempt 1 never reaches alex
  mira.replies.set(turn, { text: "boom", ok: false });
  await w.stepNode(mira);
  alex.core.emit("team.authority", { node_id: bea.core.nodeId });
  // bea has everything from alex except the claim post of the running run, which is only a stub (catching up)
  const evs = w.eventsOf(alex);
  const claimEv = evs.find((e: any) => typeof e.body?.text === "string" && e.body.text.startsWith("walkie-talkie-claim:v1:"));
  for (const e of evs) bea.core.ingest(e, "remote");
  bea.core.store.replaceWithStub(w.stubOf(claimEv));
  w.syncFrom(alex, mira);
  w.net.plan = () => "ok";
  console.log("S4b bea authority?", bea.core.isAuthority(), "uncovered:", w.L.uncoveredAuthority(bea.core)?.slice(0, 6));
  await w.advance(300_000, { step: 15_000 });
  console.log("S4b after 300s: bea view:", w.show(bea, x.id), "| net:", w.net.log.filter((l) => l.path === "schedule-progress").map((l) => l.result).join(","));
  console.log("S4b mira status:", mira.s.status()?.slice(0, 100));
  // catch-up finishes now
  bea.core.ingest(claimEv, "remote");
  console.log("S4b catch-up done. uncovered:", w.L.uncoveredAuthority(bea.core));
  await w.advance(60_000, { step: 15_000 });
  console.log("S4b after catch-up: bea view:", w.show(bea, x.id), "| completions:", w.completions(bea).length, "| mira status:", mira.s.status()?.slice(0, 100));
  expect(w.completions(bea)).toHaveLength(1);
  expect(mira.s.status()).toBeNull();
});
