import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/daemon/memory/store.ts";
import { recallPersonal } from "../../src/daemon/memory/primer.ts";

const endpoints = [
  "127.0.0.1", "127.0.0.1:5432", "10.42.1.7:443", "http://127.0.0.1:8080/",
  "10:30", "3:4",
  "[::1]", "[::1]:443", "::1", "2001:db8::1", "[2001:db8::1]:5432",
  "http://[2001:db8::1]:8080/", "fe80::1%en0", "[fe80::1%en0]:443",
  "localhost:5432", "localhost:7777", "db:5432", "db:22", "host:22", "server:80",
  "build-box:443", "build-box:22", "db1:5432", "db1:7777", "db:5432,",
  "|build-box:22|", "`db1:5432`", "<localhost:7777>", "'host:22'",
  "http://localhost:8080", "postgres://db/app", "ssh://user:pass@db:22/path",
  "custom+v1://user:pass@host.internal:88/path", "ftp://example.com/file",
  "https://user:pass@example.com/path", "redis://user:p%40ss@cache:6379/0",
  "//example.com/path", "//db/path", "//db", "url=//db/path",
  "server: //db/path", "x //example.com/path", "'//db/path'", "[//db/path]",
  "`//db/path`", "|//db/path|", "→//db/path", "<//db/path>",
  "`//db`", "|//db|", "a //db/path", "a://db/path //host/path",
  "https://例子.测试/path", "custom+v1://用户@δοκιμή.δοκιμή/path",
  "//例子.测试/path", "url=//例子.测试/path", "//δοκιμή.δοκιμή/path",
  "//٣.مثال/path", "//xn--fsqu00a.xn--0zwm56d/path",
  "例子:5432", "δοκιμή.δοκιμή:7777", "٣.مثال:443", "xn--fsqu00a:5432",
  "host=例子.测试", "server: δοκιμή.δοκιμή", "url=xn--fsqu00a.xn--0zwm56d",
  "例子.internal", "δοκιμή.fly.dev", "٣.svc.cluster.local",
  "服务.例子.测试", "α.δοκιμή.δοκιμή", "٣.مثال.اختبار",
  "xn--fsqu00a", "xn--fsqu00a.xn--0zwm56d", "api.xn--fsqu00a.xn--0zwm56d",
  "internal.ops.example.com", "example.com:443", "db.service.com",
  "vault.internal.md", "db_service.internal", "api.internal.1", "_postgres._tcp.example.com",
  "db.local", "db.lan", "db.corp", "db.intranet", "router.home.arpa", "db.localdomain",
  "node.compute.internal", "db.svc.cluster.local", "node.amazonaws.com", "node.azurewebsites.net",
  "node.cloudapp.net", "node.googleusercontent.com", "node.fly.dev", "node.vercel.app",
  "node.supabase.co", "node.fly.dev.md", "host=setup.py", "hostname: report.pdf", "server: example.com",
  "endpoint=api.private.zip", "db_host=cache.internal", "url=example.com",
  "http%3A%2F%2Flocalhost%3A8080%2F", "127%2E0%2E0%2E1%3A5432",
  "%2531%2532%2537%252e0%252e0%252e1%253a5432",
  "ｈｔｔｐ：／／ｌｏｃａｌｈｏｓｔ：８０８０", "１２７．０．０．１：５４３２",
  "lo​calhost:5432", "user@host.example.org",
] as const;

const ordinary = [
  "localhost", "db", "build-box", "recovery", "check receipts", "run tests",
  "1.2.3", "2/3", "readme.md", "report.txt", "archive.tar.gz",
  "v1.2.3", "phase 1.2.3", "10.42", "127.0.0", "server room", "host family",
  "api-v2", "2026-10-04", "https", "user@example", "version 2.1.0",
  "example.com", "exámple.com", "file:///tmp/archive", "url=file:///tmp/archive",
  "host=localhost", "host=ready",
  "server: build-box", "database host db", "db_host=cache", "hostname: node-1",
  "db.service.py", "api.private.zip", "server.example.js", "setup.py", "README.md",
  "report.pdf", "package.json", "db.service.go", "worker.queue.rs", "ui.card.html",
  "page.header.css", "schema.table.sql", "deploy.script.sh",
  "server: ready", "hostname: pending", "database host family", "chapter:12",
  "phase:2", "version:3", "step:2", "item:3", "section:4", "line:12",
  "db:1", "db:7777", "host=db:7777", "server: ready.", "hostname plan",
  "// note", "x // y", "a//b", "foo//db/path",
  "修复数据库索引", "服务器: 就绪", "server: 准备", "host=例子",
  "例子.测试", "δοκιμή.δοκιμή", "例子.py", "a//例子/path", "// 注释",
] as const;

test("endpoint classifier agrees on write and legacy read for a table of endpoint and ordinary forms", () => {
  expect(endpoints.length + ordinary.length).toBeGreaterThanOrEqual(40);
  const dir = mkdtempSync(join(tmpdir(), "walkie-learn-endpoints-"));
  const store = MemoryStore.open(dir, { fts: false });
  const writer = store.learnings();
  const owner = "endpoint-test-owner";
  const add = (rule: string, requestId: string) => writer.add({ owner, actor: "person", machine: "node-a",
    category: "warning", rule, evidence: "synthetic fixture", confidence: 0.8, requestId });
  try {
    for (const [unsafe, examples] of [[true, endpoints], [false, ordinary]] as const) {
      for (const [index, value] of examples.entries()) {
        const rule = `Use ${value} for recovery`;
        const written = add(rule, `${unsafe ? "endpoint" : "ordinary"}-${index}`);
        expect(written.status, `write: ${value}`).toBe(unsafe ? "quarantined" : "active");
        const legacy = add("Use plain words for recovery", `${unsafe ? "legacy-endpoint" : "legacy-ordinary"}-${index}`);
        const db = new Database(join(dir, "memory.db"));
        db.query("UPDATE personal_learnings SET rule = ? WHERE id = ?").run(rule, legacy.id);
        db.close();
        const read = writer.list(owner, true).find((entry) => entry.id === legacy.id);
        expect(read?.status, `read: ${value}`).toBe(unsafe ? "quarantined" : "active");
        expect(read?.rule, `read text: ${value}`).toBe(unsafe ? "" : rule);
        const recalled = recallPersonal(store, "recovery", owner, [], new Set()).items;
        expect(recalled.some((entry) => entry.id === legacy.id), `recall: ${value}`).toBe(!unsafe);
      }
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
