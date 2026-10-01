import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLAUDE_EVENTS, detectIndent, installClaude, writeClaudeSettings, type Settings } from "./install.ts";

let dir: string;
let settingsPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "walkie-install-claude-"));
  settingsPath = join(dir, ".claude", "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const walkieEntries = (settings: Settings) => Object.entries(settings.hooks ?? {}).flatMap(([event, entries]) =>
  entries.filter((e) => e.hooks.some((h) => h.command.includes("# walkie-managed"))).map(() => event));
const read = () => JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
const backups = () => readdirSync(join(dir, ".claude")).filter((f) => f.includes(".bak-walkie-"));

// `claudeFound: false` is a machine with no claude CLI; the present-CLI path runs `claude mcp add`, which only the CLI
// tests (test/unit/hooks-install-cli.test.ts) exercise, with a stand-in `claude` and a temp HOME.

test("with no claude CLI the hooks are written, the MCP step is skipped, and the note names the command to run later", async () => {
  const r = await installClaude({ dryRun: false, uninstall: false, settingsPath, claudeFound: false });
  expect(r.changed).toEqual([settingsPath]);
  expect(r.commands).toEqual([]); // nothing ran
  expect(r.note).toContain("claude mcp add --scope user walkie -- ");
  expect(r.note).toMatch(/ mcp$/);
  expect(walkieEntries(read()).sort()).toEqual(CLAUDE_EVENTS.map((e) => e.event).sort());
});

test("a dry run with no claude CLI writes nothing and still says what would be skipped", async () => {
  const r = await installClaude({ dryRun: true, uninstall: false, settingsPath, claudeFound: false });
  expect(r.changed).toEqual([`${settingsPath} (would write)`]);
  expect(r.commands).toEqual([]);
  expect(r.note).toContain("claude mcp add --scope user walkie -- ");
  expect(existsSync(settingsPath)).toBe(false);
});

test("uninstalling with no claude CLI removes the hooks and names the command that would clear the MCP entry", async () => {
  await installClaude({ dryRun: false, uninstall: false, settingsPath, claudeFound: false });
  const r = await installClaude({ dryRun: false, uninstall: true, settingsPath, claudeFound: false });
  expect(r.commands).toEqual([]);
  expect(r.note).toContain("claude mcp remove --scope user walkie");
  expect(walkieEntries(read())).toEqual([]);
});

test("a person's own hooks and settings survive, and the old file is kept as a .bak-walkie copy", async () => {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const mine = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } };
  writeFileSync(settingsPath, JSON.stringify(mine));
  await installClaude({ dryRun: false, uninstall: false, settingsPath, claudeFound: false });
  const after = read();
  expect(after.model).toBe("opus");
  expect(after.hooks?.Stop).toHaveLength(2);
  expect(after.hooks?.Stop?.[0]?.hooks[0]?.command).toBe("echo mine");
  const kept = backups();
  expect(kept).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(dir, ".claude", kept[0] as string), "utf8"))).toEqual(mine);
});

test("a settings file that is not valid JSON is refused before anything is written", async () => {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(settingsPath, "{ not json");
  await expect(installClaude({ dryRun: false, uninstall: false, settingsPath, claudeFound: false })).rejects.toThrow();
  expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
  expect(backups()).toEqual([]);
});

test("a settings file Walkie creates, and the directory it makes for it, are private", async () => {
  await installClaude({ dryRun: false, uninstall: false, settingsPath, claudeFound: false });
  expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, ".claude")).mode & 0o777).toBe(0o700);
});

// ---- the one write of the Claude settings file (final review B, LOW): atomic, keeps the person's formatting, backs up only a change ----

const FAILED_RENAME = { rename: () => { throw new Error("EXDEV: simulated failure at the rename"); }, writeInPlace: () => undefined };
const strays = () => readdirSync(join(dir, ".claude")).filter((f) => f.includes(".bak-walkie-") || f.endsWith(".tmp"));

