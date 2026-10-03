// Host tool allow-list for every seat on this machine (WALK-76 Phase 0). Local config only: it is not a field on
// the replicated seat run, so a pre.12 peer never has to understand it. Enforcement is per-launch flags or a refusal.
import { realpathSync, statSync } from "node:fs";
import { z } from "zod";
import { DEFAULT_SEAT_MODE, type SeatMode, type SeatRuntime } from "../../protocol/seats.ts";

/**
 * One tool spec as a runtime names it (`Read`, `Grep`). Commas are rejected because the flags below join the list
 * with commas into a single argv element (a variadic flag must not swallow the next flag). A space is rejected,
 * including inside a pattern such as `Bash(git commit:*)`, because Claude splits on spaces. A space-free pattern
 * such as `Bash(git:*)` can still match this character check. It is not a verified Grok `--tools` id, and a Grok
 * launch that names it is refused.
 */
const SEAT_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:/*()~+-]*$/;
const SEAT_TOOL_NAME_MSG = "a tool name must start with a letter and contain only letters, digits, and ._:/*()~+- (no spaces, commas, quotes, or a leading dash)";

const SeatToolSpec = z.string().transform((s) => s.trim()).pipe(z.string().min(1).max(200).regex(SEAT_TOOL_NAME, SEAT_TOOL_NAME_MSG));
const SeatToolList = z.array(SeatToolSpec).max(64).transform((names) => [...new Set(names)]);

/** One string per policy that means the same thing: list order and repeats do not matter (null: no policy). */
export function toolPolicyKey(tools: { allow?: readonly string[]; deny?: readonly string[] } | null | undefined): string {
  if (!tools) return "null";
  const norm = (xs: readonly string[] | undefined) => (xs === undefined ? null : [...new Set(xs)].sort());
  // An empty deny list denies nothing, the same as none; an empty allow list means no tools, unlike none.
  return JSON.stringify({ allow: norm(tools.allow), deny: tools.deny?.length ? norm(tools.deny) : null });
}

export const SeatToolPolicySchema = z.object({
  /** Tools the seat may use. An empty list means no tools. Absent with a deny list means no extra ceiling. */
  allow: SeatToolList.optional(),
  /** Tools the seat may not use, on top of the allow list when both are set. */
  deny: SeatToolList.optional(),
}).strict().superRefine((policy, ctx) => {
  const deny = policy.deny ?? [];
  if (policy.allow === undefined && deny.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "name an allow list, a deny list, or both (an empty allow list means no tools)" });
  }
  const allow = new Set(policy.allow ?? []);
  for (const name of policy.allow ?? []) {
    // Claude's `--tools=default` means every built-in tool. Reject it on the allow list only.
    if (name.toLowerCase() === "default") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "default is not a tool name: Claude's --tools=default means every tool" });
    }
  }
  for (const name of deny) {
    if (allow.has(name)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `a tool cannot be both allowed and denied: ${name}` });
  }
});
export type SeatToolPolicy = z.infer<typeof SeatToolPolicySchema>;

/** A stored policy that actually constrains a launch. `{}` and a deny list of nothing do not. */
export function seatToolPolicyActive(policy: SeatToolPolicy | undefined | null): boolean {
  if (!policy) return false;
  return policy.allow !== undefined || (policy.deny?.length ?? 0) > 0;
}

/**
 * Why this runtime cannot enforce the host policy, or null when it can (or when no policy is set).
 * Claude's ceiling is `--tools` (an allow list). `--allowedTools` only pre-approves; it does not remove tools,
 * so it is never the only flag. Grok's ceiling is `--tools` plus `--deny` (MCP meta-tools survive `--tools`).
 * An empty Grok `--tools` value allows every tool, and so does any `--tools` id grok 1.0.46 does not know, so a
 * Grok allow list that is empty or names anything outside {@link GROK_VERIFIED_TOOLS} is refused. `search_replace`
 * without `read_file` is refused too (that CLI exits 1). A Grok deny name that is not a deny rule, and that this
 * host cannot map to one, is refused rather than passed through. `mode` is the launch's permission mode. Callers
 * that are not launching (the doctor) omit it and are judged as acceptEdits, the seat default. The doctor also
 * flags a policy that default mode cannot enforce, including a list that is only `web_search`. Codex and Kimi
 * have no such flags in the argv this host builds.
 */

