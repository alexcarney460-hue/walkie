// PRE4-INT: the projects lane's store migration (11 on its lane) lands as 12, after pre.3's orch_messages (11). A store
// that ran pre.3's migration list (and holds board-op posts it received from newer peers as ordinary messages, plus
// orchestrator messages) upgrades in place: migration 12 applies, existing posts are classified as board ops, the
// boards fold from them, re-validation runs once for the new rules (validity 10), and nothing pre.3 stored is lost.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema } from "../../src/daemon/config.ts";
import { Core } from "../../src/daemon/core.ts";
import { FakeIdentity } from "../../src/daemon/identity.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { ensureHome, pathsFor } from "../../src/daemon/paths.ts";
import { ProjectsIndex } from "../../src/daemon/projects/index.ts";
import { Hub } from "../../src/daemon/sse.ts";
import { MIGRATIONS, Store } from "../../src/daemon/store.ts";
import { DEFAULT_COLUMNS, isBoardOp } from "../../src/protocol/projects/schema.ts";
import type { BodyOf, Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore, settle, statusOf } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, now, tnode, type TNode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const ORCH = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE orch_messages"));
const BOARDS = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE board_projects"));
/** pre.3's migration list: everything up to and including orch_messages. */
const PRE3 = MIGRATIONS.slice(0, ORCH + 1);
const CH = "p-0e1c7ed0";

