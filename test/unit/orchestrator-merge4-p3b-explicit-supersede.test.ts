import { afterAll, beforeAll, expect, test } from "bun:test";
import { rig, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";
let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("a superseded access request reports 409 and keeps the old access", async () => {
  await r.alex.client("").orchestratorStart({ access: "platform" });
  await waitFor(() => r.host().child?.alive, { what: "platform child" });
  const host = r.host();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  host.detectLogins = async () => { entered = true; await held; };
  const access = host.setAccess("full");
  await waitFor(() => entered, { what: "access login check" });
  host.runGeneration++; // a newer non-final attempt supersedes this request
  release();
  await expect(access).rejects.toMatchObject({ status: 409, code: "orchestrator_superseded" });
  expect(host.state.access).toBe("platform");
  expect(r.count("talkie-create")).toBe(0);
}, 60_000);
