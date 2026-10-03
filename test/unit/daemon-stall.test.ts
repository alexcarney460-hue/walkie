// DAEMON-STALL-1: on a store the size of a real team's (100k events, nearly all agent statuses, 1k archived agents) the
// queries the daemon runs per request or periodically stay fast, because each one reads through an index that bounds
// it: none walks every row through an index led by a column almost every row shares (redacted, status). Plus the
// migration that makes it so, the agent rows' receipt time, the board search index's rowid map and the status scrub's
// cache.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../src/daemon/logger.ts";
import { ProjectsDb } from "../../src/daemon/projects/db.ts";
import { ProjectsIndex } from "../../src/daemon/projects/index.ts";
import { migrate13, MIGRATIONS, Store, type EventRow } from "../../src/daemon/store.ts";
import type { CardView } from "../../src/protocol/projects/schema.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, tnode } from "../helpers/events.ts";

const N_EVENTS = 100_000;
const N_AGENTS = 1_000;
const ORIGINS = ["a0a0a0a0a0a0a0a0", "b1b1b1b1b1b1b1b1", "c2c2c2c2c2c2c2c2", "d3d3d3d3d3d3d3d3"];
const SELF = ORIGINS[0] as string;
const CHANNELS = ["general", "ops", "p-0e1c7ed0", "p-1f2d8ee1", "seats-x"];
const ROSTER_KINDS = ["team.create", "team.member", "team.node", "channel.upsert"];
const T0 = 1_790_000_000_000;
/** The warm budget per hot query (the incident's took seconds cold; these take a few ms). */
const BUDGET_MS = 50;

const dirs: string[] = [];
let store: Store;
let askId = "";
let threadRoot = "";
let blobHash = "";

function tmp(): string {
  const d = mkdtempSync("/tmp/walkie-stall-");
  dirs.push(d);
  return d;
}

/**
 * 100k events: per origin a roster prefix, then mostly agent.status (~400 bytes of JSON each, as real ones), a msg.post
 * every 20th (some replies), an ask with answers every 5,000th, some stubs and some hidden rows; 1k agent rows (half
 * with no remembered receipt, as after an older build wrote them), a blob reference.
 */
