// LICENSE-FIX-2 F3 through the real route: a Free team where another machine holds the Linear slot on
// the chain can't enable Fireflies here (402 plan_limit, nothing configured); the same connector, and
// disabling, always work; a disable releases the slot on the chain.
import { afterEach, expect, test } from "bun:test";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import "../../src/integrations/routes.ts";
import { DAY_MS, TRIAL_MS } from "../../src/license/plans.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

test("F3: enabling a 2nd integration team-wide on Free is refused (402) before anything is configured; disabling releases the slot", async () => {
  let t = 0;
  const a = tnode("alex"), b = tnode("bea");
  const { team, create } = createTeam(a);
  const core = makeCore(a, team, cleanups, { clock: () => t });
  t = create.ts + 1;
  core.ingest(create, "local");
  core.emit("team.member", { login: b.login, handle: b.handle, role: "member" });
  core.emit("team.node", { node_id: b.keys.nodeId, login: b.login, hostname: b.hostname, pubkey: b.keys.pubkey, ip: "127.0.0.1" });
  core.emit("team.integration", { connector: "linear", node: b.keys.nodeId, enabled: true });
  t = create.ts + TRIAL_MS + DAY_MS; // Free: 1 integration
  const enabled: Record<string, boolean> = {};
  const calls: string[] = [];
  // The stub offers the manager surface the route uses: settings, configure (dry runs too), and the
  // scrub surface (knownSecrets on success, safeMessage on the error path).
  const manager = {
    settings: (id: string) => ({ enabled: enabled[id] === true }),
    configure: (id: string, body: { enabled?: boolean }, opts: { dryRun?: boolean } = {}) => {
      calls.push(`${opts.dryRun ? "dry" : "apply"}:${id}:${body.enabled !== false}`);
      if (!opts.dryRun) enabled[id] = body.enabled !== false;
      return { id, enabled: enabled[id] === true };
    },
    remove: (id: string) => { enabled[id] = false; calls.push(`remove:${id}`); return { id, enabled: false }; },
    knownSecrets: () => [],
    safeMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  };
  const call = async (method: string, id: string, body?: unknown) => {
    const req = new Request(`http://127.0.0.1/v1/integrations/${id}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    const ctx = { core, req, url: new URL(req.url), integrations: { manager, linear: {} }, noTimeout: () => undefined } as unknown as RouteCtx;
    try { const res = await dispatch(ctx); return { status: res.status, body: await res.json() as Record<string, unknown> }; }
    catch (err) { return { status: (err as { status: number }).status, code: (err as { code: string }).code }; }
  };
  expect(await call("POST", "fireflies", { enabled: true })).toMatchObject({ status: 402, code: "plan_limit" });
  expect(calls).toEqual(["dry:fireflies:true"]); // validated first, never applied
  expect(core.roster.integrations?.has("fireflies")).toBe(false);
  // The same connector on this machine is not a 2nd integration.
  expect((await call("POST", "linear", { enabled: true })).status).toBe(200);
  expect([...(core.roster.integrations?.get("linear") ?? [])].sort()).toEqual([a.keys.nodeId, b.keys.nodeId].sort());
  expect(enabled.linear).toBe(true);
  // Disabling always works and releases this node's slot.
  expect((await call("POST", "linear", { enabled: false })).status).toBe(200);
  await Bun.sleep(5);
  expect([...(core.roster.integrations?.get("linear") ?? [])]).toEqual([b.keys.nodeId]);
  // With B's slot released by the authority, Fireflies fits.
  core.emit("team.integration", { connector: "linear", node: b.keys.nodeId, enabled: false });
  expect((await call("POST", "fireflies", { enabled: true })).status).toBe(200);
  expect(core.roster.integrations?.get("fireflies")?.has(a.keys.nodeId)).toBe(true);
  expect((await call("DELETE", "fireflies")).status).toBe(200);
  await Bun.sleep(5);
  expect(core.roster.integrations?.has("fireflies")).toBe(false);
});
