// The fake Claude honours a stop that reaches it together with the turn it is for. A slowly starting fake reads the user
// message and the interrupt in one chunk; it used to clear the interrupt when the turn began, the full 300-word count ran and
// "the stop button interrupts the reply in progress" failed in the v0.2.0-pre.17 gate (2026-10-09).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE = join(import.meta.dir, "..", "fixtures", "fake-claude", "claude");

test("a stop written together with the user message interrupts that turn", async () => {
  const state = mkdtempSync(join(tmpdir(), "fake-claude-early-"));
  try {
    const input = [
      { type: "user", message: { role: "user", content: "count slow please" } },
      { type: "control_request", request_id: "stop-1", request: { subtype: "interrupt" } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n";
    const p = Bun.spawn(
      [process.execPath, FAKE, "-p", "--verbose", "--include-partial-messages", "--input-format", "stream-json", "--output-format", "stream-json", "--session-id", crypto.randomUUID()],
      { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", env: { ...process.env, FAKE_CLAUDE_STATE: state } },
    );
    const lines = (await new Response(p.stdout).text()).trim().split("\n").map((l) => JSON.parse(l) as { type: string; subtype?: string });
    expect(await p.exited).toBe(0);
    expect(lines.filter((l) => l.type === "stream_event").length).toBeLessThan(250); // a full count is 300 deltas over ~9 s
    expect(lines.at(-1)).toMatchObject({ type: "result", subtype: "error_during_execution" });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}, 20_000);
