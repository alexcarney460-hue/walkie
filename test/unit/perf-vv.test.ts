import { afterEach, expect, test } from "bun:test";
import { makeCore } from "../helpers/core.ts";
import { createTeam, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

test("version-vector replies use an incrementally maintained snapshot and survive rollback", () => {
  const owner = tnode("owner");
  const { team, create } = createTeam(owner);
  const core = makeCore(owner, team, cleanups);
  expect(core.ingest(create, "local").status).toBe("accepted");
  const before = core.store.vv();
  const query = core.store.db.query.bind(core.store.db);
  let reads = 0;
  (core.store.db as unknown as { query: typeof query }).query = ((sql: string) => {
    if (sql === "SELECT origin, seq FROM vv") reads++;
    return query(sql);
  }) as typeof query;
  try {
    expect(core.store.vv()).toEqual(before);
    expect(core.store.vv()).toEqual(before);
    expect(reads).toBe(0);
    core.store.setVv("peer", 7);
    expect(core.store.vv().peer).toBe(7);
    expect(reads).toBe(0);
    core.emit("agent.status", { agent: "cc-live", state: "working", runtime: "cli" }, { agent: "cc-live" });
    expect(core.store.vv()[core.nodeId]).toBe(before[core.nodeId]! + 1);
    expect(reads).toBe(0);
    expect(() => core.store.transaction(() => { core.store.setVv("peer", 9); throw new Error("rollback"); })).toThrow("rollback");
    expect(core.store.vv().peer).toBe(7);
  } finally {
    delete (core.store.db as unknown as { query?: typeof query }).query;
  }
});
