// Model files for split runs (WALKIE-POOL-2): the GGUF files of a catalog model, pinned to a Hugging Face revision
// with each file's sha256 (src/pool/gguf.json), downloaded by the head into <home>/pool/models/<repo>/<revision>/,
// checked, then renamed into place. A person may also run a local .gguf file (`walkie pool run --file`).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
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

/** How often a broken download is resumed (HTTP Range from what is on disk) before the run fails. */
export const DOWNLOAD_RETRIES = 12;
const RETRY_BASE_MS = 2_000;

class Mismatch extends Error {}

/**
 * Downloads one pinned file to `<dest>.part`, resuming where a broken connection (or an earlier daemon) left off
 * with an HTTP Range request (POOL-REAL-1: a 9 GB model over a flaky home link broke mid-way), up to
 * DOWNLOAD_RETRIES times; the sha256 covers the whole file whichever way it arrived. Renamed into place and marked
 * `.ok` only when size and sha256 match the pin.
 */
async function fetchChecked(url: string, dest: string, f: FileRef, signal: AbortSignal, onBytes: (n: number) => void, retryMs = RETRY_BASE_MS): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const part = `${dest}.part`;
  let hash = createHash("sha256");
  let got = 0;
  if (existsSync(part)) {
    const size = statSync(part).size;
    if (size > f.size) rmSync(part, { force: true });
    else {
      // What an earlier attempt left: hashed once, then continued.
      for await (const chunk of Bun.file(part).stream()) { hash.update(chunk); got += chunk.byteLength; }
      onBytes(got);
    }
  }
  for (let attempt = 0; got < f.size; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow", signal, headers: got > 0 ? { Range: `bytes=${got}-` } : {} });
      if (got > 0 && res.status === 200) {
        // No range support: start over.
        await res.body?.cancel().catch(() => undefined);
        rmSync(part, { force: true });
        onBytes(-got);
        got = 0;
        hash = createHash("sha256");
        throw new Error("the server ignored the range; starting over");
      }
      if (!res.ok || !res.body) throw new Error(`download failed (${res.status}): ${f.path}`);
      const fh = await open(part, got > 0 ? "a" : "w", 0o600);
      try {
        for await (const chunk of res.body) {
          if (got + chunk.byteLength > f.size) throw new Mismatch(`${f.path} is larger than its pinned size`);
          hash.update(chunk);
          await fh.write(chunk);
          got += chunk.byteLength;
          onBytes(chunk.byteLength);
        }
      } finally {
        await fh.close();
      }
    } catch (err) {
      if (signal.aborted || err instanceof Mismatch || attempt >= DOWNLOAD_RETRIES) {
        if (err instanceof Mismatch) rmSync(part, { force: true });
        throw err;
      }
      await Bun.sleep(Math.min(60_000, retryMs * 2 ** Math.min(attempt, 5)));
    }
  }
  const sum = hash.digest("hex");
  if (got !== f.size || sum !== f.sha256) {
    rmSync(part, { force: true });
    throw new Error(`${f.path}: sha256 or size mismatch (expected ${f.sha256}, got ${sum}, ${got} of ${f.size} bytes)`);
  }
  renameSync(part, dest);
  writeFileSync(`${dest}.ok`, `${f.sha256}\n`, { mode: 0o600 });
}

/** One download per destination file, whoever asks (POOL-REAL-1 p8-10). */
interface Shared { promise: Promise<void>; ctl: AbortController; waiters: number; listeners: Set<(n: number) => void> }
const inFlight = new Map<string, Shared>();

/**
 * Joins the download of `dest` in progress, or starts it (POOL-REAL-1 p8-10: `walkie pool prepare` and a run or a
 * served model of the same model used to write the same `.part` independently). Every caller gets progress; the
 * download is cancelled only when every caller has cancelled, and a caller that cancels stops waiting at once.
 */
function sharedFetch(url: string, dest: string, f: FileRef, signal: AbortSignal, onBytes: (n: number) => void, retryMs?: number): Promise<void> {
  let e = inFlight.get(dest);
  if (!e) {
    const ctl = new AbortController();
    const listeners = new Set<(n: number) => void>();
    const promise = fetchChecked(url, dest, f, ctl.signal, (n) => { for (const l of listeners) l(n); }, retryMs)
      .finally(() => { if (inFlight.get(dest)?.promise === promise) inFlight.delete(dest); });
    e = { promise, ctl, waiters: 0, listeners };
    inFlight.set(dest, e);
  }
  const entry = e;
  entry.waiters++;
  entry.listeners.add(onBytes);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const leave = (): void => {
      if (settled) return;
      settled = true;
      entry.listeners.delete(onBytes);
      entry.waiters--;
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      leave();
      if (entry.waiters <= 0) entry.ctl.abort();
      reject(new Error("download cancelled"));
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(() => { leave(); resolve(); }, (err: unknown) => { leave(); reject(err); });
  });
}

/**
 * Downloads every file not already present and verified (a `.ok` marker with its sha256, written only after the
 * check passed). `base` lets tests point at a local server.
 */
export async function ensureFiles(home: string, mf: ModelFiles, signal: AbortSignal, onProgress: (p: DownloadProgress) => void, base = "https://huggingface.co", retryMs?: number): Promise<string> {
  let done = 0;
  for (const f of mf.files) {
    const dest = localPath(home, mf, f);
    const ok = `${dest}.ok`;
    const have = existsSync(dest) && existsSync(ok) && statSync(dest).size === f.size && Bun.file(ok).size > 0
      && (await Bun.file(ok).text()).trim() === f.sha256;
    if (!have) {
      const url = `${base}/${mf.repo}/resolve/${mf.revision}/${f.path.split("/").map(encodeURIComponent).join("/")}`;
      await sharedFetch(url, dest, f, signal, (n) => { done += n; onProgress({ done, total: mf.bytes, file: f.path }); }, retryMs);
    } else {
      done += f.size;
      onProgress({ done, total: mf.bytes, file: f.path });
    }
  }
  return firstFile(home, mf);
}
