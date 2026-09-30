import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { rig, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";

let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("Stop returns while a failed initial Start still has a slow qualified cleanup", async () => {
  const host = r.host();
  host.shellUser.deps.socketRoot = join(r.root, "missing-socket-root");
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let destroying = false;
  r.hook.fn = async (verb) => {
    if (verb === "talkie-destroy") { destroying = true; await held; }
  };
  const start = r.alex.client("").orchestratorStart({ access: "full" }).catch(() => undefined);
  await waitFor(() => destroying || null, { what: "failed setup's destroy" });
  const stop = host.stopByHand();
  const response = await Promise.race([stop.then(() => "ok", () => "error"), Bun.sleep(2_800).then(() => "late")]);
  release();
  await Promise.allSettled([start, stop]);
  await host.shellUser.destroy();
  r.hook.fn = null;
  expect(response).toBe("ok");
  expect(host.state?.stopped_by_hand).toBe(true);
  expect(host.child).toBeNull();
  expect(host.shellUser.pendingCleanup).toBeNull();
}, 60_000);
