// P7: the same 2 s bound on the other halt() callers, with a helper destroy of DESTROY_MS.
// (a) checkPlace() (this machine revoked / no longer its person) calls `void this.stop(...)`: does the stop's
//     rejection go unhandled (Bun exits the daemon with code 1 on an unhandled rejection)?
// (b) daemon shutdown: host.close() -> does it reject? (main.ts stop() awaits it before seats.close(), store.close(),
//     pid removal; runForeground's `void shutdown()` then has an unhandled rejection too.)
import { afterAll, beforeAll, expect, test } from "bun:test";
import { facts, rig5, waitFor, type Rig5 } from "./orchestrator-merge6-setup.ts";
const DESTROY_MS = Number(process.env.DESTROY_MS ?? 3_000);
let r: Rig5;
const unhandled: string[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(String((reason as Error)?.message ?? reason)); };
beforeAll(async () => { r = await rig5({ realMonitor: true, destroyMs: DESTROY_MS }); process.on("unhandledRejection", onUnhandled); }, 60_000);
afterAll(async () => { process.off("unhandledRejection", onUnhandled); await r.c.close().catch(() => undefined); });

test("(a) revoke via checkPlace on a full-access run", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  const host = r.host();
  await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
  const me = host.core.me.bind(host.core);
  host.core.me = () => ({ ...me(), handle: "not-alex" });
  host.checkPlace();
  await Bun.sleep(3_000);
  host.core.me = me;
  const after = facts(host);
  console.log("P7a", JSON.stringify({ DESTROY_MS, unhandled, after }));
  expect(unhandled).toEqual([]);
}, 60_000);

test("(b) daemon shutdown with a full-access run", async () => {
  await waitFor(() => r.monitors.every((m) => m.code !== "pending") || null, { what: "previous monitor exit", timeoutMs: 15_000 }).catch(() => undefined);
  const host = r.host();
  await r.alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
  const t0 = Date.now();
  const closeRes = await host.close().then(() => "resolved", (e: any) => `rejected: ${e.message}`);
  console.log("P7b", JSON.stringify({ DESTROY_MS, closeRes, closeMs: Date.now() - t0, after: facts(host) }));
  expect(closeRes).toBe("resolved");
  expect(unhandled).toEqual([]);
}, 60_000);
