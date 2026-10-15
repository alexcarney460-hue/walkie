import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summaryPrompt } from "../../src/switch/summary.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("old and new switch prompts are excluded from a transcript summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqwakie-summary-"));
  dirs.push(dir);
  const path = join(dir, "transcript.jsonl");
  const turns = [
    "User: keep this real question",
    "Continue where you left off. (Walkie moved this session to another account because the previous one reached its usage limit; the last turn may have been cut short.)",
    "Walkie moved this session to another account because the previous one reached its usage limit. Answer the most recent user message, which was sent after the limit was reached, and continue from there.",
    "Continue where you left off. (Sqwakie moved this session to another account because the previous one reached its usage limit; the last turn may have been cut short.)",
    "Sqwakie moved this session to another account because the previous one reached its usage limit. Answer the most recent user message, which was sent after the limit was reached, and continue from there.",
  ];
  writeFileSync(path, turns.map((text) => JSON.stringify({ type: "user", message: { role: "user", content: text } })).join("\n"));
  const summary = summaryPrompt(path);
  expect(summary).toContain("User: User: keep this real question");
  expect(summary).not.toContain("Continue where you left off. (");
  expect(summary).not.toContain("Answer the most recent user message");
});
