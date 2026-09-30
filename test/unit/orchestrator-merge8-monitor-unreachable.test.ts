import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WT = new URL("../..", import.meta.url).pathname;

test("test monitor exits when its helper endpoint stays unreachable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-merge8-unreachable-"));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ result: false }) });
  const port = server.port;
  server.stop(true);
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "orchestrator-merge7-monitor-child.ts"),
    WT, join(dir, "missing-lease"), "unreachable-run", join(dir, "cleanup.sqlite"), String(port)],
  { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    const code = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => "timeout" as const)]);
    expect(code).toBe(4);
  } finally {
    proc.kill("SIGKILL");
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
    expect(() => process.kill(proc.pid, 0)).toThrow();
  }
}, 8_000);