function build(path: string): Store {
  const s = new Store(path);
  const ins = s.db.query(`INSERT INTO events(id, origin, seq, ts, kind, channel, thread, author_handle, author_agent, body, sig,
    redacted, status, reason, json, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const pad = "x".repeat(300);
  const seqs = new Map<string, number>(ORIGINS.map((o) => [o, 0]));
  let lastRoot = "";
  s.db.transaction(() => {
    for (let i = 0; i < N_EVENTS; i++) {
      const origin = ORIGINS[i % ORIGINS.length] as string;
      const seq = (seqs.get(origin) as number) + 1;
      seqs.set(origin, seq);
      const id = `${origin}:${seq}`;
      const ts = T0 + i * 1_000;
      let kind = "agent.status", channel: string | null = null, thread: string | null = null, agent: string | null = `agent-${i % 1_500}`;
      let redacted = 0, status = "ok";
      if (seq <= ROSTER_KINDS.length) { kind = ROSTER_KINDS[seq - 1] as string; agent = null; }
      else if (i % 5_000 === 7) { kind = "ask"; channel = "general"; askId = id; agent = null; }
      else if (i % 5_000 === 11 || i % 5_000 === 15) { kind = "answer"; channel = "general"; thread = askId; agent = null; }
      else if (i % 20 === 0) {
        kind = "msg.post"; channel = CHANNELS[(i / 20) % CHANNELS.length] as string; agent = i % 40 === 0 ? "seats" : null;
        if (i % 60 === 0 && lastRoot) { thread = lastRoot; if (i >= 50_000 && !threadRoot) threadRoot = lastRoot; } else lastRoot = id;
      } else if (i % 997 === 0) { redacted = 1; kind = "msg.post"; channel = "private-x"; agent = null; }
      else if (i % 1_999 === 0) { status = "rejected"; }
      const body = JSON.stringify({ agent, state: "working", text: pad, ...(thread ? { thread } : {}) });
      const json = redacted ? JSON.stringify({ id, origin, seq, channel }) : JSON.stringify({ id, origin, seq, ts, kind, channel, body: JSON.parse(body), sig: "s" });
      ins.run(id, origin, seq, redacted ? null : ts, redacted ? null : kind, channel, redacted ? null : thread, redacted ? null : "alex",
        redacted ? null : agent, redacted ? null : body, redacted ? null : "s", redacted, status, null, json, ts + 5);
    }
    for (const o of ORIGINS) s.setVv(o, seqs.get(o) as number);
    // (A store without the receipt columns, a build before migration 13, gets the rows without them.)
    const recv = s.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('agents_latest')").all().some((c) => c.name === "recv_at");
    const agentIns = s.db.query(`INSERT INTO agents_latest(node, agent, handle, event_id, ts, body${recv ? ", recv_id, recv_at" : ""})
      VALUES (?,?,?,?,?,?${recv ? ",?,?" : ""})`);
    for (let a = 0; a < N_AGENTS; a++) {
      const origin = ORIGINS[a % ORIGINS.length] as string;
      const eid = `${origin}:${1_000 + a}`;
      const remembered = a % 2 === 0;
      const row = [origin, `agent-${a}`, "alex", eid, T0 + a, JSON.stringify({ agent: `agent-${a}`, state: "idle" })];
      agentIns.run(...(recv ? [...row, remembered ? eid : null, remembered ? 42 : null] : row));
    }
    blobHash = "ab".repeat(32);
    s.addBlobRef(blobHash, `${SELF}:900`);
  })();
  return s;
}

/**
 * Runs `fn` once to warm the cache, then five more times, and returns the fastest of those runs in ms: what the query costs,
 * not a moment the machine was busy with something else (in a release test shard on a loaded Mac single runs of queries
 * that take a few ms on their own measured 95–715 ms). The budget is unchanged, and EXPLAIN below still checks the plans.
 */
function warm(fn: () => unknown): number {
  fn();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/** The query plans of the statements `fn` runs against `db` (EXPLAIN QUERY PLAN with the same arguments). */
function plans(db: Database, fn: () => unknown): string[] {
  const out: string[] = [];
  const orig = Database.prototype.query;
  (db as unknown as { query: unknown }).query = function (sql: string) {
    const st = orig.call(db, sql) as unknown as Record<string, unknown>;
    return new Proxy(st, {
      get(t, p) {
        const v = Reflect.get(t, p, t);
        if (typeof v !== "function") return v;
        if (p !== "all" && p !== "get" && p !== "run" && p !== "values") return v.bind(t);
        return (...args: unknown[]) => {
          if (/^\s*(SELECT|DELETE|UPDATE)/i.test(sql)) {
            const ex = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
            try { out.push((ex.all(...(args as [])) as { detail: string }[]).map((r) => r.detail).join("; ")); } finally { ex.finalize(); }
          }
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
  };
  try { fn(); } finally { delete (db as unknown as { query?: unknown }).query; }
  return out;
}

beforeAll(() => {
  store = build(join(tmp(), "walkie.db"));
}, 120_000);

afterAll(() => {
  store?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The daemon's hot queries: per request (dashboard, CLI, hooks, MCP), per emit, per archive tick, at startup. */
function hot(): Record<string, () => unknown> {
  return {
    "replies (a thread, every ask in /v1/asks)": () => store.replies(threadRoot),
    "asks": () => store.asks(),
    "events page, no filter (dashboard load, 500)": () => store.queryEvents({ limit: 500 }),
    "events page since a time (dashboard resync)": () => store.queryEvents({ since_ts: T0 + (N_EVENTS - 3_600) * 1_000, limit: 500 }),
    "events page before a time": () => store.queryEvents({ before_ts: T0 + 50_000 * 1_000, limit: 100 }),
    "events of several kinds (agent drawer)": () => store.queryEvents({ kinds: ["msg.post", "ask", "answer", "artifact.share"], limit: 500 }),
    "events of one kind (hooks: msg.post, 50)": () => store.queryEvents({ kinds: ["msg.post"], limit: 50 }),
    "agent statuses (agent drawer)": () => store.queryEvents({ kinds: ["agent.status"], limit: 500 }),
    "a channel's page": () => store.queryEvents({ channel: "general", limit: 100 }),
    "a channel's page of statuses (none: bounded by the channel)": () => store.queryEvents({ channel: "general", kinds: ["agent.status"], limit: 100 }),
    "seats roots in a channel": () => store.queryEvents({ channel: "seats-x", kinds: ["msg.post"], agents: ["seats"], roots: true, limit: 50 }),
    "meetings (kind + agents + roots)": () => store.queryEvents({ kinds: ["msg.post"], agents: ["fireflies", "wispr"], roots: true, limit: 500 }),
    "a thread page": () => store.queryEvents({ thread: threadRoot, limit: 100 }),
    "channel stats (/v1/team)": () => store.channelStats(),
    "an origin's newest ts (every emit)": () => store.maxTs(SELF),
    "self seq": () => store.selfSeq(SELF),
    "roster walk (chain build at start)": () => ORIGINS.map((o) => store.rosterRows(o, 0, N_EVENTS)),
    "hidden counts (re-validation)": () => ORIGINS.map((o) => [store.hiddenCount(o), store.hiddenRosterCount(o), store.hiddenBeyond(o, 10, 5)]),
    "blob references": () => store.blobRefRows(blobHash),
    "a re-validation page (all)": () => store.revalPage({ kind: "all" }, 0, 500),
    "the answers' re-validation page": () => store.revalPage({ kind: "answers", ask: askId }, 0, 500),
    "stub channels + due stubs (sync tick)": () => store.dueStubIds(store.stubChannels(), "peer", T0, 1_000, 60_000, 100),
    "has answers": () => store.hasAnswers(askId),
    "team create": () => store.teamCreate(),
    "agent rows + their receipt times (who, Mission Control, archive tick)": () => store.agents().map((r) => store.agentReceivedAt(r)),
    "own stubs (start)": () => store.db.query("SELECT COUNT(*) AS n FROM events WHERE origin = ? AND redacted = 1").get(SELF),
  };
}

describe("hot queries on a 100k-event store", () => {
  test("the synthetic store is the incident's shape", () => {
    expect(store.countEvents()).toBe(N_EVENTS);
    const statuses = store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'agent.status'").get()?.n ?? 0;
    expect(statuses / N_EVENTS).toBeGreaterThan(0.9);
    expect(store.agents().length).toBe(N_AGENTS);
    expect(store.replies(threadRoot).length).toBeGreaterThan(0);
  });

  for (const [name, fn] of Object.entries(hot())) {
    test(`${name}: under ${BUDGET_MS} ms warm`, () => {
      const ms = warm(fn);
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }

  test("no hot query reads events through an index on redacted or status, or scans the table", () => {
    const bad: string[] = [];
    for (const [name, fn] of Object.entries(hot())) {
      for (const p of plans(store.db, fn)) {
        // The only table scan allowed is the newest-row probe (ORDER BY rowid DESC LIMIT 1), which stops at once.
        if (/events_redacted_channel|events_status_origin|\bSCAN (events|e)\b(?! USING)/.test(p)) bad.push(`${name}: ${p}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("the plans that bound each hot query name the index that bounds it", () => {
    const planOf = (fn: () => unknown) => plans(store.db, fn).join(" | ");
    expect(planOf(() => store.replies(threadRoot))).toMatch(/events_thread/);
    expect(planOf(() => store.maxTs(SELF))).toMatch(/COVERING INDEX events_origin_ts/);
    expect(planOf(() => store.rosterRows(SELF, 0, N_EVENTS))).toMatch(/events_roster/);
    expect(planOf(() => store.channelStats())).toMatch(/COVERING INDEX events_visible_channel/);
    expect(planOf(() => store.queryEvents({ channel: "general", kinds: ["agent.status"], limit: 100 }))).toMatch(/events_(visible_channel|channel_ts)/);
    expect(planOf(() => store.queryEvents({ limit: 500 }))).toMatch(/SCAN events USING INDEX events_ts/);
    expect(planOf(() => store.blobRefRows(blobHash))).toMatch(/^SEARCH r USING COVERING INDEX sqlite_autoindex_blob_refs_1/);
    expect(planOf(() => store.revalPage({ kind: "all" }, 0, 500))).toMatch(/INTEGER PRIMARY KEY \(rowid>\?\)/);
  });
});

