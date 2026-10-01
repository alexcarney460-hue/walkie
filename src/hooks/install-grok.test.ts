import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROK_EVENTS, GROK_NATIVE_EVENTS } from "./grok-events.ts";
import { installGrok, withGrokHooks } from "./install-grok.ts";
import { CLAUDE_EVENTS, type Settings } from "./install.ts";

const MARKED = "walkie hook grok # walkie-managed";

test("Grok installer registers each native event once, for every tool, and nothing else", () => {
  const hooks = withGrokHooks({}, "walkie", true).hooks ?? {};
  expect(Object.keys(hooks).sort()).toEqual([...GROK_NATIVE_EVENTS].sort());
  for (const event of GROK_NATIVE_EVENTS) {
    expect(hooks[event]).toEqual([{ hooks: [{ type: "command", command: MARKED, timeout: 5 }] }]);
  }
});

test("Grok installer is idempotent, reversible and preserves foreign hooks", () => {
  const original = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo guard" }] }],
      Stop: [{ hooks: [{ type: "command", command: "echo custom" }] }],
    },
    enabled: true,
  };
  const once = withGrokHooks(original, "walkie", true);
  expect(withGrokHooks(once, "walkie", true)).toEqual(once);
  expect(once.hooks?.PreToolUse).toHaveLength(2);
  expect(once.hooks?.Stop).toEqual(original.hooks.Stop);
  expect(withGrokHooks(once, "walkie", false)).toEqual(original);
});

test("Grok installer keeps a person's handler in a shared group", () => {
  const shared = { hooks: { Stop: [{ hooks: [{ type: "command", command: MARKED }, { type: "command", command: "echo mine" }] }] } };
  const mine = [{ type: "command", command: "echo mine" }];
  expect(withGrokHooks(shared, "walkie", false).hooks?.Stop?.[0]?.hooks).toEqual(mine);
  expect(withGrokHooks(shared, "walkie", true).hooks?.Stop?.[0]?.hooks).toEqual(mine);
});

test("re-installing over a file from an earlier build leaves Walkie's hook only on the events the native path owns", () => {
  const earlier = {
    hooks: Object.fromEntries(GROK_EVENTS.map((e) => [e.name, [{ hooks: [{ type: "command", command: MARKED, timeout: 5 }] }]])),
  };
  expect(Object.keys(earlier.hooks)).toHaveLength(GROK_EVENTS.length);
  const next = withGrokHooks(earlier, "walkie", true);
  expect(Object.keys(next.hooks ?? {}).sort()).toEqual([...GROK_NATIVE_EVENTS].sort());
  expect(withGrokHooks(next, "walkie", true)).toEqual(next);
});

test("Grok installer ignores foreign hooks on an event it registers", () => {
  const foreign = { hooks: { StopFailure: [{ hooks: [{ type: "command", command: "echo native" }] }] } };
  expect(withGrokHooks(foreign, "walkie", true).hooks?.StopFailure).toHaveLength(2);
});

let dir: string;
let hooksPath: string;
let claudePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "walkie-install-grok-"));
  hooksPath = join(dir, "grok", "hooks", "walkie.json");
  claudePath = join(dir, "claude", "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const install = (over: { dryRun?: boolean; uninstall?: boolean } = {}) => installGrok({ dryRun: false, uninstall: false, ...over, paths: { hooks: hooksPath, claudeSettings: claudePath } });
const readClaude = () => JSON.parse(readFileSync(claudePath, "utf8")) as Settings;
const walkieEvents = (settings: Settings) => Object.entries(settings.hooks ?? {}).filter(([, entries]) => entries.some((e) => e.hooks.some((h) => h.command.includes("# walkie-managed")))).map(([event]) => event).sort();
const backups = (where: string) => readdirSync(where).filter((f) => f.includes(".bak-walkie-"));

test("the installer's two files can only be redirected together, so a test can never leave one at the real home", () => {
  type Options = Parameters<typeof installGrok>[0];
  // @ts-expect-error `hooksPath` alone is not an option: both files are named together, as `paths`
  const aloneHooks: Options = { dryRun: true, uninstall: false, hooksPath: "x" };
  // @ts-expect-error nor is the Claude settings path alone
  const aloneClaude: Options = { dryRun: true, uninstall: false, claudeSettingsPath: "x" };
  // @ts-expect-error and `paths` takes both
  const half: Options = { dryRun: true, uninstall: false, paths: { hooks: "x" } };
  expect([aloneHooks, aloneClaude, half]).toHaveLength(3); // declared, never run: nothing here touches a file
});

test("Grok installer writes the Grok file and the shared Claude hooks, both private, naming both in what it changed", async () => {
  const dry = await install({ dryRun: true });
  expect(dry.changed).toEqual([`${hooksPath} (would write)`, `${claudePath} (would write)`]);
  expect(dry.commands).toEqual([]);
  expect(existsSync(hooksPath)).toBe(false);
  expect(existsSync(claudePath)).toBe(false);

  const done = await install();
  expect(done.changed).toEqual([hooksPath, claudePath]);
  expect(done.commands).toEqual([]); // no `claude mcp add` / `remove`: the hooks writer only
  const grok = JSON.parse(readFileSync(hooksPath, "utf8")) as { hooks: Record<string, unknown[]> };
  expect(Object.keys(grok.hooks).sort()).toEqual([...GROK_NATIVE_EVENTS].sort());
  expect(walkieEvents(readClaude())).toEqual(CLAUDE_EVENTS.map((e) => e.event).sort());
  expect(statSync(hooksPath).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "grok", "hooks")).mode & 0o777).toBe(0o700);
  expect(statSync(claudePath).mode & 0o777).toBe(0o600); // a file Walkie creates
  expect(statSync(join(dir, "claude")).mode & 0o777).toBe(0o700);
});