test("a four-space file keeps its four-space indentation (and no final newline when it had none) while Walkie's hooks go in", async () => {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const mine = { model: "opus", permissions: { allow: ["Bash(ls)"] } };
  writeFileSync(settingsPath, JSON.stringify(mine, null, 4)); // no trailing newline, the way some editors save
  await installClaude({ dryRun: false, uninstall: false, settingsPath, claudeFound: false });
  const text = readFileSync(settingsPath, "utf8");
  expect(text).toContain('\n    "model": "opus"');
  expect(text).toContain('\n    "hooks": {\n        "SessionStart"');
  expect(text).not.toMatch(/\n {2}"model"/); // never re-indented to two spaces
  expect(text.endsWith("\n")).toBe(false);
  expect(JSON.parse(text).model).toBe("opus");
  // A tab-indented file keeps its tabs; a new file is two spaces with a final newline.
  const tabbed = join(dir, ".claude", "tabs.json");
  writeFileSync(tabbed, JSON.stringify({ a: 1 }, null, "\t") + "\n");
  writeClaudeSettings(tabbed, { a: 1, b: 2 });
  expect(readFileSync(tabbed, "utf8")).toBe('{\n\t"a": 1,\n\t"b": 2\n}\n');
  const fresh = join(dir, ".claude", "fresh.json");
  writeClaudeSettings(fresh, { a: 1 });
  expect(readFileSync(fresh, "utf8")).toBe('{\n  "a": 1\n}\n');
  expect(detectIndent(JSON.stringify({ a: 1 }, null, 4))).toBe(4);
});

test("a backup is written only when the write changes the file: the first install makes one, the second makes none and touches nothing", async () => {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const mine = JSON.stringify({ model: "opus" }, null, 4);
  writeFileSync(settingsPath, mine);
  await installClaude({ dryRun: false, uninstall: false, settingsPath, claudeFound: false });
  const kept = readdirSync(join(dir, ".claude")).filter((f) => f.includes(".bak-walkie-"));
  expect(kept).toHaveLength(1);
  expect(readFileSync(join(dir, ".claude", kept[0] as string), "utf8")).toBe(mine);
  const after = readFileSync(settingsPath, "utf8");
  const before = statSync(settingsPath);
  await installClaude({ dryRun: false, uninstall: false, settingsPath, claudeFound: false });
  expect(readFileSync(settingsPath, "utf8")).toBe(after);
  expect(statSync(settingsPath).ino).toBe(before.ino); // not even rewritten
  expect(statSync(settingsPath).mtimeMs).toBe(before.mtimeMs);
  expect(strays()).toEqual(kept);
});

test("a write that fails at the rename leaves the old file byte for byte, no backup and no temp file behind, and says so", () => {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const mine = JSON.stringify({ model: "opus" }, null, 4);
  writeFileSync(settingsPath, mine);
  const next = { model: "opus", extra: true } as Settings;
  expect(() => writeClaudeSettings(settingsPath, next, FAILED_RENAME)).toThrow(/EXDEV: simulated failure at the rename/);
  expect(() => writeClaudeSettings(settingsPath, next, FAILED_RENAME)).toThrow(settingsPath);
  expect(readFileSync(settingsPath, "utf8")).toBe(mine);
  expect(strays()).toEqual([]);
  // The same for a file that did not exist: nothing is created.
  rmSync(settingsPath);
  expect(() => writeClaudeSettings(settingsPath, next, FAILED_RENAME)).toThrow();
  expect(existsSync(settingsPath)).toBe(false);
  expect(strays()).toEqual([]);
});