/** A name on one of this file's tables. `Object.hasOwn` skips Object.prototype (`constructor`, `toString`, …). */
function ownString(table: Readonly<Record<string, string>>, name: string): string | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}
const GROK_EMPTY_TOOLS = "this machine's tool allow-list leaves this Grok seat with no enforceable tool (an empty --tools value allows every tool, so the launch is refused): name Read, Grep or Glob, or clear it with walkie seats allow --clear-tool-policy";
const REASON_MAX = 280;

/** The versions whose tool ids were checked, as they appear in a refusal (`grok 1.0.46`). */
function grokVerifiedLabel(): string {
  return `grok ${GROK_VERIFIED_VERSIONS.join(", ")}`;
}

function grokSearchReplaceReason(): string {
  return `this Grok seat's allow list names search_replace without read_file: ${grokVerifiedLabel()} exits 1 because search_replace requires a Read tool, so the launch is refused`;
}

function withNames(prefix: string, names: readonly string[], suffix: string): string {
  const join = (shown: string) => `${prefix}${shown}${suffix}`;
  const full = join(names.join(", "));
  if (full.length <= REASON_MAX) return full;
  for (let n = names.length - 1; n >= 1; n--) {
    const msg = join(`${names.slice(0, n).join(", ")} +${names.length - n}`);
    if (msg.length <= REASON_MAX) return msg;
  }
  const marker = names.length > 1 ? ` +${names.length - 1}` : "";
  const room = REASON_MAX - prefix.length - suffix.length - marker.length;
  const cut = room > 0 ? (names[0] ?? "").slice(0, room) : "";
  const msg = join(`${cut}${marker}`);
  return msg.length <= REASON_MAX ? msg : msg.slice(0, REASON_MAX);
}

function grokUnsupportedAllow(names: readonly string[]): string {
  return withNames(
    "this Grok seat's allow list includes ",
    names,
    `, which ${grokVerifiedLabel()} does not narrow (an unknown --tools name allows every tool), so the launch is refused`,
  );
}

function grokUnsupportedDeny(names: readonly string[]): string {
  return withNames(
    "this Grok seat's deny list includes ",
    names,
    `, which this host cannot map to a ${grokVerifiedLabel()} deny rule (an unmapped --deny does not block that tool), so the launch is refused`,
  );
}

export function seatToolPolicyRefusal(runtime: SeatRuntime, policy: SeatToolPolicy | undefined, mode: SeatMode = DEFAULT_SEAT_MODE): string | null {
  if (!seatToolPolicyActive(policy)) return null;
  // seatToolPolicyActive already returned when there is no policy. Always return on grok so the
  // exhaustiveness check below stays `never` (a grok seat with no policy must not fall through).
  if (runtime === "grok") {
    if (policy?.allow !== undefined) {
      const why = grokAllowRefusal(mode, policy.allow);
      if (why) return why;
    }
    const unmapped = (policy?.deny ?? []).filter((name) => ownString(GROK_DENY_RULE, name) === undefined);
    if (unmapped.length) return grokUnsupportedDeny(unmapped);
    return null;
  }
  if (runtime === "claude") return null;
  if (runtime === "codex") {
    return "this machine's tool allow-list cannot be enforced for a Codex seat (Codex has no per-launch tool flags): use --runtime claude or --runtime grok, or clear the policy with walkie seats allow --clear-tool-policy";
  }
  if (runtime === "kimi") {
    return "this machine's tool allow-list cannot be enforced for a Kimi seat (Kimi's prompt mode has no tool flags): use --runtime claude or --runtime grok, or clear the policy with walkie seats allow --clear-tool-policy";
  }
  const _unenforceable: never = runtime;
  return _unenforceable;
}