describe("pre.8 merge: the Linear import's event queries keep the hints", () => {
  test("extRoots and authoredCardRoots read the project channels' visible rows, not every person-authored or root row", () => {
    const db = new ProjectsDb(store.db);
    const a = plans(store.db, () => db.extRoots("linear", "alex")).join(" | ");
    const b = plans(store.db, () => db.authoredCardRoots("p-0e1c7ed0", "alex")).join(" | ");
    for (const p of [a, b]) {
      expect(p).toMatch(/events_(visible_channel|channel_ts)/); // bounded by the channel (or the p- range)
      expect(p).not.toMatch(/events_author_agent_ts|events_thread|events_kind_ts|\bSCAN events\b(?! USING)/);
    }
    expect(warm(() => db.extRoots("linear", "alex"))).toBeLessThan(BUDGET_MS);
  });
});

describe("queryEvents: several kinds read one kind at a time give the same page", () => {
  test("equal to one query over all the kinds, ties included", () => {
    const kinds = ["msg.post", "ask", "answer", "agent.status"];
    for (const f of [{ limit: 500 }, { limit: 37, before_ts: T0 + 70_000 * 1_000 }, { limit: 200, since_ts: T0 + 90_000 * 1_000, agents: ["seats", "agent-3"] }]) {
      const where = ["redacted = 0", "status = 'ok'", `kind IN (${kinds.map(() => "?").join(",")})`];
      const args: (string | number)[] = [...kinds];
      if ("before_ts" in f) { where.push("ts < ?"); args.push(f.before_ts as number); }
      if ("since_ts" in f) { where.push("ts > ?"); args.push(f.since_ts as number); }
      if ("agents" in f) { where.push(`author_agent IN (${(f.agents as string[]).map(() => "?").join(",")})`); args.push(...(f.agents as string[])); }
      const one = store.db.query<{ id: string }, (string | number)[]>(
        `SELECT id FROM events WHERE ${where.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ?`).all(...args, f.limit).map((r) => r.id);
      const split = store.queryEvents({ ...f, kinds: [...kinds, "msg.post"] }).map((r: EventRow) => r.id);
      expect(split).toEqual(one);
      expect(one.length).toBeGreaterThan(0);
    }
    // Rows with the same ts are ordered by id, as SQL orders them.
    const d = tmp();
    const s = new Store(join(d, "w.db"));
    const ins = s.db.query("INSERT INTO events(id, origin, seq, ts, kind, redacted, status, json, received_at) VALUES (?,?,?,?,?,0,'ok','{}',0)");
    ["o:9", "o:10", "o:11", "o:2"].forEach((id, i) => ins.run(id, "o", i + 1, 5, i % 2 ? "ask" : "msg.post"));
    ins.run("o:12", "o", 12, 4, "answer");
    expect(s.queryEvents({ kinds: ["ask", "msg.post", "answer"], limit: 4 }).map((r) => r.id)).toEqual(["o:9", "o:2", "o:11", "o:10"]);
    s.close();
  });
});

