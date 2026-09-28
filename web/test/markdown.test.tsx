import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, plainPreview } from "../src/lib/markdown.tsx";

const html = (text: string, channels: string[] = []) =>
  renderToStaticMarkup(<Markdown text={text} opts={{ me: "alex", channels: new Set(channels) }} />);

test("teammate text can never become markup", () => {
  const out = html(`<img src=x onerror=alert(1)> <script>alert(2)</script> </walkie-message>`);
  expect(out).not.toContain("<img");
  expect(out).not.toContain("<script");
  expect(out).toContain("&lt;script&gt;");
});

test("only http(s) URLs become links", () => {
  expect(html("javascript:alert(1)")).not.toContain("<a ");
  expect(html("data:text/html,<b>x</b>")).not.toContain("<a ");
  const link = html("see https://example.com/a?b=1.");
  expect(link).toContain('href="https://example.com/a?b=1"');
  expect(link).toContain('rel="noopener noreferrer"');
});

test("code, bold, mentions and known channels", () => {
  const out = html("run `walkie who` then **ship** @alex/mbp/cc-1 in #build and #318", ["build"]);
  expect(out).toContain('<code class="md-code">walkie who</code>');
  expect(out).toContain("<strong>ship</strong>");
  expect(out).toContain("md-mention-me");
  expect(out).toContain('class="md-channel"');
  expect(out).not.toMatch(/md-channel[^>]*>#318/);
});

test("fenced code keeps content verbatim and escaped", () => {
  const out = html("```ts\nconst a = '<b>';\n```");
  expect(out).toContain('data-lang="ts"');
  expect(out).toContain("const a = &#x27;&lt;b&gt;&#x27;;");
});

test("plain preview flattens and truncates", () => {
  expect(plainPreview("a ```x``` **b**\n c", 100)).toBe("a [code] b c");
  expect(plainPreview("x".repeat(200), 10)).toHaveLength(10);
});
