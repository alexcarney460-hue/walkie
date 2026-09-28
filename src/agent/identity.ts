// Resolve which agent a CLI / MCP / hook process speaks for, and the context
// it's working in. Hooks and the MCP server of one Claude Code session must
// derive the SAME agent name with no coordination: both see
// CLAUDE_CODE_SESSION_ID in their environment, so that is the key.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { readSmallFile } from "./safe-read.ts";
import { basename, dirname, join } from "node:path";

export type Runtime = "claude-code" | "codex" | "kimi" | "cli" | "other";

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export function detectRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  if (env.CLAUDE_CODE_SESSION_ID || env.CLAUDECODE) return "claude-code";
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_HOME) return "codex";
  if (env.KIMI_SESSION_ID) return "kimi";
  return "cli";
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Six characters of a session id. A UUIDv7 (Codex thread ids) starts with its timestamp, so every session started
 * within the same few hours shares the first six: those use the random tail instead.
 */
function shortId(raw: string): string {
  const clean = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (UUID_V7.test(raw.trim()) ? clean.slice(-6) : clean.slice(0, 6)) || "x";
}

/** Normalize a user-supplied name to the AgentName grammar, or null if unusable. */
export function normalizeAgentName(raw: string | undefined): string | null {
  if (!raw) return null;
  const n = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 48);
  return NAME_RE.test(n) ? n : null;
}

/**
 * Agent name precedence: WALKIE_AGENT → runtime session id → null (a human at the CLI).
 * `sessionId` lets a hook pass the id from its JSON input when the env lacks it.
 */
export function resolveAgentName(env: NodeJS.ProcessEnv = process.env, sessionId?: string): string | null {
  const explicit = normalizeAgentName(env.WALKIE_AGENT);
  if (explicit) return explicit;
  const cc = env.CLAUDE_CODE_SESSION_ID ?? (detectRuntime(env) === "claude-code" ? sessionId : undefined);
  if (cc) return `cc-${shortId(cc)}`;
  const codex = env.CODEX_THREAD_ID ?? (detectRuntime(env) === "codex" ? sessionId : undefined);
  if (codex) return `codex-${shortId(codex)}`;
  if (env.KIMI_SESSION_ID) return `kimi-${shortId(env.KIMI_SESSION_ID)}`;
  return null;
}

/** "~/workspace/x" style path: never ship absolute home paths to teammates. */
export function homeRelative(p: string): string {
  const home = homedir();
  return p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

export interface RepoContext { repo?: string; branch?: string; cwd: string }

/** Walk up to the git dir and read HEAD directly: no `git` subprocess on the hot path. */
export function repoContext(cwd: string): RepoContext {
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    const dotgit = join(dir, ".git");
    if (existsSync(dotgit)) {
      const gitDir = resolveGitDir(dotgit);
      const branch = gitDir ? readBranch(gitDir) : undefined;
      return { repo: basename(dir), branch, cwd: homeRelative(cwd) };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { cwd: homeRelative(cwd) };
}

function resolveGitDir(dotgit: string): string | null {
  try {
    if (statSync(dotgit).isDirectory()) return dotgit;
    const text = readSmallFile(dotgit, 4096); // a regular file only: a FIFO here never blocks (MISSION-1 fix 2)
    if (text === null) return null;
    const m = /^gitdir:\s*(.+)$/m.exec(text); // worktree / submodule
    if (!m?.[1]) return null;
    const target = m[1].trim();
    return target.startsWith("/") ? target : join(dirname(dotgit), target);
  } catch {
    return null;
  }
}

function readBranch(gitDir: string): string | undefined {
  try {
    const head = (readSmallFile(join(gitDir, "HEAD"), 4096) ?? "").trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m?.[1] ?? (head.length >= 7 ? head.slice(0, 7) : undefined);
  } catch {
    return undefined;
  }
}

/**
 * Issue key (ALE-5156, ENG-12) from the given strings, in priority order. Within a
 * string, prefer a key with 3+ digits: "merge FIX-1 (ALE-5156)" means ALE-5156.
 */
export function detectTask(...sources: (string | undefined)[]): string | undefined {
  for (const s of sources) {
    const keys = s ? [...s.matchAll(/\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g)].map((m) => m[1] as string) : [];
    const best = keys.find((k) => /-\d{3,}$/.test(k)) ?? keys[0];
    if (best) return best;
  }
  return undefined;
}

export type AskPolicy = "auto" | "human" | "off";

/** WALKIE_ASK_POLICY: auto (agent answers), human (a person answers in the dashboard), off. */
export function askPolicy(env: NodeJS.ProcessEnv = process.env): AskPolicy {
  const v = env.WALKIE_ASK_POLICY;
  return v === "human" || v === "off" ? v : "auto";
}
