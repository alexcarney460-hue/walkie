// PROJECT-REPORTS-1: a join code, a link or a key cannot be hidden from the checks by what is written between its letters.
// A letter and an accent that composes (w + acute is one character, which is a letter, not a mark) and the blank-looking
// letters outside the control, format and mark classes (Hangul fillers, the braille blank, the object replacement mark) broke
// the run of ASCII characters the checks look for, while a model reads straight through them. The checks therefore run on the
// text's bare letters (decomposed, marks, controls, format characters and fillers taken out), and what is shown keeps its
// accents. Every code here is random bytes in the shape of an invite, never a real one; every non-ASCII character is spelled
// by its code point.
import { describe, expect, test } from "bun:test";
import { containsJoinCredential } from "../../src/protocol/join-credential.ts";
import { bareLetters, cleanReport, composeReport, plainTitle, safeText } from "../../src/protocol/projects/status-report.ts";

const U = (...cps: number[]) => String.fromCodePoint(...cps);
const ACUTE = U(0x301);
const WITHHELD = "(text withheld)";
const prefixes = ["WEB"];

/** A small deterministic generator, so a failure names the same code every run. */
function prng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; };
}
/** `wk1` and base64url of 141 random bytes: the shape and the length of a real invite code (it is never one). */
function randomCode(rand: () => number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return `wk1${Array.from({ length: 188 }, () => alphabet[Math.floor(rand() * 64)]).join("")}`;
}
const COMPOSES = new Set([..."ACEGIKLMNOPRSUWYZacegiklmnoprsuwyz"]); // letters that have a precomposed form with an acute
/** An acute on a composing letter at least every `every` characters (the first after the `wk1` prefix). */
function accented(code: string, every: number): string {
  let out = "";
  let run = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i] as string;
    out += ch;
    run++;
    if (i >= 3 && run >= every && COMPOSES.has(ch)) { out += ACUTE; run = 0; }
  }
  return out;
}
/** A blank-looking character after every fifth character. */
const filled = (code: string, filler: number) => [...code].map((ch, i) => (i % 5 === 4 ? ch + U(filler) : ch)).join("");
/** One of each kind of character that has no width or no look of its own, by the class that takes it out of the bare letters. */
const FILLERS: Array<[string, number]> = [
  // blank-looking letters and symbols (not controls, format characters or marks)
  ["HANGUL FILLER", 0x3164], ["HALFWIDTH HANGUL FILLER", 0xffa0], ["HANGUL CHOSEONG FILLER", 0x115f], ["HANGUL JUNGSEONG FILLER", 0x1160],
  ["BRAILLE PATTERN BLANK", 0x2800], ["OBJECT REPLACEMENT CHARACTER", 0xfffc],
  // private use, unassigned and a lone surrogate
  ["A PRIVATE USE CHARACTER", 0xe000], ["AN UNASSIGNED CODE POINT", 0x378], ["A LONE SURROGATE", 0xd800],
  // format characters
  ["ZERO WIDTH SPACE", 0x200b], ["SOFT HYPHEN", 0xad], ["WORD JOINER", 0x2060], ["BYTE ORDER MARK", 0xfeff], ["ARABIC LETTER MARK", 0x61c], ["A TAG CHARACTER", 0xe0061],
  ["ARABIC NUMBER SIGN (a format character that is not default-ignorable)", 0x600],
  // marks
  ["COMBINING GRAPHEME JOINER", 0x34f], ["VARIATION SELECTOR-16", 0xfe0f],
  // controls (not tab or line feed)
  ["BELL", 0x07], ["VERTICAL TAB", 0x0b], ["DELETE", 0x7f], ["NEXT LINE", 0x85],
];
const title = (s: string) => `Rotate ${s} for the Dave account`;

