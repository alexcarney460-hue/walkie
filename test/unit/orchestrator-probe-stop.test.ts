// Attack 4: switchModel now awaits probePermissionPrompts(). Can a slow/hung probe block a stop or hang the switch,
// and does a person's stop issued during the awaited probe still win?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_DIR, rig, waitFor, type Rig } from "./orchestrator-race-setup.ts";
let r: Rig; let person = "";
beforeAll(async () => {
  r = await rig();
  person = join(r.root, "person-claude");
  // --help is slow while $ROOT/slowhelp holds a number of seconds; otherwise the fake claude.
  writeFileSync(person, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "--help" ] && [ -f '${join(r.root, "slowhelp")}' ]; then /bin/sleep "$(cat '${join(r.root, "slowhelp")}')"; fi; done\nexec '${process.execPath}' '${join(FAKE_DIR, "claude")}' "$@"\n`);
  chmodSync(person, 0o755);
}, 60_000);
afterAll(async () => { await r.c.close(); });

test("stop during the awaited probe of a platform switch", async () => {
  await r.alex.client("").orchestratorStart({ access: "platform", claude: person });
  await waitFor(() => r.rows().length >= 1, { what: "platform launch" });
  const host = r.host();
  console.log("D0 first platform child pp:", r.rows()[0].argv.includes("--permission-prompts"));
  appendFileSync(person, "# upgraded\n"); // same path, new identity: the switch must re-probe
  writeFileSync(join(r.root, "slowhelp"), "3");
  const t0 = Date.now();
  const sw = host.setModel("sonnet").then(() => Date.now() - t0, (e: Error) => `rejected: ${e.message}`);
  await Bun.sleep(400);
  const queued = host.say("Stay queued until the switch finishes", undefined, { via: "cli" });
  const rowsAtStop = r.rows().length;
  const phaseAtStop = host.phase;
  const stopAt = Date.now() - t0;
  await r.alex.client("").orchestratorStop();
  const stopDone = Date.now() - t0;
  const swDone = await sw;
  await Bun.sleep(300);
  const rows = r.rows();
  console.log("D1", JSON.stringify({ phaseAtStop, stopIssuedMs: stopAt, stopResolvedMs: stopDone, switchResolvedMs: swDone,
    rowsAtStop, rowsAfter: rows.length, lastChildPp: rows.at(-1)?.argv?.includes("--permission-prompts"), lastChildModel: rows.at(-1)?.argv?.[rows.at(-1).argv.indexOf("--model") + 1],
    childAlive: !!host.child?.alive, phase: host.phase, view: host.view().state, leadershipValid: host.leadership.valid }));
  expect(host.child).toBeNull();
  expect(host.phase).toBe("stopped");
  expect(rows.length).toBe(rowsAtStop);
  expect(host.queue.length).toBe(0);
  expect(r.alex.d.core.store.orchMessage(queued.id)?.state).toBe("dropped");
}, 60_000);
