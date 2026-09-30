// P5 (Codex round-2 MED "Stop waits behind the platform probe"): a platform model switch re-probes a changed binary whose
// --help never answers. How long does a person's Stop take to resolve, and does anything spawn after it?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_DIR, rig, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";
let r: Rig; let person = "";
beforeAll(async () => {
  r = await rig();
  person = join(r.root, "person-claude");
  writeFileSync(person, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "--help" ] && [ -f '${join(r.root, "slowhelp")}' ]; then /bin/sleep "$(cat '${join(r.root, "slowhelp")}')"; fi; done\nexec '${process.execPath}' '${join(FAKE_DIR, "claude")}' "$@"\n`);
  chmodSync(person, 0o755);
}, 60_000);
afterAll(async () => { await r.c.close(); });

test("stop behind a hung probe", async () => {
  await r.alex.client("").orchestratorStart({ access: "platform", claude: person });
  await waitFor(() => r.rows().length >= 1 && r.host().child?.alive, { what: "platform launch" });
  const host = r.host();
  appendFileSync(person, "# upgraded\n");
  writeFileSync(join(r.root, "slowhelp"), "60");
  const t0 = Date.now();
  const sw = host.setModel("sonnet").then(() => Date.now() - t0);
  await waitFor(() => !!host.probeController, { what: "switch entered probe", timeoutMs: 5_000 });
  const rowsAtStop = r.rows().length;
  const stopIssued = Date.now() - t0;
  await r.alex.client("").orchestratorStop();
  const stopResolved = Date.now() - t0;
  const swResolved = await sw;
  await waitFor(() => !host.child && host.phase === "stopped", { what: "stopped state", timeoutMs: 15_000 });
  const out = { stopIssued, stopResolved, stopWaitedMs: stopResolved - stopIssued, swResolved, rowsAtStop, rowsAfter: r.rows().length,
    child: !!host.child, phase: host.phase };
  console.log("P5", JSON.stringify(out));
  expect(out.rowsAfter).toBe(rowsAtStop);
  expect(out.stopWaitedMs).toBeLessThan(5_000);
}, 60_000);
