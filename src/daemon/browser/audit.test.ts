import { expect, test } from "bun:test";
import { browserAuditLine } from "./audit.ts";

test("browser audit records URL path and control, without query or typed value", () => {
  const line = browserAuditLine("type", { text: "completed", url: "https://example.org/form?token=secret123", role: "textbox", name: "City" });
  expect(line).toContain("https://example.org/form textbox City");
  expect(line).not.toContain("token=");
  expect(line).not.toContain("secret123");
});

test("browser audit redacts typed values in path segments", () => {
  const line = browserAuditLine("click", { text: "", url: "https://example.org/search/some%20private%20phrase/result?query=secret", role: "button", name: "Go" }, undefined, ["private phrase"]);
  expect(line).toContain("https://example.org/search/[typed]/result button Go");
  expect(line).not.toContain("private");
  expect(line).not.toContain("query");
});

test("browser audit redacts typed values in host labels and fragments", () => {
  const line = browserAuditLine("read", { text: "", url: "https://privatephrase.example.org/search/privatephrase#privatephrase", role: "document", name: "read" }, undefined, ["privatephrase"]);
  expect(line).toContain("https://[typed].example.org/search/[typed]");
  expect(line).not.toContain("privatephrase");
  expect(line).not.toContain("#");
  const acrossLabels = browserAuditLine("open", { text: "", url: "https://foo.bar.example.org/a#foo.bar", role: "navigation", name: "open" }, undefined, ["foo.bar"]);
  expect(acrossLabels).toContain("https://[typed]/a");
  expect(acrossLabels).not.toContain("foo.bar");
});

test("audit redacts case-changed and NFKC-equivalent typed text in URL and control metadata", () => {
  const line = browserAuditLine("click", { text: "", url: "https://BLUERABBIT7.example.org/ＢＬＵＥＲＡＢＢＩＴ７",
    role: "BLUERABBIT7", name: "Accept ＢＬＵＥＲＡＢＢＩＴ７" }, undefined, ["BlueRabbit7"]);
  expect(line).not.toMatch(/bluerabbit7/i);
  expect(line).not.toContain("ＢＬＵＥＲＡＢＢＩＴ７");
  expect(line).toContain("[typed]");
  const folded = browserAuditLine("click", { text: "", url: "https://example.org/STRASSE", role: "button", name: "STRASSE" },
    undefined, ["Straße"]);
  expect(folded).not.toContain("STRASSE");
});
