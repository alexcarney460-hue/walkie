// P9: timing sweep of the P1 race (fenced restart vs a person's switch or Start). Invariant checked at EVERY spawn():
// state access full / bypassPermissions  =>  shellUser.active (else the person's own claude runs with bypassPermissions
// as the person). Also counts spawns while stopping and kills of a newer child.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { crash, rig, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";
let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("sweep", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => r.host().child?.alive, { what: "shell launch" });
  const host = r.host();
  const bad: any[] = [];
  let spawns = 0;
  const spawn = host.spawn.bind(host);
  host.spawn = (session: string, resume: boolean) => {
    spawns++;
    const s = host.state;
    const shellWanted = s?.access === "full" || s?.permission_mode === "bypassPermissions";
    if (shellWanted && !host.shellUser.active) bad.push({ kind: "spawn_without_uid", access: s?.access, mode: s?.permission_mode });
    return spawn(session, resume);
  };
  const orig = host.prepareShellUser.bind(host);
  const results: any[] = [];
  for (const kind of ["switch", "start"]) {
    for (const delay of [0, 1, 3, 10, 30, 100, 300]) {
      const alive = await waitFor(() => host.child?.alive, { what: "alive before round", timeoutMs: 8_000 }).then(() => true, () => false);
      if (!alive) { results.push({ kind, delay, stuck: true, phase: host.phase, view: host.view().state, restartTimer: !!host.restartTimer, child: !!host.child, last: host.lastError, gave_up: host.state?.gave_up ?? null });
        await r.alex.client("").orchestratorStart({ access: "full" }).catch(() => undefined); continue; }
      let k = 0;
      let restartSettled = false;
      host.prepareShellUser = async () => {
        if (k++ === 0) { try { if (delay) await Bun.sleep(delay); return await orig(); } finally { restartSettled = true; } }
        return orig();
      };
      host.attempt = 0;
      await crash(host);
      const entered = await waitFor(() => k >= 1, { what: "T inside prepareShellUser", timeoutMs: 5_000 }).then(() => true, () => false);
      if (!entered) { results.push({ kind, delay, skipped: true, phase: host.phase, restartTimer: !!host.restartTimer, child: !!host.child, last: host.lastError }); host.prepareShellUser = orig; continue; }
      if (kind === "switch") await host.setModel(delay % 2 ? "sonnet" : "opus").catch(() => undefined);
      else await r.alex.client("").orchestratorStart({ access: "full" }).catch(() => undefined);
      const newer = host.child;
      await waitFor(() => restartSettled && host.shellUser.cleaning === null,
        { what: "fenced restart cleanup settled", timeoutMs: 15_000 });
      results.push({ kind, delay, newerKilled: !!newer && !newer.alive, destroys: r.count("talkie-destroy"), phase: host.phase });
      host.prepareShellUser = orig;
    }
  }
  console.log("P9", JSON.stringify({ spawns, bad, results }));
  expect(bad).toEqual([]);
  expect(results.some((result) => result.stuck || result.skipped || result.newerKilled)).toBe(false);
}, 120_000);
