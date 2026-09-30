// Attack 1, realistic variant: production backoff leaves the restart timer ARMED for seconds ("Restarting Claude…").
// A person changes the model meanwhile; that child crashes too -> give-up -> cleanupAfterGiveUp (does not clear restartTimer).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rig, waitFor, type Rig } from "./orchestrator-race-setup.ts";
let r: Rig;
beforeAll(async () => { r = await rig({ runtimeBody: `if [ -f '$ROOT/crash' ]; then echo boom >&2; exit 3; fi` }); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("armed restart timer survives give-up", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => r.rows().length >= 1, { what: "shell launch" });
  const host = r.host();
  host.opts.restartBaseMs = 1_000; host.opts.restartMaxMs = 3_000; // closer to production (1 s base, 60 s max)
  host.attempt = 3;
  writeFileSync(join(r.root, "crash"), "1");
  host.child?.terminate();
  await waitFor(() => host.phase === "restarting" && host.restartTimer, { what: "restart timer armed" });
  await host.setModel("sonnet"); // the person changes the model during "Restarting Claude…"
  await waitFor(() => host.phase === "failed", { what: "give-up", timeoutMs: 5_000 });
  await waitFor(() => !host.shellUser.active, { what: "uid destroyed" });
  const at = { armedAfterGiveUp: !!host.restartTimer, creates: r.adminCalls.filter((v) => v === "talkie-create").length, rows: r.rows().length };
  console.log("A3 at give-up", JSON.stringify({ ...at, view: host.view().state }));
  rmSync(join(r.root, "crash"));
  await Bun.sleep(4_000);
  const after = { creates: r.adminCalls.filter((v) => v === "talkie-create").length, rows: r.rows().length, phase: host.phase, view: host.view().state,
    running: host.view().running, shellActive: host.shellUser.active, childAlive: !!host.child?.alive, gave_up: host.state?.gave_up ?? null };
  console.log("A3 later", JSON.stringify(after));
  expect(after.creates).toBe(at.creates);
  expect(after.rows).toBe(at.rows);
  expect(after.childAlive).toBe(false);
  expect(after.phase).toBe("failed");
}, 60_000);
