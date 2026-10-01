// Linux worker-root scan (walkie seats cleanup-root): a process of this user that made itself non-dumpable hides /proc
// environ, cwd and fds even from that user. The best-effort scan must not refuse because of one, and must still see the
// root in such a process's command line, which stays readable.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerRootOccupied } from "../../src/daemon/seats/worker-root.ts";

const linux = process.platform === "linux" && !!Bun.which("python3");
// prctl(PR_SET_DUMPABLE = 4, 0): from here on /proc/<pid>/environ, cwd and fd answer EACCES to this user too.
const NON_DUMPABLE = "import ctypes,time; ctypes.CDLL(None).prctl(4, 0, 0, 0, 0); print('ready', flush=True); time.sleep(30)";

const started: Bun.Subprocess[] = [];
afterEach(() => { for (const p of started.splice(0)) p.kill(); });

async function nonDumpable(extraArg?: string): Promise<Bun.Subprocess<"ignore", "pipe", "inherit">> {
  const p = Bun.spawn(["python3", "-c", NON_DUMPABLE, ...(extraArg ? [extraArg] : [])], { stdout: "pipe", stderr: "inherit" });
  started.push(p);
  const reader = p.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(value)).toContain("ready");
  return p;
}

describe.skipIf(!linux)("Linux worker-root scan and non-dumpable processes", () => {
  test("a non-dumpable process of this user no longer makes the scan refuse", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "walkie-wr-")), ".walkie-workers", "seat-a");
    mkdirSync(root, { recursive: true });
    try {
      await nonDumpable();
      expect(workerRootOccupied(root)).toBe(false);
    } finally { rmSync(join(root, "..", ".."), { recursive: true, force: true }); }
  });

  test("a non-dumpable process whose command line names the root still counts as using it", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "walkie-wr-")), ".walkie-workers", "seat-b");
    mkdirSync(root, { recursive: true });
    try {
      await nonDumpable(root);
      expect(workerRootOccupied(root)).toBe(true);
    } finally { rmSync(join(root, "..", ".."), { recursive: true, force: true }); }
  });
});
