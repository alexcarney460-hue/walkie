// Conservative editor for Hermes profile YAML. It changes only marked hook entries and refuses inline/ambiguous hooks.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readSmallFile } from "../agent/safe-read.ts";
import { walkieArgv, type InstallResult } from "./install.ts";
import { isMap, isScalar, isSeq, parseDocument, stringify, YAMLMap, type Pair } from "yaml";

export const HERMES_EVENTS = ["on_session_start", "pre_llm_call", "pre_tool_call", "post_tool_call", "post_llm_call", "on_session_end", "on_session_finalize"] as const;
const PROFILE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Eight queued 1.5s status calls need 12s, plus process and polling overhead.
const HERMES_HOOK_TIMEOUT_S = 30;

function marker(event: string, open: boolean, indent: string): string {
  return `${indent}# ${open ? ">>>" : "<<<"} walkie-hermes:${event} ${open ? ">>>" : "<<<"}`;
}

function lineAt(text: string, line: string, from = 0): number {
  for (let at = text.indexOf(line + "\n", from); at >= 0; at = text.indexOf(line + "\n", at + 1)) {
    if (at === 0 || text[at - 1] === "\n") return at;
  }
  return -1;
}

function stripManaged(text: string): string {
  let next = text;
  for (const event of HERMES_EVENTS) {
    for (const indent of ["  ", "    "]) {
      const begin = marker(event, true, indent);
      const end = marker(event, false, indent);
      const start = lineAt(next, begin);
      if (start < 0) continue;
      if (lineAt(next, begin, start + 1) >= 0) throw new Error("duplicate Hermes managed hook marker");
      const finish = lineAt(next, end, start);
      if (finish < 0) throw new Error("incomplete Hermes managed hook marker");
      const middle = next.slice(start + begin.length + 1, finish);
      const expected = indent === "  " ? new RegExp(`^  ${event}:\\n    - command: [^\\n]+\\n      timeout: (?:5|30)\\n$`)
        : /^    - command: [^\n]+\n      timeout: (?:5|30)\n$/;
      if (!expected.test(middle)) throw new Error("edited Hermes managed hook block; no changes made");
      next = next.slice(0, start) + next.slice(finish + end.length + 1);
    }
  }
  const rootBegin = "# >>> walkie-hermes:root >>>";
  const rootEnd = "# <<< walkie-hermes:root <<<";
  const rootAt = lineAt(next, rootBegin);
  if (rootAt >= 0) {
    const rootEndAt = lineAt(next, rootEnd, rootAt);
    if (rootEndAt < 0 || next.slice(rootAt + rootBegin.length + 1, rootEndAt) !== "hooks:\n") {
      throw new Error("edited Hermes managed hooks root; no changes made");
    }
    const withoutMarkers = next.slice(0, rootAt) + "hooks:\n" + next.slice(rootEndAt + rootEnd.length + 1);
    const range = hooksRange(withoutMarkers)!;
    const body = withoutMarkers.split("\n").slice(range.start + 1, range.end).join("\n").trim();
    next = body ? withoutMarkers : next.slice(0, rootAt) + next.slice(rootEndAt + rootEnd.length + 1);
  }
  if (next.includes("walkie-hermes:")) throw new Error("unrecognized Hermes managed hook marker");
  return next;
}

function lineNumber(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length - 1;
}

function yamlHooks(text: string): { hooks: YAMLMap | null; range: { start: number; end: number } | null } {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length || !isMap(doc.contents)) throw new Error("Hermes config is not an unambiguous YAML mapping; no changes made");
  const roots = doc.contents.items;
  const hookPair = roots.find((pair) => isScalar(pair.key) && pair.key.value === "hooks");
  if (!hookPair) return { hooks: null, range: null };
  const keyLine = text.split("\n")[lineNumber(text, hookPair.key.range![0])] ?? "";
  const empty = isScalar(hookPair.value) && hookPair.value.value === null && /^\s*(?:hooks|"hooks"|'hooks'):\s*(?:#.*)?$/.test(keyLine);
  if ((!isMap(hookPair.value) && !empty) || (isMap(hookPair.value) && hookPair.value.flow)) {
    throw new Error("Hermes hooks mapping is ambiguous; no changes made");
  }
  const start = lineNumber(text, hookPair.key.range![0]);
  const next = roots.find((pair) => pair.key?.range?.[0] > hookPair.key.range![0]);
  const lines = text.split("\n");
  const end = next ? lineNumber(text, next.key.range![0]) : lines.length - (lines.at(-1) === "" ? 1 : 0);
  return { hooks: isMap(hookPair.value) ? hookPair.value : new YAMLMap(), range: { start, end } };
}

