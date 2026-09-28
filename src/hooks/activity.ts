// One-line, secret-redacted description of a tool call for the dashboard.
//
// Privacy (WALKIE-MISSION-1 fix round 1, src/agent/share-policy.ts): without share_activity the line is a fixed phrase
// that names the KIND of step only ("Running a command"), never its text. With it, every string taken from the tool
// input is redacted in FULL before it is shortened: a secret cut in half by truncation no longer matches its pattern,
// so redacting after truncating leaked most of it (Codex 3).
import { redactSecrets } from "../protocol/safety.ts";
import { homeRelative } from "../agent/identity.ts";
import { BUILTIN_SUBAGENT_TYPES } from "../protocol/subagents.ts";

const MAX = 180;
/** Tool input text is redacted up to this length; only its first ~120 characters are ever shown. */
const REDACT_SPAN = 8 * 1024;

function short(s: unknown, n: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/**
 * The input string, redacted whole, then shortened to n characters; null when it is longer than REDACT_SPAN: too long
 * to redact whole, so no detail is shown at all (Codex r2 #3: a secret whose end lay past the span leaked its start).
 */
function safe(s: unknown, n: number): string | null {
  const t = String(s ?? "");
  return t.length > REDACT_SPAN ? null : short(redactSecrets(t).text, n);
}

function relPath(p: unknown, cwd: string): string {
  const s = String(p ?? "");
  if (cwd && s.startsWith(cwd + "/")) return s.slice(cwd.length + 1);
  return homeRelative(s);
}

/** The fixed phrase for a tool call when its text may not be shared (share_activity off). */
export function activityPhrase(tool: string): string {
  switch (tool) {
    case "Bash": case "exec_command": case "shell": case "local_shell": return "Running a command";
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": case "apply_patch": return "Editing files";
    case "Read": return "Reading files";
    case "Grep": case "Glob": case "WebSearch": return "Searching";
    case "WebFetch": return "Fetching a web page";
    case "Task": case "Agent": return "Waiting on a subagent";
    case "TodoWrite": return "Planning";
    default: return "Using a tool";
  }
}

/**
 * The activity line for a tool call. `detail` (share_activity) false: the fixed phrase only. True: "Edit src/x.ts",
 * "$ bun test", ... with the input redacted before it is shortened.
 */
export function describeTool(tool: string, input: Record<string, unknown>, cwd: string, detail = false): string {
  if (!detail) return activityPhrase(tool);
  const part = (v: unknown, n: number): string => {
    const t = safe(v, n);
    if (t === null) throw new TooLong();
    return t;
  };
  let line: string;
  try {
    line = ((): string => {
      switch (tool) {
        case "Edit": case "MultiEdit": case "Write": case "NotebookEdit":
          return `${tool} ${part(relPath(input.file_path ?? input.notebook_path, cwd), 150)}`;
        case "Read":
          return `Read ${part(relPath(input.file_path, cwd), 150)}`;
        case "Bash":
          return `$ ${part(input.command, 120)}`;
        case "Grep": case "Glob":
          return `Search ${part(input.pattern, 80)}`;
        case "WebFetch":
          return `Fetch ${part(input.url, 120)}`;
        case "WebSearch":
          return `Web search ${part(input.query, 100)}`;
        case "Task": case "Agent":
          // Never the launch's description (prompt text: the sub-agent's own row carries it, under share_prompts) nor
          // a custom agent's name; a built-in type only (Codex mission-sub r1 #1).
          return typeof input.subagent_type === "string" && BUILTIN_SUBAGENT_TYPES.has(input.subagent_type)
            ? `Subagent: ${input.subagent_type}` : activityPhrase(tool);
        default: {
          const m = /^mcp__(.+?)__(.+)$/.exec(tool);
          return m ? `MCP ${m[1]}.${m[2]}` : tool;
        }
      }
    })();
  } catch (err) {
    if (err instanceof TooLong) return activityPhrase(tool);
    throw err;
  }
  return short(redactSecrets(line).text, MAX);
}

class TooLong extends Error {}

/** Title from a user prompt: first meaningful line, redacted whole, then trimmed. */
export function titleFromPrompt(prompt: string): string {
  const first = prompt.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return safe(first, 140) ?? ""; // a first line too long to redact whole: no title
}
