// Trust rules for the iroh native modules scripts/build.ts embeds in release binaries (kept apart so tests can
// import them; build.ts runs on import). A module file is only ever used when its SHA-256 matches the pin in
// scripts/iroh-napi/SHA256SUMS; a cached darwin-x64 compile with no pin is never reused (it is rebuilt from source).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** "<version>/<file>" → pinned hex SHA-256, from a SHA256SUMS text ("<hex>  <version>/<file>" lines, # comments). */
export function parsePins(text: string): Map<string, string> {
  return new Map(text.split("\n").filter((l) => /^[0-9a-f]{64}\s/.test(l)).map((l) => {
    const [h, f] = l.split(/\s+/);
    return [f as string, h as string] as const;
  }));
}

/**
 * Whether a cached module at `path` may be reused: only when it matches its pin. A stale, modified or unpinned
 * cache file is deleted, so the caller builds a fresh one.
 */
export function reuseCached(path: string, want: string | undefined): boolean {
  if (!existsSync(path)) return false;
  if (want && sha256File(path) === want) return true;
  rmSync(path, { force: true });
  return false;
}

/** A freshly built module: must match its pin when there is one. Returns its SHA-256. */
export function checkBuilt(path: string, name: string, want: string | undefined): string {
  const got = sha256File(path);
  if (want && got !== want) throw new Error(`${name}: SHA-256 ${got} does not match the pin ${want}`);
  return got;
}
