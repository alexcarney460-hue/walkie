// Sqwakie Direct invites carry wk1 bearer codes; reusable fleet links carry wl1 bearer tokens.
// The join page reads it from /join#wk1...; installers and `walkie join` use the bare code.
// Best-effort content defense. The boundary is private delivery at mint time: content filtering cannot catch
// arbitrary encodings or pieces spread over separate writes. Sqwakie identifiers use other prefixes (event ids are
// hex:sequence, projects p-..., agents named by their caller); wk1_ is a possible bearer-code prefix.
const CODE = /w[kl]1[A-Za-z0-9_-]{38,}/;
const STRIP = /[\s\p{Default_Ignorable_Code_Point}]/gu;

export function containsJoinCredential(text: string): boolean {
  if (CODE.test(text) || CODE.test(text.replace(STRIP, ""))) return true;
  // Detection only: preserve authored text, but recognize compatible spellings such as full-width ASCII.
  const normalized = text.normalize("NFKC");
  if (CODE.test(normalized.replace(STRIP, ""))) return true;
  // Normalization can turn unrelated compatible percent punctuation into an invalid escape.
  // Keep the original decoding path as well, so a new spelling cannot suppress an existing match.
  for (const candidate of normalized === text ? [text] : [text, normalized]) {
    try {
      const decoded = decodeURIComponent(candidate);
      // Canonical composition may change an ASCII match; normalized scans are strictly additive.
      if (CODE.test(decoded.replace(STRIP, "")) || CODE.test(decoded.normalize("NFKC").replace(STRIP, ""))) return true;
    } catch { /* the other spelling and the undecoded text are checked independently */ }
  }
  return false;
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
