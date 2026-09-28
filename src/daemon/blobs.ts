// Content-addressed blob files at blobs/<aa>/<hash> (25 MB cap).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_BLOB_BYTES = 25 * 1024 * 1024;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function blobPath(root: string, hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("invalid blob hash");
  return join(root, hash.slice(0, 2), hash);
}

/** Writes atomically (tmp + rename); returns the hash. */
export function writeBlob(root: string, bytes: Uint8Array): string {
  const hash = sha256Hex(bytes);
  const path = blobPath(root, hash);
  if (existsSync(path)) return hash;
  mkdirSync(join(root, hash.slice(0, 2)), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, bytes, { mode: 0o600 });
  renameSync(tmp, path);
  return hash;
}

export function readBlob(root: string, hash: string): Uint8Array | null {
  const path = blobPath(root, hash);
  if (!existsSync(path)) return null;
  const bytes = new Uint8Array(readFileSync(path));
  return sha256Hex(bytes) === hash ? bytes : null;
}