describe("migration order", () => {
  test("orch_messages is 11 and the projects boards are 12; DAEMON-STALL-1's indexes are 13, the last one", () => {
    expect(ORCH + 1).toBe(11);
    expect(BOARDS + 1).toBe(12);
    expect(MIGRATIONS.length).toBe(13);
  });

  test("a fresh store runs every migration once", () => {
    const dir = mkdtempSync("/tmp/walkie-fresh-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Store(join(dir, "walkie.db"));
    cleanups.push(() => store.close());
    const versions = store.db.query<{ version: number }, []>("SELECT version FROM migrations ORDER BY version").all().map((r) => r.version);
    expect(versions).toEqual(Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1));
    const tables = new Set(store.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    for (const t of ["orch_messages", "status_provenance", "board_projects", "board_cards", "board_hidden", "board_key_history"]) expect(tables.has(t)).toBe(true);
  });
});

/** Signed events: a team of alex (owner) and bob, a project channel, and a project, board and card made by newer peers. */
function world(dave: TNode) {
  const alex = tnode("alex"), bob = tnode("bob");
  const { team, create } = createTeam(alex);
  const roster: Event[] = [create, memberEv(team, alex, bob, "member"), nodeEv(team, alex, bob), memberEv(team, alex, dave, "member"), nodeEv(team, alex, dave)];
  roster.push(ev(team, alex, "channel.upsert", { name: "general" }), ev(team, alex, "channel.upsert", { name: CH, project: true }));
  const post = (n: TNode, body: Record<string, unknown>, channel = CH) => ev(team, n, "msg.post", body as BodyOf<"msg.post">, { channel });
  const root = post(alex, { text: "project", board: { v: 1, rev: 0, op: "project", name: "Web", prefix: "WEB" } });
  const board = post(alex, { text: "board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } });
  const card = post(bob, { text: "card", board: { v: 1, rev: 0, op: "card", board: board.id, title: "Ship pre.4", column: "todo", n: 1 } });
  const chat = post(bob, { text: "hello" }, "general");
  return { team, bob, events: [...roster, root, board, card, chat], root, board, card, chat };
}

/**
 * A walkie.db built by pre.3's migration list only, holding the rows a full store stored for `events` (copied column
 * by column: pre.3's events table has no bop/fin), an orchestrator message and pre.3's validity version.
 */
function pre3Store(dave: TNode, team: string, events: readonly Event[], list: readonly string[] = PRE3, validity = "7"): string {
  const source = makeCore(dave, team, cleanups);
  feed(source, events);
  const dir = mkdtempSync("/tmp/walkie-pre3-");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "walkie.db");
  const raw = new Database(path, { create: true, strict: true });
  raw.exec("CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  list.forEach((sql, i) => {
    raw.exec(sql);
    raw.query("INSERT INTO migrations(version, applied_at) VALUES (?, ?)").run(i + 1, 1);
  });
  // Every pre.3 table's rows (the chain's channels, members, …), copied by pre.3's columns; meta is set below.
  const tables = raw.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('migrations', 'meta') AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
  for (const t of tables) {
    const cols = raw.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${t}')`).all().map((c) => c.name);
    if (t === "events" && list === PRE3) expect(cols).not.toContain("bop");
    const read = source.store.db.query<Record<string, unknown>, []>(`SELECT ${cols.join(", ")} FROM ${t}`).all();
    if (t === "events") expect(read.length).toBe(events.length);
    const ins = raw.prepare(`INSERT INTO ${t}(${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    for (const r of read) ins.run(...cols.map((c) => r[c] as string | number | null));
  }
  raw.query("INSERT INTO meta(key, value) VALUES ('team', ?), ('validity_version', ?)").run(team, validity);
  if (list.some((m) => m.includes("CREATE TABLE orch_messages"))) {
    raw.query("INSERT INTO orch_messages(id, thread, role, text, ts) VALUES ('m1', 't1', 'person', 'keep me', 1)").run();
  }
  raw.close();
  return dir;
}

/** The daemon's startup over `dir`'s store: Core, then the board index (main.ts order). */
async function start(dir: string, dave: TNode, store = new Store(join(dir, "walkie.db"))) {
  const paths = pathsFor(dir);
  ensureHome(paths);
  const hub = new Hub(60_000, 5);
  const core = new Core({
    paths, config: ConfigSchema.parse({}), log: createLogger({}), keys: dave.keys, store, hub, hostname: dave.hostname,
    ip: "127.0.0.1", login: dave.login, peerPort: 7458, clock: now,
    identity: new FakeIdentity({ ip: "127.0.0.1", login: dave.login, nodeName: dave.hostname }, new Map()),
  });
  const idx = new ProjectsIndex(core, createLogger({}));
  core.onPostChange = (e, change) => idx.onPost(e, change);
  idx.start();
  await settle(core);
  return { store, core, hub, idx, stop: () => { idx.stop(); core.close(); hub.close(); } };
}

const versionsOf = (store: Store) => store.db.query<{ version: number }, []>("SELECT version FROM migrations ORDER BY version").all().map((r) => r.version);
const bopOf = (store: Store, id: string) => store.db.query<{ bop: number }, [string]>("SELECT bop FROM events WHERE id = ?").get(id)?.bop;

describe("PRE4 RC (Codex 1, Opus 3): a projects-lane store, and a rollback to pre.3 and forward again", () => {
  test("a store whose migration 11 was the boards (no orch_messages): orch_messages is created, 12 recorded, nothing re-run", async () => {
    const dave = tnode("dave");
    const w = world(dave);
    const lane = [...MIGRATIONS.slice(0, ORCH), MIGRATIONS[BOARDS] as string];
    const dir = pre3Store(dave, w.team, w.events, lane, "8");
    const s = await start(dir, dave);
    cleanups.push(() => { s.stop(); s.store.close(); });
    expect(versionsOf(s.store)).toEqual(Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1));
    s.store.db.query("INSERT INTO orch_messages(id, thread, role, text, ts) VALUES ('m2', 't1', 'person', 'works', 2)").run();
    expect(s.store.getMeta("validity_version")).toBe("11");
    s.idx.flushAll();
    expect(s.idx.db.card(w.card.id)).toMatchObject({ title: "Ship pre.4", column: "todo" });
  });

  test("an early projects-lane store (PROJECTS-1..6: boards without bop/fin, other card columns) upgrades and re-folds", async () => {
    const dave = tnode("dave");
    const w = world(dave);
    const early = `CREATE TABLE board_projects(channel TEXT PRIMARY KEY, root_id TEXT, json TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE board_cards(id TEXT PRIMARY KEY, channel TEXT NOT NULL, board TEXT NOT NULL, n INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX board_cards_channel ON board_cards(channel, board);`;
    const dir = pre3Store(dave, w.team, w.events, [...MIGRATIONS.slice(0, ORCH), early], "8");
    const raw = new Database(join(dir, "walkie.db"));
    raw.query("INSERT INTO meta(key, value) VALUES ('projects_fold', 'old')").run();
    raw.close();
    const s2 = await start(dir, dave);
    cleanups.push(() => { s2.stop(); s2.store.close(); });
    expect(versionsOf(s2.store)).toEqual(Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1));
    expect([bopOf(s2.store, w.root.id), bopOf(s2.store, w.card.id), bopOf(s2.store, w.chat.id)]).toEqual([1, 1, 0]);
    expect(s2.store.getMeta("validity_version")).toBe("11");
    s2.idx.flushAll();
    expect(s2.idx.db.card(w.card.id)).toMatchObject({ title: "Ship pre.4", column: "todo" });
  });

  test("rows an older build stored with bop 0 after a rollback are classified at the next start, not only once", async () => {
    const dave = tnode("dave");
    const w = world(dave);
    const dir = pre3Store(dave, w.team, w.events);
    const store = new Store(join(dir, "walkie.db"));
    cleanups.push(() => store.close());
    const first = await start(dir, dave, store);
    expect(bopOf(store, w.card.id)).toBe(1);
    first.stop();
    // Nothing new since: a second look examines nothing (the examined mark, PRE4 delta).
    expect(store.classifyBoardOps(() => true)).toEqual({ examined: 0, marked: 0 });
    // pre.3 again: its writes are new rows without bop (a stub upgrade is a delete + insert, as pre.3's upgradeStub),
    // e.g. the card re-stored and a new board op; then pre.4 again.
    const pre3Insert = (e: Event) => store.db.query(`INSERT INTO events(id, origin, seq, ts, kind, channel, thread, author_handle, author_agent, body, sig,
      redacted, status, reason, json, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,'ok',NULL,?,?)`).run(
      e.id, e.origin, e.seq, e.ts, e.kind, e.channel ?? null, null, e.author.handle, null, JSON.stringify(e.body), e.sig, JSON.stringify(e), Date.now());
    store.db.query("DELETE FROM events WHERE id = ?").run(w.card.id);
    pre3Insert(w.card);
    const later = ev(w.team, w.bob, "msg.post", { text: "card 2", board: { v: 1, rev: 0, op: "card", board: w.board.id, title: "Later", column: "todo", n: 2 } } as never, { channel: CH });
    pre3Insert(later);
    expect([bopOf(store, w.card.id), bopOf(store, later.id)]).toEqual([0, 0]);
    store.setMeta("validity_version", "10");
    const again = await start(dir, dave, store);
    cleanups.push(() => again.stop());
    expect([bopOf(store, w.root.id), bopOf(store, w.board.id), bopOf(store, w.card.id), bopOf(store, w.chat.id), bopOf(store, later.id)]).toEqual([1, 1, 1, 0, 1]);
    expect(store.classifyBoardOps(() => true)).toEqual({ examined: 0, marked: 0 });
  });
});

describe("board-op classification is paged and remembers what it examined (PRE4 delta, Codex)", () => {
  test("pages of one row: every p- post examined once; the next call examines none", () => {
    const dave = tnode("dave");
    const w = world(dave);
    const dir = pre3Store(dave, w.team, w.events);
    const store = new Store(join(dir, "walkie.db"));
    cleanups.push(() => store.close());
    expect(store.classifyBoardOps(isBoardOp, 1)).toEqual({ examined: 3, marked: 3 });
    expect(store.classifyBoardOps(isBoardOp, 1)).toEqual({ examined: 0, marked: 0 });
    expect(bopOf(store, w.chat.id)).toBe(0);
  });
});

describe("a pre.3 store upgrades to pre.4", () => {
  test("migration 12 applies, stored posts become board ops and fold into the board, and pre.3's rows survive", async () => {
    const dave = tnode("dave");
    const w = world(dave);
    const dir = pre3Store(dave, w.team, w.events);

    const store = new Store(join(dir, "walkie.db"));
    const versions = store.db.query<{ version: number }, []>("SELECT version FROM migrations ORDER BY version").all().map((r) => r.version);
    expect(versions).toEqual(Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1));
    expect(store.db.query<{ text: string }, []>("SELECT text FROM orch_messages WHERE id = 'm1'").get()?.text).toBe("keep me");

    const paths = pathsFor(dir);
    ensureHome(paths);
    const hub = new Hub(60_000, 5);
    const core = new Core({
      paths, config: ConfigSchema.parse({}), log: createLogger({}), keys: dave.keys, store, hub, hostname: dave.hostname,
      ip: "127.0.0.1", login: dave.login, peerPort: 7458, clock: now,
      identity: new FakeIdentity({ ip: "127.0.0.1", login: dave.login, nodeName: dave.hostname }, new Map()),
    });
    const idx = new ProjectsIndex(core, createLogger({}));
    core.onPostChange = (e, change) => idx.onPost(e, change);
    cleanups.push(() => { idx.stop(); core.close(); hub.close(); store.close(); });
    idx.start(); // as the daemon does at startup (main.ts): no boards folded yet, so everything is re-folded
    await settle(core);

    // The existing rows are classified once (the three board ops, not the chat post) and re-judged (validity 10).
    const bop = (id: string) => store.db.query<{ bop: number }, [string]>("SELECT bop FROM events WHERE id = ?").get(id)?.bop;
    expect([bop(w.root.id), bop(w.board.id), bop(w.card.id), bop(w.chat.id)]).toEqual([1, 1, 1, 0]);
    expect(store.getMeta("validity_version")).toBe("11"); // 10 since the seats mark (PRE4 delta)
    for (const e of w.events) expect(`${e.kind} ${statusOf(core, e.id)} ${store.getRow(e.id)?.reason ?? ""}`).toBe(`${e.kind} ok `);

    idx.flushAll();
    expect(idx.db.card(w.card.id)).toMatchObject({ title: "Ship pre.4", column: "todo", n: 1 });
    expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM board_projects").get()?.n).toBe(1);
    expect(store.db.query<{ text: string }, []>("SELECT text FROM orch_messages WHERE id = 'm1'").get()?.text).toBe("keep me");
  });
});