/**
 * Claude flags for an active policy. Each list is one argv element so a variadic option cannot swallow the next flag.
 * `--tools` is the built-in ceiling (`--tools=` allows none). `--allowedTools` pre-approves that same ceiling.
 * `--disallowedTools` names the deny list. `--strict-mcp-config` with no `--mcp-config` stops settings from adding
 * MCP servers. Naming an MCP tool does not wire a server, so the seat cannot call it.
 */
export function claudeToolFlags(policy: SeatToolPolicy | undefined): string[] {
  if (!seatToolPolicyActive(policy) || !policy) return [];
  const flags: string[] = [];
  if (policy.allow !== undefined) {
    flags.push(`--tools=${policy.allow.join(",")}`);
    if (policy.allow.length) flags.push(`--allowedTools=${policy.allow.join(",")}`);
  }
  if (policy.deny?.length) flags.push(`--disallowedTools=${policy.deny.join(",")}`);
  flags.push("--strict-mcp-config");
  return flags;
}

const GROK_READ_ONLY = ["read_file", "grep", "list_dir"] as const;

/**
 * Grok `--tools` ids verified on the releases in {@link GROK_VERIFIED_VERSIONS} to narrow the tool set.
 * Any other id (`run_terminal_command`, `spawn_subagent`, `write`, `terminal`, an unknown name) is treated as
 * every tool, so Walkie never emits it. `search_replace` narrows only together with `read_file` (alone, grok
 * exits 1: "requires a Read tool"). `web_search` leaves the MCP meta-tools, which `--deny MCPTool` still names.
 */
export const GROK_VERIFIED_TOOLS = ["read_file", "grep", "list_dir", "search_replace", "web_search"] as const;
const GROK_VERIFIED = new Set<string>(GROK_VERIFIED_TOOLS);

/**
 * Grok releases whose tool ids above were checked live. Dated 2026-10-02.
 * `grok --version` on 1.0.46 prints `grok 1.0.46 (commit)` and may add a channel tag such as `[stable]`.
 * A tool policy is refused on any other version number: a later grok can treat an unknown id as every tool.
 */
export const GROK_VERIFIED_VERSIONS = ["1.0.46"] as const;

/** How long `grok --version` may run before a policy launch is refused. */
export const GROK_VERSION_TIMEOUT_MS = 3_000;

/** `grok --version` prints one short line. More than this much on stdout or stderr is not a version line. */
export const GROK_VERSION_MAX_OUTPUT_BYTES = 4_096;

/** What `grok --version` said, or why it could not be used. */
export type GrokVersionProbe =
  | { kind: "version"; version: string }
  | { kind: "unparseable"; found: string }
  | { kind: "timeout" }
  | { kind: "missing" }
  | { kind: "unchecked" }
  | { kind: "failed"; found: string };

/**
 * First line of `grok 1.0.46`, `grok 1.0.46 (commit)`, or the same with a trailing channel tag (`[stable]`,
 * `[beta]`, `[canary-1.2]`). The channel is any letters, digits, dots and dashes. Only the X.Y.Z number is
 * compared. Extra trailing text is not a version.
 */
const GROK_VERSION_LINE = /^grok (\d+\.\d+\.\d+)(?: \([0-9A-Za-z._-]{1,80}\))?(?: \[[A-Za-z0-9.-]{1,40}\])?\s*$/;

function clipFound(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= 80 ? one : `${one.slice(0, 77)}...`;
}

export function parseGrokVersion(text: string): string | null {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
  return GROK_VERSION_LINE.exec(line)?.[1] ?? null;
}

/** Keep a transient-failure hint inside {@link REASON_MAX} even when the found text is long. */
function boundReason(body: string, hint: string): string {
  const msg = `${body}${hint}`;
  if (msg.length <= REASON_MAX) return msg;
  const room = REASON_MAX - hint.length;
  if (room < 1) return hint.slice(0, REASON_MAX);
  return `${body.slice(0, room).trimEnd()}${hint}`;
}

/**
 * Why this probe cannot carry a tool policy, or null when the version is one Walkie has checked. A launch refusal
 * points a retry at `walkie seats doctor`. The doctor's own row passes `doctor: true` and says only "Retry.", so it
 * never tells the user to run the command they are already running.
 */
