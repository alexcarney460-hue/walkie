import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHermes, withHermesHooks, HERMES_EVENTS } from "./install-hermes.ts";

test("Hermes installer preserves other hooks and is idempotent and reversible", () => {
  const src = "model: fixture\nhooks:\n  pre_tool_call:\n    - command: other-tool\n      timeout: 9\n  outbound:\n    - url: https://example.invalid/observe\nprofile_setting: true\n";
  const next = withHermesHooks(src, "'/path with space/walkie' hook hermes", true);
  expect(next).toContain("command: other-tool");
  expect(next).toContain("https://example.invalid/observe");
  expect((next.match(/hook hermes/g) ?? [])).toHaveLength(HERMES_EVENTS.length);
  expect(withHermesHooks(next, "'/path with space/walkie' hook hermes", true)).toBe(next);
  expect(withHermesHooks(next, "'/path with space/walkie' hook hermes", false)).toBe(src);
});

test("Hermes installer restores a config that originally had no hooks", () => {
  const src = "model: fixture\n";
  const installed = withHermesHooks(src, "walkie hook hermes", true);
  expect(withHermesHooks(installed, "walkie hook hermes", true)).toBe(installed);
  expect(withHermesHooks(installed, "walkie hook hermes", false)).toBe(src);
  const withOther = installed + "  custom_event:\n    - command: other-tool\n";
  const removed = withHermesHooks(withOther, "walkie hook hermes", false);
  expect(removed).toContain("hooks:\n");
  expect(removed).toContain("command: other-tool");
});

test("Hermes installer writes only selected scratch profiles", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-install-"));
  try {
    mkdirSync(join(root, "profiles", "billing"), { recursive: true });
    writeFileSync(join(root, "profiles", "billing", "config.yaml"), "model: test\n");
    const result = await installHermes({ profiles: ["billing"], root, dryRun: false, uninstall: false });
    expect(result.changed).toEqual([join(root, "profiles", "billing", "config.yaml")]);
    const installed = readFileSync(result.changed[0]!, "utf8");
    await installHermes({ profiles: ["billing"], root, dryRun: false, uninstall: false });
    expect(readFileSync(result.changed[0]!, "utf8")).toBe(installed);
    expect(() => readFileSync(join(root, "config.yaml"), "utf8")).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Hermes installer rejects ambiguous YAML and unsafe profiles", () => {
  expect(() => withHermesHooks("hooks: {pre_tool_call: []}\n", "walkie hook hermes", true)).toThrow();
  expect(() => withHermesHooks("hooks:\n  pre_tool_call: []\n", "walkie hook hermes", true)).toThrow();
  expect(() => withHermesHooks("hooks:\nhooks:\n", "walkie hook hermes", true)).toThrow();
  expect(() => withHermesHooks("hooks:\n  pre_tool_call:\n    - command: x\n", "walkie\nmalice", true)).toThrow();
});

test("Hermes installer preflights every selected profile before writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-preflight-"));
  try {
    writeFileSync(join(root, "config.yaml"), "model: safe\n");
    await expect(installHermes({ profiles: ["default", "missing"], root, dryRun: false, uninstall: false })).rejects.toThrow("does not exist");
    expect(readFileSync(join(root, "config.yaml"), "utf8")).toBe("model: safe\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Hermes installer extends quoted YAML event keys without duplicating or changing custom hooks", () => {
  const src = "hooks:\n  \"pre_tool_call\":\n    - command: other-tool\n      timeout: 9\n  'post_llm_call':\n    - command: another-tool\n  # person comment\n  custom_event:\n    - command: keep-me\n";
  const installed = withHermesHooks(src, "walkie hook hermes", true);
  expect((installed.match(/^  [\"']?pre_tool_call[\"']?:/gm) ?? [])).toHaveLength(1);
  expect((installed.match(/^  [\"']?post_llm_call[\"']?:/gm) ?? [])).toHaveLength(1);
  expect(installed).toContain("# person comment\n  custom_event:\n    - command: keep-me");
  expect((Bun.YAML.parse(installed) as { hooks: Record<string, unknown[]> }).hooks.pre_tool_call).toHaveLength(2);
  expect(withHermesHooks(installed, "walkie hook hermes", true)).toBe(installed);
  expect(withHermesHooks(installed, "walkie hook hermes", false)).toBe(src);
  expect(() => withHermesHooks("hooks:\n  pre_tool_call: []\n  \"pre_tool_call\": []\n", "walkie hook hermes", true)).toThrow();
});

test("Hermes hook timeout covers eight serialized status calls and upgrades old managed blocks", () => {
  const original = "model: fixture\n";
  const installed = withHermesHooks(original, "walkie hook hermes", true);
  expect((installed.match(/timeout: 30/g) ?? [])).toHaveLength(HERMES_EVENTS.length);
  const old = installed.replaceAll("timeout: 30", "timeout: 5");
  expect(withHermesHooks(old, "walkie hook hermes", true)).toBe(installed);
  expect(withHermesHooks(old, "walkie hook hermes", false)).toBe(original);
});
