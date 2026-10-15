import { expect, test } from "bun:test";
import { Store } from "./store.ts";
import { askView } from "./views.ts";
import { ProjectsDb } from "./projects/db.ts";

function row(store: Store, id: string, seq: number, kind: string, channel: string | null, thread: string | null,
  body: object = {}): void {
  store.db.query(`INSERT INTO events(id, origin, seq, ts, kind, channel, thread, json, received_at)
    VALUES (?, '0123456789abcdef', ?, ?, ?, ?, ?, ?, ?)`).run(
    id, seq, seq, kind, channel, thread, JSON.stringify({ id, origin: "0123456789abcdef", seq, ts: seq,
      kind, channel, body, author: { handle: "@bench", agent: "bench" } }), seq);
}

test("ask page batching preserves each ask's answer order, visibility and expiry", () => {
  const store = new Store(":memory:");
  try {
    row(store, "ask-1", 1, "ask", null, null, { expires_at: 9_000_000_000_000 });
    row(store, "ask-2", 2, "ask", null, null, { expires_at: 9_000_000_000_000 });
    row(store, "reply-other", 3, "msg.post", null, "ask-1");
    row(store, "answer-1", 4, "answer", null, "ask-1", { ask: "ask-1" });
    row(store, "answer-2", 5, "answer", null, "ask-1", { ask: "ask-1", declined: true });
    row(store, "answer-hidden", 6, "answer", null, "ask-2", { ask: "ask-2" });
    store.db.query("UPDATE events SET status = 'rejected' WHERE id = 'answer-hidden'").run();
    const core = { store, visible: (ev: { id: string }) => ev.id !== "answer-2" } as any;
    const asks = store.asks();
    const replies = store.askReplies(asks.map((ask) => ask.id));
    expect(asks.map((ask) => askView(core, ask, replies.get(ask.id) ?? [], ask.received_at)))
      .toEqual(asks.map((ask) => askView(core, ask)));
    expect(replies.get("ask-1")?.map((r) => r.id)).toEqual(["reply-other", "answer-1", "answer-2"]);
  } finally { store.close(); }
});

test("unfiltered event pages preserve timestamp and id order and visibility", () => {
  const store = new Store(":memory:");
  try {
    row(store, "a", 1, "agent.status", null, null);
    row(store, "b", 2, "msg.post", null, null);
    row(store, "c", 3, "msg.post", null, null);
    row(store, "d", 4, "msg.post", null, null);
    store.db.query("UPDATE events SET ts = 2 WHERE id = 'c'").run();
    store.db.query("UPDATE events SET status = 'rejected' WHERE id = 'd'").run();
    expect(store.queryEvents({ limit: 2 }).map((event) => event.id)).toEqual(["c", "b"]);
    expect(store.queryEvents({ before_ts: 2, limit: 2 }).map((event) => event.id)).toEqual(["a"]);
    expect(store.queryEvents({ since_ts: 1, limit: 2 }).map((event) => event.id)).toEqual(["c", "b"]);
  } finally { store.close(); }
});

test("unfiltered pages follow the timestamp index; agent pages use the agent index", () => {
  const store = new Store(":memory:");
  try {
    const plan = (source: string, filter = "") => store.db.query<{ detail: string }, []>(
      `EXPLAIN QUERY PLAN SELECT id, origin, seq, ts, kind, channel, thread, sig, redacted, status, json
       FROM ${source} WHERE redacted = 0 AND status = 'ok' ${filter} ORDER BY ts DESC, id DESC LIMIT 100`,
    ).all().map((row) => row.detail).join("\n");
    expect(plan("events INDEXED BY events_ts")).toContain("USING INDEX events_ts");
    expect(plan("events", "AND author_agent IN ('bench')")).toContain("USING INDEX events_author_agent_ts");
  } finally { store.close(); }
});

