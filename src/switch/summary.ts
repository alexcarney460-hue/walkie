// Prompts the switcher starts a relaunched session with (ACCOUNTS-2).
//   continuation: after a limit cut a turn short, the resumed session is asked to carry on.
//   summary:      when the other account refuses to resume the conversation (signed thinking blocks / encrypted
//                 reasoning are tied to the account that produced them) the session starts fresh with the recent
//                 conversation as plain text, built locally from the transcript — no model call, no thinking
//                 blocks, no tool output, capped at ~6 KB — and the transcript's path for anything older.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../protocol/safety.ts";

export const CONTINUE_PROMPT =
  "Continue where you left off. (Walkie moved this session to another account because the previous one reached its usage limit; the last turn may have been cut short.)";

/** The continuation when a prompt was typed after the limit: it is in the transcript, unanswered. */
export const ANSWER_PROMPT =
  "Walkie moved this session to another account because the previous one reached its usage limit. Answer the most recent user message, which was sent after the limit was reached, and continue from there.";

const MAX_TOTAL = 6_000;
const MAX_EACH = 700;
const READ_MAX = 4 * 1024 * 1024;

interface Msg { role: "user" | "assistant"; text: string }

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => {
    const blk = b as { type?: unknown; text?: unknown };
    return (blk.type === "text" || blk.type === "input_text" || blk.type === "output_text") && typeof blk.text === "string" ? blk.text : "";
  }).filter(Boolean).join("\n");
}

/** User / assistant text messages, oldest first (Claude transcript or Codex rollout lines). */
export function messagesFrom(lines: readonly string[]): Msg[] {
  const out: Msg[] = [];
  for (const line of lines) {
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (e.isApiErrorMessage === true || e.isMeta === true) continue;
    // Claude: {type: "user"|"assistant", message: {role, content}}
    if ((e.type === "user" || e.type === "assistant") && e.message && typeof e.message === "object") {
      const m = e.message as { role?: unknown; content?: unknown };
      const text = textOf(m.content).trim();
      if (text && !text.startsWith("<command-") && !text.startsWith("<local-command")) out.push({ role: e.type, text });
      continue;
    }
    // Codex: {type: "response_item", payload: {type: "message", role, content}}
    const p = e.payload as { type?: unknown; role?: unknown; content?: unknown } | undefined;
    if (e.type === "response_item" && p?.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const text = textOf(p.content).trim();
      if (text && !text.startsWith("<environment_context>") && !text.startsWith("<user_instructions>")) out.push({ role: p.role, text });
    }
  }
  return out;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function summaryPrompt(transcriptPath: string | null): string {
  let lines: string[] = [];
  if (transcriptPath && existsSync(transcriptPath)) {
    try {
      const size = statSync(transcriptPath).size;
      const text = readFileSync(transcriptPath, "utf8");
      lines = (size > READ_MAX ? text.slice(-READ_MAX) : text).split("\n");
    } catch { /* unreadable */ }
  }
  const picked: string[] = [];
  let total = 0;
  for (const m of messagesFrom(lines).filter((x) => !x.text.startsWith(CONTINUE_PROMPT) && !x.text.startsWith(ANSWER_PROMPT)).reverse()) {
    const entry = `${m.role === "user" ? "User" : "Assistant"}: ${clip(redactSecrets(m.text).text.replace(/\s+\n/g, "\n"), MAX_EACH)}`;
    if (total + entry.length > MAX_TOTAL) break;
    picked.unshift(entry);
    total += entry.length;
  }
  return [
    "This continues an earlier session that ran on another account. Walkie moved it here because that account reached its usage limit, and this account could not resume the earlier conversation directly.",
    picked.length ? `The most recent part of that conversation (oldest first):\n\n${picked.join("\n\n")}` : "(The earlier conversation could not be read.)",
    transcriptPath ? `The full earlier transcript is at ${transcriptPath} if you need more.` : "",
    "Continue where it left off.",
  ].filter(Boolean).join("\n\n");
}

/**
 * Round 1 (Codex 3 / Opus 9): the summary never travels on a command line. It is written, secrets redacted, to a 0600
 * file in the wrapper's private run directory, and the new session gets only a short instruction naming that file
 * (the CLI reads it with its own file tool). The wrapper deletes the file when it exits.
 */
export function writeSummaryFile(runDir: string, transcriptPath: string | null, n: number): string {
  const path = join(runDir, `summary-${process.pid}-${n}.md`);
  writeFileSync(path, summaryPrompt(transcriptPath) + "\n", { mode: 0o600 });
  return path;
}

export function summaryInstruction(path: string): string {
  return `Walkie moved this session to another account, which could not resume the earlier conversation, so this is a new session. Read the file ${path} (a summary of the earlier conversation, secrets redacted) and continue where it left off.`;
}
