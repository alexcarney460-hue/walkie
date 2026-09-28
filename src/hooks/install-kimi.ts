// Verified against the installed Kimi Code schema; evidence in docs/plans/AGENT-SEE-1.md.
// Preserve the original TOML byte-for-byte, adding only a managed array-of-tables block.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readSmallFile } from "../agent/safe-read.ts";
import { walkieArgv, type InstallResult } from "./install.ts";

const BEGIN = "# >>> walkie-kimi (walkie-managed) >>>";
const END = "# <<< walkie-kimi (walkie-managed) <<<";
export const KIMI_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "Interrupt", "SessionEnd"] as const;
const marker = /\n# >>> walkie-kimi \(walkie-managed\) >>>\n[\s\S]*?# <<< walkie-kimi \(walkie-managed\) <<<\n/g;

function parse(text: string): Record<string, unknown> {
  try { return Bun.TOML.parse(text) as Record<string, unknown>; } catch { throw new Error("Kimi config is not valid TOML; no changes made"); }
}

export function withKimiHooks(toml: string, command: string, install: boolean): string {
  const original = parse(toml);
  const stripped = toml.replace(marker, "");
  const base = parse(stripped);
  const originalHooks = original.hooks;
  if (originalHooks !== undefined && !Array.isArray(originalHooks)) throw new Error("Kimi hooks must be an array");
  const kept = (originalHooks as { command?: unknown }[] | undefined)?.filter((h) =>
    !(typeof h?.command === "string" && h.command.endsWith(" hook kimi # walkie-managed")));
  const expected = { ...original, ...(kept?.length ? { hooks: kept } : {}) };
  if (!kept?.length) delete expected.hooks;
  if (!isDeepStrictEqual(base, expected)) throw new Error("Kimi managed hook block is ambiguous; no changes made");
  if (!install) return stripped;
  // Inline arrays cannot be extended with [[hooks]]. Refuse safely rather than rewrite a user's config.
  if (base.hooks !== undefined && !/^\s*\[\[hooks\]\]\s*$/m.test(stripped)) {
    throw new Error("Kimi hooks use an inline array; convert it to [[hooks]] tables before installing");
  }
  const hooks = KIMI_EVENTS.map((event) => ({ event, command: `${command} hook kimi # walkie-managed`, timeout: 5 }));
  const block = hooks.map((h) => `[[hooks]]\nevent = ${JSON.stringify(h.event)}\ncommand = ${JSON.stringify(h.command)}\ntimeout = 5\n`).join("\n");
  const next = `${stripped}\n${BEGIN}\n${block}${END}\n`;
  if (!isDeepStrictEqual(parse(next), { ...base, hooks: [...(base.hooks as unknown[] ?? []), ...hooks] })) {
    throw new Error("Kimi hook edit would change unrelated settings; no changes made");
  }
  return next;
}

export async function installKimi(opts: { dryRun: boolean; uninstall: boolean; configPath?: string }): Promise<InstallResult> {
  const path = opts.configPath ?? join(process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code"), "config.toml");
  const current = existsSync(path) ? readSmallFile(path, 1024 * 1024) : "";
  if (current === null) throw new Error("Kimi config is not a readable regular file under 1 MiB");
  // A shell command: single quotes protect literal $, backticks and spaces in binary paths.
  const command = walkieArgv().map((s) => "'" + s.replaceAll("'", "'\\''") + "'").join(" ");
  const next = withKimiHooks(current, command, !opts.uninstall);
  if (!opts.dryRun && current !== next) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) copyFileSync(path, `${path}.bak-walkie-${Date.now()}`);
    writeFileSync(path, next, { mode: 0o600 });
  }
  return { changed: [opts.dryRun ? `${path} (would write)` : path], commands: [] };
}
