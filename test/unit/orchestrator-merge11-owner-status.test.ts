import { expect, test } from "bun:test";
import { HttpError } from "../../src/daemon/http.ts";
import { rig } from "./orchestrator-merge4-setup.ts";

test("a refused second daemon Start keeps its plain owner message in local status", async () => {
  const r = await rig();
  try {
    const host = r.host();
    const message = "Another Walkie daemon owns shell access on this machine; stop it before starting here";
    host.shellUser.prepare = async () => { throw new HttpError(409, "talkie_user_owned", message); };
    await expect(r.alex.client("").orchestratorStart({ access: "full" })).rejects.toThrow(message);
    expect(host.view().last_error).toBe(message);
  } finally { await r.c.close(); }
}, 30_000);

test("a manual Start retains cleanup failure and recovery in local status", async () => {
  const r = await rig();
  try {
    const host = r.host();
    const message = "WalkieTalkie's OS user could not be cleaned: empty uid sweep could not be verified";
    host.shellUser.prepare = async () => { throw new HttpError(409, "talkie_cleanup_failed", message); };
    await expect(r.alex.client("").orchestratorStart({ access: "full" })).rejects.toThrow(message);
    expect(host.view().last_error).toContain(message);
    expect(host.view().last_error).toContain("walkie talkie cleanup --repair");
  } finally { await r.c.close(); }
}, 30_000);
