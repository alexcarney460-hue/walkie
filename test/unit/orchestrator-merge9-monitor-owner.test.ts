import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CleanupObligation } from "../../src/daemon/orchestrator/cleanup-obligation.ts";
import { TalkieOsUser } from "../../src/daemon/orchestrator/os-user.ts";
import { waitFor } from "./orchestrator-merge7-setup.ts";

const WT = new URL("../..", import.meta.url).pathname;
const CHILD = join(import.meta.dir, "orchestrator-merge7-monitor-child.ts");

test("a stopped separate monitor loses cleanup ownership after its short lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-monitor-owner-"));
  const cleanupFile = join(root, "cleanup.sqlite");
  const obligation = new CleanupObligation(cleanupFile);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ result: false }) });
  const child = Bun.spawn([process.execPath, CHILD, WT, join(root, "missing-lease"), "run", cleanupFile, String(server.port)],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    await waitFor(() => obligation.monitorOwner("run")?.pid === child.pid, { what: "monitor owner", timeoutMs: 5_000 });
    process.kill(child.pid, "SIGSTOP");
    const db = new Database(cleanupFile);
    try {
      db.query("UPDATE retry_owner SET heartbeat = ? WHERE generation = 'run'").run(Date.now() - 10_000);
    } finally { db.close(); }
    expect(obligation.ownerActive("run")).toBe(false);
    const calls: string[] = [];
    const user = new TalkieOsUser(join(root, "daemon.sock"), () => false, {
      cleanupFile, retrySleep: () => new Promise<void>(() => undefined),
      admin: async (verb) => { calls.push(verb); return { ok: true }; },
    });
    await (user as any).retryPending();
    expect(calls).toEqual(["talkie-destroy"]);
    expect(obligation.read()).toBeNull();
  } finally {
    try { process.kill(child.pid, "SIGCONT"); } catch { /* exited */ }
    child.kill("SIGKILL");
    await child.exited;
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
    expect(() => process.kill(child.pid, 0)).toThrow();
  }
}, 10_000);

test("a working separate monitor renews ownership during a slow helper", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-monitor-renew-"));
  const cleanupFile = join(root, "cleanup.sqlite");
  const obligation = new CleanupObligation(cleanupFile);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async () => {
    await Bun.sleep(5_000);
    return Response.json({ result: true });
  } });
  const child = Bun.spawn([process.execPath, CHILD, WT, join(root, "missing-lease"), "run", cleanupFile, String(server.port)],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    await waitFor(() => obligation.monitorOwner("run")?.pid === child.pid, { what: "monitor owner", timeoutMs: 5_000 });
    await Bun.sleep(4_000);
    expect(obligation.ownerActive("run")).toBe(true);
    const db = new Database(cleanupFile);
    try {
      const row = db.query("SELECT heartbeat, interval_ms FROM retry_owner WHERE generation = 'run'").get() as { heartbeat: number; interval_ms: number };
      expect(row.interval_ms).toBe(3_000);
      expect(Date.now() - row.heartbeat).toBeLessThan(3_000);
    } finally { db.close(); }
    expect(await child.exited).toBe(0);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
    expect(() => process.kill(child.pid, 0)).toThrow();
  }
}, 12_000);
