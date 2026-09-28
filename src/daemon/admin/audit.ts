// AGENT-ADMIN-1: the audit trail of agent and remote administration. Every entry is appended to
// <walkie home>/admin-audit.jsonl (0600, this machine only) and, when `post` is set, posted to the team's #general
// as the reserved agent `walkie-admin`, mentioning the machine's person when `notify` names them.
import { appendFileSync, chmodSync, closeSync, existsSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../../protocol/safety.ts";
import type { Core } from "../core.ts";

/** The author of audit posts (reserved: no caller may post as it, local-routes.ts validAgentHeader). */
export const ADMIN_AGENT = "walkie-admin";
/** Where audit lines go. */
export const AUDIT_CHANNEL = "general";
const AUDIT_FILE = "admin-audit.jsonl";
const MAX_TEXT = 600;

export interface AuditEntry {
  /** Who acted: `@handle/machine/agent` (an agent), `@handle/machine` (a person, remotely). */
  readonly actor: string;
  /** What they did, in words ("enabled seats: same-user, max 12"). */
  readonly action: string;
  /** The machine it happened on (this machine's hostname). */
  readonly machine: string;
  /** "local" (an agent on this machine) or "remote" (over Walkie from another machine). */
  readonly via: "local" | "remote";
  /** Refused, and why (logged here only, never posted). */
  readonly refused?: string;
}

export function auditPath(home: string): string {
  return join(home, AUDIT_FILE);
}

/** One line of the team post. */
export function auditText(e: AuditEntry): string {
  // Redacted first, then cut (fix round 2, Codex LOW): a cut must never leave half a secret that no pattern matches.
  const text = redactSecrets(`[admin] ${e.actor} ${e.via === "remote" ? "(remote) " : ""}on ${e.machine}: ${e.action}`).text;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** The log is rotated past this size (one previous file kept, admin-audit.jsonl.1). */
export const AUDIT_ROTATE_BYTES = 4 * 1024 * 1024;
/** How much of the log's end `readAudit` reads. */
const AUDIT_TAIL_BYTES = 256 * 1024;

/** Appends the entry to this machine's audit log; a failure is logged, never thrown (the action already ran). */
export function appendAudit(core: Core, e: AuditEntry): void {
  try {
    const p = auditPath(core.paths.home);
    if (existsSync(p) && statSync(p).size > AUDIT_ROTATE_BYTES) renameSync(p, `${p}.1`);
    appendFileSync(p, JSON.stringify({ ts: Date.now(), ...e, action: redactSecrets(e.action).text }) + "\n", { mode: 0o600 });
    chmodSync(p, 0o600); // appending never repairs an existing file's mode
  } catch (err) {
    core.log.warn("admin_audit_write_failed", { error: (err as Error).message });
  }
  core.log.info("admin_action", { actor: e.actor, via: e.via, machine: e.machine, ...(e.refused ? { refused: e.refused } : {}) });
}

/**
 * Logs the entry and posts it to the team (#general), mentioning `notify` (a handle) when given. Without a team (or
 * without #general) only the local log has it.
 */
export function recordAdmin(core: Core, e: AuditEntry, o: { post: boolean; notify?: string } = { post: true }): void {
  appendAudit(core, e);
  if (!o.post || e.refused) return;
  postAudit(core, auditText(e), o.notify);
}

/** A post from `walkie-admin` in #general (the audit line, or the upgrade notice). */
export function postAudit(core: Core, text: string, notify?: string): void {
  if (!core.teamId || !core.me() || !core.roster.channels.has(AUDIT_CHANNEL)) return;
  const mention = notify ? `@${notify}` : null;
  const body = { text: mention && !text.includes(mention) ? `${mention} ${text}` : text, ...(mention ? { mentions: [mention] } : {}) };
  try {
    core.emit("msg.post", body, { channel: AUDIT_CHANNEL, agent: ADMIN_AGENT });
  } catch (err) {
    core.log.warn("admin_audit_post_failed", { error: (err as Error).message });
  }
}

/** The newest `limit` entries of this machine's audit log, newest first. */
export function readAudit(home: string, limit = 50): Record<string, unknown>[] {
  const p = auditPath(home);
  if (!existsSync(p)) return [];
  const out: Record<string, unknown>[] = [];
  // Only the end of the file (fix round 2): the first line of the window may be cut, and is skipped as torn.
  const size = statSync(p).size;
  const len = Math.min(size, AUDIT_TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fd = openSync(p, "r");
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  const lines = buf.toString("utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try { out.push(JSON.parse(lines[i] as string) as Record<string, unknown>); } catch { /* a torn line */ }
  }
  return out;
}

const NOTICE_FILE = "admin-notice-v1";

/** The one post after the upgrade that brought agent and remote admin (AGENT-ADMIN-1 §(c)), mentioning this person. */
export const UPGRADE_NOTICE = "Walkie update: agents on this machine can now set Walkie up for you, and team owners (and your own other "
  + "machines) can run allow-listed walkie setup commands here over Walkie (seats, accounts, hooks, pool, orchestrator; never a "
  + "shell). Every such action is posted here, naming who did it. To refuse it on this machine: walkie admin remote off (remote) and "
  + "walkie agents admin off (local agents); only you can turn them back on.";

/** Posts the upgrade notice once per machine (a marker file in the Walkie home), when it is on a team. */
export function postUpgradeNotice(core: Core): void {
  const marker = join(core.paths.home, NOTICE_FILE);
  const me = core.myHandle();
  if (existsSync(marker) || !core.teamId || !me || !core.roster.channels.has(AUDIT_CHANNEL)) return;
  postAudit(core, `[admin] ${UPGRADE_NOTICE} (${core.hostname})`, me);
  try { appendFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 }); } catch (err) { core.log.warn("admin_notice_mark_failed", { error: (err as Error).message }); }
}
