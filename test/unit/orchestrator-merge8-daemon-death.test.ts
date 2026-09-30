import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CleanupObligation } from "../../src/daemon/orchestrator/cleanup-obligation.ts";

const WT = new URL("../..", import.meta.url).pathname;

test("monitor takes over when its cleanup-owning daemon dies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-merge8-death-"));
  let destroys = 0;
  let monitorPid = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => {
    destroys++;
    return Response.json({ result: true });
  } });
  try {
    const cleanupFile = join(dir, "cleanup.sqlite");
    const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "orchestrator-merge8-dying-daemon-child.ts"),
      WT, join(dir, "missing-lease"), "dying-run", cleanupFile, String(server.port)],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const output = await new Response(daemon.stdout).text();
    expect(await daemon.exited).toBe(0);
    monitorPid = (JSON.parse(output) as { monitor: number }).monitor;
    expect(destroys).toBe(0);
    for (let i = 0; i < 50 && destroys === 0; i++) await Bun.sleep(100);
    expect(destroys).toBe(1);
    expect(new CleanupObligation(cleanupFile).read()).toBeNull();
  } finally {
    if (monitorPid) {
      try { process.kill(monitorPid, "SIGKILL"); } catch { /* already exited */ }
    }
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
