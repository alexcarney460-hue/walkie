// Release d4c1839b src/daemon/memory/store.ts created only memory, memory_recent and memory_fts.
// It had no memory_migrations table. Keep this fixture at that exact released schema.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/daemon/memory/store.ts";

test("released pre.14 memory.db upgrades through every migration and keeps recallable notes", () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-pre14-upgrade-"));
  const path = join(home, "memory.db");
  const id = `m-${"a".repeat(32)}`;
  const secondId = `m-${"b".repeat(32)}`;
  const owner = '["0123456789abcdef","login",-1]';
  try {
    const released = new Database(path, { create: true });
    released.exec(`CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      sources TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      retracted INTEGER NOT NULL,
      retracted_at INTEGER,
      actor TEXT NOT NULL,
      redactions TEXT NOT NULL
    )`);
    released.exec("CREATE INDEX IF NOT EXISTS memory_recent ON memory (retracted, created_at DESC, id DESC)");
    released.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, body, sources)");
    released.query("INSERT INTO memory VALUES (?, 'fact', ?, '[]', 1000, 0, NULL, 'person', '[]')")
      .run(id, "pre.14 onboarding checklist");
    released.query("INSERT INTO memory VALUES (?, 'decision', ?, '[]', 1001, 0, NULL, 'person', '[]')")
      .run(secondId, "pre.14 approval record");
    released.query("INSERT INTO memory_fts (id, body, sources) VALUES (?, ?, '')")
      .run(id, "pre.14 onboarding checklist");
    released.query("INSERT INTO memory_fts (id, body, sources) VALUES (?, ?, '')")
      .run(secondId, "pre.14 approval record");
    released.close();
    chmodSync(path, 0o600);

    const upgraded = MemoryStore.open(home);
    const proof = { team: "0123456789abcdef", node: "fedcba9876543210", person: "release-person", identity: owner };
    upgraded.resolveLegacy(proof, true);
    expect(upgraded.recallEntries(owner).map((note) => [note.id, note.text]))
      .toEqual([[secondId, "pre.14 approval record"], [id, "pre.14 onboarding checklist"]]);
    expect(upgraded.search("onboarding", 10, owner).map((note) => note.id)).toEqual([id]);
    upgraded.close();

    const db = new Database(path, { readonly: true });
    try {
      expect(db.query<{ version: number }, []>("SELECT version FROM memory_migrations ORDER BY version").all()
        .map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(db.query<{ body: string }, [string]>("SELECT body FROM memory WHERE id = ?").get(id)?.body)
        .toBe("pre.14 onboarding checklist");
      expect(db.query<{ body: string }, [string]>("SELECT body FROM memory WHERE id = ?").get(secondId)?.body)
        .toBe("pre.14 approval record");
    } finally { db.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
