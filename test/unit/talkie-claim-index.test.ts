import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../src/daemon/store.ts";
import { CLAIM_PREFIX, CLAIM_RETENTION_MS, CLAIMS_PER_SCHEDULE } from "../../src/daemon/orchestrator/schedule-claims.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { createTeam, ev, tnode } from "../helpers/events.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "55555555-5555-4555-8555-555555555555";
const RUN = "22222222-2222-4222-8222-222222222222";
const AT = 1_700_000_000_000;

test("indexed claim lookup migrates an old latest post and bounds each schedule to 50 records", () => {
  const dir = mkdtempSync("/tmp/walkie-claim-index-");
  const path = join(dir, "walkie.db");
  const a = tnode("alex"), b = tnode("bea");
  const { team } = createTeam(a);
  const terms = [{ authority: a.keys.nodeId, after: null, floor: 0, ceiling: null }];
  let store: Store | null = null;
  try {
    store = new Store(path);
    const post = (by: typeof a, schedule: string, at: number) => {
      const text = CLAIM_PREFIX + JSON.stringify({ schedule, slot: at, run: RUN, epoch: 1,
        holder: a.keys.nodeId, term: 0, after: null, at, checks: {} });
      const event = ev(team, by, "msg.post", { text }, { channel: SCHEDULE_CHANNEL });
      store!.insertEvent(event, "ok", null);
      return event;
    };
    const historical = post(a, OTHER, AT);
    // Simulate a database created before migration 14, with the signed claim still in events.
    store.db.exec(`DROP INDEX events_claim_latest;
      ALTER TABLE events DROP COLUMN claim_schedule; ALTER TABLE events DROP COLUMN claim_at;
      ALTER TABLE events DROP COLUMN claim_term; ALTER TABLE events DROP COLUMN claim_after;
      DROP TABLE hermes_sessions; DELETE FROM migrations WHERE version >= 14;`);
    store.close();
    store = new Store(path);
    expect(store.scheduleClaimEvents(OTHER, AT + 1, CLAIMS_PER_SCHEDULE, terms).map((row) => row.id))
      .toEqual([historical.id]);

    for (let i = 0; i < CLAIMS_PER_SCHEDULE + 10; i++) post(a, ID, AT + i * 60_000);
    post(b, ID, AT + CLAIM_RETENTION_MS); // Valid shape, but not signed by this authority.
    expect(store.scheduleClaimEvents(ID, AT, CLAIMS_PER_SCHEDULE, terms)).toHaveLength(CLAIMS_PER_SCHEDULE);
    expect(store.scheduleClaimEvents(ID, AT, CLAIMS_PER_SCHEDULE, terms).every((row) => row.origin === a.keys.nodeId))
      .toBe(true);
    const latestPlan = store.db.query<{ detail: string }, [string]>(
      `EXPLAIN QUERY PLAN SELECT id FROM events WHERE claim_schedule = ?
       AND redacted = 0 AND status = 'ok' ORDER BY claim_term DESC, seq DESC LIMIT 1`).all(ID);
    expect(latestPlan.some((row) => row.detail.includes("events_claim_latest"))).toBe(true);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration 14 records bounded progress and resumes after a store closes mid-backfill", async () => {
  const dir = mkdtempSync("/tmp/walkie-claim-batch-");
  const path = join(dir, "walkie.db");
  let store: Store | null = null;
  try {
    store = new Store(path);
    const insert = store.db.query(`INSERT INTO events(id, origin, seq, ts, kind, channel, body, json, received_at)
      VALUES (?, 'authority', ?, ?, 'msg.post', 'talkie-schedules', ?, '{}', ?)`);
    const body = JSON.stringify({ text: CLAIM_PREFIX + JSON.stringify({ schedule: ID, slot: AT, run: RUN,
      epoch: 1, holder: "authority", term: 0, after: null, at: AT, checks: {} }) });
    store.db.transaction(() => {
      for (let i = 1; i <= 1_600; i++) insert.run(`claim-${i}`, i, AT, body, AT);
    })();
    store.db.exec(`DROP INDEX events_claim_latest;
      ALTER TABLE events DROP COLUMN claim_schedule; ALTER TABLE events DROP COLUMN claim_at;
      ALTER TABLE events DROP COLUMN claim_term; ALTER TABLE events DROP COLUMN claim_after;
      DROP TABLE hermes_sessions; DELETE FROM migrations WHERE version >= 14;`);
    store.close();
    store = new Store(path);
    expect(store.claimIndexReady).toBe(false);
    const progress = Number(store.getMeta("claim_index_cursor"));
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThan(1_600);
    expect(store.channelEventCount(SCHEDULE_CHANNEL)).toBe(1_600);
    expect(store.db.query("SELECT version FROM migrations WHERE version = 14").get()).toBeNull();
    // What comes after the claim index (Hermes sessions, 16 to 18) waits for its last batch: the ledger is never ahead of the index.
    expect(store.db.query("SELECT version FROM migrations WHERE version > 13").all()).toEqual([]);
    expect(store.db.query("SELECT name FROM sqlite_master WHERE name = 'hermes_sessions'").get()).toBeNull();
    store.close();
    store = new Store(path);
    for (let i = 0; i < 100 && !store.claimIndexReady; i++) await Bun.sleep(5);
    expect(store.claimIndexReady).toBe(true);
    expect(store.getMeta("claim_index_cursor")).toBeNull();
    expect(store.db.query("SELECT version FROM migrations WHERE version = 14").get()).toEqual({ version: 14 });
    // Its last batch ran 15 and the migrations after it, in order, in the same transaction.
    expect(store.db.query<{ version: number }, []>("SELECT version FROM migrations WHERE version >= 14 ORDER BY version").all().map((r) => r.version))
      .toEqual([14, 15, 16, 17, 18]);
    expect(store.db.query("SELECT name FROM sqlite_master WHERE name = 'hermes_sessions'").get()).toEqual({ name: "hermes_sessions" });
    expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE claim_schedule IS NOT NULL").get()?.n)
      .toBe(1_600);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
