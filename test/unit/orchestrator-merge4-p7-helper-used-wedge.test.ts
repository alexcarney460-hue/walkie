import { afterAll, beforeAll, expect, test } from "bun:test";
import { rig, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";
let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("a helper create failure during a switch gets a restart", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => r.host().child?.alive, { what: "shell launch" });
  const host = r.host();
  await host.shellUser.destroy();
  let failed = false;
  r.hook.fn = async (verb) => {
    if (verb === "talkie-create" && !failed) { failed = true; return { ok: false, why: "walkie-talkie or uid 550000 already exists" }; }
  };
  await expect(host.setModel("sonnet")).rejects.toThrow("could not be created");
  await waitFor(() => host.child?.alive, { what: "recovered child", timeoutMs: 10_000 });
  expect(host.shellUser.active).toBe(true);
  expect(r.count("talkie-create")).toBeGreaterThanOrEqual(3);
}, 60_000);
