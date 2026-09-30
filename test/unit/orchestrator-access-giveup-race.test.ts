import { afterAll, beforeAll, expect, test } from "bun:test";
import { rig, waitFor, type Rig } from "./orchestrator-race-setup.ts";

let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("access preparation does not create a uid after give-up", async () => {
  await r.alex.client("").orchestratorStart({ access: "platform" });
  await waitFor(() => r.rows().length === 1, { what: "platform launch" });
  const host = r.host();
  const detect = host.detectLogins.bind(host);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  host.detectLogins = async () => { entered = true; await held; await detect(); };
  host.attempt = 4;
  const access = host.setAccess("full");
  await waitFor(() => entered, { what: "access preparation" });
  host.child?.terminate();
  await waitFor(() => host.phase === "failed", { what: "give-up" });
  release();
  await expect(access).rejects.toMatchObject({ status: 409, code: "orchestrator_superseded" });
  expect(r.adminCalls.filter((call) => call === "talkie-create")).toHaveLength(0);
  expect(host.phase).toBe("failed");
  expect(host.state.gave_up).toBe(true);
}, 60_000);