describe("a join code disguised so that its letters do not run together", () => {
  const body = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt".slice(0, 44);
  const cases: Array<[string, string]> = [
    ["an acute on the w", `w${ACUTE}k1${body}`],
    ["an acute on the k", `wk${ACUTE}1${body}`],
    ["a grave on the w and a diaeresis on the k", `w${U(0x300)}k${U(0x308)}1${body}`],
    ["an acute on three letters of the body", `wk1${body.replace("A", `A${ACUTE}`).replace("E", `E${ACUTE}`).replace("O", `O${ACUTE}`)}`],
    ["a cedilla and an ogonek that compose", `wk1${body.replace("A", `A${U(0x328)}`).replace("S", `S${U(0x327)}`)}`],
    ["a mark that does not compose (it was already caught)", `wk1${U(0x338)}${body}`],
    ["an acute on every twelfth character", accented(`wk1${body}`, 12)],
  ];
  for (const [label, code] of cases) {
    test(`${label}: the title is withheld, as the plain code is`, () => {
      expect(safeText(title(code), 300)).toBe(WITHHELD);
      expect(plainTitle(title(code), prefixes, 300)).toBe(WITHHELD);
    });
  }
  test("the plain code is withheld too (the control)", () => {
    expect(safeText(title(`wk1${body}`), 300)).toBe(WITHHELD);
  });

  test("random codes with an acute at least every 12, 20 or 28 characters are withheld, every one of 300 at each spacing", () => {
    const rand = prng(20261001);
    for (const every of [12, 20, 28]) {
      let reached = 0;
      for (let i = 0; i < 300; i++) {
        const code = accented(randomCode(rand), every);
        if (plainTitle(title(code), prefixes, 600) !== WITHHELD) reached++;
      }
      expect(reached).toBe(0);
    }
  });

  test("random codes with one acute on the w, or on one letter of the body, are withheld", () => {
    const rand = prng(7);
    let reached = 0;
    for (let i = 0; i < 500; i++) {
      const code = randomCode(rand);
      const onW = `w${ACUTE}${code.slice(1)}`;
      const at = 3 + Math.floor(rand() * 38);
      const onBody = [...code].map((ch, k) => (k === at && COMPOSES.has(ch) ? ch + ACUTE : ch)).join("");
      for (const v of [onW, onBody]) if (plainTitle(title(v), prefixes, 600) !== WITHHELD) reached++;
    }
    expect(reached).toBe(0);
  });

  for (const [name, filler] of FILLERS) {
    test(`${name} (U+${filler.toString(16).toUpperCase()}) every five characters does not hide a code`, () => {
      const rand = prng(filler);
      for (let i = 0; i < 20; i++) expect(plainTitle(title(filled(randomCode(rand), filler)), prefixes, 600)).toBe(WITHHELD);
    });
  }
});

describe("a link or a key disguised the same ways", () => {
  const key = `sk-ant-api03-${"Qz7_".repeat(12)}`;
  test("a link whose scheme has an accent that composes, or a blank-looking letter in it, is a link", () => {
    for (const disguised of [
      `https${ACUTE}`, // an acute on the s of https: s and the accent are one character
      `h${U(0x308)}ttps`, // a diaeresis on the h
      `h${U(0x3164)}ttps`, `ht${U(0xffa0)}tps`, `htt${U(0x2800)}ps`, `http${U(0xfffc)}s`,
    ]) {
      const out = safeText(`see ${disguised}://evil.example/x now`, 200);
      expect(out).not.toContain("evil.example");
      expect(out).toContain("(link)");
    }
  });
  test("a key with an accent that composes, or a blank-looking letter in it, is redacted", () => {
    for (const disguised of [
      `s${ACUTE}${key.slice(1)}`, `sk${U(0x3164)}${key.slice(2)}`, `sk-${U(0x2800)}ant-api03-${key.slice(13)}`, `sk-ant-api03-${key.slice(13, 25)}${U(0xfffc)}${key.slice(25)}`,
    ]) {
      const out = safeText(`key ${disguised} end`, 300);
      expect(out).not.toMatch(/sk-ant/i);
      expect(out).not.toContain("Qz7_Qz7_Qz7_");
    }
  });
  test("a key written straight after an accented letter is redacted: the accent ends a word where it is shown, and the bare letters would run the two together", () => {
    // \b in the key patterns sees é as a separator but the e in its bare form as part of the word, so the bare letters alone would miss these.
    const keys: Array<[string, string]> = [
      ["AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7"], // the documentation example, not a key
      [`sk-ant-api03-${"Qz7_".repeat(12)}`, "Qz7_Qz7"],
      ["xoxb-123456789012-abcdefghijkl", "123456789012"],
      [`npm_${"ab12".repeat(6)}`, "ab12ab12"],
    ];
    for (const [key, body] of keys) {
      const out = safeText(`Caf${U(0xe9)}${key} here`, 200);
      expect(out).not.toContain(body);
      expect(out).toContain("[REDACTED:");
      expect(out.startsWith(`Caf${U(0xe9)}`)).toBe(true); // what is shown keeps its accent when only the shown text had the find
    }
  });
  test("a long key met at its front by one view and in full by the other is redacted whole, not left with a tail", () => {
    const out = safeText(`key sk-ant-api03-${"Qz7_".repeat(3)}${U(0xfffc)}${"Qz7_".repeat(9)} end`, 300);
    expect(out).not.toMatch(/sk-ant/i);
    expect(out).not.toContain("Qz7_Qz7_");
  });
  test("a card key with an accent that composes (W + acute) is stripped from a title", () => {
    expect(plainTitle(`W${ACUTE}EB-12 fix pricing`, ["WEB"])).toBe("fix pricing");
    expect(plainTitle(`Fix pricing (W${U(0x3164)}EB-12-7f3a09c1)`, ["WEB"])).toBe("Fix pricing");
  });
});

