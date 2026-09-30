import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runTalkieRunner } from "../../src/daemon/seats/talkie-runner.ts";
import { TALKIE_UID } from "../../src/daemon/seats/talkie-user.ts";

test("talkie-runner refuses a non-dedicated uid before executing its header", async () => {
  expect(process.getuid?.()).not.toBe(TALKIE_UID);
  const root = mkdtempSync("/tmp/walkie-talkie-runner-uid-");
  try {
    const marker = join(root, "executed");
    const header = JSON.stringify({ argv: ["/bin/sh", "-c", `touch '${marker}'`], cwd: root, env: {} });
    let sent = false;
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) { controller.enqueue(new TextEncoder().encode(`${header}\n`)); sent = true; }
        else return new Promise<void>(() => undefined);
      },
    });
    expect(await runTalkieRunner(input)).toBe(2);
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
