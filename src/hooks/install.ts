// `walkie hooks install|uninstall claude|codex [--dry-run]`
// Idempotent: our entries are recognised by the "walkie-managed" marker in the
// command string, so re-running replaces them and never duplicates.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const MARK = "# walkie-managed";
/**
 * The Claude Code events Walkie's hook handles. PreToolUse only for Agent / Task (a sub-agent's description at its
 * launch) and SubagentStart / SubagentStop (WALKIE-MISSION-SUB-1): each sub-agent is a row of its own. A matcher made
 * only of [A-Za-z0-9_|, -] is an exact list of tool names in Claude Code 2.1.283 (not a regex), so "Agent|Task" is
 * already anchored; "^(Agent|Task)$" would take the regex path instead and lose its tool-alias expansion.
 */
export const CLAUDE_EVENTS: readonly { event: string; matcher?: string }[] = [
  { event: "SessionStart" }, { event: "UserPromptSubmit" }, { event: "PreToolUse", matcher: "Agent|Task" },
  { event: "PostToolUse", matcher: "*" }, { event: "Notification" }, { event: "Stop" }, { event: "SessionEnd" },
  { event: "SubagentStart" }, { event: "SubagentStop" },
];

/** Whether this is a compiled walkie (an install), not bun running the sources (dev, tests). */
export function isCompiledWalkie(): boolean {
  return import.meta.dir.startsWith("/$bunfs") || basename(process.execPath).startsWith("walkie");
}

/** argv prefix that runs this walkie: the compiled binary, or bun + main.ts in dev. */
export function walkieArgv(): string[] {
  return isCompiledWalkie() ? [process.execPath] : [process.execPath, resolve(import.meta.dir, "../cli/main.ts")];
}

export function walkieCommand(): string {
  return walkieArgv().map((a) => JSON.stringify(a)).join(" ");
}

export type HookEntry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };
export type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

/** A hook command Walkie installed. */
export function isOurHook(h: { command?: unknown }): boolean {
  return typeof h.command === "string" && h.command.includes(MARK);
}

/** The entry Walkie installs for one event. */
export function ourEntry(cmd: string, matcher: string | undefined): HookEntry {
  return { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: `${cmd} hook claude ${MARK}`, timeout: 5 }] };
}

/**
 * Pure: settings with our hooks removed, then (if install) re-added. Only our hooks go: a person's hook that shares an
 * entry with one of ours stays in that entry (Opus mission-sub r1 #3).
 */
export function withClaudeHooks(settings: Settings, cmd: string, install: boolean): Settings {
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    const kept = entries.flatMap((e) => {
      const theirs = (e.hooks ?? []).filter((h) => !isOurHook(h));
      if (theirs.length === (e.hooks ?? []).length) return [e];
      return theirs.length ? [{ ...e, hooks: theirs }] : [];
    });
    if (kept.length) hooks[event] = kept;
  }
  if (install) {
    for (const { event, matcher } of CLAUDE_EVENTS) hooks[event] = [...(hooks[event] ?? []), ourEntry(cmd, matcher)];
  }
  const { hooks: _drop, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

/** The walkie command our installed entries run (null: none installed). */
export function installedClaudeCommand(settings: Settings): string | null {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return null;
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue; // malformed: not ours to read
    for (const e of entries) {
      const h = Array.isArray(e?.hooks) ? e.hooks.find(isOurHook) : undefined;
      if (h) return h.command.replace(/\s+hook claude\s+# walkie-managed\s*$/, "");
    }
  }
  return null;
}

export interface InstallResult { changed: string[]; commands: string[] }

async function run(argv: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { ok: code === 0, out: (out + err).trim() };
  } catch (e) {
    return { ok: false, out: String(e) };
  }
}

export async function installClaude(opts: { dryRun: boolean; uninstall: boolean; settingsPath?: string }): Promise<InstallResult> {
  const path = opts.settingsPath ?? join(homedir(), ".claude", "settings.json");
  const cmd = walkieCommand();
  const current: Settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const next = withClaudeHooks(current, cmd, !opts.uninstall);
  const commands = opts.uninstall
    ? ["claude mcp remove --scope user walkie"]
    : [`claude mcp add --scope user walkie -- ${cmd} mcp`];
  if (opts.dryRun) return { changed: [`${path} (would write)`], commands };
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak-walkie-${Date.now()}`);
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  if (opts.uninstall) {
    await run(["claude", "mcp", "remove", "--scope", "user", "walkie"]);
  } else {
    await run(["claude", "mcp", "remove", "--scope", "user", "walkie"]); // replace any stale path
    const r = await run(["claude", "mcp", "add", "--scope", "user", "walkie", "--", ...walkieArgv(), "mcp"]);
    if (!r.ok) throw new Error(`claude mcp add failed: ${r.out}`);
  }
  return { changed: [path], commands };
}

const CODEX_BEGIN = "# >>> walkie (walkie-managed) >>>";
const CODEX_END = "# <<< walkie (walkie-managed) <<<";

/** Pure: config.toml with our block removed, then (if install) re-added. */
export function withCodexBlock(toml: string, bin: string[], install: boolean): { toml: string; notifySkipped: boolean } {
  const stripped = toml
    .replace(new RegExp(`${escape(CODEX_BEGIN)}[\\s\\S]*?${escape(CODEX_END)}\\n?`, "g"), "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
  if (!install) return { toml: stripped.trimEnd() + "\n", notifySkipped: false };
  const hasNotify = /^\s*notify\s*=/m.test(stripped);
  const args = [...bin.slice(1), "mcp"].map((a) => JSON.stringify(a)).join(", ");
  const notify = [...bin, "hook", "codex"].map((a) => JSON.stringify(a)).join(", ");
  // notify must be a top-level key, so it goes BEFORE the first table; the MCP table goes at the end.
  const top = hasNotify ? "" : `${CODEX_BEGIN}\nnotify = [${notify}]\n${CODEX_END}\n`;
  const table = `${CODEX_BEGIN}\n[mcp_servers.walkie]\ncommand = ${JSON.stringify(bin[0])}\nargs = [${args}]\n${CODEX_END}\n`;
  return { toml: `${top}${stripped.trimEnd()}\n\n${table}`, notifySkipped: hasNotify };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function installCodex(opts: { dryRun: boolean; uninstall: boolean; configPath?: string }): Promise<InstallResult & { notifySkipped: boolean }> {
  const path = opts.configPath ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
  const bin = walkieArgv();
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const { toml, notifySkipped } = withCodexBlock(current, bin, !opts.uninstall);
  if (!opts.dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) copyFileSync(path, `${path}.bak-walkie-${Date.now()}`);
    writeFileSync(path, toml);
  }
  return { changed: [opts.dryRun ? `${path} (would write)` : path], commands: [], notifySkipped };
}
