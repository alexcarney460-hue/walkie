// Upgrading an existing Claude hook install to this version's events (WALKIE-MISSION-SUB-1; Opus mission-sub r1 #1-4).
// The daemon does this at start after an upgrade, so it must never damage a person's settings.json:
//   - additive only: it adds Walkie's hook for the events this version introduced (SUBAGENT_EVENTS) that have no
//     Walkie hook yet, as new entries. It never modifies or removes an existing entry (a person's timeout, matcher,
//     an entry shared with their own hooks, an event they removed on purpose all stay). An event it added once is
//     never added again (recorded in <walkie home>/hooks-refresh.json), so removing it afterwards sticks.
//   - the real file: a symlinked settings.json (dotfiles) is resolved first; the new file is written next to the
//     target, with its mode and owner, and renamed over the TARGET, so the link stays a link.
//   - only when writable (file and its directory); a read-only file is left alone and `walkie doctor` says so.
//   - hard-linked files are left alone (a rename would cut the other links).
//   - a narrow lost-update window: the backup is taken, then the target is read again right before the rename; if it
//     changed, the refresh starts over once, then gives up. A write between that re-check and the rename can still
//     be lost (Claude Code takes no lock to coordinate with); after the rename the file is read again and only events
//     actually there are recorded as added.
//   - the file's indentation and final newline are kept; a malformed value (an event that isn't a list, `hooks` that
//     isn't an object) is never replaced.
// `walkie hooks install claude` (a person asking for it) still rewrites Walkie's entries in full.
import { accessSync, chmodSync, chownSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CLAUDE_EVENTS, detectIndent, installedClaudeCommand, isOurHook, ourEntry, type HookEntry, type Settings } from "./install.ts";

export { detectIndent }; // the settings writer (install.ts) keeps a file's indentation the same way

/** The events this version introduced: the only ones a refresh adds. */
export const SUBAGENT_EVENTS: readonly { event: string; matcher?: string }[] = CLAUDE_EVENTS.filter((e) => ["PreToolUse", "SubagentStart", "SubagentStop"].includes(e.event));

const MARKER = "hooks-refresh.json";

