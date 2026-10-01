// `walkie hooks install grok` writes two files, so a machine with only Grok gets the whole lifecycle:
//  - ~/.grok/hooks/walkie.json: the events the Claude-compatible path does not deliver (grok-events.ts).
//  - ~/.claude/settings.json: Walkie's shared Claude-compatible hooks, which Grok scans by default (compat.claude.hooks)
//    and which deliver the rest. They are written with the pure hooks writer only (install.ts): never `claude mcp add`
//    or `remove`, so no claude CLI is needed. The file is created when absent; an old one is kept as .bak-walkie-<ms>.
// Both files are read and checked before either is written, and the Claude settings go first, so a failure in between
// leaves the shared hooks (every event but four) rather than the native file alone (a card that never goes idle).
// Uninstall removes the Grok file's hooks only. The Claude hooks are Claude Code's too and stay, so Grok keeps
// reporting through them until `walkie hooks uninstall claude` or Grok's compat.claude.hooks is turned off.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { claudeSettingsPath, readClaudeSettings, walkieArgv, walkieCommand, withClaudeHooks, writeClaudeSettings, type HookEntry, type InstallResult, type Settings } from "./install.ts";
import { readSmallFile } from "../agent/safe-read.ts";
import { GROK_NATIVE_EVENTS } from "./grok-events.ts";

const MARK = " hook grok # walkie-managed";

function isOurs(h: { command?: unknown }): boolean {
  return typeof h.command === "string" && h.command.endsWith(MARK);
}

export function grokCommand(argv: readonly string[] = walkieArgv()): string {
  return argv.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
}

export function withGrokHooks(settings: Settings, command: string, install: boolean): Settings {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Grok hook file must be a JSON object");
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) throw new Error("Grok hooks must be an object");
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(entries)) throw new Error("Grok hook entries must be arrays");
    const kept = entries.flatMap((entry) => {
      if (!entry || !Array.isArray(entry.hooks)) throw new Error("Grok hook handlers must be arrays");
      if (entry.hooks.some((h) => !h || typeof h !== "object")) throw new Error("Grok hook handler must be an object");
      const handlers = entry.hooks.filter((h) => !isOurs(h));
      return handlers.length ? [{ ...entry, hooks: handlers }] : [];
    });
    if (kept.length) hooks[event] = kept;
  }
  if (install) for (const event of GROK_NATIVE_EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), {
      hooks: [{ type: "command", command: `${command}${MARK}`, timeout: 5 }],
    }];
  }
  const { hooks: _old, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

/** Where Grok reads Walkie's own hook file. */
export function grokHooksPath(): string {
  return join(homedir(), ".grok", "hooks", "walkie.json");
}

/**
 * The two files `install grok` writes. They are overridden together or not at all, so that pointing one at a temp
 * directory can never leave the other at the real home (a test that did that rewrote the real ~/.claude/settings.json).
 */
export interface GrokInstallPaths { readonly hooks: string; readonly claudeSettings: string }

export async function installGrok(opts: { dryRun: boolean; uninstall: boolean; paths?: GrokInstallPaths }): Promise<InstallResult> {
  const path = opts.paths?.hooks ?? grokHooksPath();
  const raw = existsSync(path) ? readSmallFile(path, 1024 * 1024) : "";
  if (raw === null) throw new Error("Grok hook file is not a readable regular file under 1 MiB");
  let current: Settings;
  try { current = raw ? JSON.parse(raw) as Settings : {}; } catch { throw new Error("Grok hook file is not valid JSON; no changes made"); }
  const next = withGrokHooks(current, grokCommand(), !opts.uninstall);
  // The shared Claude hooks Grok also runs. Read and checked now (a file that is not usable stops everything, before
  // any write), and only on install: uninstall does not so much as read that file.
  const shared = opts.uninstall ? null : sharedClaudeHooks(opts.paths?.claudeSettings ?? claudeSettingsPath());
  if (!opts.dryRun) {
    if (shared && shared.changed) writeClaudeSettings(shared.path, shared.next);
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path)) copyFileSync(path, `${path}.bak-walkie-${Date.now()}`);
      writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    }
  }
  const named = (file: string) => (opts.dryRun ? `${file} (would write)` : file);
  return { changed: [named(path), ...(shared ? [named(shared.path)] : [])], commands: [] };
}

/** The Claude settings with Walkie's hooks in them, and whether that differs from what the file holds now. */
function sharedClaudeHooks(path: string): { path: string; next: Settings; changed: boolean } {
  const current = readClaudeSettings(path);
  const next = withClaudeHooks(current, walkieCommand(), true);
  // Compared as data: a file that already holds the hooks keeps its own key order, indentation and backups as they are.
  return { path, next, changed: !Bun.deepEquals(current, next) };
}
