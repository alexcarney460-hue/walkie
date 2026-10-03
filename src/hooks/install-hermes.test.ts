import { expect, test } from "bun:test";
import { chmodSync, chownSync, linkSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installHermes, withHermesHooks, writeHermesConfig, HERMES_EVENTS, type HermesIo } from "./install-hermes.ts";

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

// ---- the one write of a profile's config.yaml: the same replacement as the Claude settings file (replaceFileText) ----

type Write = NonNullable<HermesIo["write"]>;
const realWrite: Write = (path, body) => writeFileSync(path, body, { mode: 0o600, flag: "wx" });
const realInPlace: HermesIo["writeInPlace"] = (path, body) => writeFileSync(path, body);
/** The real file system calls, with `over` replacing some of them. */
const io = (over: Partial<HermesIo> = {}): HermesIo => ({ write: realWrite, rename: renameSync, writeInPlace: realInPlace, ...over });
const failing = (code: string): Error => Object.assign(new Error(`${code}: simulated failure`), { code });
/** A scratch Hermes home whose default profile's config.yaml holds `text`; removed after `body`. */
async function withProfile(text: string, body: (root: string, path: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-atomic-"));
  try {
    const path = join(root, "config.yaml");
    writeFileSync(path, text);
    await body(root, path);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const install = (root: string, over: HermesIo, uninstall = false) => installHermes({ profiles: ["default"], root, dryRun: false, uninstall, io: over });
/** What sits beside config.yaml besides it, `known` names and its backups: a temp file would show here. */
const strays = (root: string, ...known: string[]) => readdirSync(root).filter((f) => f !== "config.yaml" && !known.includes(f) && !f.includes(".bak-walkie-"));
const backups = (root: string) => readdirSync(root).filter((f) => f.includes(".bak-walkie-"));
const read = (root: string, name: string) => readFileSync(join(root, name), "utf8");

test("a write that fails at the rename leaves the old config byte for byte, no temp file and no backup, and names no path", () => withProfile("model: safe\n", async (root, path) => {
  const rename: HermesIo["rename"] = () => { throw failing("EXDEV"); };
  const error = await install(root, io({ rename })).then(() => null, (e: Error) => e);
  expect(error?.message).toBe("could not write the Hermes profile config (EXDEV); the file is as it was");
  expect(error?.message).not.toContain(root); // the audit line of a failed install carries this text and never names a profile
  expect(readFileSync(path, "utf8")).toBe("model: safe\n");
  expect(readdirSync(root)).toEqual(["config.yaml"]); // the backup made first is removed again: a failed install leaves nothing stray
}));

test("a write that fails part-way through the temp file leaves the old config and removes the partial file and the backup", () => withProfile("model: safe\n", async (root, path) => {
  const write: Write = (target, body) => { writeFileSync(target, body.slice(0, 9), { mode: 0o600, flag: "wx" }); throw failing("ENOSPC"); };
  await expect(install(root, io({ write }))).rejects.toThrow("could not write the Hermes profile config (ENOSPC); the file is as it was");
  expect(readFileSync(path, "utf8")).toBe("model: safe\n");
  expect(readdirSync(root)).toEqual(["config.yaml"]);
}));

test("an error with no code still says the file is as it was", () => withProfile("model: safe\n", async (root, path) => {
  const write: Write = () => { throw new Error("disk exploded"); };
  await expect(install(root, io({ write }))).rejects.toThrow("could not write the Hermes profile config; the file is as it was");
  expect(readFileSync(path, "utf8")).toBe("model: safe\n");
  expect(readdirSync(root)).toEqual(["config.yaml"]);
}));

test("the whole new text is in a private temp file in the same directory before it is renamed over the file, whose old text was whole until then", () => withProfile("model: safe\n", async (root, path) => {
  chmodSync(path, 0o640);
  const seen: Array<{ from: string; to: string; staged: string; stagedMode: number; old: string }> = [];
  let createdMode = -1;
  const over = io({
    write: (target, body) => { realWrite(target, body); createdMode = statSync(target).mode & 0o777; },
    rename: (from, to) => {
      seen.push({ from, to, staged: readFileSync(from, "utf8"), stagedMode: statSync(from).mode & 0o777, old: readFileSync(to, "utf8") });
      renameSync(from, to);
    },
  });
  const result = await install(root, over);
  const installed = readFileSync(path, "utf8");
  expect(result.changed).toEqual([path]);
  expect(installed).toContain("walkie-hermes:on_session_start");
  expect(createdMode).toBe(0o600); // private while it is written
  expect(seen).toHaveLength(1);
  // Compared as real paths, as the Claude installer's test does: macOS's temp directory is reached through a link (/var ->
  // /private/var) and the installer stages beside the file's real path.
  expect(dirname(seen[0]!.from)).toBe(realpathSync(dirname(path))); // the same directory, so the rename is atomic
  expect(seen[0]!.to).toBe(realpathSync(path));
  expect(seen[0]!.staged).toBe(installed); // complete before the rename
  expect(seen[0]!.stagedMode).toBe(0o640); // already carrying the file's own permissions
  expect(seen[0]!.old).toBe("model: safe\n"); // and the old file was whole until that instant
  expect(statSync(path).mode & 0o777).toBe(0o640); // the file keeps the permissions it had
  expect(strays(root)).toEqual([]);
  expect(backups(root).map((f) => read(root, f))).toEqual(["model: safe\n"]); // the backup of a write that worked stays
}));

/** A group the person belongs to besides the one this process runs under, that a file can be given: none on a machine without one. */
function anotherGroup(): number | undefined {
  const dir = mkdtempSync(join(tmpdir(), "walkie-hermes-group-"));
  try {
    const probe = join(dir, "probe");
    writeFileSync(probe, "");
    for (const gid of process.getgroups?.() ?? []) {
      if (gid === process.getgid?.()) continue;
      try { chownSync(probe, process.getuid!(), gid); return gid; } catch { /* not a group this file can be given */ }
    }
    return undefined;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const GROUP = anotherGroup();

test.skipIf(GROUP === undefined)("the file keeps its group: a rename makes a new file, which would take the process's own group", () => withProfile("model: safe\n", async (root, path) => {
  chownSync(path, process.getuid!(), GROUP!);
  expect(statSync(path).gid).toBe(GROUP!);
  expect(GROUP).not.toBe(process.getgid?.());
  await installHermes({ profiles: ["default"], root, dryRun: false, uninstall: false });
  expect(readFileSync(path, "utf8")).toContain("walkie-hermes:on_session_start");
  expect(statSync(path).gid).toBe(GROUP!); // not the process's group
  expect(statSync(path).uid).toBe(process.getuid!());
  await installHermes({ profiles: ["default"], root, dryRun: false, uninstall: true }); // and the same through an uninstall
  expect(read(root, "config.yaml")).toBe("model: safe\n");
  expect(statSync(path).gid).toBe(GROUP!);
  expect(strays(root)).toEqual([]);
}));

test("a hard-linked config is written in place, so its other name sees the change too: a rename would cut that name off", () => withProfile("model: safe\n", async (root, path) => {
  const twin = join(root, "twin.yaml");
  linkSync(path, twin);
  const inode = statSync(path).ino;
  await install(root, io());
  const installed = read(root, "config.yaml");
  expect(installed).toContain("walkie-hermes:on_session_start");
  expect(read(root, "twin.yaml")).toBe(installed); // the other name has the hooks
  expect(statSync(path).ino).toBe(inode); // the same file
  expect(statSync(path).nlink).toBe(2);
  expect(strays(root, "twin.yaml")).toEqual([]);
  expect(backups(root).map((f) => read(root, f))).toEqual(["model: safe\n"]); // the backup of a write that worked stays
  await install(root, io(), true); // an uninstall goes the same way
  expect(read(root, "twin.yaml")).toBe("model: safe\n");
  expect(statSync(path).nlink).toBe(2);
}));

test("a write in place that fails puts the old text back under both names, leaves no new backup, and names no path", () => withProfile("model: safe\n", async (root, path) => {
  const twin = join(root, "twin.yaml");
  linkSync(path, twin);
  const writeInPlace: HermesIo["writeInPlace"] = (target, body) => { writeFileSync(target, body.slice(0, 7)); throw failing("EIO"); }; // the file is cut short, then it fails
  const error = await install(root, io({ writeInPlace })).then(() => null, (e: Error) => e);
  expect(error?.message).toBe("could not write the Hermes profile config (EIO); the file is as it was");
  expect(error?.message).not.toContain(root);
  expect(read(root, "config.yaml")).toBe("model: safe\n");
  expect(read(root, "twin.yaml")).toBe("model: safe\n");
  expect(statSync(path).nlink).toBe(2);
  expect(backups(root)).toEqual([]);
  expect(strays(root, "twin.yaml")).toEqual([]);
}));

test.skipIf(process.getuid?.() === 0)("when putting the old text back fails too, the backup stays and the error says so, still without a path", () => withProfile("model: safe\n", async (root, path) => {
  linkSync(path, join(root, "twin.yaml"));
  const writeInPlace: HermesIo["writeInPlace"] = (target) => { chmodSync(target, 0o444); throw failing("EIO"); }; // the file is now read-only: restoring it fails
  try {
    const error = await install(root, io({ writeInPlace })).then(() => null, (e: Error) => e);
    expect(error?.message).toBe("could not write the Hermes profile config (EIO); restoring it failed too (EACCES); its old content is in the .bak-walkie copy beside it");
    expect(error?.message).not.toContain(root);
    expect(backups(root).map((f) => read(root, f))).toEqual(["model: safe\n"]); // the old content is where the error says
  } finally { chmodSync(path, 0o600); }
}));

test("an uninstall that fails leaves the installed hooks in place, and the next one removes them", () => withProfile("model: safe\n", async (root, path) => {
  await installHermes({ profiles: ["default"], root, dryRun: false, uninstall: false });
  const installed = readFileSync(path, "utf8");
  expect(installed).toContain("walkie-hermes:on_session_start");
  await expect(install(root, io({ rename: () => { throw failing("EIO"); } }), true)).rejects.toThrow("(EIO)");
  expect(readFileSync(path, "utf8")).toBe(installed);
  expect(strays(root)).toEqual([]);
  await installHermes({ profiles: ["default"], root, dryRun: false, uninstall: true });
  expect(readFileSync(path, "utf8")).toBe("model: safe\n");
}));

test.skipIf(process.getuid?.() === 0)("a read-only config is refused before anything is made: no temp file, no backup, the file as it was", () => withProfile("model: safe\n", async (root, path) => {
  chmodSync(path, 0o444);
  try {
    await expect(installHermes({ profiles: ["default"], root, dryRun: false, uninstall: false })).rejects.toThrow("Hermes profile config is not writable; no changes made");
    expect(readFileSync(path, "utf8")).toBe("model: safe\n");
    expect(statSync(path).mode & 0o777).toBe(0o444);
    expect(readdirSync(root)).toEqual(["config.yaml"]);
  } finally { chmodSync(path, 0o600); }
}));

test("a config that vanished between the plan and the write is written new, private, with nothing to back up", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-vanished-"));
  try {
    const path = join(root, "config.yaml");
    writeHermesConfig(path, "model: fresh\n");
    expect(readFileSync(path, "utf8")).toBe("model: fresh\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(["config.yaml"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
