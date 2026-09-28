// ORCH-FIX-2 (ALE-5233): the renderer against the round-2 audits (docs/audits/2026-09-26-*-orch-r2.md).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RichMarkdown } from "../src/lib/markdown-rich.tsx";
import { MessageBoundary } from "../src/views/orchestrator/Messages.tsx";

const html = (text: string) => renderToStaticMarkup(<RichMarkdown text={text} opts={{ me: "alex", channels: new Set() }} />);

function timed(text: string): number {
  const t0 = performance.now();
  html(text);
  return performance.now() - t0;
}

const N = 30_000;
const LS = " ";
const PS = " ";

describe("Codex MEDIUM 3 / Opus MEDIUM 2: JavaScript line terminators don't make block patterns quadratic", () => {
  const cases: [string, string][] = [
    ["heading + U+2028", `#${" ".repeat(N)}${LS}x`],
    ["heading + U+2029", `#${" ".repeat(N)}${PS}x`],
    ["heading text + U+2028", `# a${" ".repeat(N)}${LS}x`],
    ["fence + U+2028", `${"`".repeat(N)}${LS}x`],
    ["tilde fence + U+2029", `${"~".repeat(N)}${PS}x`],
    ["fence info + U+2028", `\`\`\`${" ".repeat(N)}${LS}x`],
    ["quote + U+2028", `>${" ".repeat(N)}${LS}x`],
    ["list item + U+2028", `-${" ".repeat(N)}${LS}x`],
    ["indented item + U+2029", `${" ".repeat(N)}-${PS}x`],
    ["rule + U+2028", `---${" ".repeat(N)}${LS}x`],
    ["table separator + U+2028", `a|b\n|--|${" ".repeat(N)}${LS}x`],
    ["lone CR lines", `#${" ".repeat(N)}\rx`],
  ];
  for (const [name, text] of cases) {
    test(`${name}: ${text.length} chars render in < 50 ms`, () => {
      timed(text); // warm up
      expect(timed(text)).toBeLessThan(50);
    });
  }

  test("U+2028/U+2029 end a line like \\n does", () => {
    expect(html(`# Title${LS}body`)).toContain(">Title</h2>");
    expect(html(`\`\`\`ts${PS}code${PS}\`\`\``)).toContain(">ts</span>");
    expect(html(`- one${LS}- two`)).toContain("<li>two</li>");
  });
});

describe("Opus MEDIUM 3: deep quote nesting neither overflows the stack nor takes the tab down", () => {
  test('">".repeat(3000) renders (nesting capped at 8) in < 50 ms', () => {
    const text = ">".repeat(3000);
    let out = "";
    expect(() => { out = html(text); }).not.toThrow();
    expect(out.split("<blockquote").length - 1).toBe(8);
    expect(timed(`${text}\n${text}`)).toBeLessThan(50);
  });

  test("ordinary nested quotes still nest", () => {
    const out = html("> outer\n> > inner");
    expect(out.split("<blockquote").length - 1).toBe(2);
    expect(out).toContain("inner");
  });

  test("a message that throws while rendering falls back to its plain text; the next text gets a fresh try", () => {
    expect(MessageBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const b = new MessageBoundary({ text: "**broken** reply", children: null });
    b.state = { failed: true, text: "**broken** reply" };
    const fallback = renderToStaticMarkup(<>{b.render()}</>);
    expect(fallback).toContain("**broken** reply");
    expect(fallback).toContain("orch-plain");
    expect(MessageBoundary.getDerivedStateFromProps({ text: "next chunk", children: null }, { failed: true, text: "**broken** reply" }))
      .toEqual({ failed: false, text: "next chunk" });
    expect(MessageBoundary.getDerivedStateFromProps({ text: "same", children: null }, { failed: true, text: "same" })).toBeNull();
  });
});
