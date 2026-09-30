import { afterAll, beforeAll, expect, test } from "bun:test";
import { crash, helperEmulator, rig, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";
let r: Rig;
const helper = helperEmulator({ ms: 100 });
beforeAll(async () => { r = await rig(); r.hook.fn = helper.fn; }, 60_000);
afterAll(async () => { await r.c.close(); });

test("a restart and a model switch prepare the dedicated uid serially", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => r.host().child?.alive, { what: "shell launch" });
  const host = r.host();
  const prepare = host.prepareShellUser.bind(host);
  let inPrepare = 0;
  let maxConcurrent = 0;
  host.prepareShellUser = async () => {
    inPrepare++;
    maxConcurrent = Math.max(maxConcurrent, inPrepare);
    try { await Bun.sleep(200); await prepare(); }
    finally { inPrepare--; }
  };
  await crash(host);
  const switched = host.setModel("sonnet");
  await switched;
  await waitFor(() => host.child?.alive, { what: "switched child" });
  expect(maxConcurrent).toBe(1);
  expect(r.count("talkie-create")).toBe(1);
  expect(helper.state.current).toBe(host.shellUser.generation);
}, 60_000);
