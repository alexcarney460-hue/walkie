// Signed, replicated prose revisions. The event log is the authority; installed files are a replaceable projection.
import { createHash } from "node:crypto";
import YAML from "yaml";
import { redactSecrets } from "../../protocol/safety.ts";
import { scanSkillHygiene } from "../../mcp/skill-hygiene.ts";
import type { Event } from "../../protocol/schemas.ts";

export const MAX_SKILL_BYTES = 64 * 1024;
export const SKILLS_CHANNEL = "skills";
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;
const BUNDLED = new Set(["browser", "scrape", "skill-creation", "whatsapp-web", "telegram-web", "sqwakie-ops"]);

export interface CatalogSkill { name: string; description: string; uses: string[]; text: string; sha256: string; revision: string }
export interface CatalogRecord {
  id: string;
  kind: "propose" | "approve" | "revoke" | "rollback";
  body: Record<string, unknown>;
  owner: boolean;
  person: boolean;
  signatureValid: boolean;
}
export type CatalogProjection = { active: CatalogSkill[]; pending: CatalogSkill[]; eligible: string[]; blocked: string[]; heads: Record<string, string> };

/** Ordinary posts remain ordinary messages when the optional operation is malformed. */
export function catalogPost(ev: Event): boolean {
  return ev.kind === "msg.post" && ev.channel === SKILLS_CHANNEL
    && typeof (ev.body as { skill?: unknown }).skill === "object"
    && (ev.body as { skill?: unknown }).skill !== null;
}

export function catalogOperation(ev: Event): CatalogRecord["kind"] | null {
  if (!catalogPost(ev)) return null;
  const op = ((ev.body as { skill: { op?: unknown } }).skill).op;
  return op === "propose" || op === "approve" || op === "revoke" || op === "rollback" ? op : null;
}

export function skillHash(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }

/** Reject known restricted project identifiers before putting a proposal in the team-wide log. */
export function privateProjectMentions(text: string, projects: readonly { name: string; prefix: string; prior_prefixes?: string[]; private: boolean }[]): string[] {
  for (const project of projects) {
    if (!project.private) continue;
    const name = project.name.trim();
    if (name && text.toLocaleLowerCase().includes(name.toLocaleLowerCase())) return ["private project text"];
    for (const prefix of [project.prefix, ...(project.prior_prefixes ?? [])]) {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:-[1-9][0-9]*)?(?=$|[^A-Za-z0-9-])`, "i").test(text)) return ["private project text"];
    }
  }
  return [];
}

export function parseCatalogSkill(text: string): Omit<CatalogSkill, "sha256" | "revision"> {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_SKILL_BYTES) throw new Error("skill exceeds 64 KiB");
  const match = /^---\r?\n([^]*?)\r?\n---\r?\n([^]+)$/.exec(text);
  if (!match) throw new Error("SKILL.md needs frontmatter and Markdown body");
  const doc = YAML.parseDocument(match[1]!, { uniqueKeys: true });
  if (doc.errors.length) throw new Error("invalid frontmatter");
  const meta = doc.toJS() as Record<string, unknown>;
  if (!meta || Object.keys(meta).sort().join(",") !== "description,name,uses"
    || typeof meta.name !== "string" || !NAME.test(meta.name)
    || typeof meta.description !== "string" || !meta.description.trim() || /[\r\n]/.test(meta.description)
    || !Array.isArray(meta.uses) || !meta.uses.every((u) => typeof u === "string" && /^[a-z][a-z0-9_]*$/.test(u))) {
    throw new Error("invalid skill metadata");
  }
  const body = match[2]!;
  if (!body.trim()) throw new Error("empty skill body");
  return { name: meta.name, description: meta.description, uses: meta.uses as string[], text };
}

/** Prose may mention a command, but it must not carry an executable block, attachment, or active HTML. */
export function validateCatalogProse(text: string, available?: readonly string[]): string[] {
  const problems: string[] = [];
  let parsed: ReturnType<typeof parseCatalogSkill> | null = null;
  try { parsed = parseCatalogSkill(text); } catch (err) { problems.push((err as Error).message); }
  if (parsed) {
    if (BUNDLED.has(parsed.name)) problems.push("bundled skill name is reserved");
    const body = /^---\r?\n[^]*?\r?\n---\r?\n([^]+)$/.exec(text)?.[1] ?? "";
    if (/(?:^|\n)\s*(```|~~~)|(?:^|\n) {4,}\S|<\s*[a-z][^>]*>|\]\(\s*(?:javascript:|data:)|(?:^|\n)#!/i.test(body)) problems.push("executable content");
    if (/!\[|\[[^\]]*\]\([^)]*\.(?:sh|py|js|ts|wasm|zip|tar|gz)\)/i.test(body)) problems.push("attachment or executable reference");
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffd]/.test(text)) problems.push("non-prose bytes");
    if (available) for (const use of parsed.uses) if (!available.includes(use)) problems.push(`unavailable tool ${use}`);
  }
  for (const finding of scanSkillHygiene(text)) problems.push(`hygiene: ${finding}`);
  if (redactSecrets(text).redactions.length) problems.push("secret-bearing text");
  return [...new Set(problems)];
}

