// The import map (LINEAR-IMPORT-1): ~/.walkie/linear-import.json (0600, written by atomic rename after every committed
// batch). Local, never replicated. It is a cache of what the signed log already says (cards carry `ext`): losing it
// loses only the sync snapshots, never an import (the next run finds its cards by `ext`).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ColumnRole } from "../../protocol/projects/schema.ts";
import { Selection } from "./plan.ts";

const FieldsSchema = z.object({
  title: z.string().max(400), place: ColumnRole, labels: z.array(z.string().max(64)).max(20),
  estimate: z.number().nullable(), due: z.string().max(20).nullable(), assignee: z.string().max(200).nullable(),
});
const SnapSchema = z.object({ l: FieldsSchema, w: FieldsSchema });

const CardEntry = z.object({
  card: z.string().max(40), channel: z.string().max(20), key: z.string().max(40), ident: z.string().max(40),
  project: z.string().max(120), team_id: z.string().max(100),
  snap: SnapSchema.optional(),
});
export type CardEntry = z.infer<typeof CardEntry>;
const ProjectEntry = z.object({
  channel: z.string().max(20), prefix: z.string().max(10), name: z.string().max(80), team_id: z.string().max(100),
  /** The run's team filter (a Linear team id): sync reads only that team's issues of this project too. */
  team_filter: z.string().max(100).optional(),
});
export type ProjectEntry = z.infer<typeof ProjectEntry>;

export const SyncSettings = z.object({
  enabled: z.boolean().default(false),
  two_way: z.boolean().default(false),
  interval_min: z.number().int().min(2).max(1_440).default(10),
  /** The key file a scheduled sync reads (a path, never the key); absent = the Linear integration's key. */
  key_file: z.string().max(1024).optional(),
  /** Issues updated after this (ISO) are read by the next sync (with an overlap). */
  watermark: z.string().max(40).optional(),
  /** Issue ids a pass read but couldn't apply (their project's batch failed): the next pass reads them again. */
  retry: z.array(z.string().max(100)).max(5_000).optional(),
  last_run: z.number().optional(),
  last_result: z.string().max(500).optional(),
  last_error: z.string().max(500).optional(),
});
export type SyncSettings = z.infer<typeof SyncSettings>;

const StateFile = z.object({
  v: z.literal(1),
  projects: z.record(ProjectEntry).default({}),
  cards: z.record(CardEntry).default({}),
  sync: SyncSettings.default({}),
  last_selection: Selection.optional(),
});
export type ImportState = z.infer<typeof StateFile>;

export function importStatePath(home: string): string { return join(home, "linear-import.json"); }

export function emptyState(): ImportState {
  return { v: 1, projects: {}, cards: {}, sync: SyncSettings.parse({}) };
}

/** The stored map; a missing or unreadable file is an empty one (logged by the caller). */
export function loadState(home: string): { state: ImportState; error?: string } {
  const p = importStatePath(home);
  if (!existsSync(p)) return { state: emptyState() };
  try {
    const parsed = StateFile.safeParse(JSON.parse(readFileSync(p, "utf8")));
    if (parsed.success) return { state: parsed.data };
    return { state: emptyState(), error: `linear-import.json doesn't match its schema (${parsed.error.issues[0]?.path.join(".") ?? "?"}); starting from the signed log` };
  } catch (err) {
    return { state: emptyState(), error: `linear-import.json can't be read (${err instanceof Error ? err.message.slice(0, 120) : "error"}); starting from the signed log` };
  }
}

export function saveState(home: string, s: ImportState): void {
  const p = importStatePath(home);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  renameSync(tmp, p);
}
