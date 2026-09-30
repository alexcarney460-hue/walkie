import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("every source Worker file is a release compile entry point", () => {
  const build = readFileSync(join(root, "scripts", "build.ts"), "utf8");
  const missing: string[] = [];
  for (const source of sources(join(root, "src"))) {
    const text = readFileSync(source, "utf8");
    for (const match of text.matchAll(/\bnew Worker\s*\(/g)) {
      const call = text.slice(match.index, match.index + 300);
      const direct = /^new Worker\s*\(\s*new URL\s*\(\s*"(\.[^\"]+\.ts)"/s.exec(call)?.[1];
      const helper = /^new Worker\s*\(\s*([a-zA-Z]\w*)\(\)/s.exec(call)?.[1];
      const body = helper && new RegExp(`function ${helper}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(text)?.[1];
      const spec = direct ?? (body && /new URL\("(\.[^\"]+\.ts)", import\.meta\.url\)/.exec(body)?.[1]);
      if (!spec) { missing.push(`${relative(root, source)}: unresolved Worker target`); continue; }
      const path = relative(join(root, "src"), join(source, "..", spec));
      if (!build.includes(`join(root, "src", ${path.split("/").map((part) => JSON.stringify(part)).join(", ")})`)) missing.push(path);
    }
  }
  expect(missing).toEqual([]);
});

test("the embedded discovery Worker path is a release compile entry point", () => {
  const source = readFileSync(join(root, "src", "daemon", "discovery-files.ts"), "utf8");
  const build = readFileSync(join(root, "scripts", "build.ts"), "utf8");
  const embedded = /WALKIE_EMBEDDED[^\n]*\n\s*\?\s*"(\.\/[^\"]+\.ts)"/.exec(source)?.[1];
  expect(embedded).toBeDefined();
  const path = embedded!.split("/").slice(1);
  expect(build).toContain(`join(root, "src", ${path.map((part) => JSON.stringify(part)).join(", ")})`);
});