export interface HooksReport {
  /** The command Walkie's hooks run (null: Walkie's hooks are not installed). */
  command: string | null;
  /** This version's events without a Walkie hook. */
  missing: string[];
  /** Events whose Walkie hook shares an entry with the person's own hooks. */
  mixed: string[];
  /** Events whose Walkie entry has another matcher or timeout than Walkie installs. */
  customised: string[];
  /** Events whose value isn't a list of entries (left alone). "hooks" when `hooks` itself isn't an object. */
  malformed: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Pure: what is installed, what is missing, what a person changed. */
export function inspectClaudeHooks(settings: Settings): HooksReport {
  const missing: string[] = [];
  const mixed = new Set<string>();
  const customised = new Set<string>();
  const malformed: string[] = [];
  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
    return { command: null, missing: [], mixed: [], customised: [], malformed: ["hooks"] };
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  for (const { event, matcher } of CLAUDE_EVENTS) {
    const value = hooks[event];
    if (value !== undefined && !Array.isArray(value)) { malformed.push(event); continue; }
    const entries = ((value ?? []) as unknown[]).filter((e): e is HookEntry => isPlainObject(e) && Array.isArray(e.hooks));
    const ours = entries.filter((e) => (e.hooks ?? []).some(isOurHook));
    if (!ours.length) { missing.push(event); continue; }
    for (const e of ours) {
      if ((e.hooks ?? []).some((h) => !isOurHook(h))) mixed.add(event);
      const h = (e.hooks ?? []).find(isOurHook);
      if ((e.matcher ?? undefined) !== matcher || h?.timeout !== 5) customised.add(event);
    }
  }
  return { command: installedClaudeCommand(settings), missing, mixed: [...mixed], customised: [...customised], malformed };
}

/** Pure: the refresh. New entries for SUBAGENT_EVENTS with no Walkie hook and not added before; nothing else changes. */
export function withNewClaudeEvents(settings: Settings, cmd: string, addedBefore: ReadonlySet<string>): { settings: Settings; added: string[] } {
  const report = inspectClaudeHooks(settings);
  // A malformed value is never replaced (Opus mission-sub r2): only missing events whose value is absent or a list.
  const add = SUBAGENT_EVENTS.filter((e) => report.missing.includes(e.event) && !addedBefore.has(e.event) && !report.malformed.includes(e.event));
  if (!add.length || report.malformed.includes("hooks")) return { settings, added: [] };
  const hooks = { ...(settings.hooks ?? {}) };
  for (const { event, matcher } of add) hooks[event] = [...(hooks[event] ?? []), ourEntry(cmd, matcher)];
  return { settings: { ...settings, hooks }, added: add.map((e) => e.event) };
}

function readMarker(home: string): Set<string> {
  try {
    const v = JSON.parse(readFileSync(join(home, MARKER), "utf8")) as { claude?: { added?: unknown } };
    return new Set(Array.isArray(v.claude?.added) ? v.claude.added.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeMarker(home: string, added: ReadonlySet<string>, now: number): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, MARKER), JSON.stringify({ claude: { added: [...added].sort(), at: now } }) + "\n", { mode: 0o600 });
}

/** The file and its directory are writable by this process (a rename needs the directory). */
function writable(target: string): boolean {
  try {
    accessSync(target, constants.W_OK);
    accessSync(dirname(target), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export type RefreshStatus = "written" | "current" | "not-installed" | "no-settings" | "read-only" | "hard-linked" | "changed-underneath";

export interface RefreshResult { status: RefreshStatus; added: string[]; detail?: string }

export interface RefreshOptions {
  settingsPath?: string;
  /** Walkie's home (the marker file); default ~/.walkie. */
  home?: string;
  now?: number;
  /** Tests: runs right before the target is read again (a concurrent writer). */
  beforeRecheck?: () => void;
  /** Tests: runs between the re-check and the rename (the window no check can close without a lock). */
  beforeRename?: () => void;
  /** Tests: runs right after the rename (a writer that saves its stale copy over ours). */
  afterRename?: () => void;
  /** Tests: the marker write. */
  writeMarker?: (home: string, added: ReadonlySet<string>, now: number) => void;
}

/** One refresh of settings.json; never throws for the cases above (a malformed file throws: the caller logs it). */
export function refreshClaudeHooks(opts: RefreshOptions = {}): RefreshResult {
  const path = opts.settingsPath ?? join(homedir(), ".claude", "settings.json");
  const home = opts.home ?? join(homedir(), ".walkie");
  const now = opts.now ?? Date.now();
  if (!existsSync(path)) return { status: "no-settings", added: [] };
  const target = realpathSync(path); // a symlink's real file: the link itself is never replaced
  for (let attempt = 0; attempt < 2; attempt++) {
    const st = statSync(target);
    // A hard-linked file: a rename would cut the other links off (Opus mission-sub r2). Left alone; doctor says so.
    if (st.nlink > 1) return { status: "hard-linked", added: [], detail: `${target} has ${st.nlink} hard links` };
    const text = readFileSync(target, "utf8");
    const current = JSON.parse(text) as Settings;
    const cmd = installedClaudeCommand(current);
    if (cmd === null) return { status: "not-installed", added: [] };
    const before = readMarker(home);
    const { settings: next, added } = withNewClaudeEvents(current, cmd, before);
    if (!added.length) return { status: "current", added: [] };
    if (!writable(target)) return { status: "read-only", added: [], detail: `${target} is not writable` };
    const tmp = join(dirname(target), `.${basename(target)}.walkie-${process.pid}-${now}.tmp`);
    try {
      const body = JSON.stringify(next, null, detectIndent(text)) + (text.endsWith("\n") ? "\n" : "");
      writeFileSync(tmp, body, { mode: st.mode & 0o777, flag: "wx" });
      chmodSync(tmp, st.mode & 0o7777); // the umask narrowed the create mode: the original, exactly
      if (st.uid !== process.getuid?.() || st.gid !== process.getgid?.()) chownSync(tmp, st.uid, st.gid);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* not created */ }
      return { status: "read-only", added: [], detail: `cannot keep the file's mode / owner: ${(err as Error).message}` };
    }
    // The backup first, then the re-check (Codex mission-sub r2 #4): what is backed up is what was checked. A write
    // between the re-check and the rename can still be lost; no check closes that window without a lock Claude Code
    // doesn't take. The re-read after the rename below at least never records events that didn't land.
    const backup = `${path}.bak-walkie-${now}`;
    try {
      copyFileSync(target, backup);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* not there */ }
      return { status: "read-only", added: [], detail: `cannot back it up: ${(err as Error).message}` };
    }
    opts.beforeRecheck?.();
    const st2 = statSync(target);
    const unchanged = st2.mtimeMs === st.mtimeMs && st2.size === st.size && st2.ino === st.ino && readFileSync(target, "utf8") === text;
    if (!unchanged) { unlinkSync(tmp); try { unlinkSync(backup); } catch { /* gone */ } continue; } // written meanwhile: read it again
    try {
      opts.beforeRename?.();
      renameSync(tmp, target);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* renamed already */ }
      return { status: "read-only", added: [], detail: `cannot replace it: ${(err as Error).message}` };
    }
    // Recorded only what is there now (Opus mission-sub r2): a writer that won the race erased our events, so they
    // weren't "added" and a later start may add them.
    opts.afterRename?.();
    let landed: string[] = [];
    try {
      const missingNow = inspectClaudeHooks(JSON.parse(readFileSync(target, "utf8")) as Settings).missing;
      landed = added.filter((e) => !missingNow.includes(e));
    } catch { /* unreadable now: nothing recorded */ }
    if (!landed.length) return { status: "changed-underneath", added: [], detail: "settings.json was rewritten while Walkie was updating it; left as it is" };
    try {
      (opts.writeMarker ?? writeMarker)(home, new Set([...before, ...landed]), now);
    } catch (err) {
      // The settings are updated; only the "added once" record is missing (a person's later removal may be undone).
      return { status: "written", added: landed, detail: `marker not saved: ${(err as Error).message}` };
    }
    return { status: "written", added: landed };
  }
  return { status: "changed-underneath", added: [], detail: "settings.json changed while Walkie was updating it; left as it is" };
}

export interface HooksCheck { level: "ok" | "warn"; detail: string }

/** `walkie doctor`: the Claude hooks' state, what a person changed, and whether an upgrade could update them. */
export function claudeHooksDoctor(opts: { settingsPath?: string; home?: string } = {}): HooksCheck[] {
  const path = opts.settingsPath ?? join(homedir(), ".claude", "settings.json");
  if (!existsSync(path)) return [{ level: "ok", detail: "not installed (walkie hooks install claude)" }];
  const target = realpathSync(path);
  const report = inspectClaudeHooks(JSON.parse(readFileSync(target, "utf8")) as Settings);
  if (report.malformed.includes("hooks")) return [{ level: "warn", detail: `"hooks" in ${target} is not an object: left alone` }];
  if (report.command === null) return [{ level: "ok", detail: "not installed (walkie hooks install claude)" }];
  const out: HooksCheck[] = [];
  if (report.malformed.length) out.push({ level: "warn", detail: `not a list of entries (${report.malformed.join(", ")}): left alone; fix them in ${target}` });
  const links = statSync(target).nlink;
  const before = readMarker(opts.home ?? join(homedir(), ".walkie"));
  const subMissing = report.missing.filter((e) => SUBAGENT_EVENTS.some((s) => s.event === e));
  const removed = subMissing.filter((e) => before.has(e));
  const pending = subMissing.filter((e) => !before.has(e));
  const otherMissing = report.missing.filter((e) => !subMissing.includes(e));
  if (!report.missing.length) out.push({ level: "ok", detail: "installed, current (sub-agents included)" });
  if (pending.length) {
    out.push({ level: "warn", detail: `no sub-agent events yet (${pending.join(", ")}): restart the daemon or run walkie hooks install claude, then restart Claude Code sessions` });
    if (!writable(target)) out.push({ level: "warn", detail: `${target} is not writable: the daemon can't add them` });
    if (links > 1) out.push({ level: "warn", detail: `${target} has ${links} hard links: the daemon leaves it alone; walkie hooks install claude adds them` });
  }
  if (removed.length) out.push({ level: "warn", detail: `removed after Walkie added them (${removed.join(", ")}): sub-agents don't show; walkie hooks install claude adds them back` });
  if (otherMissing.length) out.push({ level: "warn", detail: `events without Walkie's hook (${otherMissing.join(", ")}): walkie hooks install claude restores them` });
  if (report.mixed.length) out.push({ level: "warn", detail: `Walkie's hook shares an entry with your own hooks (${report.mixed.join(", ")}): left as is` });
  if (report.customised.length) out.push({ level: "ok", detail: `your changes to Walkie's entries kept (${report.customised.join(", ")}: matcher or timeout)` });
  return out;
}