test("Grok installer keeps a person's Claude settings and hooks, and the old file as a .bak-walkie copy", async () => {
  mkdirSync(join(dir, "claude"), { recursive: true });
  const mine = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } };
  writeFileSync(claudePath, JSON.stringify(mine));
  await install();
  const after = readClaude();
  expect(after.model).toBe("opus");
  expect(after.hooks?.Stop?.map((e) => e.hooks[0]?.command.includes("walkie-managed") ? "walkie" : e.hooks[0]?.command)).toEqual(["echo mine", "walkie"]);
  const kept = backups(join(dir, "claude"));
  expect(kept).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(dir, "claude", kept[0] as string), "utf8"))).toEqual(mine);
});

test("Grok installer is idempotent: a second install changes neither file and makes no new backup", async () => {
  await install();
  const before = { grok: readFileSync(hooksPath, "utf8"), claude: readFileSync(claudePath, "utf8") };
  await install();
  expect(readFileSync(hooksPath, "utf8")).toBe(before.grok);
  expect(readFileSync(claudePath, "utf8")).toBe(before.claude);
  expect(backups(join(dir, "claude"))).toEqual([]);
  expect(backups(join(dir, "grok", "hooks"))).toEqual([]);
});

test("Grok installer leaves a person's formatting alone when the Claude hooks are already there", async () => {
  await install();
  // The same content as a person's editor might keep it: other key order, four-space indent, no final newline.
  const current = readClaude();
  const { hooks, ...rest } = current;
  const reformatted = JSON.stringify({ hooks, ...rest, theme: "dark" }, null, 4);
  writeFileSync(claudePath, reformatted);
  await install();
  expect(readFileSync(claudePath, "utf8")).toBe(reformatted);
  expect(backups(join(dir, "claude"))).toEqual([]);
});

test("Grok installer writes nothing when the Claude settings cannot be read as hooks", async () => {
  mkdirSync(join(dir, "claude"), { recursive: true });
  for (const bad of ["{ not json", "[]", JSON.stringify({ hooks: [] }), JSON.stringify({ hooks: { Stop: { not: "a list" } } }), JSON.stringify({ hooks: { Stop: [{ hooks: "x" }] } })]) {
    writeFileSync(claudePath, bad);
    await expect(install(), bad).rejects.toThrow(/no changes made/);
    await expect(install({ dryRun: true }), `dry run: ${bad}`).rejects.toThrow(/no changes made/);
    expect(readFileSync(claudePath, "utf8")).toBe(bad);
    expect(existsSync(hooksPath), "the Grok file is not written either").toBe(false);
    expect(backups(join(dir, "claude"))).toEqual([]);
  }
});

test("a failed write leaves the shared hooks in place, never the native file alone", async () => {
  // The Grok hook directory cannot be made (a regular file is in its way): the Claude settings were written first.
  writeFileSync(join(dir, "grok"), "in the way");
  await expect(install()).rejects.toThrow();
  expect(walkieEvents(readClaude())).toEqual(CLAUDE_EVENTS.map((e) => e.event).sort());
  expect(existsSync(hooksPath)).toBe(false);
  // The Claude settings cannot be written: the native file is not written either.
  rmSync(join(dir, "grok"), { force: true });
  rmSync(join(dir, "claude"), { recursive: true, force: true });
  writeFileSync(join(dir, "claude"), "in the way");
  await expect(install()).rejects.toThrow();
  expect(existsSync(hooksPath)).toBe(false);
});

test("Grok uninstall removes only the Grok file's hooks: the Claude settings are not read, let alone written", async () => {
  await install();
  const claudeBefore = readFileSync(claudePath, "utf8");
  const r = await install({ uninstall: true });
  expect(r.changed).toEqual([hooksPath]);
  expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toEqual({});
  expect(readFileSync(claudePath, "utf8")).toBe(claudeBefore);
  expect(walkieEvents(readClaude())).toEqual(CLAUDE_EVENTS.map((e) => e.event).sort()); // still Claude Code's hooks too
  // Not even a Claude settings file that is invalid is looked at.
  writeFileSync(claudePath, "invalid compatibility JSON");
  await install({ uninstall: true });
  expect(readFileSync(claudePath, "utf8")).toBe("invalid compatibility JSON");
});
