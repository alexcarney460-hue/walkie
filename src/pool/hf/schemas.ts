// What the Hugging Face Hub API answers, validated at the boundary with zod (nothing from the Hub is trusted: every id,
// name and number is checked before it reaches the catalog, a terminal, an agent or HTML). An item that does not parse
// is skipped and counted, a list that is not a list fails the refresh.
import { z } from "zod";

/** A repository id: `owner/name`, characters the Hub allows, short. Everything built into a URL or shown comes from here. */
export const REPO_ID = /^[A-Za-z0-9][\w.-]{0,95}\/(?!\.+$)[\w.-]{1,128}$/;
export const RepoId = z.string().regex(REPO_ID);

const Count = z.number().int().nonnegative().max(1e12);
const Iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T/).max(40);

export const BaseModels = z.object({
  relation: z.string().max(24),
  models: z.array(z.object({ id: RepoId })).max(16),
});
export type BaseModels = z.infer<typeof BaseModels>;

/** One repository in a list (`/api/models?...&expand[]=baseModels&expand[]=downloads&expand[]=createdAt`). */
export const ListItem = z.object({
  id: RepoId,
  downloads: Count.optional().catch(undefined),
  createdAt: Iso.optional().catch(undefined),
  baseModels: BaseModels.optional().catch(undefined),
});
export type ListItem = z.infer<typeof ListItem>;

/** One benchmark result of a model (`.eval_results/*.yaml`); a malformed file comes back as `{filename, error}`. */
export const EvalEntry = z.object({
  filename: z.string().max(200).optional(),
  // Malformed provenance must not silently become an admissible missing flag.
  verified: z.boolean().optional(),
  pullRequest: z.number().int().positive().safe().optional(),
  data: z.object({
    dataset: z.object({ id: z.string().max(160), task_id: z.string().max(160).optional().catch(undefined) }),
    value: z.number().finite(),
  }),
});
export type EvalEntry = z.infer<typeof EvalEntry>;

/** A base model's record with the expansions the pipeline asks for. */
export const ModelRecord = z.object({
  id: RepoId,
  pipeline_tag: z.string().max(60).nullable().optional().catch(undefined),
  createdAt: Iso,
  downloads: Count.optional().catch(undefined),
  likes: Count.optional().catch(undefined),
  gated: z.union([z.boolean(), z.string().max(20)]).optional().catch(undefined),
  tags: z.array(z.string().max(120)).max(400).optional().catch(undefined),
  sha: z.string().regex(/^[0-9a-f]{40}$/).optional().catch(undefined),
  safetensors: z.object({ total: z.number().nonnegative().max(1e14).optional().catch(undefined) }).nullable().optional().catch(undefined),
  baseModels: BaseModels.optional().catch(undefined),
  /** Entries are checked one by one (a hostile or broken one is dropped, the rest kept). */
  evalResults: z.array(z.unknown()).max(600).optional().catch(undefined),
});
export type ModelRecord = z.infer<typeof ModelRecord>;

/** The valid benchmark results of a record and how many entries were not. */
export function evalEntries(record: ModelRecord): { entries: EvalEntry[]; bad: number } {
  const entries: EvalEntry[] = [];
  let bad = 0;
  for (const raw of record.evalResults ?? []) {
    const r = EvalEntry.safeParse(raw);
    if (r.success) entries.push(r.data);
    else bad++;
  }
  return { entries, bad };
}

/** A quantization repository with its files and their sizes (`/api/models/<repo>?blobs=true&expand[]=siblings...`). */
export const BlobRecord = z.object({
  id: RepoId,
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  downloads: Count.optional().catch(undefined),
  siblings: z.array(z.object({
    rfilename: z.string().max(300),
    size: z.number().int().nonnegative().max(1e13).optional().catch(undefined),
    lfs: z.object({ sha256: z.string().max(80).optional().catch(undefined), size: z.number().int().nonnegative().max(1e13).optional().catch(undefined) }).optional().catch(undefined),
  })).max(3000),
});
export type BlobRecord = z.infer<typeof BlobRecord>;

export const OrgOverview = z.object({
  name: z.string().max(100),
  fullname: z.string().max(200).optional().catch(undefined),
  numFollowers: Count,
  isVerified: z.boolean().optional().catch(undefined),
});
export type OrgOverview = z.infer<typeof OrgOverview>;

/** Items of a list that parse, and how many did not. A value that is not an array fails. */
export function parseItems<T>(raw: unknown, item: z.ZodType<T, z.ZodTypeDef, unknown>, max: number): { items: T[]; bad: number } {
  if (!Array.isArray(raw)) throw new Error("not a list");
  const items: T[] = [];
  let bad = 0;
  for (const x of raw.slice(0, max)) {
    const r = item.safeParse(x);
    if (r.success) items.push(r.data);
    else bad++;
  }
  return { items, bad };
}

/** A maker's display name from the Hub's `fullname`: printable ASCII from a small set, 2-40 characters; else the login. */
export function makerName(fullname: string | undefined, login: string): string {
  const clean = (s: string): string => s.normalize("NFKC").replace(/[^A-Za-z0-9 .&+-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim();
  const a = fullname ? clean(fullname) : "";
  return a.length >= 2 ? a : clean(login).length >= 2 ? clean(login) : "Unknown";
}