describe("agent rows remember when their status was received (migration 13)", () => {
  test("upsertAgent records the event's receipt; a row an older build updated falls back to the event", () => {
    const s = new Store(join(tmp(), "w.db"));
    const ev = { id: "n1:1", origin: "n1", seq: 1, ts: 100, kind: "agent.status", author: { handle: "alex", node: "n1" }, body: { agent: "cc", state: "working" }, sig: "s" };
    s.db.query("INSERT INTO events(id, origin, seq, ts, kind, redacted, status, json, received_at) VALUES ('n1:1','n1',1,100,'agent.status',0,'ok','{}',777)").run();
    s.db.query("INSERT INTO events(id, origin, seq, ts, kind, redacted, status, json, received_at) VALUES ('n1:2','n1',2,200,'agent.status',0,'ok','{}',888)").run();
    s.upsertAgent(ev as never);
    const row = s.agent("n1", "cc");
    expect([row?.recv_id, row?.recv_at]).toEqual(["n1:1", 777]);
    expect(s.agentReceivedAt(row as never)).toBe(777);
    // An older build's upsert moves event_id and leaves recv_* naming the old event: the event's own time is used.
    s.db.query("UPDATE agents_latest SET event_id = 'n1:2', ts = 200 WHERE node = 'n1'").run();
    expect(s.agentReceivedAt(s.agent("n1", "cc") as never)).toBe(888);
    s.close();
  });

  test("a store at migration 12 is upgraded: old indexes replaced, receipts backfilled, every migration recorded once", () => {
    const path = join(tmp(), "old.db");
    const raw = new Database(path, { create: true, strict: true });
    raw.exec("CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (let i = 0; i < 12; i++) {
      raw.exec(MIGRATIONS[i] as string);
      raw.query("INSERT INTO migrations(version, applied_at) VALUES (?, ?)").run(i + 1, 1);
    }
    raw.exec(`INSERT INTO events(id, origin, seq, ts, kind, redacted, status, json, received_at) VALUES ('n1:1','n1',1,100,'agent.status',0,'ok','{}',555);
      INSERT INTO agents_latest(node, agent, handle, event_id, ts, body) VALUES ('n1','cc','alex','n1:1',100,'{}');`);
    raw.close();
    const s = new Store(path);
    const idx = new Set(s.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name));
    expect(idx.has("events_redacted_channel") || idx.has("events_status_origin")).toBe(false);
    for (const n of ["events_stub_origin", "events_stub_channel", "events_rejected", "events_visible_channel", "events_origin_ts", "events_roster"]) expect(idx.has(n)).toBe(true);
    expect(s.agent("n1", "cc")).toMatchObject({ recv_id: "n1:1", recv_at: 555 });
    const versions = s.db.query<{ version: number }, []>("SELECT version FROM migrations ORDER BY version").all().map((r) => r.version);
    expect(versions).toEqual(Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1));
    s.close();
  });
});

