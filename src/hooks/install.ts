// `walkie hooks install|uninstall claude|codex [--dry-run]`
// Idempotent: our entries are recognised by the "walkie-managed" marker in the
// command string, so re-running replaces them and never duplicates.
// `walkie hooks install claude` needs the claude CLI only to register the MCP server: without it the hooks are still
// written and the MCP step is left for when Claude Code is installed (a machine with only Grok has none).
import { accessSync, chmodSync, chownSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

export interface InstallResult {
  changed: string[];
  /** The commands that ran (in a dry run: would run). */
  commands: string[];
  /** A step that was skipped, with the command that does it later. */
  note?: string;
}

/** Where Claude Code reads its settings, and Grok too (its Claude-compatibility scan, compat.claude.hooks). */
export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * The Claude settings file as an object ({} when there is none). A file that is not a JSON object, or whose hooks are
 * not an object of lists of entries, is refused here, before anything is written.
 */
export function readClaudeSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error(`${path} is not valid JSON; no changes made`); }
  if (!isRecord(value)) throw new Error(`${path} is not a JSON object; no changes made`);
  const hooks = value.hooks;
  if (hooks !== undefined && (!isRecord(hooks) || Object.values(hooks).some((entries) =>
    !Array.isArray(entries) || entries.some((e) => !isRecord(e) || (e.hooks !== undefined && (!Array.isArray(e.hooks) || e.hooks.some((h) => !isRecord(h)))))))) {
    throw new Error(`"hooks" in ${path} is not an object of lists of hook entries; no changes made`);
  }
  return value as Settings;
}

/** The file's indentation (two / four spaces, a tab), so a write changes only what it adds. */
export function detectIndent(text: string): string | number {
  const m = /^[{[][ \t]*\r?\n([ \t]+)\S/.exec(text);
  if (!m?.[1]) return 2;
  return m[1].startsWith("\t") ? "\t" : m[1].length;
}

/** What the one write of a settings or config file asks of the file system, injectable so a failure at each step can be tested. */
export interface SettingsIo {
  /** Creates `path`, which must not exist yet, private to its owner (0600), holding `body`: the staging file. Default: an exclusive create. */
  write?(path: string, body: string): void;
  /** Replaces `to` with `from`, which sits in the same directory: atomic. */
  rename(from: string, to: string): void;
  /** Writes `body` into the existing file `path` itself, keeping its inode: only for a file that has other hard links. */
  writeInPlace(path: string, body: string): void;
}
const realSettingsIo: Required<SettingsIo> = {
  write: (path, body) => writeFileSync(path, body, { mode: 0o600, flag: "wx" }),
  rename: renameSync,
  writeInPlace: (path, body) => writeFileSync(path, body),
};

/** How the replacement of a file words its errors: the Claude settings writer names the file and the cause, the Hermes one names neither. */
export interface ErrorWords {
  /** A read-only file, refused before anything is made. */
  readonly notWritable: string;
  /** What an error says of its cause ("" says nothing). */
  cause(error: unknown): string;
  /** The whole error text, from that cause and what became of the file. */
  failed(cause: string, outcome: string): string;
}

/** Whether the file's content already is `settings`, as data (key order, indentation and a missing final newline do not count). */
function holdsExactly(text: string, settings: Settings): boolean {
  try { return Bun.deepEquals(JSON.parse(text) as unknown, settings); } catch { return false; }
}

/**
 * The one way Walkie rewrites a person's settings or config file (`walkie hooks install|uninstall`): `produce` makes the new text from
 * the file's current text (null when there is no file), or null for "nothing to change", which touches nothing. Atomic: the new text is
 * written whole beside the file under a staging name, private (0600) while it is written, then given the file's own mode and its
 * owner and group (where they differ from this process's: a group of the person's, or the owner when permitted), and renamed over it
 * in the same directory, so a reader never sees half a file and a failure leaves the old one whole. A symlinked file (dotfiles) has its
 * real file replaced and stays a link; a file with other hard links is written in place instead (a rename would cut the others off).
 * A read-only file is refused before anything is made; otherwise the old one is kept first as `.bak-walkie-<ms>`, and that backup is
 * removed again if the write then fails, so a failed install leaves nothing stray. `path` is the name the file is known by, the one the
 * backup sits beside.
 */
export function replaceFileText(path: string, produce: (current: string | null) => string | null, words: ErrorWords, io: SettingsIo = realSettingsIo): void {
  const { write, rename, writeInPlace } = { ...realSettingsIo, ...io };
  const target = existsSync(path) ? realpathSync(path) : path;
  const old = existsSync(target) ? statSync(target) : null;
  const text = old ? readFileSync(target, "utf8") : null;
  const body = produce(text);
  if (body === null) return;
  // A file its person made read-only stays as it is: a rename would replace it whatever its mode, so the check comes first, and
  // before any backup (the old writer made one per attempt and then failed with a bare EACCES).
  if (old) { try { accessSync(target, constants.W_OK); } catch { throw new Error(words.notWritable); } }
  const mode = old ? old.mode & 0o7777 : 0o600;
  const staged = join(dirname(target), `.${basename(target)}.walkie-${process.pid}-${Date.now()}.tmp`);
  let backup: string | null = null;
  try {
    if (text !== null) backup = makeBackup(target, path);
    if (old && old.nlink > 1) { writeInPlace(target, body); return; }
    write(staged, body);
    chmodSync(staged, mode); // created 0600: the file's own mode, exactly, before it takes the file's place
    if (old && (old.uid !== process.getuid?.() || old.gid !== process.getgid?.())) chownSync(staged, old.uid, old.gid);
    rename(staged, target);
  } catch (error) {
    rmSync(staged, { force: true });
    const restored = old && old.nlink > 1 && text !== null ? restoreInPlace(target, text, words) : null;
    if (backup && restored === null) rmSync(backup, { force: true });
    throw new Error(words.failed(words.cause(error), restored ?? (text === null ? "nothing was written" : "the file is as it was")));
  }
}

/**
 * The one write of the Claude settings file, used by `walkie hooks install claude|grok`: replaceFileText with the settings as JSON in
 * the file's own indentation and final-newline style. A file that already holds exactly these settings is not written and not backed up.
 */
export function writeClaudeSettings(path: string, settings: Settings, io: SettingsIo = realSettingsIo): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  replaceFileText(path, (text) => text !== null && holdsExactly(text, settings) ? null
    : JSON.stringify(settings, null, text === null ? 2 : detectIndent(text)) + (text === null || text.endsWith("\n") ? "\n" : ""), {
    notWritable: `${path} is not writable; no changes made`,
    cause: (error) => (error as Error).message,
    failed: (cause, outcome) => `could not write ${path}: ${cause}; ${outcome}`,
  }, io);
}

/** Copies `from` to a backup beside `path` that does not exist yet: `<path>.bak-walkie-<ms>`, with a counter when two land in one millisecond. Returns where. */
export function makeBackup(from: string, path: string): string {
  const stem = `${path}.bak-walkie-${Date.now()}`;
  for (let n = 0; ; n++) {
    const name = n === 0 ? stem : `${stem}-${n}`;
    try { copyFileSync(from, name, constants.COPYFILE_EXCL); return name; }
    catch (error) {
      const taken = (error as NodeJS.ErrnoException).code === "EEXIST";
      if (taken && n < 99) continue;
      if (!taken) rmSync(name, { force: true }); // a copy that failed part-way leaves its own partial file, never someone else's
      throw error;
    }
  }
}

/** Puts a hard-linked file's old content back after a failed in-place write. Null: done. Otherwise what went wrong, and where the old content is. */
function restoreInPlace(target: string, text: string, words: ErrorWords): string | null {
  try { writeFileSync(target, text); return null; }
  catch (error) {
    const cause = words.cause(error);
    return `restoring it failed too${cause ? ` (${cause})` : ""}; its old content is in the .bak-walkie copy beside it`;
  }
}

async function run(argv: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { ok: code === 0, out: (out + err).trim() };
  } catch (e) {
    return { ok: false, out: String(e) };
  }
}

