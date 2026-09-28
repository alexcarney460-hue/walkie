// The one credential scrubber for everything that leaves a connector: HTTP and GraphQL errors, thrown
// errors, route responses, MCP tool errors, log lines and every field of an emitted event. It removes
// the exact configured keys (and their URL-/JSON-encoded spellings) first, then anything shaped like a
// secret (redactSecrets patterns). Callers truncate AFTER scrubbing, so a cut never leaves half a key.
import { redactSecrets } from "../protocol/safety.ts";

/** Shorter strings are never treated as keys (they would match ordinary words). */
export const MIN_SECRET_CHARS = 8;
export const KEY_PLACEHOLDER = "[REDACTED:key]";

function spellings(secret: string): string[] {
  const out = new Set<string>([secret]);
  out.add(encodeURIComponent(secret));
  out.add(JSON.stringify(secret).slice(1, -1));
  return [...out].filter((s) => s.length >= MIN_SECRET_CHARS);
}

/** Replaces only the known secrets (every spelling), leaving other text exactly as it was. */
export function scrubKnown(text: string, knownSecrets: readonly (string | null | undefined)[]): string {
  let out = text;
  const secrets = [...new Set(knownSecrets.filter((s): s is string => typeof s === "string" && s.length >= MIN_SECRET_CHARS))]
    .sort((a, b) => b.length - a.length); // longest first: a key that contains another is removed whole
  for (const secret of secrets) {
    for (const s of spellings(secret)) out = out.split(s).join(KEY_PLACEHOLDER);
  }
  return out;
}

/** Replaces every known secret and every secret-shaped token in `text`. */
export function scrubSecrets(text: string, knownSecrets: readonly (string | null | undefined)[]): string {
  return redactSecrets(scrubKnown(text, knownSecrets)).text;
}

/**
 * scrubSecrets on every string leaf of a structured value (a parsed API response, a meeting, a note):
 * external fields are scrubbed BEFORE they are cached, formatted, truncated or returned (#2/#3).
 * Numbers, booleans and null pass through; the shape is kept.
 */
export function scrubDeep<T>(value: T, knownSecrets: readonly (string | null | undefined)[]): T {
  if (typeof value === "string") return scrubSecrets(value, knownSecrets) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => scrubDeep(v, knownSecrets)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubDeep(v, knownSecrets);
    return out as T;
  }
  return value;
}

/** scrubSecrets, then a length cap (for error messages and log fields). */
export function scrubMessage(text: string, knownSecrets: readonly (string | null | undefined)[], max = 300): string {
  const out = scrubSecrets(text, knownSecrets);
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

/** An Authorization header value and the bare key inside it ("Bearer <key>" → both). */
export function secretsOfAuth(auth: string): string[] {
  return [auth, auth.replace(/^Bearer\s+/i, "")];
}