export function validCatalogEvent(record: CatalogRecord): boolean {
  if (!record.signatureValid) return false;
  const { name, sha256, text, prev, op } = record.body;
  if (op !== record.kind || Object.keys(record.body).sort().join(",") !== (
    record.kind === "propose" ? "name,op,sha256,text" :
      record.kind === "revoke" ? (prev === undefined ? "name,op" : "name,op,prev") :
        prev === undefined ? "name,op,sha256" : "name,op,prev,sha256")) return false;
  if (typeof name !== "string" || !NAME.test(name)) return false;
  if (record.kind === "propose") {
    if (typeof sha256 !== "string" || !HASH.test(sha256) || typeof text !== "string" || skillHash(text) !== sha256) return false;
    try { if (parseCatalogSkill(text).name !== name) return false; } catch { return false; }
    return validateCatalogProse(text).length === 0;
  }
  if (!record.owner || !record.person) return false;
  if (prev !== undefined && (typeof prev !== "string" || !/^[0-9a-f]{16}:[1-9][0-9]*$/.test(prev))) return false;
  return record.kind === "revoke" ? true : typeof sha256 === "string" && HASH.test(sha256);
}

export function projectCatalog(records: readonly CatalogRecord[], available: readonly string[]): CatalogProjection {
  const proposed = new Map<string, CatalogSkill>();
  const blocked: string[] = [];
  for (const record of records.filter((item) => item.kind === "propose")) {
    if (!validCatalogEvent(record)) { blocked.push(`${record.id}: invalid signature, role, hash or prose`); continue; }
    const name = record.body.name as string;
    const text = record.body.text as string;
    const parsed = parseCatalogSkill(text);
    proposed.set(`${name}:${record.body.sha256}`, { ...parsed, sha256: record.body.sha256 as string, revision: record.id });
  }
  const decisions = new Map<string, CatalogRecord[]>();
  for (const record of records.filter((item) => item.kind !== "propose")) {
    if (!validCatalogEvent(record)) { blocked.push(`${record.id}: invalid signature, role, hash or prose`); continue; }
    const name = record.body.name as string;
    decisions.set(name, [...(decisions.get(name) ?? []), record]);
  }
  const current = new Map<string, CatalogSkill>();
  const eligible = new Set<string>();
  const heads: Record<string, string> = {};
  for (const [name, items] of decisions) {
    type Branch = { head?: string; skill?: CatalogSkill; approved: ReadonlySet<string>; eligible: ReadonlySet<string>; depth: number; revoked: boolean };
    const byPrev = new Map<string, CatalogRecord[]>();
    for (const item of items) {
      const prev = (item.body.prev as string | undefined) ?? "";
      byPrev.set(prev, [...(byPrev.get(prev) ?? []), item]);
    }
    const leaves: Branch[] = [];
    const stack: Branch[] = [{ approved: new Set(), eligible: new Set(), depth: 0, revoked: false }];
    while (stack.length) {
      const branch = stack.pop()!;
      const children = (byPrev.get(branch.head ?? "") ?? []).filter((item) => item.id !== branch.head);
      if (!children.length) { leaves.push(branch); continue; }
      let advanced = false;
      for (const item of children) {
        if (item.kind === "revoke") {
          stack.push({ head: item.id, approved: branch.approved, eligible: new Set(), depth: branch.depth + 1, revoked: true });
          advanced = true;
          continue;
        }
        const key = `${name}:${item.body.sha256}`;
        const proposedSkill = proposed.get(key);
        if (!proposedSkill) { blocked.push(`${item.id}: exact proposed revision unavailable`); continue; }
        if (item.kind === "rollback" && !branch.approved.has(key)) { blocked.push(`${item.id}: revision was never approved`); continue; }
        const approved = item.kind === "approve" ? new Set([...branch.approved, key]) : branch.approved;
        const issues = validateCatalogProse(proposedSkill.text, available);
        if (issues.length) blocked.push(`${item.id}: ${issues.join(", ")}`);
        stack.push({ head: item.id, approved, eligible: issues.length ? branch.eligible : new Set([...branch.eligible, key]),
          skill: issues.length ? branch.skill : proposedSkill, depth: branch.depth + 1, revoked: false });
        advanced = true;
      }
      if (!advanced) leaves.push(branch);
    }
    // No clock participates. A revocation at a fork beats an approval; a later rollback on that same chain can restore.
    leaves.sort((a, b) => Number(b.revoked) - Number(a.revoked) || b.depth - a.depth || (a.head ?? "").localeCompare(b.head ?? ""));
    const winner = leaves[0];
    if (winner?.head) heads[name] = winner.head;
    if (winner?.skill && !winner.revoked) current.set(name, winner.skill);
    for (const key of winner?.eligible ?? []) eligible.add(key);
  }
  const active = [...current.values()].sort((a, b) => a.name.localeCompare(b.name));
  const pending = [...proposed.values()].filter((skill) => current.get(skill.name)?.sha256 !== skill.sha256)
    .sort((a, b) => a.name.localeCompare(b.name) || a.revision.localeCompare(b.revision));
  return { active, pending, eligible: [...eligible], blocked, heads };
}
