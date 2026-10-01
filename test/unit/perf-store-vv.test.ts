import { expect, test } from "bun:test";
import { Store } from "../../src/daemon/store.ts";
import { stubOf } from "../../src/protocol/header.ts";
import { createTeam, tnode } from "../helpers/events.ts";

test("a deferred commit failure leaves vv at disk state so anti-entropy can fetch the stub", () => {
  const local = new Store(":memory:");
  const peer = new Store(":memory:");
  try {
    const author = tnode("alex");
    const { create } = createTeam(author);
    const stub = stubOf(create);
    peer.insertStub(stub);
    expect(local.vv()).toEqual({}); // prime the in-memory cache before the failed transaction

    local.db.exec(`CREATE TABLE commit_gate(id TEXT PRIMARY KEY);
      CREATE TABLE deferred_failure(id TEXT, gate TEXT,
        FOREIGN KEY(gate) REFERENCES commit_gate(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_stub_commit AFTER INSERT ON events BEGIN
        INSERT INTO deferred_failure(id, gate) VALUES (NEW.id, 'missing');
      END;`);
    expect(() => local.insertStub(stub)).toThrow();
    expect(local.getRow(stub.id)).toBeNull();
    expect(local.vvOf(stub.origin)).toBe(0);
    expect(local.vv()[stub.origin] ?? 0).toBe(local.vvOf(stub.origin));

    const missing = peer.rowsForSync(stub.origin, local.vv()[stub.origin] ?? 0, peer.vvOf(stub.origin), 500);
    expect(missing.map((row) => row.id)).toEqual([stub.id]);
    local.db.exec("DROP TRIGGER fail_stub_commit");
    local.insertStub(stub);
    expect(local.vv()[stub.origin]).toBe(1);
  } finally {
    local.close();
    peer.close();
  }
});
