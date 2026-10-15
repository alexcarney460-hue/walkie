// Safe, local personal learning ledger. Only MemoryStore opens this database and supplies its transaction boundary.
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { bareLetters, readable } from "../../protocol/projects/status-report.ts";
import { redactSecrets } from "../../protocol/safety.ts";
import { containsNetworkEndpoint } from "./endpoint.ts";
import { MemoryError } from "./text.ts";

export type LearningStatus = "active" | "superseded" | "retracted" | "quarantined";
export interface Learning {
  id: string; category: string; rule: string; evidence: string; confidence: number;
  effectiveConfidence: number; actor: string; machine: string; session: string;
  createdAt: number; confirmedAt: number; status: LearningStatus;
  supersedes: string | null; supersededBy: string | null;
}
export interface LearningInput {
  owner: string; actor: string; machine: string; session?: string;
  category: string; rule: string; evidence: string; confidence: number; requestId: string;
  supersedes?: string;
}
/** Stable key for a retried CLI/MCP request that did not supply one. Scoped again by owner in SQLite. */
export function automaticLearningRequestId(input: {
  action: string; category: string; rule: string; evidence: string; confidence: number;
  session?: string; supersedes?: string;
}): string {
  const fields = [input.action, input.category, input.rule, input.evidence, input.confidence,
    input.session ?? "", input.supersedes ?? ""];
  return `auto:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`;
}
interface LearningRow {
  id: string; owner: string; request_id: string; payload_hash: string;
  category: string; rule: string; evidence: string; confidence: number;
  actor: string; machine: string; session: string; created_at: number;
  confirmed_at: number; status: LearningStatus; supersedes: string | null; superseded_by: string | null;
}
const COLUMNS = "id, owner, request_id, payload_hash, category, rule, evidence, confidence, actor, machine, session, created_at, confirmed_at, status, supersedes, superseded_by";
const ID = /^l-[0-9a-f]{32}$/;
const HALF_LIFE_MS = 180 * 86_400_000;
const HOME_PATH = /(?:~[/\\]|\/(?:Users|home|root)\/|[A-Za-z]:\\Users\\|\\\\Users\\)[^\s"'`)]+/i;
// Agent primer writes use this best-effort phrase check as a second net. Model-facing wrapping is the guarantee:
// no finite phrase list can recognise every instruction, and topic words alone are ordinary memory content.
const INSTRUCTION = /\b(?:ignore|disregard|forget|override|replace)\s+(?:(?:all|any|your|the)\s+){0,2}(?:(?:previous|prior|above|system|developer|user|safety|all)\s+)?(?:instructions?|rules?|prompts?)(?:\s+(?:above|below|before|previous|prior))?\b|\b(?:run|execute)\s+(?:this|the following)\s+command\b|\byou\s+are\s+now\s+(?:(?:a|an|the)\s+)?(?:system|developer|assistant|user|agent)\b|\bsystem\s+message\s*:|<\s*\/?\s*(?:system|developer|assistant|user)\s*>|\b(?:system|developer|assistant|user)\s*:\s*(?:ignore|run|execute|override|follow)\b/i;
export const LEARNING_ROWS_MAX = 1000;
export const LEARNING_BYTES_MAX = 1024 * 1024;
export const AGENT_LEARNING_WRITES_PER_HOUR = 30;
export const AGENT_CONFIDENCE_MAX = 0.6;

export function createLearningSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS personal_learnings (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
    category TEXT NOT NULL, rule TEXT NOT NULL, evidence TEXT NOT NULL, confidence REAL NOT NULL,
    actor TEXT NOT NULL, machine TEXT NOT NULL, session TEXT NOT NULL, created_at INTEGER NOT NULL,
    confirmed_at INTEGER NOT NULL, status TEXT NOT NULL, supersedes TEXT, superseded_by TEXT,
    UNIQUE(owner, request_id))`);
  db.exec("CREATE INDEX IF NOT EXISTS personal_learnings_owner ON personal_learnings(owner, status, created_at DESC)");
}

function unsafe(text: string): boolean {
  const shown = readable(text);
  const bare = bareLetters(shown);
  const lookalikes = (value: string) => value.replace(/[іιΙІ]/g, "i").replace(/[гΓ]/g, "g")
    .replace(/[οоΟО]/g, "o").replace(/[еΕЕ]/g, "e").replace(/[аΑА]/g, "a")
    .replace(/[рΡР]/g, "p").replace(/[сϹС]/g, "c").replace(/[хΧХ]/g, "x");
  return HOME_PATH.test(shown) || HOME_PATH.test(bare)
    || containsNetworkEndpoint(text)
    || [shown, bare, lookalikes(shown), lookalikes(bare)].some((value) => INSTRUCTION.test(value) || redactSecrets(value).redactions.length > 0);
}

/** The same read-time quarantine decision used for personal learning rows. */
export const learningTextUnsafe = unsafe;

function validText(value: string, label: string, max: number): void {
  if (typeof value !== "string" || !value || value.length > max || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MemoryError("invalid", `${label} must be 1..${max} plain characters`);
  }
}

function validate(input: LearningInput): void {
  validText(input.owner, "owner", 512);
  validText(input.actor, "actor", 64);
  validText(input.machine, "machine", 128);
  if (input.session) validText(input.session, "session", 128);
  validText(input.category, "category", 32);
  if (!/^[a-z][a-z0-9_-]*$/.test(input.category)) throw new MemoryError("invalid", "invalid learning category");
  validText(input.rule, "rule", 2000);
  validText(input.evidence, "evidence", 2000);
  validText(input.requestId, "request id", 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(input.requestId)) throw new MemoryError("invalid", "invalid request id");
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new MemoryError("invalid", "confidence must be 0..1");
  }
  if (input.supersedes && !ID.test(input.supersedes)) throw new MemoryError("invalid", "invalid prior learning id");
}

export class LearningLedger {
  constructor(private readonly db: Database, private readonly now: () => number, private readonly write: <T>(fn: () => T) => T) {}

  private view(row: LearningRow): Learning {
    const age = Math.max(0, this.now() - row.confirmed_at);
    const quarantined = [row.rule, row.evidence, row.category, row.session, row.actor, row.machine].some(unsafe);
    return {
      id: row.id, category: quarantined ? "quarantined" : row.category,
      rule: quarantined ? "" : row.rule, evidence: quarantined ? "" : row.evidence,
      confidence: row.confidence, effectiveConfidence: Math.round(row.confidence * 0.5 ** (age / HALF_LIFE_MS) * 1000) / 1000,
      actor: quarantined ? "withheld" : row.actor, machine: quarantined ? "withheld" : row.machine,
      session: quarantined ? "" : row.session, createdAt: row.created_at,
      confirmedAt: row.confirmed_at, status: quarantined ? "quarantined" : row.status,
      supersedes: row.supersedes, supersededBy: row.superseded_by,
    };
  }

  private row(id: string, owner: string): LearningRow | null {
    return this.db.query<LearningRow, [string, string]>(`SELECT ${COLUMNS} FROM personal_learnings WHERE id = ? AND owner = ?`).get(id, owner);
  }

  list(owner: string, history = false, limit = 100): Learning[] {
    if (!owner) return [];
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new MemoryError("invalid", "invalid learning limit");
    const rows = this.db.query<LearningRow, [string, number]>(
      `SELECT ${COLUMNS} FROM personal_learnings WHERE owner = ? ${history ? "" : "AND status = 'active'"} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(owner, history ? limit : 5000).map((row) => this.view(row));
    return (history ? rows : rows.filter((row) => row.status === "active")).slice(0, limit);
  }

  add(input: LearningInput): Learning { return this.save(input); }
  correct(input: LearningInput & { supersedes: string }): Learning { return this.save(input); }

  private checkCapacity(input: LearningInput, id: string, requestKey: string, digest: string,
    status: LearningStatus, stored: readonly string[], at: number, correcting: boolean): void {
    const usage = this.db.query<{ rows: number; bytes: number }, [string]>(`SELECT COUNT(*) AS rows,
      COALESCE(SUM(length(CAST(id AS BLOB)) + length(CAST(owner AS BLOB))
      + length(CAST(request_id AS BLOB)) + length(CAST(payload_hash AS BLOB))
      + length(CAST(category AS BLOB)) + length(CAST(rule AS BLOB)) + length(CAST(evidence AS BLOB))
      + length(CAST(actor AS BLOB)) + length(CAST(machine AS BLOB)) + length(CAST(session AS BLOB))
      + length(CAST(status AS BLOB)) + length(CAST(COALESCE(supersedes, '') AS BLOB))
      + length(CAST(COALESCE(superseded_by, '') AS BLOB))), 0) AS bytes
      FROM personal_learnings WHERE owner = ?`).get(input.owner)!;
    const bytes = Buffer.byteLength(id) + Buffer.byteLength(input.owner) + Buffer.byteLength(requestKey)
      + Buffer.byteLength(digest) + Buffer.byteLength(status) + Buffer.byteLength(input.supersedes ?? "")
      + stored.reduce((sum, value) => sum + Buffer.byteLength(value), 0)
      + (correcting && status === "active" ? Buffer.byteLength(id) + "superseded".length - "active".length : 0);
    if (usage.rows >= LEARNING_ROWS_MAX || usage.bytes + bytes > LEARNING_BYTES_MAX) {
      throw new MemoryError("full", `personal learning store is full (${LEARNING_ROWS_MAX} rows or ${LEARNING_BYTES_MAX} bytes); no history was evicted`);
    }
    if (input.actor === "person") return;
    const recent = this.db.query<{ count: number }, [string, number]>(
      "SELECT COUNT(*) AS count FROM personal_learnings WHERE owner = ? AND actor <> 'person' AND created_at > ?",
    ).get(input.owner, at - 3_600_000)!.count;
    if (recent >= AGENT_LEARNING_WRITES_PER_HOUR) {
      throw new MemoryError("full", `agent learning write rate exceeded (${AGENT_LEARNING_WRITES_PER_HOUR} per hour); retry later`);
    }
  }

  private save(input: LearningInput): Learning {
    validate(input);
    const confidence = input.actor === "person" ? input.confidence : Math.min(input.confidence, AGENT_CONFIDENCE_MAX);
    const payload = JSON.stringify([input.actor, input.machine, input.session ?? "", input.category, input.rule,
      input.evidence, confidence, input.supersedes ?? null]);
    const digest = createHash("sha256").update(payload).digest("hex");
    const quarantine = [input.rule, input.evidence, input.session ?? "", input.category,
      input.actor, input.machine, input.requestId].some(unsafe);
    const requestKey = createHash("sha256").update(input.requestId).digest("hex");
    return this.write(() => {
      const prior = this.db.query<LearningRow, [string, string]>(
        `SELECT ${COLUMNS} FROM personal_learnings WHERE owner = ? AND request_id = ?`,
      ).get(input.owner, requestKey);
      if (prior) {
        if (prior.payload_hash !== digest) throw new MemoryError("invalid", "request id was used for another learning");
        return this.view(prior);
      }
      const old = input.supersedes ? this.row(input.supersedes, input.owner) : null;
      if (input.supersedes && (!old || this.view(old).status !== "active")) throw new MemoryError("not_found", "no such active learning");
      const id = `l-${randomBytes(16).toString("hex")}`;
      const at = this.now();
      const status: LearningStatus = quarantine ? "quarantined" : "active";
      const stored = [quarantine ? "quarantined" : input.category, quarantine ? "" : input.rule,
        quarantine ? "" : input.evidence, unsafe(input.actor) ? "withheld" : input.actor,
        unsafe(input.machine) ? "withheld" : input.machine, quarantine ? "" : input.session ?? ""];
      this.checkCapacity(input, id, requestKey, digest, status, stored, at, !!old);
      this.db.query(`INSERT INTO personal_learnings (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.owner, requestKey, digest, ...stored.slice(0, 3), confidence, ...stored.slice(3),
        at, at, status, input.supersedes ?? null, null,
      );
      if (old && status === "active") this.db.query(
        "UPDATE personal_learnings SET status = 'superseded', superseded_by = ? WHERE id = ? AND owner = ? AND status = 'active'",
      ).run(id, old.id, input.owner);
      return this.view(this.row(id, input.owner)!);
    });
  }

  confirm(id: string, owner: string): Learning {
    if (!ID.test(id) || !owner) throw new MemoryError("invalid", "invalid learning confirmation");
    return this.write(() => {
      const old = this.row(id, owner);
      if (!old || old.status !== "active" || this.view(old).status !== "active") {
        throw new MemoryError("not_found", "no such safe active learning");
      }
      if (old.confidence === 1) return this.view(old);
      this.db.query("UPDATE personal_learnings SET confidence = 1, confirmed_at = ? WHERE id = ? AND owner = ?")
        .run(this.now(), id, owner);
      return this.view(this.row(id, owner)!);
    });
  }

  retract(id: string, owner: string, requestId: string): Learning {
    if (!ID.test(id) || !owner || !requestId) throw new MemoryError("invalid", "invalid learning retraction");
    return this.write(() => {
      const row = this.row(id, owner);
      if (!row) throw new MemoryError("not_found", "no such learning");
      if (row.status === "active") this.db.query(
        "UPDATE personal_learnings SET status = 'retracted' WHERE id = ? AND owner = ?",
      ).run(id, owner);
      return this.view(this.row(id, owner)!);
    });
  }
}
