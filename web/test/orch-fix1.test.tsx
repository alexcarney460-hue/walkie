// ORCH-FIX-1 (ALE-5233): the Orchestrator tab's Markdown renderer (docs/audits/2026-09-26-opus-orch.md). The view model is
// tested in orchestrator.test.tsx (ORCH-FIX-11: the tab shows only this machine's local conversation).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RichMarkdown } from "../src/lib/markdown-rich.tsx";

const html = (text: string) => renderToStaticMarkup(<RichMarkdown text={text} opts={{ me: "alex", channels: new Set() }} />);

function timed(text: string): number {
  const t0 = performance.now();
  html(text);
  return performance.now() - t0;
}

describe("no regex in the renderer backtracks super-linearly (Opus MEDIUM 4)", () => {
  const N = 30_000;
  const cases: [string, string][] = [
    ["heading", `# a${" ".repeat(N)}b`],
    ["heading closing hashes", `## a${" #".repeat(N / 2)}x`],
    ["fence", `\`\`\`${" ".repeat(N)}x`],
    ["rule", `-${" ".repeat(N)}x`],
    ["rule dashes", `${"- ".repeat(N / 2)}x`],
    ["quote", `>${" ".repeat(N)}x`],
    ["list item", `${" ".repeat(N)}x`],
    ["table separator", `a|b\n${" ".repeat(N)}x`],
    ["table separator trailing", `a|b\n|--|${" ".repeat(N)}x`],
    ["table cells", `a|b\n${"|--".repeat(N / 3)}x`],
    ["inline stars", `${"*a".repeat(N / 2)}`],
    ["inline underscores", `${" _a".repeat(N / 3)}`],
    ["inline links", `${"[a](".repeat(N / 4)}`],
    ["inline unclosed link openers", "[".repeat(N)],
    ["inline unclosed code", `\`${"a".repeat(N)}`],
    ["inline unclosed bold", `**${"a b".repeat(N / 3)}`],
  ];
  // (A line that is thousands of tiny `code` spans is linear too, just many React elements: not a regex case.)
  for (const [name, text] of cases) {
    test(`${name}: a ${text.length}-char adversarial line renders in < 50 ms`, () => {
      timed(text); // warm up
      expect(timed(text)).toBeLessThan(50);
    });
  }

  test("headings still render as before", () => {
    expect(html("# Title")).toContain(">Title</h2>");
    expect(html("## Title ##")).toContain(">Title</h3>");
    expect(html("### Title #hash")).toContain(">Title #hash</h4>");
    expect(html("#### C# ###")).toContain(">C#</h5>");
    expect(html("#hashtag")).not.toContain("<h");
    expect(html("```ts\ncode\n```")).toContain(">ts</span>");
    expect(html("``` ts \ncode\n```")).toContain(">ts</span>");
  });
});