function hooksRange(text: string): { start: number; end: number } | null {
  return yamlHooks(text).range;
}

function addToHooks(text: string, command: string): string {
  const withRoot = hooksRange(text) ? text : `${text}${text && !text.endsWith("\n") ? "\n" : ""}# >>> walkie-hermes:root >>>\nhooks:\n# <<< walkie-hermes:root <<<\n`;
  let next = withRoot;
  for (const event of HERMES_EVENTS) {
    const { hooks, range } = yamlHooks(next);
    const pair = hooks!.items.find((item: Pair) => isScalar(item.key) && item.key.value === event);
    const yamlCommand = stringify(command, { lineWidth: 0 }).trimEnd();
    if (pair) {
      if (!isSeq(pair.value) || pair.value.flow || !pair.value.range) throw new Error("Hermes hook event uses unsupported YAML; no changes made");
      const at = pair.value.range[2];
      const block = [marker(event, true, "    "), `    - command: ${yamlCommand}`, `      timeout: ${HERMES_HOOK_TIMEOUT_S}`, marker(event, false, "    "), ""].join("\n");
      next = next.slice(0, at) + block + next.slice(at);
    } else {
      const lines = next.split("\n");
      lines.splice(range!.end, 0, marker(event, true, "  "), `  ${event}:`, `    - command: ${yamlCommand}`, `      timeout: ${HERMES_HOOK_TIMEOUT_S}`, marker(event, false, "  "));
      next = lines.join("\n");
    }
  }
  return next.endsWith("\n") ? next : next + "\n";
}

export function withHermesHooks(yaml: string, command: string, install: boolean): string {
  if (yaml.length > 1024 * 1024 || /[\r\n]/.test(command) || !command.trim()) throw new Error("unsafe Hermes config or command");
  const stripped = stripManaged(yaml);
  if (!install) return stripped;
  return addToHooks(stripped, command);
}

export async function installHermes(opts: { profiles: readonly string[]; dryRun: boolean; uninstall: boolean; root?: string }): Promise<InstallResult> {
  if (!opts.profiles.length || opts.profiles.some((p) => !PROFILE.test(p))) throw new Error("choose valid Hermes profile names explicitly");
  const root = opts.root ?? join(homedir(), ".hermes");
  const command = walkieArgv().map((s) => "'" + s.replaceAll("'", "'\\''") + "'").join(" ") + " hook hermes";
  const plans = [...new Set(opts.profiles)].map((profile) => {
    const path = profile === "default" ? join(root, "config.yaml") : join(root, "profiles", profile, "config.yaml");
    if (!existsSync(path)) throw new Error("selected Hermes profile config does not exist; no changes made");
    const current = readSmallFile(path, 1024 * 1024, process.getuid?.() ?? null);
    if (current === null) throw new Error("Hermes profile config is not a readable regular file under 1 MiB");
    return { path, current, next: withHermesHooks(current, command, !opts.uninstall) };
  });
  const changed: string[] = [];
  for (const { path, current, next } of plans) {
    if (next === current) continue;
    changed.push(opts.dryRun ? `${path} (would write)` : path);
    if (opts.dryRun) continue;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) copyFileSync(path, `${path}.bak-walkie-${Date.now()}`);
    writeFileSync(path, next, { mode: 0o600 });
  }
  return { changed, commands: [] };
}
