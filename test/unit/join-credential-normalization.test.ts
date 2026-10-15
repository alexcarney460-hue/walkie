import { expect, test } from "bun:test";
import { containsJoinCredential, containsJoinCredentialBytes, containsJoinCredentialValue,
  maskJoinCredentials } from "../../src/protocol/join-credential.ts";

const fullWidth = (text: string) => text.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
const suffix = "Az09_-".repeat(24); // An unusable synthetic pattern, never a minted credential.

for (const prefix of ["wk1", "wl1"]) {
  const token = prefix + suffix;
  const wide = fullWidth(token);
  const forms = [
    ["full-width", wide],
    ["wrapped full-width", wide.match(/.{1,8}/g)!.join("\u200b\n")],
    ["encoded full-width", encodeURIComponent(wide)],
    ["full-width percent escapes", fullWidth(token.split("").map((c) => `%${c.charCodeAt(0).toString(16)}`).join(""))],
    ["malformed escape beside full-width", `%zz ${wide}`],
    ["mixed compatible prefix", fullWidth(prefix) + suffix],
  ] as const;

  for (const [name, text] of forms) {
    test(`${prefix} ${name} is detected in strings, nested values and UTF-8 bytes`, () => {
      expect(containsJoinCredential(text)).toBe(true);
      expect(containsJoinCredentialValue({ nested: [{ text }] })).toBe(true);
      expect(containsJoinCredentialBytes(new TextEncoder().encode(text))).toBe(true);
    });
  }

  test(`${prefix} deliberate person delivery still restores the original spelling`, () => {
    const original = `Private delivery: ${token}`;
    const masked = maskJoinCredentials(original);
    expect(masked.masked.includes(token)).toBe(false);
    expect(masked.restore(masked.masked) === original).toBe(true);
  });
}

test("normalization does not make short markers or ordinary Unicode prose into credentials", () => {
  for (const text of ["ｗｋ１", "ｗｌ１", "Fleet instructions are ready.", "通常の作業メモ", "Full-width ｆｌｅｅｔ notes"]) {
    expect(containsJoinCredential(text)).toBe(false);
    expect(containsJoinCredentialBytes(new TextEncoder().encode(text))).toBe(false);
  }
});

for (const [name, separator] of [
  ["soft hyphen", "\u00ad"], ["combining grapheme joiner", "\u034f"],
  ["Arabic letter mark", "\u061c"], ["Mongolian vowel separator", "\u180e"],
  ["left to right mark", "\u200e"], ["directional override", "\u202e"],
  ["invisible times", "\u2062"], ["variation selector", "\ufe0f"],
  ["supplementary variation selector", "\u{e0100}"],
] as const) {
  test(`wl1 split by ${name} is detected`, () => {
    const text = `w${separator}l1${suffix.slice(0, 12)}${separator}${suffix.slice(12)}`;
    expect(containsJoinCredential(text)).toBe(true);
    expect(containsJoinCredentialValue({ nested: [text] })).toBe(true);
    expect(containsJoinCredentialBytes(new TextEncoder().encode(text))).toBe(true);
  });
}
