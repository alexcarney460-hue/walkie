import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dropClaudeProjections } from "../../src/daemon/seats/runner.ts";
import { scrubSeatOutput } from "../../src/daemon/seats/host.ts";
import { loginLines } from "../../src/cli/commands/seats.ts";
import type { SeatsLocalView } from "../../src/protocol/seats.ts";

test("projection cleanup visits every run despite stray entries and closed config directories", () => {
  const home = mkdtempSync("/tmp/walkie-ocj-drop-");
  try {
    const root = join(home, "walkie-seats");
    for (const name of ["run-1", "run-2"]) {
      const config = join(root, name, "claude-config");
      mkdirSync(config, { recursive: true });
      writeFileSync(join(config, ".credentials.json"), "fake-access");
    }
    writeFileSync(join(root, "notes.txt"), "stray");
    symlinkSync(join(root, "run-1"), join(root, "link"));
    symlinkSync(join(root, "run-1", "claude-config"), join(root, "run-3"));
    mkdirSync(join(root, "run-4"));
    symlinkSync(join(root, "run-1", "claude-config"), join(root, "run-4", "claude-config"));
    chmodSync(join(root, "run-2", "claude-config"), 0o500);
    expect(dropClaudeProjections(home)).toBe(true);
    for (const name of ["run-1", "run-2"]) expect(existsSync(join(root, name, "claude-config", ".credentials.json"))).toBe(false);
    expect(existsSync(join(root, "run-4", "claude-config"))).toBe(false);
  } finally { chmodSync(join(home, "walkie-seats", "run-2", "claude-config"), 0o700); rmSync(home, { recursive: true, force: true }); }
});

test("one unremovable projection does not stop cleanup of later runs", () => {
  const home = mkdtempSync("/tmp/walkie-ocj-drop-");
  try {
    const root = join(home, "walkie-seats");
    mkdirSync(join(root, "run-1", "claude-config", ".credentials.json"), { recursive: true });
    const second = join(root, "run-2", "claude-config", ".credentials.json");
    mkdirSync(join(root, "run-2", "claude-config"), { recursive: true });
    writeFileSync(second, "fake-access");
    expect(dropClaudeProjections(home)).toBe(false);
    expect(existsSync(second)).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a replaced seats root symlink is unlinked without following its target", () => {
  const home = mkdtempSync("/tmp/walkie-ocj-root-");
  const target = mkdtempSync("/tmp/walkie-ocj-target-");
  try {
    writeFileSync(join(target, "marker"), "keep");
    symlinkSync(target, join(home, "walkie-seats"));
    expect(dropClaudeProjections(home)).toBe(true);
    expect(existsSync(join(home, "walkie-seats"))).toBe(false);
    expect(existsSync(join(target, "marker"))).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});

test("disclosure distinguishes separate, same-user, and dedicated Claude login", () => {
  const view = (ephemeral: boolean, claude_login: "machine" | "dedicated") => ({ ephemeral, claude_login }) as SeatsLocalView;
  expect(loginLines(view(true, "machine")).join(" ")).toContain("short-lived Claude access token, never the refresh token");
  expect(loginLines(view(false, "machine")).join(" ")).toContain("full Claude login");
  expect(loginLines(view(true, "dedicated")).join(" ")).toContain("token set for seats only");
});

test("seat output scrubs reversed projected token", () => {
  const token = "fake-claude-access-123456";
  const reversed = [...token].reverse().join("");
  expect(scrubSeatOutput(`output ${reversed}`, token)).not.toContain(reversed);
});