export async function installClaude(opts: { dryRun: boolean; uninstall: boolean; settingsPath?: string; claudeFound?: boolean }): Promise<InstallResult> {
  const path = opts.settingsPath ?? claudeSettingsPath();
  const cmd = walkieCommand();
  const next = withClaudeHooks(readClaudeSettings(path), cmd, !opts.uninstall);
  const mcp = opts.uninstall ? "claude mcp remove --scope user walkie" : `claude mcp add --scope user walkie -- ${cmd} mcp`;
  // The MCP step needs the claude CLI; the hooks do not. Without the CLI they are still written, and the step is left
  // for when Claude Code is installed.
  const found = opts.claudeFound ?? Bun.which("claude") !== null;
  const commands = found ? [mcp] : [];
  const skipped = found ? {} : { note: mcpSkippedNote(opts.uninstall, mcp) };
  if (opts.dryRun) return { changed: [`${path} (would write)`], commands, ...skipped };
  writeClaudeSettings(path, next);
  if (found) {
    if (opts.uninstall) {
      await run(["claude", "mcp", "remove", "--scope", "user", "walkie"]);
    } else {
      await run(["claude", "mcp", "remove", "--scope", "user", "walkie"]); // replace any stale path
      const r = await run(["claude", "mcp", "add", "--scope", "user", "walkie", "--", ...walkieArgv(), "mcp"]);
      if (!r.ok) throw new Error(`claude mcp add failed: ${r.out}`);
    }
  }
  return { changed: [path], commands, ...skipped };
}

function mcpSkippedNote(uninstall: boolean, mcp: string): string {
  return uninstall
    ? `claude is not on PATH, so the MCP step is skipped. If Claude Code lists Walkie as an MCP server, remove it with: ${mcp}`
    : `claude is not on PATH, so the MCP step is skipped. Once Claude Code is installed, run: ${mcp}`;
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