function card(id: string, title: string, state = "open"): CardView {
  return {
    id, channel: "p-0e1c7ed0", board: "b", n: Number(id.split(":")[1]), key: `WEB-${id.split(":")[1]}`, title, body: "", labels: [],
    state, column: "todo", assignee: null, updated_at: 1, short: id,
  } as unknown as CardView;
}

describe("board search rows are found by rowid, not by scanning the search table per card", () => {
  test("re-saving a card keeps one search row; deleting it leaves none; search still finds it", () => {
    const s = new Store(join(tmp(), "w.db"));
    const db = new ProjectsDb(s.db);
    if (!db.fts) { s.close(); return; } // a build without FTS5 has no search table
    const count = () => s.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM board_fts").get()?.n;
    for (let i = 0; i < 3; i++) db.saveCard(card("n1:1", `Ship pre.${i}`), null, 1);
    db.saveCard(card("n1:2", "Other"), null, 1);
    expect(count()).toBe(2);
    expect(db.search("pre.2", ["p-0e1c7ed0"], 10)).toEqual(["n1:1"]);
    expect(db.search("pre.0", ["p-0e1c7ed0"], 10)).toEqual([]);
    expect(plans(s.db, () => db.saveCard(card("n1:1", "Again"), null, 1)).some((p) => /board_fts VIRTUAL TABLE INDEX 0:=/.test(p))).toBe(true);
    db.deleteCard("n1:1");
    expect(count()).toBe(1);
    db.saveCard(card("n1:2", "gone", "deleted"), null, 1);
    expect(count()).toBe(0);
    s.close();
  });

  test("rows an older build wrote (by id, unmapped, duplicated) are re-mapped at start, a card keeping its newest", () => {
    const path = join(tmp(), "w.db");
    const s = new Store(path);
    const db = new ProjectsDb(s.db);
    if (!db.fts) { s.close(); return; }
    db.saveCard(card("n1:1", "first"), null, 1);
    // An older build: deletes by id, inserts a new row (not in the map), and once left two rows for one card.
    s.db.exec(`DELETE FROM board_fts WHERE id = 'n1:1';
      INSERT INTO board_fts(id, channel, key, title, body, labels) VALUES ('n1:1','p-0e1c7ed0','WEB-1','stale','','');
      INSERT INTO board_fts(id, channel, key, title, body, labels) VALUES ('n1:1','p-0e1c7ed0','WEB-1','newest','','');
      INSERT INTO board_fts(id, channel, key, title, body, labels) VALUES ('n1:3','p-0e1c7ed0','WEB-3','third','','');`);
    const again = new ProjectsDb(s.db);
    const rows = s.db.query<{ id: string; title: string }, []>("SELECT id, title FROM board_fts ORDER BY id").all();
    expect(rows).toEqual([{ id: "n1:1", title: "newest" }, { id: "n1:3", title: "third" }]);
    again.saveCard(card("n1:1", "latest"), null, 1);
    expect(s.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM board_fts WHERE id = 'n1:1'").get()?.n).toBe(1);
    expect(again.search("latest", ["p-0e1c7ed0"], 10)).toEqual(["n1:1"]);
    s.close();
  });
});

describe("the status scrub's private prefixes are cached per board revision and roster", () => {
  test("a project turning private or public, and a rolled-back write, reach the next scrub", () => {
    const cleanups: (() => void)[] = [];
    try {
      const alex = tnode("alex");
      const { team, create } = createTeam(alex);
      const core = makeCore(alex, team, cleanups);
      expect(core.ingest(create, "local").status).toBe("accepted");
      const projects = new ProjectsIndex(core, createLogger({}));
      const view = (priv: boolean) => JSON.stringify({ channel: "p-0e1c7ed0", prefix: "SEC", private: priv });
      const b = { agent: "cc", state: "working", title: "on SEC-12" };
      expect(projects.scrubStatus(b).title).toBe("on SEC-12");
      projects.db.saveProject("p-0e1c7ed0", null, view(true), 0);
      expect(projects.scrubStatus(b).title).toBe("on ******");
      expect(projects.scrubStatus(b).title).toBe("on ******");
      projects.db.saveProject("p-0e1c7ed0", null, view(false), 0);
      expect(projects.scrubStatus(b).title).toBe("on SEC-12");
      // A write read into the cache and then rolled back: the cache goes with it.
      expect(() => core.store.transaction(() => {
        projects.db.saveProject("p-0e1c7ed0", null, view(true), 0);
        expect(projects.scrubStatus(b).title).toBe("on ******");
        throw new Error("rolled back");
      })).toThrow("rolled back");
      expect(projects.scrubStatus(b).title).toBe("on SEC-12");
    } finally {
      while (cleanups.length) (cleanups.pop() as () => void)();
    }
  });
});

test("migration 13 can be replayed independently without its ledger", () => {
  const s = new Store(join(tmp(), "replay.db"));
  try {
    migrate13(s.db);
    migrate13(s.db);
    expect(s.db.query("PRAGMA table_info(agents_latest)").all().filter((c: any) => c.name === "recv_at")).toHaveLength(1);
    s.db.exec("ALTER TABLE agents_latest DROP COLUMN recv_id");
    migrate13(s.db);
    expect(s.db.query("PRAGMA table_info(agents_latest)").all().filter((c: any) => c.name === "recv_id")).toHaveLength(1);
  } finally { s.close(); }
});
