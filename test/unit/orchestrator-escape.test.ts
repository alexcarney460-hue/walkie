import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
test("a stalled daemon stops renewing; the lease lapses and kills a live setsid tool, leaving an unmarked process alone", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".escape-"));
  const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "../fixtures/orchestrator-supervisor/escaped-daemon.ts"), dir], { stdout: "pipe", stderr: "pipe" });
  const unrelated = Bun.spawn(["sleep", "120"]);
  let supervisor = 0, escaped = 0;
  try {
    const output = await daemon.stdout.getReader().read();
    supervisor = Number(new TextDecoder().decode(output.value).trim());
    const until = Date.now() + 5000;
    while (!existsSync(join(dir, "escaped")) && Date.now() < until) await Bun.sleep(10);
    escaped = Number(readFileSync(join(dir, "escaped"), "utf8"));
    expect(alive(escaped)).toBe(true);
    process.kill(daemon.pid, "SIGSTOP");
    const deadline = Date.now() + 5000; // lease 1.5 s + supervisor poll; a stall alone no longer kills (a5367ec)
    while (alive(escaped) && Date.now() < deadline) await Bun.sleep(20);
    expect(alive(escaped)).toBe(false);
    expect(alive(unrelated.pid)).toBe(true);
  } finally {
    for (const pid of [escaped, supervisor, daemon.pid, unrelated.pid]) if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await daemon.exited; await unrelated.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
