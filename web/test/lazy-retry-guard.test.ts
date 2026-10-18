import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

// Every lazy page goes through retryableLazy, whose retry-after-navigation behaviour is tested in
// ui-polish-fix2-r3.test.tsx; a plain React.lazy caches a failed chunk until the page reloads.
test("no view uses a plain React.lazy outside retryableLazy", async () => {
  const src = join(import.meta.dir, "..", "src");
  const offenders: string[] = [];
  for await (const file of new Glob("**/*.{ts,tsx}").scan(src)) {
    if (file.endsWith("lib/retryable-lazy.tsx")) continue;
    const text = await Bun.file(join(src, file)).text();
    if (/(^|[^A-Za-z])lazy\(/.test(text)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
