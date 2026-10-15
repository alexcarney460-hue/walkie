import { expect, test } from "bun:test";
import { scrubPhrases } from "../../src/protocol/phrase-scrub.ts";

test("private titles in unspaced running text are removed", () => {
  expect(scrubPhrases("我们需要先完成秘密计划的工作", ["秘密计划"])).not.toContain("秘密计划");
  expect(scrubPhrases("極秘計画のため遅れています", ["極秘計画"])).not.toContain("極秘計画");
  expect(scrubPhrases("请先轮换保险库密钥再更新页面", ["轮换保险库密钥"])).not.toContain("轮换保险库密钥");
  expect(scrubPhrases("เราทำโครงการลับก่อน", ["โครงการลับ"])).not.toContain("โครงการลับ");
  expect(scrubPhrases("先做秘密-计划吧", ["秘密-计划"])).not.toContain("秘密-计划");
});

test("a one-token private title also matches separated words", () => {
  expect(scrubPhrases("Northwind Vault work blocks this", ["NorthwindVault"])).not.toContain("Northwind Vault");
  expect(scrubPhrases("North-wind work blocks this", ["Northwind"])).not.toContain("North-wind");
  expect(scrubPhrases("North_wind work blocks this", ["Northwind"])).not.toContain("North_wind");
  expect(scrubPhrases("NorthwindVault work blocks this", ["Northwind Vault"])).not.toContain("NorthwindVault");
});

test("a symbol-only private title is removed literally", () => {
  expect(scrubPhrases("the 🦄🚀 project is blocking", ["🦄🚀"])).not.toContain("🦄🚀");
  expect(scrubPhrases("work on ★★★ today", ["★★★"])).not.toContain("★★★");
});

test("ordinary short words and longer Latin words remain", () => {
  expect(scrubPhrases("se-ed seeding seed", ["seed"])).toBe("se-ed seeding");
  expect(scrubPhrases("NorthwindVaulted", ["NorthwindVault"])).toBe("NorthwindVaulted");
  expect(scrubPhrases("Northwind Vaulted", ["NorthwindVault"])).toBe("Northwind Vaulted");
});

test("Latin names are whole tokens at unspaced-script boundaries", () => {
  for (const sentence of ["Northwindの件で遅れています", "我们需要先完成Northwind的工作", "Northwind를 먼저 끝내야 합니다", "เราต้องทำNorthwindก่อน"]) {
    expect(scrubPhrases(sentence, ["Northwind"])).not.toContain("Northwind");
  }
  expect(scrubPhrases("seeding keys2", ["seed", "keys"])).toBe("seeding keys2");
});

test("ASCII punctuation titles are not phrases", () => {
  for (const title of ["-", "?", "..."]) {
    expect(scrubPhrases(`keep ${title} here`, [title])).toBe(`keep ${title} here`);
  }
  expect(scrubPhrases("keep 🦄 here", ["🦄"])).toBe("keep here");
});

test("one Hangul syllable does not match part of another syllable", () => {
  expect(scrubPhrases("각자 간다 가자", ["가"])).toBe("각자 간다 자");
});
