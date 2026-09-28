// The Data Room's secret warning (DATA-ROOM-1): text uploads are scanned with the post redactor's detectors before
// they are shared. The scan only reports; the file's bytes are never changed (a person may upload anyway).
import { redactSecrets } from "../safety.ts";

/** How much of a text file is scanned (the first 64 KB get every pass, the rest the linear ones: safety.ts). */
export const SCAN_BYTES = 4 * 1024 * 1024;
const SNIFF_BYTES = 64 * 1024;
const TEXT_MIME = /^(text\/|application\/(json|ld\+json|x-ndjson|xml|yaml|x-yaml|toml|javascript|x-javascript|typescript|x-sh|x-shellscript|sql|csv|x-httpd-php|x-python|x-ruby|graphql)\b)/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|ps1|py|rb|js|mjs|cjs|ts|tsx|jsx|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sql|html?|css|xml|svg|log|pem|key|tf|tfvars|properties|gradle|dockerfile|gitignore|npmrc|netrc|pgpass)$/i;

const BINARY_MIME = /^((image|video|audio|font)\/|application\/(pdf|zip|gzip|x-gzip|x-tar|x-7z-compressed|x-bzip2|x-rar-compressed|wasm|msword|vnd\.)).*/i;

/** Whether the type says binary (not text by type or name; no bytes needed). An unknown type is neither. */
export function binaryByType(mime: string, name: string): boolean {
  return !textByType(mime, name) && BINARY_MIME.test(mime);
}

/** Whether the type or the name says text (no bytes needed). */
export function textByType(mime: string, name: string): boolean {
  return TEXT_MIME.test(mime) || TEXT_EXT.test(name) || /^\.env(\.|$)/i.test(name);
}

/**
 * Whether bytes are text: a text mime or extension, else valid UTF-8 without NUL bytes in the first 64 KB (a multi-byte
 * character cut at the end of that window is fine).
 */
export function looksText(bytes: Uint8Array, mime: string, name: string): boolean {
  const head = bytes.subarray(0, SNIFF_BYTES);
  if (head.includes(0)) return false;
  if (textByType(mime, name)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: bytes.length > SNIFF_BYTES });
    return true;
  } catch {
    return false;
  }
}

export interface ScanResult {
  /** Scanned as text. */
  text: boolean;
  /** Detector kinds found (deduplicated, sorted); empty = nothing found. */
  findings: string[];
  /** Only the first SCAN_BYTES were scanned. */
  partial: boolean;
}

/**
 * Scans an upload for secrets with the post redactor's detectors. "Random-looking token" findings alone don't count
 * (they would flag every lockfile, hash list and UUID table); provider tokens, key blocks and credentials in context do.
 */
export function scanUpload(bytes: Uint8Array, mime: string, name: string): ScanResult {
  if (!looksText(bytes, mime, name)) return { text: false, findings: [], partial: false };
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, SCAN_BYTES));
  const kinds = new Set(redactSecrets(text).redactions.filter((k) => k !== "high_entropy"));
  return { text: true, findings: [...kinds].sort(), partial: bytes.length > SCAN_BYTES };
}