describe("what is shown keeps its accents", () => {
  test("ordinary text with accents, other scripts and a typographic ellipsis is unchanged", () => {
    expect(safeText("Café résumé rollout for München, 東京 and São Paulo", 80)).toBe("Café résumé rollout for München, 東京 and São Paulo");
    expect(plainTitle("Café résumé pricing page", prefixes)).toBe("Café résumé pricing page");
  });
  test("a plain link beside accents is replaced and the accents stay", () => {
    expect(safeText("Café résumé https://example.com/a for Zoë", 80)).toBe("Café résumé (link) for Zoë");
  });
  test("a plain key beside accents is redacted and the accents stay", () => {
    const out = safeText("Zoë uses sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA at the café", 100);
    expect(out).toContain("Zoë");
    expect(out).toContain("café");
    expect(out).not.toContain("sk-ant-api03");
  });
  test("when a disguised link is found beside accents, the text is said as its bare letters, link taken out", () => {
    expect(safeText(`Café h${U(0x308)}ttps://evil.example/x for Zoë`, 80)).toBe("Cafe (link) for Zoe");
  });
  test("a decomposed accent is shown composed, and a mark that composes with nothing is dropped", () => {
    expect(safeText(`Cafe${ACUTE} re${ACUTE}sume${ACUTE} 5${ACUTE}`, 80)).toBe(`Caf${U(0xe9)} r${U(0xe9)}sum${U(0xe9)} 5`);
    expect(plainTitle(`Cafe${ACUTE} pricing`, prefixes)).toBe(`Caf${U(0xe9)} pricing`);
  });
  test("a control character inside a word is dropped, not turned into a space, and so is a mark that composes with nothing", () => {
    expect(safeText(`re${U(7)}sume ${U(0x85)}done 5${ACUTE}`, 80)).toBe("resume done 5");
  });
  test("a text in a script that composes (Hangul) keeps its syllables whole when a disguised link makes it be said in its bare letters", () => {
    const hangul = U(0xd55c, 0xad6d, 0xc5b4); // han, guk, eo
    expect(safeText(`${hangul} h${U(0x308)}ttps://evil.example/x`, 80)).toBe(`${hangul} (link)`);
    expect(bareLetters(hangul)).toBe(hangul);
  });
  test("the bare letters are what a reader strips a text down to, and nothing is made of nothing", () => {
    expect(bareLetters(`w${ACUTE}k1`)).toBe("wk1");
    expect(bareLetters(`h${U(0x3164)}t${U(0x2800)}tp${U(0xfffc)}s`)).toBe("https");
    expect(bareLetters("Café résumé")).toBe("Cafe resume");
    expect(bareLetters(U(0xff57, 0xff4b, 0xff11))).toBe("wk1"); // fullwidth
    expect(bareLetters("a\tb\nc d")).toBe("a\tb\nc d"); // tabs, newlines and spaces still separate words
    expect(bareLetters("")).toBe("");
  });
});