export function grokVersionPolicyRefusal(probe: GrokVersionProbe, opts?: { doctor?: boolean }): string | null {
  if (probe.kind === "version" && (GROK_VERIFIED_VERSIONS as readonly string[]).includes(probe.version)) return null;
  const found = probe.kind === "version" ? probe.version
    : probe.kind === "unparseable" ? `(grok --version printed ${JSON.stringify(clipFound(probe.found))})`
    : probe.kind === "timeout" ? "(grok --version timed out)"
    : probe.kind === "missing" ? "(grok was not found)"
    : probe.kind === "unchecked" ? "(its version was not verified)"
    : `(grok --version failed: ${clipFound(probe.found)})`;
  // A missing binary, a crash, or a timeout can change without the file identity changing. A wrong version number cannot.
  const hint = probe.kind === "timeout" || probe.kind === "failed" || probe.kind === "missing"
    ? (opts?.doctor ? " Retry." : " Retry, or run `walkie seats doctor`.")
    : "";
  const body = `this Grok seat's tool policy cannot be enforced on grok ${found} (Walkie verified tool ids only on ${grokVerifiedLabel()}), so the launch is refused.`;
  return boundReason(body, hint);
}

/** Identity of the file `grok --version` actually runs. `ctimeMs` moves when the file is replaced; `touch` cannot set it. */
type GrokBinaryId = { realPath: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
type GrokVersionCacheEntry = GrokBinaryId & { probe: GrokVersionProbe };
const grokVersionCache = new Map<string, GrokVersionCacheEntry>();
/** One probe per identity while it is running, so two admissions do not start two copies. */
const grokVersionInflight = new Map<string, Promise<GrokVersionProbe>>();
/** Bumped by {@link clearGrokVersionCache} so a probe that started earlier cannot refill the map. */
let grokVersionEpoch = 0;

function grokBinaryId(bin: string): GrokBinaryId | null {
  try {
    const realPath = realpathSync(bin);
    const st = statSync(realPath);
    if (!st.isFile()) return null;
    return { realPath, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
  } catch {
    return null;
  }
}

function sameGrokBinary(a: GrokBinaryId, b: GrokBinaryId): boolean {
  return a.realPath === b.realPath && a.dev === b.dev && a.ino === b.ino
    && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function grokBinaryKey(id: GrokBinaryId): string {
  return [id.realPath, id.dev, id.ino, id.size, id.mtimeMs, id.ctimeMs].join("\0");
}

/** Tests replace a binary, or need a probe that was deliberately not cached to run again. */
export function clearGrokVersionCache(): void {
  grokVersionEpoch++;
  grokVersionCache.clear();
}

/** What an over-cap answer reports. */
const OVER_CAP_FOUND = `over ${GROK_VERSION_MAX_OUTPUT_BYTES} bytes of output`;

/**
 * A parsed line is stable for this file. A timeout, a failed run or an over-cap answer is not: the next launch tries
 * again (a crash that wrote a long error, cut off at the cap before its exit was seen, must not keep refusing after grok
 * recovers: WALK-76 r6 review LOW-2).
 */
function cacheableGrokProbe(probe: GrokVersionProbe): boolean {
  return probe.kind === "version" || (probe.kind === "unparseable" && probe.found !== OVER_CAP_FOUND);
}

/**
 * `grok --version` for this binary. A successful or unparseable answer is cached for the resolved file's device,
 * inode, size, mtime and ctime, so replacing the binary (including with the same mtime) is a new probe. A timeout
 * or a failed run is not cached. A seat with no tool policy must not call this. The read does not block the
 * event loop, and a timeout kills the process group, including a grandchild that still holds the pipes.
 */
export async function readGrokVersion(bin: string, opts?: { timeoutMs?: number }): Promise<GrokVersionProbe> {
  const id = grokBinaryId(bin);
  if (!id) return { kind: "missing" };
  const hit = grokVersionCache.get(id.realPath);
  if (hit && sameGrokBinary(hit, id)) return hit.probe;
  const key = grokBinaryKey(id);
  const pending = grokVersionInflight.get(key);
  if (pending) return pending;
  const epoch = grokVersionEpoch;
  const flight = (async () => {
    const probe = await runGrokVersion(id.realPath, opts?.timeoutMs ?? GROK_VERSION_TIMEOUT_MS);
    const after = grokBinaryId(bin);
    if (epoch === grokVersionEpoch && after && sameGrokBinary(after, id) && cacheableGrokProbe(probe)) {
      grokVersionCache.set(after.realPath, { ...after, probe });
    }
    return probe;
  })();
  grokVersionInflight.set(key, flight);
  try {
    return await flight;
  } finally {
    if (grokVersionInflight.get(key) === flight) grokVersionInflight.delete(key);
  }
}

/**
 * Reads at most `cap` bytes of a child's pipe. Past the cap it keeps nothing more, calls `onOver` (the caller kills
 * the process group), stops reading and reports `over`. It never rejects: a pipe error ends the read with what
 * arrived, which the caller then fails to parse.
 */
async function readCapped(stream: unknown, cap: number, onOver: () => void): Promise<{ text: string; over: boolean }> {
  if (!(stream instanceof ReadableStream)) return { text: "", over: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      const room = cap - total;
      if (chunk.byteLength > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        over = true;
        onOver();
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } catch {
    // A broken pipe ends the read.
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const decoder = new TextDecoder();
  return { text: chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode(), over };
}

async function runGrokVersion(bin: string, timeoutMs: number): Promise<GrokVersionProbe> {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let killed = false;
  const killGroup = () => {
    if (killed) return;
    const pid = child?.pid;
    if (pid === undefined || pid <= 0) return;
    try {
      process.kill(-pid, "SIGKILL");
      killed = true;
    } catch {
      try { child?.kill("SIGKILL"); killed = true; } catch { /* already gone */ }
    }
  };
  // A killed grandchild stays in the group as a zombie until it is reaped. Wait that out so a caller that checks
  // the pid sees it gone. An empty group fails the signal at once, so a clean exit does not wait.
  const reapGroup = async (pgid: number): Promise<void> => {
    try { process.kill(-pgid, "SIGKILL"); } catch { return; }
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      try { process.kill(-pgid, 0); } catch { return; }
      await Bun.sleep(10);
    }
  };
  try {
    child = Bun.spawn([bin, "--version"], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: "/",
      env: { PATH: "/usr/bin:/bin" }, detached: true,
    });
    const stdoutP = readCapped(child.stdout, GROK_VERSION_MAX_OUTPUT_BYTES, killGroup);
    const stderrP = readCapped(child.stderr, GROK_VERSION_MAX_OUTPUT_BYTES, killGroup);
    timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    timer.unref?.();
    const code = await child.exited;
    if (timer) { clearTimeout(timer); timer = undefined; }
    // The leader is done. A grandchild may still hold the pipes, so the group is killed before the read.
    killGroup();
    if (timedOut) {
      await Promise.race([Promise.allSettled([stdoutP, stderrP]), Bun.sleep(200)]);
      return { kind: "timeout" };
    }
    let stdout = "";
    let stderr = "";
    try {
      const out = await Promise.race([
        Promise.all([stdoutP, stderrP]),
        Bun.sleep(timeoutMs).then(() => { throw new Error("output"); }),
      ]);
      // Over the cap on either pipe: the group was killed at that point and the output is not a version line.
      if (out[0].over || out[1].over) return { kind: "unparseable", found: OVER_CAP_FOUND };
      stdout = out[0].text;
      stderr = out[1].text;
    } catch {
      killGroup();
      return { kind: "timeout" };
    }
    if (code !== 0) return { kind: "failed", found: clipFound(stdout || stderr || `exit ${code}`) };
    const version = parseGrokVersion(stdout) ?? parseGrokVersion(stderr);
    if (!version) return { kind: "unparseable", found: clipFound(stdout || stderr || "empty") };
    return { kind: "version", version };
  } catch (err) {
    return { kind: "failed", found: clipFound((err as Error).message || "could not run") };
  } finally {
    if (timer) clearTimeout(timer);
    const pid = child?.pid;
    killGroup();
    if (pid !== undefined && pid > 0) await reapGroup(pid);
  }
}

/**
 * The version refusal for a Grok launch, or null. `resolve` runs only when a policy is set, so a seat with no
 * policy does not start `grok --version`.
 */
export async function grokLaunchVersionRefusal(
  policy: SeatToolPolicy | null | undefined,
  resolve: () => GrokVersionProbe | Promise<GrokVersionProbe>,
): Promise<string | null> {
  if (!seatToolPolicyActive(policy)) return null;
  return grokVersionPolicyRefusal(await resolve());
}

/**
 * Claude names that correspond to a verified Grok `--tools` id. Glob, LS and ListDir map to `list_dir`, which is
 * narrower than Claude's Glob, not the same tool. Bash, Edit, Task and a pattern are not mapped: grok 1.0.46
 * treats an unknown `--tools` name as every tool.
 */
const CLAUDE_TO_GROK: Readonly<Record<string, string>> = {
  Read: "read_file",
  Grep: "grep",
  Glob: "list_dir",
  LS: "list_dir",
  ListDir: "list_dir",
};

/**
 * Grok `--deny` matches permission-rule names, not `--tools` ids. On grok 1.0.46, `--deny run_terminal_command`
 * does not block the shell and `--deny Bash` does. A name with no entry is refused, never passed through.
 * Justified from this tree: Bash, Edit, MCPTool and Read are the rules this host already emits; the hook aliases
 * in test/helpers/grok-dispatch.ts (Grok's 10-hooks.md) pair Bash with run_terminal_command, Edit/Write/MultiEdit
 * with search_replace, Read with read_file, Grep with grep and WebSearch with web_search. `write` is that Write
 * alias. WebFetch is the deny name the CLI stores and a recognized grok 1.0.46 permission-rule name. Glob and
 * list_dir are absent on purpose: a Glob deny rule is Grok's alias of Grep, not list_dir. Task and spawn_subagent
 * are not recognized deny rules.
 */
const GROK_DENY_RULE: Readonly<Record<string, string>> = {
  Bash: "Bash",
  Edit: "Edit",
  Read: "Read",
  MCPTool: "MCPTool",
  Grep: "Grep",
  WebSearch: "WebSearch",
  WebFetch: "WebFetch",
  run_terminal_command: "Bash",
  search_replace: "Edit",
  write: "Edit",
  Write: "Edit",
  MultiEdit: "Edit",
  read_file: "Read",
  grep: "Grep",
  web_search: "WebSearch",
};

function mappedAllow(allow: readonly string[]): { tools: string[]; unsupported: string[] } {
  const tools: string[] = [];
  const seen = new Set<string>();
  const unsupported: string[] = [];
  for (const name of allow) {
    const mapped = ownString(CLAUDE_TO_GROK, name) ?? (GROK_VERIFIED.has(name) ? name : null);
    if (!mapped || !GROK_VERIFIED.has(mapped)) {
      unsupported.push(name);
      continue;
    }
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    tools.push(mapped);
  }
  return { tools, unsupported };
}

/** Names that may be passed to `--tools` for this mode. `search_replace` is omitted unless `read_file` is present. */
function emitAllow(mode: SeatMode, tools: readonly string[]): string[] {
  const narrowed = mode === "default" ? tools.filter((name) => (GROK_READ_ONLY as readonly string[]).includes(name)) : tools;
  return narrowed.filter((name) => GROK_VERIFIED.has(name) && (name !== "search_replace" || tools.includes("read_file")));
}

function grokAllowRefusal(mode: SeatMode, allow: readonly string[]): string | null {
  const { tools, unsupported } = mappedAllow(allow);
  if (unsupported.length) return grokUnsupportedAllow(unsupported);
  if (tools.includes("search_replace") && !tools.includes("read_file")) return grokSearchReplaceReason();
  if (emitAllow(mode, tools).length === 0) return GROK_EMPTY_TOOLS;
  return null;
}

/**
 * The tool segment of a Grok seat's argv. With no policy this is the historical read-only segment (or nothing, when
 * the mode is not default). With a policy, `--tools` is the ceiling and `--deny` carries deny rules. The ceiling
 * is omitted when nothing verified remains: `--tools` with an empty value allows every Grok tool, and so does an
 * id outside {@link GROK_VERIFIED_TOOLS}, so that launch is refused instead of spawned. Default mode stays inside
 * the read-only set: a policy cannot add a shell or an edit there. `MCPTool` is always denied while a policy is
 * set, because Grok's `--tools` leaves that meta-tool in place. A deny name is emitted only as a deny-rule name
 * (`run_terminal_command` becomes `Bash`). An unmapped deny name is left out of the argv; the refusal path rejects
 * the launch. `--no-subagents` is still passed. On grok 1.0.46 it does not remove `spawn_subagent`: the tool is
 * still offered, and a subagent inherits the parent's deny rules (including Bash). Walkie does not rely on `--no-subagents`
 * to keep a subagent inside the policy. Credential-path denies stay with the caller.
 */
export function grokToolFlags(mode: SeatMode, policy: SeatToolPolicy | undefined): string[] {
  if (!seatToolPolicyActive(policy) || !policy) {
    return mode === "default"
      ? ["--tools", "read_file,grep,list_dir", "--deny", "Bash", "--deny", "Edit", "--deny", "MCPTool", "--no-subagents", "--sandbox", "read-only"]
      : [];
  }
  const deny: string[] = [];
  const seen = new Set<string>();
  const addDeny = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    deny.push(name);
  };
  for (const name of policy.deny ?? []) {
    const rule = ownString(GROK_DENY_RULE, name);
    if (rule) addDeny(rule);
  }
  let tools: string[] | undefined;
  if (policy.allow !== undefined) {
    tools = emitAllow(mode, mappedAllow(policy.allow).tools);
  } else if (mode === "default") {
    tools = [...GROK_READ_ONLY];
  }
  addDeny("MCPTool");
  if (mode === "default") {
    addDeny("Bash");
    addDeny("Edit");
  }
  const flags: string[] = [];
  // Never `--tools` with an empty value. grok 1.0.46 treats that as every tool.
  if (tools && tools.length > 0) flags.push("--tools", tools.join(","));
  for (const name of deny) flags.push("--deny", name);
  flags.push("--no-subagents");
  if (mode === "default") flags.push("--sandbox", "read-only");
  return flags;
}

function joinShown(names: readonly string[]): string {
  if (names.length <= 8) return names.join(", ");
  return `${names.slice(0, 8).join(", ")} +${names.length - 8}`;
}

function finishSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Separate sentences. A reason that already ends with punctuation is not given a second period. The first part is
 * the row's label (`tool allow-list: …`) and keeps its case; each sentence after a period starts with a capital.
 */
function joinSentences(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => (part ? finishSentence(part) : ""))
    .filter(Boolean)
    .map((sentence, i) => (i === 0 ? sentence : `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`))
    .join(" ");
}

/** Running and paused seats keep the argv they started with. Null when none are in either state. */
export function toolPolicyRestartLine(running: number, paused: number): string | null {
  if (running > 0 && paused > 0) return "Running and paused seats keep the tool flags they started with until they are restarted.";
  if (running > 0) return "Running seats keep the tool flags they started with until they are restarted.";
  if (paused > 0) return "Paused seats keep the tool flags they started with until they are restarted.";
  return null;
}

/** One line for `walkie seats`. Runtimes that cannot enforce the policy are named when `runtimes` is passed. */
export function toolPolicyPhrase(view: { tools?: SeatToolPolicy; runtimes?: readonly SeatRuntime[] }): string {
  const policy = view.tools;
  if (!seatToolPolicyActive(policy) || !policy) return "no tool allow-list";
  const bits: string[] = [];
  if (policy.allow !== undefined) bits.push(policy.allow.length ? `allow ${joinShown(policy.allow)}` : "allow no tools");
  if (policy.deny?.length) bits.push(`deny ${joinShown(policy.deny)}`);
  const blocked = (view.runtimes ?? []).filter((runtime) => seatToolPolicyRefusal(runtime, policy) !== null);
  const note = blocked.length ? `; ${blocked.join(", ")} refused` : "";
  return `tool allow-list: ${bits.join("; ")}${note}`;
}

/**
 * The doctor row. Absent when seats are off and no policy is stored.
 * `grokCli` is the host's `grok --version` probe when grok is enabled. Omitted, an otherwise enforceable Grok
 * policy is refused: the ids are only proven on {@link GROK_VERIFIED_VERSIONS}.
 */
export function toolPolicyCheck(local: { allow?: boolean; tools?: SeatToolPolicy; runtimes?: readonly SeatRuntime[] }, grokCli?: GrokVersionProbe): { ok: boolean | "warn"; what: string; fix?: string } | null {
  if (!seatToolPolicyActive(local.tools)) {
    return local.allow ? { ok: true, what: "no tool allow-list: seats use each runtime's own tools" } : null;
  }
  const runtimes = local.runtimes ?? [];
  const policyBlocks = (runtime: SeatRuntime) => seatToolPolicyRefusal(runtime, local.tools) !== null;
  const grokCanEnforce = runtimes.includes("grok") && !policyBlocks("grok");
  const versionWhy = runtimes.includes("grok") && (grokCli !== undefined || grokCanEnforce)
    ? grokVersionPolicyRefusal(grokCli ?? { kind: "unchecked" }, { doctor: true })
    : null;
  const blocked = runtimes.filter((runtime) => (runtime === "grok" && versionWhy !== null) || policyBlocks(runtime));
  const enforced = runtimes.filter((runtime) => !blocked.includes(runtime));
  const phrase = toolPolicyPhrase({ tools: local.tools });
  const enforce = enforced.length === 0
    ? "no enabled runtime can enforce it"
    : `${enforced.join(" and ")} ${enforced.length === 1 ? "enforces" : "enforce"} it on every launch`;
  const refuse = blocked.length ? `; ${blocked.join(" and ")} ${blocked.length === 1 ? "is" : "are"} refused` : "";
  const defaultWhy = grokCanEnforce && versionWhy === null ? seatToolPolicyRefusal("grok", local.tools, "default") : null;
  // The mapping refusal and the version refusal are each their own sentence, including when both apply.
  const policyWhy = runtimes.includes("grok") ? seatToolPolicyRefusal("grok", local.tools) : null;
  const fixParts: string[] = [];
  if (enforced.length === 0) fixParts.push("walkie seats allow --runtimes claude — or walkie seats allow --clear-tool-policy");
  else if (blocked.length) fixParts.push(`${blocked.join(" and ")} launches are refused while this policy is set`);
  if (defaultWhy) fixParts.push("add Read, Grep or Glob, or launch Grok with --permission-mode acceptEdits or bypassPermissions");
  const fix = fixParts.length ? fixParts.join("; ") : undefined;
  return {
    ok: enforced.length === 0 ? false : blocked.length || defaultWhy !== null ? "warn" : true,
    what: joinSentences([
      phrase,
      `${enforce}${refuse}`,
      defaultWhy ? "A default-mode Grok launch is refused" : null,
      policyWhy,
      versionWhy,
    ]),
    ...(fix ? { fix } : {}),
  };
}

/**
 * `undefined` leaves the stored policy alone. `null` clears it. A list replaces that side; the other side is kept.
 * An update that constrains nothing (no allow list and no deny names) clears the policy.
 */
export function resolveSeatTools(
  prev: SeatToolPolicy | undefined,
  update: { allow?: readonly string[] | null; deny?: readonly string[] | null; clear?: boolean },
): SeatToolPolicy | null | undefined {
  if (update.clear) return null;
  if (update.allow === undefined && update.deny === undefined) return undefined;
  const allow = update.allow === undefined ? prev?.allow : update.allow === null ? undefined : [...update.allow];
  const deny = update.deny === undefined ? prev?.deny : update.deny === null ? undefined : [...update.deny];
  if (allow === undefined && !(deny && deny.length)) return null;
  return {
    ...(allow !== undefined ? { allow: [...allow] } : {}),
    ...(deny && deny.length ? { deny: [...deny] } : {}),
  };
}
