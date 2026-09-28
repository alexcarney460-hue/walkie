// Limit resets (WALKIE-ACCOUNTS-RESET-1). Only Codex offers an official way for a client to use one: the Codex CLI's
// own app-server protocol (JSON-RPC over stdio, the protocol its IDE extension speaks), methods
// `account/rateLimits/read` (the resets the account holds) and `account/rateLimitResetCredit/consume` (use one, with
// an idempotency key: "reuse the same value when retrying that attempt"). Walkie runs the user's own `codex
// app-server` against the login's CODEX_HOME and never reads, holds or sends a token for it: the CLI authenticates
// itself. Claude resets are used on claude.ai (Settings > Usage > "Reset for free", per Anthropic's help centre) and
// Kimi has none, so for those Walkie only links to the provider's page.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";
import { VERSION } from "../daemon/version.ts";
import type { ResetFailure, ResetResult } from "../protocol/accounts.ts";
import type { Login } from "./types.ts";

export type { ResetFailure, ResetOutcome, ResetResult } from "../protocol/accounts.ts";

/** One JSON-RPC session with a `codex app-server` child. */
export interface AppServerSession {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

/** Starts the Codex app-server for one login (tests pass a fake). */
export type AppServerLauncher = (login: Login) => Promise<AppServerSession>;

export class RpcError extends Error {
  constructor(readonly code: "timeout" | "closed" | "rpc_error" | "spawn_failed" | "not_found") { super(code); }
}

export const INIT_TIMEOUT_MS = 15_000;
export const READ_TIMEOUT_MS = 20_000;
export const CONSUME_TIMEOUT_MS = 30_000;
const LINE_MAX = 1024 * 1024;
/** Environment the child keeps (nothing else of the daemon's leaks into it). */
const ENV_KEEP = ["HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE"];

/** The `codex` binary: on PATH, else where its installers put it (a launchd daemon has a short PATH). */
export function findCodex(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  const dirs = [...(env.PATH ?? "").split(delimiter), join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  for (const d of dirs) {
    if (!d) continue;
    const p = join(d, "codex");
    if (existsSync(p)) return p;
  }
  return null;
}

/** The real launcher: `codex app-server` in its own session (no terminal), minimal environment, CODEX_HOME per login. */
export const launchCodexAppServer: AppServerLauncher = async (login) => {
  const bin = findCodex();
  if (!bin) throw new RpcError("not_found");
  const env: Record<string, string> = {};
  for (const k of ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k] as string;
  if (!login.isDefault) env.CODEX_HOME = login.dir;
  let child: ChildProcess;
  try {
    child = spawn(bin, ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"], detached: true });
  } catch {
    throw new RpcError("spawn_failed");
  }
  return stdioSession(child);
};

/** After SIGTERM to the app-server's process group, SIGKILL to the whole group this much later. */
export const KILL_GRACE_MS = 2_000;

/**
 * Ends a detached child's whole process group (the child leads it: it was started with its own session). Both signals
 * go to the GROUP whether or not the leader has already exited, so a descendant that outlives the leader (an MCP
 * helper, a code-mode host) is still ended (RESET-2, Codex MEDIUM 6). ESRCH (the group is gone) is fine.
 */
export function endProcessGroup(pid: number | undefined, graceMs = KILL_GRACE_MS): void {
  if (pid === undefined || pid <= 1) return;
  const signal = (sig: NodeJS.Signals) => { try { process.kill(-pid, sig); } catch { /* the group is gone */ } };
  signal("SIGTERM");
  const t = setTimeout(() => signal("SIGKILL"), graceMs);
  (t as { unref?: () => void }).unref?.();
}

/** JSON-RPC 2.0 over newline-delimited stdio. Server requests and notifications are ignored. */
export function stdioSession(child: ChildProcess, graceMs = KILL_GRACE_MS): AppServerSession {
  let nextId = 1;
  let closed = false;
  let buf = "";
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const failAll = () => {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new RpcError("closed")); }
    pending.clear();
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    if (buf.length > LINE_MAX && !buf.includes("\n")) { buf = ""; return; }
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg: { id?: unknown; result?: unknown; error?: unknown; method?: unknown };
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg.id !== "number" || msg.method !== undefined) continue;
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error !== undefined) p.reject(new RpcError("rpc_error"));
      else p.resolve(msg.result);
    }
  });
  let exited = false;
  child.on("exit", () => { exited = true; failAll(); });
  child.on("error", () => { exited = true; failAll(); });
  const write = (o: unknown) => { if (!closed && !exited) child.stdin?.write(JSON.stringify(o) + "\n"); };
  return {
    request(method, params, timeoutMs) {
      if (closed || exited) return Promise.reject(new RpcError("closed"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new RpcError("timeout")); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        write({ id, method, params });
      });
    },
    notify(method, params) { write(params === undefined ? { method } : { method, params }); },
    close() {
      if (closed) return;
      closed = true;
      failAll();
      try { child.stdin?.end(); } catch { /* gone */ }
      endProcessGroup(child.pid, graceMs);
    },
  };
}

