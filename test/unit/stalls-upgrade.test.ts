import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Core } from "../../src/daemon/core.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { MIGRATIONS, migrate13, Store } from "../../src/daemon/store.ts";
import { ProjectsDb } from "../../src/daemon/projects/db.ts";
import { ProjectsIndex } from "../../src/daemon/projects/index.ts";

test("pre.14 upgrade keeps project and origin reads usable across claim-index batches", async () => {
  const dir = mkdtempSync("/tmp/walkie-stalls-upgrade-");
  const path = join(dir, "walkie.db");
  const raw = new Database(path, { create: true, strict: true });
  let store: Store | null = null;
  try {
    raw.exec("CREATE TABLE migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (let i = 0; i < 13; i++) {
      if (i === 12) migrate13(raw);
      else raw.exec(MIGRATIONS[i]!);
      raw.query("INSERT INTO migrations(version, applied_at) VALUES (?, 0)").run(i + 1);
    }
    const insert = raw.query(`INSERT INTO events(id, origin, seq, ts, kind, channel, author_handle, body, json, received_at)
      VALUES (?, 'origin-a', ?, ?, ?, ?, '@alex', ?, '{}', ?)`);
    raw.transaction(() => {
      insert.run("project", 1, 1, "msg.post", "p-test", JSON.stringify({ board: { op: "project",
        ext: { src: "linear", id: "EXT-1" } } }), 1);
      for (let i = 2; i <= 1_202; i++) insert.run(`status-${i}`, i, i, "agent.status", null, "{}", i);
    })();
    raw.close();

    store = new Store(path);
    const projects = new ProjectsDb(store.db);
    expect(store.claimIndexReady).toBe(false);
    expect(store.db.query<{ v: number }, []>("SELECT MAX(version) AS v FROM migrations").get()?.v).toBe(13);
    expect(store.db.query("SELECT name FROM sqlite_master WHERE name IN ('events_project_roots', 'events_origin_rowid')").all())
      .toEqual([]);
    expect(projects.projectChannels()).toEqual(["p-test"]);
    expect(projects.extRoots("linear", "@alex").map((row) => row.id)).toEqual(["project"]);
    expect(store.revalPage({ kind: "origin", origin: "origin-a", minSeq: 1 }, 0, 2).map((row) => row.id))
      .toEqual(["project", "status-2"]);
    const startup = new ProjectsIndex({ store, isProjectChannel: () => false } as unknown as Core, createLogger({}));
    try { startup.start(); } finally { startup.stop(); }

    for (let i = 0; i < 100 && !store.claimIndexReady; i++) await Bun.sleep(5);
    expect(store.claimIndexReady).toBe(true);
    expect(store.db.query<{ v: number }, []>("SELECT MAX(version) AS v FROM migrations").get()?.v).toBe(19);
    expect(store.db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE name IN ('events_project_roots', 'events_origin_rowid') ORDER BY name",
    ).all().map((row) => row.name)).toEqual(["events_origin_rowid", "events_project_roots"]);
    expect(projects.projectChannels()).toEqual(["p-test"]);
    expect(projects.extRoots("linear", "@alex").map((row) => row.id)).toEqual(["project"]);
    expect(store.revalPage({ kind: "origin", origin: "origin-a", minSeq: 1 }, 0, 2).map((row) => row.id))
      .toEqual(["project", "status-2"]);
  } finally {
    store?.close();
    raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