test("watermarked board and project checks follow rowid", () => {
  const store = new Store(":memory:");
  try {
    const plan = (sql: string) => store.db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
      .all().map((row) => row.detail).join("\n");
    expect(plan(`SELECT rowid, id, json FROM events NOT INDEXED WHERE rowid > 10 AND kind = 'msg.post'
      AND channel LIKE 'p-%' AND redacted = 0 AND bop = 0 ORDER BY rowid LIMIT 1000`))
      .toContain("USING INTEGER PRIMARY KEY (rowid>?)");
    expect(plan(`SELECT 1 FROM events NOT INDEXED WHERE rowid > 10 AND ((kind = 'msg.post' AND channel LIKE 'p-%')
      OR kind IN ('team.create','team.member','team.node','channel.upsert','team.authority','team.license','team.integration')) LIMIT 1`))
      .toContain("USING INTEGER PRIMARY KEY (rowid>?)");
    expect(plan(`SELECT rowid, id FROM events e INDEXED BY events_origin_rowid WHERE rowid > 10 AND redacted = 0
      AND kind NOT IN ('team.create','team.member','team.node','channel.upsert','team.authority','team.license','team.integration')
      AND status IN ('ok','rejected') AND origin = '0123456789abcdef' AND seq >= 1 ORDER BY rowid LIMIT 100`))
      .toContain("USING INDEX events_origin_rowid (origin=? AND rowid>?)");
    row(store, "project-1", 1, "msg.post", "p-test", null);
    const projects = new ProjectsDb(store.db);
    expect(projects.projectPostsAfter(0)).toBe(true);
    expect(projects.projectPostsAfter(1)).toBe(false);
    expect(store.revalPage({ kind: "origin", origin: "0123456789abcdef", minSeq: 1 }, 0, 100).map((r) => r.id))
      .toEqual(["project-1"]);
    expect(plan(`SELECT COUNT(*) FROM events INDEXED BY events_rejected WHERE status = 'rejected'
      AND origin = '0123456789abcdef' AND redacted = 0 AND bop = 0 AND kind NOT IN
      ('team.create','team.member','team.node','channel.upsert','team.authority','team.license','team.integration')`))
      .toContain("USING INDEX events_rejected (origin=?)");
  } finally { store.close(); }
});

test("long status-only tails use kind indexes while short tails use rowid", () => {
  const store = new Store(":memory:");
  try {
    const projects = new ProjectsDb(store.db);
    const statements: string[] = [];
    const query = store.db.query;
    (store.db as any).query = (sql: string) => new Proxy(query.call(store.db, sql), {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property === "all" || property === "get") return (...args: unknown[]) => {
          statements.push(sql);
          return value.apply(target, args);
        };
        return value.bind(target);
      },
    });
    const insert = store.db.query(`INSERT INTO events(id, origin, seq, ts, kind, json, received_at)
      VALUES (?, 'status-origin', ?, ?, 'agent.status', '{}', ?)`);
    insert.run("status-1", 1, 1, 1);
    expect(projects.projectPostsAfter(0)).toBe(false);
    expect(store.classifyBoardOps(() => false)).toEqual({ examined: 0, marked: 0 });
    expect(statements.some((sql) => sql.includes("FROM events NOT INDEXED WHERE rowid > ? AND ((kind"))).toBe(true);
    expect(statements.some((sql) => sql.includes("FROM events NOT INDEXED WHERE rowid > ? AND kind = 'msg.post'"))).toBe(true);

    store.db.transaction(() => {
      for (let i = 2; i <= 20_002; i++) insert.run(`status-${i}`, i, i, i);
    })();
    statements.length = 0;
    expect(projects.projectPostsAfter(1)).toBe(false);
    expect(store.classifyBoardOps(() => false)).toEqual({ examined: 0, marked: 0 });
    expect(statements.some((sql) => sql.includes("FROM events WHERE rowid > ? AND ((kind"))).toBe(true);
    expect(statements.some((sql) => sql.includes("FROM events INDEXED BY events_kind_ts WHERE rowid > ? AND kind = 'msg.post'"))).toBe(true);
  } finally { store.close(); }
});

