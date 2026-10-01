import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { createWorkerRoot, removeWorkerRoot, sweepWorkerRoots } from "../../src/daemon/seats/worker-root.ts";
import { SeatsHost } from "../../src/daemon/seats/host.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

test("private per-seat config and temp directories are removed without touching provider homes", () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-worker-test-"));
  homes.push(home);
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "keep"), "person's login");
  const root = createWorkerRoot(home, "0123456789abcdef:1");
  for (const path of [root.root, root.claude, root.codex, root.temp]) expect(lstatSync(path).mode & 0o777).toBe(0o700);
  const settings = JSON.parse(readFileSync(join(root.claude, "settings.json"), "utf8")) as { hooks: Record<string, unknown> };
  expect(settings.hooks.SessionStart).toBeDefined();
  expect(settings.hooks.PostToolUse).toBeDefined();
  expect(readFileSync(join(root.codex, "config.toml"), "utf8")).toContain("[mcp_servers.walkie]");
  expect(readFileSync(join(root.claude, "CLAUDE.md"), "utf8")).toContain("Walkie worker seat");
  writeFileSync(join(root.claude, "session"), "transcript");
  removeWorkerRoot(home, root.key);
  expect(existsSync(root.root)).toBe(false);
  expect(readFileSync(join(home, ".claude", "keep"), "utf8")).toBe("person's login");
});

test("a seat instance after cleanup or crash never receives an earlier root path", () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-worker-test-"));
  homes.push(home);
  const id = "0123456789abcdef:1";
  const crashed = createWorkerRoot(home, id);
  const later = createWorkerRoot(home, id);
  expect(later.root).not.toBe(crashed.root);
  removeWorkerRoot(home, crashed.key);
  const afterCleanup = createWorkerRoot(home, id);
  expect(afterCleanup.root).not.toBe(crashed.root);
  expect(afterCleanup.root).not.toBe(later.root);
  expect(existsSync(later.root)).toBe(true);
  for (const root of [later, afterCleanup]) expect(lstatSync(root.root).mode & 0o777).toBe(0o700);
});

test("read-only subdirectories are removed and startup sweep leaves live roots alone", () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-worker-test-"));
  homes.push(home);
  const orphan = createWorkerRoot(home, "0123456789abcdef:1");
  const live = createWorkerRoot(home, "0123456789abcdef:2");
  mkdirSync(join(orphan.claude, "readonly"));
  writeFileSync(join(orphan.claude, "readonly", "copy"), "fake credential");
  chmodSync(join(orphan.claude, "readonly"), 0o500);
  chmodSync(orphan.claude, 0o500);
  expect(sweepWorkerRoots(home, new Set([live.key]))).toEqual([orphan.key]);
  expect(existsSync(orphan.root)).toBe(false);
  expect(existsSync(live.root)).toBe(true);
});

test("worker cleanup rejects an invalid id and a symlinked root", () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-worker-test-"));
  homes.push(home);
  const victim = join(home, "victim");
  mkdirSync(victim);
  writeFileSync(join(victim, "keep"), "safe");
  expect(() => createWorkerRoot(home, "../../victim")).toThrow();
  mkdirSync(join(home, ".walkie-workers"));
  symlinkSync(victim, join(home, ".walkie-workers", "seat-0123456789abcdef-1"));
  expect(() => createWorkerRoot(home, "0123456789abcdef:1")).not.toThrow();
  expect(() => removeWorkerRoot(home, "0123456789abcdef:1")).toThrow();
  expect(readFileSync(join(victim, "keep"), "utf8")).toBe("safe");
});

test("a bad orphan does not prevent cleanup of later valid roots", () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-worker-test-"));
  homes.push(home);
  const victim = join(home, "victim");
  mkdirSync(victim);
  writeFileSync(join(victim, "keep"), "safe");
  mkdirSync(join(home, ".walkie-workers"));
  symlinkSync(victim, join(home, ".walkie-workers", "seat-0123456789abcdef-1"));
  const orphan = createWorkerRoot(home, "0123456789abcdef:2");
  const errors: string[] = [];
  expect(sweepWorkerRoots(home, new Set(), (id) => errors.push(id))).toEqual([orphan.key]);
  expect(errors).toEqual(["0123456789abcdef:1"]);
  expect(existsSync(orphan.root)).toBe(false);
  expect(readFileSync(join(victim, "keep"), "utf8")).toBe("safe");
});

test("a dangling symlink root is reported for later inspection, never counted as removed", () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-worker-test-"));
  homes.push(home);
  mkdirSync(join(home, ".walkie-workers"));
  const link = join(home, ".walkie-workers", "seat-0123456789abcdef-1");
  symlinkSync(join(home, "missing"), link);
  const errors: string[] = [];
  expect(sweepWorkerRoots(home, new Set(), (id) => errors.push(id))).toEqual([]);
  expect(errors).toEqual(["0123456789abcdef:1"]);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
});

test("a reused PID does not hold a crashed worker root", () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-worker-test-"));
  homes.push(home);
  const id = "0123456789abcdef:11";
  const root = createWorkerRoot(home, id);
  const pendingRoots = new Map([[root.key, { id: root.key, pid: process.pid, started: "Mon Jan  1 00:00:00 2001" }]]);
  const host = { home, pendingRoots, rootRetry: null, closing: true, save: () => true };
  const retry = (SeatsHost.prototype as unknown as { retryPendingRoots: (this: unknown) => void }).retryPendingRoots;
  retry.call(host);
  expect(existsSync(root.root)).toBe(false);
  expect(pendingRoots.size).toBe(0);
});