describe("the same on the reply side", () => {
  const sentence = (code: string) => `**On track.** The team pasted ${code} into a card today and nothing else changed this hour.`;
  /** 30 characters of the code's body, in order, are in the text once accents, fillers and everything that is not a code character are ignored. */
  const material = (text: string, code: string) => bareLetters(text).replace(/[^A-Za-z0-9_-]/g, "").includes(code.slice(3, 33));
  test("a disguised code a model copies into its report does not reach the post: it is taken out like a plain one, or the report is voided", () => {
    const rand = prng(99);
    let leaked = 0;
    let removed = 0;
    let daemonWouldMiss = 0;
    for (let i = 0; i < 300; i++) {
      const code = randomCode(rand);
      for (const disguised of [accented(code, 12), accented(code, 28), `w${ACUTE}${code.slice(1)}`, filled(code, 0x3164), filled(code, 0x2800)]) {
        const clean = cleanReport(sentence(disguised), { prefixes });
        if (clean !== null && material(clean, code)) leaked++;
        if (clean !== null && !containsJoinCredential(bareLetters(clean))) removed++;
        if (!containsJoinCredential(sentence(disguised))) daemonWouldMiss++;
      }
    }
    expect(leaked).toBe(0);
    expect(removed).toBeGreaterThan(1_400); // posted with the code taken out, in all but the few the entropy redactor or a void dealt with
    expect(daemonWouldMiss).toBeGreaterThan(1_000); // the daemon's post-time check cannot see these: this check is what stops them
  });
  test("a disguised code in a report is taken out, and the rest of the report stands", () => {
    const clean = cleanReport(sentence(accented(randomCode(prng(3)), 12)), { prefixes });
    expect(clean).toBe("**On track.** The team pasted (code removed) into a card today and nothing else changed this hour.");
  });
  test("a disguised link in a report is taken out; the report goes out in its bare letters", () => {
    const clean = cleanReport(`**On track.** See h${U(0x308)}ttps://evil.example/x for the Zoë plan, as agreed this hour with the team.`, { prefixes });
    expect(clean).not.toBeNull();
    expect(clean).not.toContain("evil.example");
    expect(clean).toContain("(link removed)");
  });
  test("a disguised key in a report is redacted", () => {
    const clean = cleanReport(`**On track.** The key sk${U(0x3164)}-ant-api03-${"Qz7_".repeat(12)} was rotated this hour by the team.`, { prefixes });
    expect(clean).not.toBeNull();
    expect(clean).not.toMatch(/sk-ant/i);
    expect(clean).not.toContain("Qz7_Qz7_Qz7_");
  });
  test("a report with accents, a typographic ellipsis and a non-breaking space is unchanged", () => {
    const report = `**On track:** Café résumé shipped${U(0x2026)} the São Paulo team agrees${U(0xa0)}today.`;
    expect(cleanReport(report, { prefixes })).toBe(report);
  });
  test("a wk1 that is a week, in a report with accents, is posted as written: not a code, and the daemon's check does not take it for one", () => {
    const report = "**On track.** The wk1 plan for São Paulo and Zürich rollout was finished early by the team today and the next steps follow.";
    expect(containsJoinCredential(report)).toBe(false);
    expect(cleanReport(report, { prefixes })).toBe(report);
  });
  test("a code that is both spaced and accented is voided, not posted: the bare letters make it contiguous", () => {
    const spaced = `wk1 ${"AbCd ".repeat(12)}Zo${U(0xeb)} shared with the team today.`;
    expect(containsJoinCredential(spaced)).toBe(true);
    expect(cleanReport(`**Fine.** ${spaced}`, { prefixes })).toBeNull();
    const hidden = `w${ACUTE}k1 ${"AbCd ".repeat(12)}shared with the team today.`;
    expect(containsJoinCredential(hidden)).toBe(false); // the daemon's own check misses it
    expect(cleanReport(`**Fine.** ${hidden}`, { prefixes })).toBeNull();
  });
  test("a wk1 followed by what a code is made of is a code, accents or not", () => {
    expect(cleanReport(`**Fine.** wk1 ${"AbCd ".repeat(12)}Zoë shared with the team today.`, { prefixes })).toBeNull();
  });
  test("a header naming the project is judged the same way: a disguised code in a project's name is withheld", () => {
    const code = randomCode(prng(5));
    expect(composeReport(`Site ${accented(code, 12)}`, Date.UTC(2026, 9, 1, 14, 0), "body text here for the report")).toContain(WITHHELD);
  });
  test("hostile text with characters that are not ASCII costs next to nothing: the bare pass is bounded too", () => {
    const time = (f: () => unknown) => Math.min(...[1, 2, 3].map(() => { const t0 = performance.now(); f(); return performance.now() - t0; }));
    const hostile = [
      `${U(0xe9)}[a](`.repeat(3_900), `[a]${U(0x3164)}(${" ".repeat(8)}`.repeat(1_500), `${"ht".repeat(2_000)}${U(0x301)}tps://x`, `${"x".repeat(15_000)}${U(0xe9)}`,
      `**x** ${"[a](".repeat(1_900)}${U(0x2026)}${"b".repeat(8_000)}`, `${U(0xff57)}${U(0xff4b)}1${"A".repeat(60)}`.repeat(300),
    ];
    for (const text of hostile) expect(time(() => cleanReport(text, { prefixes }))).toBeLessThan(250);
  });
});