test("project-wide root scans use the partial root index", () => {
  const store = new Store(":memory:");
  try {
    const where = `channel >= 'p-' AND channel < 'p.' AND channel LIKE 'p-%' AND +kind = 'msg.post'
      AND kind = 'msg.post' AND redacted = 0 AND status = 'ok' AND +thread IS NULL AND thread IS NULL`;
    const plan = (tail: string) => store.db.query<{ detail: string }, []>(
      `EXPLAIN QUERY PLAN SELECT id FROM events INDEXED BY events_project_roots WHERE ${where} ${tail}`,
    ).all().map((row) => row.detail).join("\n");
    expect(plan("AND json_extract(body, '$.board.op') = 'project'"))
      .toContain("USING INDEX events_project_roots");
    expect(plan("AND author_handle = '@bench' AND +author_agent IS NULL AND json_extract(body, '$.board.ext.src') = 'linear'"))
      .toContain("USING INDEX events_project_roots");
    row(store, "root", 1, "msg.post", "p-test", null);
    store.db.query("UPDATE events SET body = '{\"board\":{\"op\":\"project\"}}' WHERE id = 'root'").run();
    expect(new ProjectsDb(store.db).projectChannels()).toEqual(["p-test"]);
  } finally { store.close(); }
});

test("channel stats track visible inserts, updates and deletes", () => {
  const store = new Store(":memory:");
  try {
    row(store, "first", 1, "msg.post", "one", null);
    expect(store.channelStats().get("one")).toEqual({ count: 1, last_ts: 1 });
    const detached = store.channelStats();
    detached.get("one")!.count = 999;
    detached.delete("one");
    expect(store.channelStats().get("one")?.count).toBe(1);
    row(store, "second", 2, "msg.post", "one", null);
    expect(store.channelStats().get("one")).toEqual({ count: 2, last_ts: 2 });
    store.db.query("UPDATE events SET ts = 3 WHERE id = 'first'").run();
    expect(store.channelStats().get("one")?.last_ts).toBe(3);
    store.db.query("UPDATE events SET status = 'rejected' WHERE id = 'first'").run();
    expect(store.channelStats().get("one")).toEqual({ count: 1, last_ts: 2 });
    store.db.query("UPDATE events SET channel = 'two' WHERE id = 'second'").run();
    expect(store.channelStats().get("one")).toBeUndefined();
    expect(store.channelStats().get("two")).toEqual({ count: 1, last_ts: 2 });
    store.db.query("UPDATE events SET redacted = 1 WHERE id = 'second'").run();
    expect(store.channelStats().get("two")).toBeUndefined();
    store.db.query("UPDATE events SET redacted = 0 WHERE id = 'second'").run();
    expect(store.channelStats().get("two")?.count).toBe(1);
    store.db.query("DELETE FROM events WHERE id = 'second'").run();
    expect(store.channelStats().get("two")).toBeUndefined();
  } finally { store.close(); }
});

test("channel stats match committed rows after a rollback and another write", () => {
  const store = new Store(":memory:");
  try {
    expect(() => store.transaction(() => {
      row(store, "rolled-back", 1, "msg.post", "first", null);
      expect(store.channelStats().get("first")).toEqual({ count: 1, last_ts: 1 });
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(0);

    store.transaction(() => {
      row(store, "committed", 2, "msg.post", "second", null);
      expect(store.channelStats().get("second")).toEqual({ count: 1, last_ts: 2 });
    });
    const rows = store.db.query<{ channel: string; ts: number }, []>("SELECT channel, ts FROM events").all();
    expect(rows).toEqual([{ channel: "second", ts: 2 }]);
    expect([...store.channelStats()]).toEqual([["second", { count: 1, last_ts: 2 }]]);
  } finally { store.close(); }
});
