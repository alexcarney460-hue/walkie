// Model files for split runs (WALKIE-POOL-2): the GGUF files of a catalog model, pinned to a Hugging Face revision
// with each file's sha256 (src/pool/gguf.json), downloaded by the head into <home>/pool/models/<repo>/<revision>/,
// checked, then renamed into place. A person may also run a local .gguf file (`walkie pool run --file`).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import ggufJson from "../gguf.json" with { type: "json" };
import type { Quant } from "../catalog.ts";

const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const RepoPath = z.string().regex(/^[\w.-]+(?:\/[\w.-]+)*\.gguf$/).refine((p) => !p.split("/").includes(".."), "no ..");
const FileRef = z.object({ path: RepoPath, size: z.number().int().positive(), sha256: Sha }).strict();
export const GgufPins = z.object({
  version: z.number().int().positive(),
  updated: z.string(),
  note: z.string(),
  models: z.record(z.object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    files: z.object({ q4: z.array(FileRef).min(1).nullable(), q8: z.array(FileRef).min(1).nullable() }).strict(),
  }).strict()),
}).strict();
export type GgufPins = z.infer<typeof GgufPins>;
export type FileRef = z.infer<typeof FileRef>;

export const PINS: GgufPins = GgufPins.parse(ggufJson);

export interface ModelFiles {
  repo: string; revision: string; files: FileRef[];
  /** Total bytes of the files. */
  bytes: number;
}

export function filesFor(modelId: string, quant: Quant, pins: GgufPins = PINS): ModelFiles | null {
  const m = pins.models[modelId];
  const files = m?.files[quant];
  if (!m || !files) return null;
  return { repo: m.repo, revision: m.revision, files, bytes: files.reduce((s, f) => s + f.size, 0) };
}

export function localPath(home: string, mf: ModelFiles, f: FileRef): string {
  return join(home, "pool", "models", mf.repo, mf.revision, f.path);
}

/** The first file llama-server loads (it finds the other parts of a split GGUF next to it). */
export function firstFile(home: string, mf: ModelFiles): string {
  return localPath(home, mf, mf.files[0]!);
}

export interface DownloadProgress { done: number; total: number; file: string }

async function fetchChecked(url: string, dest: string, f: FileRef, signal: AbortSignal, onBytes: (n: number) => void): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const part = `${dest}.part`;
  rmSync(part, { force: true });
  const res = await fetch(url, { redirect: "follow", signal });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}): ${f.path}`);
  const hash = createHash("sha256");
  const out = Bun.file(part).writer();
  let got = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.byteLength;
      if (got > f.size) throw new Error(`${f.path} is larger than its pinned size`);
      hash.update(chunk);
      out.write(chunk);
      onBytes(chunk.byteLength);
    }
  } finally {
    await out.end();
  }
  const sum = hash.digest("hex");
  if (got !== f.size || sum !== f.sha256) {
    rmSync(part, { force: true });
    throw new Error(`${f.path}: sha256 or size mismatch (expected ${f.sha256}, got ${sum}, ${got} of ${f.size} bytes)`);
  }
  renameSync(part, dest);
  writeFileSync(`${dest}.ok`, `${f.sha256}\n`, { mode: 0o600 });
}

/**
 * Downloads every file not already present and verified (a `.ok` marker with its sha256, written only after the
 * check passed). `base` lets tests point at a local server.
 */
export async function ensureFiles(home: string, mf: ModelFiles, signal: AbortSignal, onProgress: (p: DownloadProgress) => void, base = "https://huggingface.co"): Promise<string> {
  let done = 0;
  for (const f of mf.files) {
    const dest = localPath(home, mf, f);
    const ok = `${dest}.ok`;
    const have = existsSync(dest) && existsSync(ok) && statSync(dest).size === f.size && Bun.file(ok).size > 0
      && (await Bun.file(ok).text()).trim() === f.sha256;
    if (!have) {
      const url = `${base}/${mf.repo}/resolve/${mf.revision}/${f.path.split("/").map(encodeURIComponent).join("/")}`;
      await fetchChecked(url, dest, f, signal, (n) => { done += n; onProgress({ done, total: mf.bytes, file: f.path }); });
    } else {
      done += f.size;
      onProgress({ done, total: mf.bytes, file: f.path });
    }
  }
  return firstFile(home, mf);
}
