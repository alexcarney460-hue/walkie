// LICENSE-FIX-2 F3 end to end: the integration count is decided at the roster authority. Two machines
// enabling different connectors at once on Free: exactly one wins. Disabling releases the slot. With
// the authority offline an enable is queued (202) and the connector turns on once it comes back.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { WalkieError } from "../../src/client/index.ts";
import { DAY_MS } from "../../src/license/plans.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const LIN = "lin_f3_key_0123456789abcdefXYZ";
let c: Cluster;
let alex: TestNode, kira: TestNode, kira2: TestNode;
let wisprDir: string;
/** The authority's clock offset: 0 while the team is set up, then 20 days (the trial is over: Free, 1 integration). */
let offset = 0;

async function caught(p: Promise<unknown>): Promise<WalkieError> {
  try { await p; } catch (err) { if (err instanceof WalkieError) return err; throw err; }
  throw new Error("expected an error");
}

beforeAll(async () => {
  c = new Cluster();
  wisprDir = join(c.root, "wispr");
  mkdirSync(wisprDir, { recursive: true });
  // Every machine's clock moves together: a peer more than a day ahead is held (`future_ts`, FINAL Fable 1).
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", clock: () => Date.now() + offset });
  kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp", clock: () => Date.now() + offset });
  kira2 = await c.add({ name: "kira2", login: "kira@example.com", hostname: "kiras-studio", clock: () => Date.now() + offset });
  await alex.client().init("acme", "alex");
  await alex.client().invite("kira@example.com", "kira", "member");
  for (const n of [kira, kira2]) {
    const j = await n.client().join(alex.peerAddr);
    if (!j.admitted) throw new Error(`join failed: ${j.reason}`);
  }
  for (const name of ["meetings", "linear"]) await alex.client().channel({ name });
  await waitFor(async () => (await kira2.client().team()).channels.some((ch) => ch.name === "linear") && (await kira.client().team()).channels.some((ch) => ch.name === "meetings"), { what: "channels replicated" });
  offset = 20 * DAY_MS; // the trial is over on the authority
  expect((await alex.client().license()).plan).toBe("free");
});
afterAll(async () => { await c.close(); });

test("two machines enabling different connectors at once on Free: exactly one wins; a third is refused; a release makes room", async () => {
  const [a, b] = await Promise.allSettled([
    kira.client().configureIntegration("wispr", { dir: wisprDir, channel: "meetings" }),
    kira2.client().configureIntegration("linear", { key: LIN, channel: "linear" }),
  ]);
  const outcomes = [a, b].map((r) => r.status);
  expect(outcomes.sort()).toEqual(["fulfilled", "rejected"]);
  const lost = [a, b].find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(lost.reason).toMatchObject({ status: 402, code: "plan_limit" });
  expect((lost.reason as WalkieError).details).toMatchObject({ resource: "integrations", limit: 1, used: 1, plan: "free" });
  const won = a.status === "fulfilled" ? kira : kira2;
  const loser = won === kira ? kira2 : kira;
  const wonId = won === kira ? "wispr" : "linear";
  const lostId = wonId === "wispr" ? "linear" : "wispr";
  expect((await won.client().integrations()).integrations.find((i) => i.id === wonId)?.enabled).toBe(true);
  expect((await loser.client().integrations()).integrations.find((i) => i.id === lostId)?.enabled).toBeFalsy();
  const slots = alex.d.core.roster.integrations;
  expect([...(slots?.get(wonId) ?? [])]).toEqual([won.d.nodeId]);
  expect(slots?.has(lostId)).toBe(false);
  // The authority itself can't add a third; the same connector on another machine is fine.
  const third = await caught(alex.client().configureIntegration("fireflies", { key: ("ff_f3_" + "key_0123456789abcdef"), channel: "meetings" }));
  expect([third.status, third.code]).toEqual([402, "plan_limit"]);
  const same = wonId === "wispr" ? { dir: wisprDir, channel: "meetings" } : { key: LIN, channel: "linear" };
  expect((await alex.client().configureIntegration(wonId, same)).integration.enabled).toBe(true);
  await alex.client().configureIntegration(wonId, { enabled: false });
  // The winner turns its connector off: the slot is released, the loser can enable now.
  await won.client().configureIntegration(wonId, { enabled: false });
  await waitFor(() => !alex.d.core.roster.integrations?.has(wonId), { what: "slot released" });
  const body = lostId === "wispr" ? { dir: wisprDir, channel: "meetings" } : { key: LIN, channel: "linear" };
  expect((await loser.client().configureIntegration(lostId, body)).integration.enabled).toBe(true);
  expect([...(alex.d.core.roster.integrations?.get(lostId) ?? [])]).toEqual([loser.d.nodeId]);
  await loser.client().configureIntegration(lostId, { enabled: false });
  await waitFor(() => !alex.d.core.roster.integrations?.size, { what: "all slots released" });
});

test("authority offline: enabling is queued (202, not enabled yet); it turns on once the authority accepts", async () => {
  await alex.stop();
  const res = await kira.client().configureIntegration("wispr", { dir: wisprDir, channel: "meetings" });
  expect(res.queued).toBe(true);
  expect(typeof res.request_id).toBe("string");
  expect(res.integration.enabled).toBe(false);
  expect(res.integration.settings.pending_enable).toBe(true);
  expect((await kira.client().integrations()).integrations.find((i) => i.id === "wispr")?.enabled).toBe(false);
  await alex.start();
  const view = await waitFor(async () => { const v = (await kira.client().integrations()).integrations.find((i) => i.id === "wispr"); return v?.enabled ? v : null; }, { what: "enabled after the authority returned", timeoutMs: 20_000 });
  expect(view.settings.pending_enable).toBeUndefined();
  expect([...(alex.d.core.roster.integrations?.get("wispr") ?? [])]).toEqual([kira.d.nodeId]);
  // And while it holds the slot, the other machine is refused a different connector.
  const err = await caught(kira2.client().configureIntegration("linear", { key: LIN, channel: "linear" }));
  expect([err.status, err.code]).toEqual([402, "plan_limit"]);
});
