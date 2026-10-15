import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Core } from "../core.ts";
import { verifyEvent } from "../keys.ts";
import { verifyHeader } from "../keys.ts";
import { eventHeader } from "../../protocol/header.ts";
import { catalogOperation, projectCatalog, SKILLS_CHANNEL, skillHash, validateCatalogProse, type CatalogRecord, type CatalogSkill } from "./catalog.ts";

function root(home: string): string { return join(home, "skills", "catalog"); }
const failedActivationFallback = new WeakMap<Core, Map<string, string>>();
function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("catalog path is not a plain directory");
  chmodSync(path, 0o700);
}

export function catalogRecords(core: Core): CatalogRecord[] {
  return core.store.catalogEvents().flatMap((ev) => {
    const kind = catalogOperation(ev);
    if (!kind) return [];
    const atApproval = core.rosterAt(ev.origin, ev.seq);
    const node = atApproval.nodes.get(ev.origin);
    const member = node ? atApproval.members.get(node.login) : undefined;
    const channel = atApproval.channels.get(SKILLS_CHANNEL);
    return [{ id: ev.id, kind, body: (ev.body as { skill: Record<string, unknown> }).skill,
      owner: member?.role === "owner", person: ev.author.agent === undefined,
      signatureValid: !!channel && !channel.members && !channel.archived
        && !!node && !node.revoked && member?.handle === ev.author.handle
        && verifyEvent(ev, node.pubkey) && verifyHeader(eventHeader(ev), ev.hsig, node.pubkey) }];
  });
}

export function catalogState(core: Core, available: readonly string[]) {
  return projectCatalog(catalogRecords(core), available);
}

export function installedCatalog(home: string, core: Core, available: readonly string[]): CatalogSkill[] {
  const state = catalogState(core, available);
  const revisions = [...state.active, ...state.pending];
  const names = [...new Set(revisions.map((skill) => skill.name))];
  return names.flatMap((name) => {
    try {
      if (existsSync(join(root(home), `${name}.off`))) return [];
      const dir = join(root(home), name);
      const file = join(dir, "SKILL.md");
      if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()
        || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) return [];
      const text = readFileSync(file, "utf8");
      const sha256 = skillHash(text);
      const revision = revisions.find((skill) => skill.name === name && skill.sha256 === sha256);
      const desired = state.active.find((skill) => skill.name === name)?.sha256;
      const allowed = desired === sha256 || failedActivationFallback.get(core)?.get(name) === sha256;
      return revision && allowed && state.eligible.includes(`${name}:${sha256}`)
        && validateCatalogProse(text, available).length === 0 ? [revision] : [];
    } catch { return []; }
  });
}

/** A failed scan/write keeps the old directory. Readers verify the hash and never load a partial swap. */
export function reconcileCatalog(core: Core, available: readonly string[]): { active: string[]; blocked: string[] } {
  const state = catalogState(core, available);
  const base = root(core.paths.home);
  const blocked = [...state.blocked];
  const fallback = failedActivationFallback.get(core) ?? new Map<string, string>();
  failedActivationFallback.set(core, fallback);
  try { ensureDir(join(core.paths.home, "skills")); ensureDir(base); }
  catch (err) { return { active: [], blocked: [...blocked, `catalog directory: ${(err as Error).message}`] }; }
  for (const skill of state.active) {
    if (existsSync(join(base, `${skill.name}.off`))) continue;
    const dest = join(base, skill.name);
    try {
      ensureDir(dest);
      const file = join(dest, "SKILL.md");
      if (existsSync(file) && !lstatSync(file).isSymbolicLink() && lstatSync(file).isFile()
        && skillHash(readFileSync(file, "utf8")) === skill.sha256) { fallback.delete(skill.name); continue; }
      const stage = join(dest, `.stage-${randomUUID()}`);
      try {
        writeFileSync(stage, skill.text, { flag: "wx", mode: 0o600 });
        if (skillHash(readFileSync(stage, "utf8")) !== skill.sha256) throw new Error("staged hash mismatch");
        renameSync(stage, file); // one-file rename leaves either the old complete revision or the new one
        fallback.delete(skill.name);
      } finally { if (existsSync(stage)) rmSync(stage); }
    } catch (err) {
      const file = join(dest, "SKILL.md");
      try {
        if (existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink()) {
          const prior = skillHash(readFileSync(file, "utf8"));
          if (state.eligible.includes(`${skill.name}:${prior}`)) fallback.set(skill.name, prior);
        }
      } catch { /* no fallback if the old file cannot be verified */ }
      blocked.push(`${skill.name}: activation failed: ${(err as Error).message}`);
    }
  }
  // Revoked entries and inactive revisions are disabled on receipt, including after an offline sync.
  for (const name of existsSync(base) ? (awaitNames(base)) : []) {
    if (!state.eligible.some((key) => key.startsWith(`${name}:`))) {
      fallback.delete(name);
      try { rmSync(join(base, name), { recursive: true }); } catch (err) { blocked.push(`${name}: deactivation failed: ${(err as Error).message}`); }
    }
  }
  return { active: installedCatalog(core.paths.home, core, available).map((s) => s.name), blocked };
}

function awaitNames(base: string): string[] {
  return readdirSync(base).filter((name) => /^[a-z][a-z0-9-]{0,63}$/.test(name) && lstatSync(join(base, name)).isDirectory());
}

export function setCatalogOptOut(home: string, name: string, off: boolean): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error("invalid skill name");
  const base = root(home);
  ensureDir(join(home, "skills")); ensureDir(base);
  const marker = join(base, `${name}.off`);
  if (off) writeFileSync(marker, "off\n", { mode: 0o600 });
  else if (existsSync(marker)) rmSync(marker);
}
