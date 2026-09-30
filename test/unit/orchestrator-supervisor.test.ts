import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { supervisorParentValid, OS_USER_RUNNER_PARENT } from "../../src/daemon/orchestrator/supervisor.ts";

test("dedicated uid supervisor accepts the runner parent only with an explicit sentinel", () => {
  expect(supervisorParentValid(OS_USER_RUNNER_PARENT, 432)).toBe(true);
  expect(supervisorParentValid(123, 432)).toBe(false);
  expect(supervisorParentValid(432, 432)).toBe(true);
});

function alive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}
for (const mode of ["stall", "expiry", "path", "orphan", "detached-orphan"]) {
  test(`independent supervisor fences the live child group on ${mode}`, async () => {
    const dir = mkdtempSync(join(import.meta.dir, ".supervisor-"));
    const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "../fixtures/orchestrator-supervisor/stalled-daemon.ts"), dir, mode],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let group = 0, orphan = 0;
    try {
      const reader = daemon.stdout.getReader();
      const output = await Promise.race([reader.read(), Bun.sleep(5_000).then(() => { throw new Error("child did not start"); })]);
      group = (JSON.parse(new TextDecoder().decode(output.value)) as { group: number }).group;
      expect(alive(group)).toBe(true);
      if (mode === "orphan" || mode === "detached-orphan") {
        const path = join(dir, "orphan");
        const ready = Date.now() + 2_000;
        while (!existsSync(path) && Date.now() < ready) await Bun.sleep(10);
        orphan = Number(readFileSync(path, "utf8"));
        if (mode === "detached-orphan") await Bun.sleep(550);
      }
      if (mode === "stall" || mode === "orphan" || mode === "detached-orphan") {
        await Bun.sleep(1_500); // the daemon is stalled, but its authority lease is still live
        expect(alive(group)).toBe(true);
        daemon.kill("SIGKILL"); // parent death, unlike a delayed renewal, must fence immediately
        await daemon.exited;
      }
      const deadline = Date.now() + (mode === "stall" || mode === "orphan" || mode === "detached-orphan" ? 2_000 : 4_000);
      while (alive(group) && Date.now() < deadline) await Bun.sleep(25);
      expect(alive(group)).toBe(false);
      if (orphan) {
        const reaped = Date.now() + 1_000;
        while (Date.now() < reaped) {
          try { process.kill(orphan, 0); } catch { break; }
          await Bun.sleep(25);
        }
        expect(() => process.kill(orphan, 0)).toThrow();
      }
    } finally {
      daemon.kill("SIGKILL");
      if (group && alive(group)) { try { process.kill(-group, "SIGKILL"); } catch {} }
      if (orphan) { try { process.kill(orphan, "SIGKILL"); } catch {} }
      await daemon.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 12_000);
}