test("the new content is written beside the file and renamed over it in the same directory: a reader never sees half a file", () => {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const mine = JSON.stringify({ model: "opus" }, null, 2) + "\n";
  writeFileSync(settingsPath, mine);
  const seen: Array<{ from: string; to: string; staged: string; inPlace: string }> = [];
  writeClaudeSettings(settingsPath, { model: "sonnet" }, { writeInPlace: () => undefined, rename: (from, to) => {
    seen.push({ from, to, staged: readFileSync(from, "utf8"), inPlace: readFileSync(to, "utf8") });
    renameSync(from, to);
  } });
  expect(seen).toHaveLength(1);
  expect(dirname(seen[0]!.from)).toBe(realpathSync(dirname(settingsPath))); // the same directory, so the rename is atomic
  expect(seen[0]!.to).toBe(realpathSync(settingsPath));
  expect(seen[0]!.staged).toBe(JSON.stringify({ model: "sonnet" }, null, 2) + "\n"); // complete before it is renamed
  expect(seen[0]!.inPlace).toBe(mine); // and the old file was whole until that instant
  expect(readFileSync(settingsPath, "utf8")).toBe(JSON.stringify({ model: "sonnet" }, null, 2) + "\n");
  expect(strays().filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test.skipIf(process.getuid?.() === 0)("a read-only file is refused before anything is made: no backup, no temp file, the file as it was; one that already holds the hooks is a no-op", () => {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const mine = JSON.stringify({ model: "opus" }, null, 2) + "\n";
  writeFileSync(settingsPath, mine);
  chmodSync(settingsPath, 0o444);
  try {
    expect(() => writeClaudeSettings(settingsPath, { model: "sonnet" })).toThrow(/is not writable; no changes made/);
    expect(readFileSync(settingsPath, "utf8")).toBe(mine);
    expect(statSync(settingsPath).mode & 0o777).toBe(0o444);
    expect(strays()).toEqual([]);
    writeClaudeSettings(settingsPath, { model: "opus" }); // already holds exactly this: nothing to write, so nothing to refuse
  } finally { chmodSync(settingsPath, 0o600); }
});

test("the file's mode is kept (a new file is 0600), and the directory of a new one is private", () => {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(settingsPath, "{}\n");
  chmodSync(settingsPath, 0o640);
  writeClaudeSettings(settingsPath, { a: 1 });
  expect(statSync(settingsPath).mode & 0o777).toBe(0o640);
  const other = join(dir, "other", ".claude", "settings.json");
  writeClaudeSettings(other, { a: 1 });
  expect(statSync(other).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(other)).mode & 0o777).toBe(0o700);
});

test("a symlinked settings.json (dotfiles) stays a link and its real file is the one replaced; the backup sits beside the link", async () => {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  mkdirSync(join(dir, "dotfiles"));
  const real = join(dir, "dotfiles", "claude-settings.json");
  const mine = JSON.stringify({ model: "opus" }, null, 4);
  writeFileSync(real, mine);
  symlinkSync(real, settingsPath);
  await installClaude({ dryRun: false, uninstall: false, settingsPath, claudeFound: false });
  expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(real, "utf8")).hooks).toBeDefined();
  expect(readFileSync(real, "utf8")).toContain('\n    "model": "opus"'); // its own indentation
  const kept = readdirSync(join(dir, ".claude")).filter((f) => f.includes(".bak-walkie-"));
  expect(kept).toHaveLength(1);
  expect(readFileSync(join(dir, ".claude", kept[0] as string), "utf8")).toBe(mine);
});

test("a hard-linked file is written in place, so every link sees the new content (a rename would cut the others off); a failure there restores it and leaves no backup", () => {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const other = join(dir, "second-link.json");
  const mine = JSON.stringify({ model: "opus" }, null, 2) + "\n";
  writeFileSync(settingsPath, mine);
  linkSync(settingsPath, other);
  writeClaudeSettings(settingsPath, { model: "sonnet" });
  const written = JSON.stringify({ model: "sonnet" }, null, 2) + "\n";
  expect(readFileSync(other, "utf8")).toBe(written);
  expect(statSync(settingsPath).nlink).toBe(2);
  const backups = () => strays().filter((f) => f.includes(".bak-walkie-"));
  expect(backups()).toHaveLength(1);
  // A write that fails in place puts the old content back and leaves no new backup (the one from the first write stays).
  const failing = { rename: renameSync, writeInPlace: () => { throw new Error("EIO: simulated failure in place"); } };
  expect(() => writeClaudeSettings(settingsPath, { model: "haiku" }, failing)).toThrow(/EIO: simulated failure in place/);
  expect(readFileSync(other, "utf8")).toBe(written);
  expect(statSync(settingsPath).nlink).toBe(2);
  expect(backups()).toHaveLength(1);
  rmSync(other);
});

test("through hooks install grok too: the same writer, so a four-space Claude file keeps its indentation there", async () => {
  const { installGrok } = await import("./install-grok.ts");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ model: "opus" }, null, 4));
  await installGrok({ dryRun: false, uninstall: false, paths: { hooks: join(dir, "grok", "walkie.json"), claudeSettings: settingsPath } });
  expect(readFileSync(settingsPath, "utf8")).toContain('\n    "model": "opus"');
  expect(JSON.parse(readFileSync(settingsPath, "utf8")).hooks.SessionStart).toBeDefined();
});
