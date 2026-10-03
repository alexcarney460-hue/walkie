// LOCAL-MODELS-HF-1 review F1: the pick rows are a two-column grid (label | text); at phone width they are one column.
// A pick's meta line is placed in column 2, so on a phone it must be put back in column 1, or the grid grows a second
// column and the real one collapses to a sliver (the text wrapped one word per line). Checked on the stylesheet itself,
// and without :has(), which the older WebKit builds the desktop app can run on do not all have.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles/local-models.css", import.meta.url), "utf8");

/** The text inside every `@media (max-width: 560px) { ... }` block: the phone rules. */
function phoneRules(src: string): string {
  const out: string[] = [];
  for (let at = src.indexOf("@media (max-width: 560px)"); at >= 0; at = src.indexOf("@media (max-width: 560px)", at + 1)) {
    const open = src.indexOf("{", at);
    let depth = 1;
    let i = open + 1;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    out.push(src.slice(open + 1, i - 1));
  }
  return out.join("\n");
}
const phone = phoneRules(css);

test("the stylesheet has a phone block", () => {
  expect(phone.length).toBeGreaterThan(100);
  expect(phone).toMatch(/\.lm-pick\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test("on a phone the meta line goes back to column 1, so the grid keeps its one column", () => {
  expect(css).toMatch(/\.lm-pick-meta\s*\{[^}]*grid-column:\s*2/); // the two-column layout above the phone width
  expect(phone).toMatch(/\.lm-pick-meta\s*\{[^}]*grid-column:\s*1\s*;/);
});

test("on a phone the label takes no row span, with or without a meta line", () => {
  expect(phone).toMatch(/\.lm-pick-label\s*\{[^}]*grid-row:\s*auto/);
  expect(phone).toMatch(/\.lm-pick\.has-meta\s+\.lm-pick-label\s*\{[^}]*grid-row:\s*auto/);
});

test("no rule outside the phone block spans rows from a selector the phone rule cannot outweigh", () => {
  // A label rule more specific than the phone one would keep its row span at phone width: the has-meta variant is
  // the only one, and the phone block restates it with the same specificity, later in the file.
  const base = css.replace(phone, "");
  expect(base).not.toContain(":has(");
  expect(css.lastIndexOf(".lm-pick.has-meta .lm-pick-label")).toBeGreaterThan(css.indexOf(".lm-pick.has-meta .lm-pick-label"));
});
