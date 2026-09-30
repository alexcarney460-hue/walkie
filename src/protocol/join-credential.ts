// Walkie Direct invites and add-machine links carry the same wk1 bearer code.
// The join page reads it from /join#wk1...; installers and `walkie join` use the bare code.
// Best-effort content defense. The boundary is private delivery at mint time: content filtering cannot catch
// arbitrary encodings or pieces spread over separate writes. Walkie identifiers use other prefixes (event ids are
// hex:sequence, projects p-..., agents named by their caller); wk1_ is a possible bearer-code prefix.
const CODE = /wk1[A-Za-z0-9_-]{38,}/;
const STRIP = /[\s\u200B-\u200D\u2060\uFEFF]/g;

export function containsJoinCredential(text: string): boolean {
  if (CODE.test(text)) return true;
  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch { /* malformed escapes: still scan raw and stripped */ }
  return CODE.test(decoded.replace(STRIP, "")) || CODE.test(text.replace(STRIP, ""));
}

export function containsJoinCredentialBytes(bytes: Uint8Array): boolean {
  return containsJoinCredential(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
}

/** Scan each authored string before JSON escaping turns whitespace into backslash sequences. */
export function containsJoinCredentialValue(value: unknown): boolean {
  if (typeof value === "string") return containsJoinCredential(value);
  if (Array.isArray(value)) return value.some(containsJoinCredentialValue);
  if (value && typeof value === "object") return Object.values(value).some(containsJoinCredentialValue);
  return false;
}

/** Keep a person's own join code intact while the ordinary redactor handles the rest of the post. */
export function maskJoinCredentials(text: string): { masked: string; restore: (redacted: string) => string } {
  const codes: string[] = [];
  let marker = "WALKIE_JOIN_CODE_";
  while (text.includes(marker)) marker += "_";
  const masked = text.replace(new RegExp(CODE.source, "g"), (code: string) => {
    const index = codes.push(code) - 1;
    return `${marker}${index}_END`;
  });
  return { masked, restore: (redacted) => redacted.replace(new RegExp(`${marker}(\\d+)_END`, "g"),
    (match, index: string) => codes[Number(index)] ?? match) };
}
