import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CleanupObligation } from "../../src/daemon/orchestrator/cleanup-obligation.ts";
import { selfOp } from "../../src/daemon/seats/admin-ledger.ts";

const WT = new URL("../..", import.meta.url).pathname;

async function monitorTakeover(heartbeat: number, observeFreshMs: number) {
  const dir = mkdtempSync(join(tmpdir(), "walkie-merge8-owner-"));
  const run = "owner-run";
  const cleanupFile = join(dir, "cleanup.sqlite");
  const obligation = new CleanupObligation(cleanupFile);
  expect(obligation.record(run, selfOp(), 3_000)).toBe(true);
  const db = new Database(cleanupFile);
  try { db.query("UPDATE retry_owner SET heartbeat = ? WHERE generation = ?").run(heartbeat, run); }
  finally { db.close(); }
  let destroys = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => {
    destroys++;
    return Response.json({ result: true });
  } });
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "orchestrator-merge7-monitor-child.ts"),
    WT, join(dir, "missing-lease"), run, cleanupFile, String(server.port)],
  { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const started = Date.now();
  try {
    if (observeFreshMs) {
      await Bun.sleep(observeFreshMs);
      expect(destroys).toBe(0);
    }
    const code = await Promise.race([proc.exited, Bun.sleep(6_000).then(() => "timeout" as const)]);
    expect(code).toBe(0);
    expect(destroys).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(obligation.read()).toBeNull();
  } finally {
    proc.kill("SIGKILL");
    await proc.exited;
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
    expect(() => process.kill(proc.pid, 0)).toThrow();
  }
}

test("wedged living daemon loses its short cleanup ownership lease", async () => {
  await monitorTakeover(Date.now() - 7_000, 900);
}, 10_000);

test("future stamped heartbeat cannot defer monitor takeover", async () => {
  await monitorTakeover(Date.now() + 30_000, 0);
}, 10_000);