const Count = z.union([z.number(), z.bigint(), z.string().regex(/^[0-9]{1,6}$/)]).transform((v) => Math.min(99, Math.max(0, Number(v))));
const Credit = z.object({
  id: z.string().min(1).max(200),
  resetType: z.string().max(64).optional(),
  status: z.string().max(32),
  expiresAt: z.number().nullable().optional(),
});
const ReadAnswer = z.object({
  accountId: z.string().max(200).nullable().optional(),
  rateLimitResetCredits: z.object({
    availableCount: Count,
    credits: z.array(z.unknown()).max(100).nullable().optional(),
  }).nullable().optional(),
});
const ConsumeAnswer = z.object({ outcome: z.string().max(64) });

/** The credit to use: the first available one that has not expired (null: let the backend pick; undefined: none). */
export function pickCredit(credits: readonly unknown[] | null | undefined, now: number): string | null | undefined {
  if (credits === null || credits === undefined) return null;
  for (const raw of credits) {
    const c = Credit.safeParse(raw);
    if (!c.success || c.data.status !== "available" || c.data.resetType === "unknown") continue;
    if (typeof c.data.expiresAt === "number" && c.data.expiresAt * 1000 <= now) continue;
    return c.data.id;
  }
  return undefined;
}

/** What one reset attempt is bound to (the account the person confirmed) and how it is retried. */
export interface RedeemPlan {
  /** The ChatGPT account id the app-server must answer with (from the one auth snapshot the attempt was bound to). */
  chatgptAccount: string;
  /** The attempt's idempotency key (reused on every retry of this attempt). */
  key: string;
  /** An earlier try of this attempt may have gone through: reconcile it, never treat "none left" as "nothing used". */
  afterUnconfirmed: boolean;
  /** The credit an earlier try of this attempt named (reused on a retry), if any. */
  creditId: string | null;
  /** Re-checked right before the use is sent: the login on disk is still the confirmed account. */
  stillBound: () => boolean;
  /** Called with the credit about to be used, BEFORE the use is sent; false (it could not be recorded) sends nothing. */
  onCredit: (creditId: string | null) => boolean;
}

const fail = (failure: ResetFailure): ResetResult => ({ outcome: "failed", left: null, failure });
const failureOf = (err: unknown): ResetFailure => (err instanceof RpcError && err.code === "rpc_error" ? "refused" : "unreachable");

/**
 * Uses one Codex reset on `login` through the Codex CLI's own app-server. The app-server must name the bound ChatGPT
 * account (a missing name fails closed: "unverified"), and the login on disk is re-checked right before the use is
 * sent. A retry after an unconfirmed try goes straight to a use with the SAME key and credit, so Codex reconciles it:
 * "already redeemed", "no credit" or "nothing to reset" then mean the earlier try went through (never "nothing used").
 * Never throws.
 */
export async function redeemCodexReset(launch: AppServerLauncher, login: Login, plan: RedeemPlan, now: number): Promise<ResetResult> {
  let session: AppServerSession;
  try { session = await launch(login); } catch (err) { return fail(err instanceof RpcError && err.code === "not_found" ? "codex_missing" : "unreachable"); }
  try {
    try {
      await session.request("initialize", {
        clientInfo: { name: "walkie", title: "Walkie", version: VERSION },
        capabilities: { experimentalApi: false, requestAttestation: false },
      }, INIT_TIMEOUT_MS);
      session.notify("initialized");
    } catch (err) { return fail(failureOf(err)); }
    let read: z.infer<typeof ReadAnswer>;
    try {
      const r = ReadAnswer.safeParse(await session.request("account/rateLimits/read", {}, READ_TIMEOUT_MS));
      if (!r.success) return fail("refused");
      read = r.data;
    } catch (err) { return fail(failureOf(err)); }
    if (!read.accountId) return { outcome: "unverified", left: null };
    if (read.accountId !== plan.chatgptAccount) return { outcome: "login_changed", left: null };
    const credits = read.rateLimitResetCredits;
    let creditId: string | null;
    if (plan.afterUnconfirmed) {
      creditId = plan.creditId; // reconcile the earlier try: same key, same credit
    } else {
      if (!credits || credits.availableCount === 0) return { outcome: "none", left: credits ? 0 : null };
      const picked = pickCredit(credits.credits, now);
      if (picked === undefined) return { outcome: "none", left: 0 };
      creditId = picked;
    }
    if (!plan.stillBound()) return { outcome: "login_changed", left: null };
    if (!plan.onCredit(creditId)) return fail("not_saved");
    let answer: unknown;
    try {
      answer = await session.request("account/rateLimitResetCredit/consume", { idempotencyKey: plan.key, ...(creditId ? { creditId } : {}) }, CONSUME_TIMEOUT_MS);
    } catch {
      return { outcome: "unconfirmed", left: null }; // sent, no answer: it may have gone through
    }
    const c = ConsumeAnswer.safeParse(answer);
    if (!c.success) return { outcome: "unconfirmed", left: null };
    const count = credits?.availableCount ?? null;
    switch (c.data.outcome) {
      case "reset": return { outcome: "reset", left: count === null ? null : Math.max(0, count - 1) };
      case "alreadyRedeemed": return { outcome: "already_used", left: count };
      case "nothingToReset": return plan.afterUnconfirmed ? { outcome: "already_used", left: count } : { outcome: "not_needed", left: count };
      case "noCredit": return plan.afterUnconfirmed ? { outcome: "already_used", left: 0 } : { outcome: "none", left: 0 };
      default: return { outcome: "unconfirmed", left: null };
    }
  } finally {
    session.close();
  }
}
