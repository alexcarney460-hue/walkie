import { afterEach, expect, setSystemTime, test } from "bun:test";
import { capacityFingerprint, lastPostedSummary, recordPostedSummary, summaryDue, SUMMARY_CLOCK_SKEW_MS, SUMMARY_COOLDOWN_MS, SUMMARY_MARKER_ROWS } from "../../src/daemon/orchestrator/capacity-summary.ts";
import type { Core } from "../../src/daemon/core.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, ev, now, tick, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });

const snapshot = { machines: [{ node: "a", online: true }], seats: [{ node: "a", free: 2 }],
  accounts: [{ key: "alex:acct", state: "ok", windows: [{ kind: "session", scope: null, used_pct: 21 }] }] };

test("capacity fingerprint is ordered and buckets account windows", () => {
  const first = capacityFingerprint(snapshot);
  expect(capacityFingerprint({ ...snapshot, accounts: [{ ...snapshot.accounts[0]!, windows: [{ kind: "session", scope: null, used_pct: 29 }] }] })).toBe(first);
  expect(capacityFingerprint({ ...snapshot, seats: [{ node: "a", free: 1 }] })).not.toBe(first);
  expect(capacityFingerprint({ ...snapshot, machines: [{ node: "a", online: false }] })).not.toBe(first);
  expect(capacityFingerprint({ ...snapshot, accounts: [{ ...snapshot.accounts[0]!, windows: [{ kind: "session", scope: null, used_pct: 30 }] }] })).not.toBe(first);
});

function markerQuery(rows: { json: string; received_at?: number }[]) {
  return {
    query: () => ({
      all: (...args: unknown[]) => {
        const limit = typeof args[3] === "number" ? args[3] : rows.length;
        const matched: { json: string; received_at: number }[] = [];
        for (const row of rows) {
          try {
            const text = (JSON.parse(row.json) as { body?: { text?: unknown } }).body?.text;
            if (typeof text === "string" && text.startsWith("walkie-talkie-capacity-summary:v1:"))
              matched.push({ json: row.json, received_at: row.received_at ?? 1_000_000 });
          } catch { /* not a marker */ }
        }
        return matched.reverse().slice(0, limit);
      },
    }),
  };
}

test("only a changed fingerprint after the cooldown is due; posting persists exact time", () => {
  const values = new Map<string, string>();
  const rows: { json: string }[] = [];
  const core = { clock: () => 1_000_000, store: { getMeta: (key: string) => values.get(key) ?? null,
    setMeta: (key: string, value: string) => { values.set(key, value); }, queryEvents: () => rows, db: markerQuery(rows) },
    emit: (_kind: string, body: { text: string }) => { rows.push({ json: JSON.stringify({ body, author: { handle: "alex" } }) }); } } as unknown as Core;
  const first = capacityFingerprint(snapshot);
  const changed = capacityFingerprint({ ...snapshot, seats: [{ node: "a", free: 1 }] });
  expect(summaryDue(first, lastPostedSummary(core), 10_000)).toBe(true);
  recordPostedSummary(core, first, 10_000);
  expect(lastPostedSummary(core)).toEqual({ fingerprint: first, at: 10_000 });
  const successor = { clock: () => 1_000_000, store: { getMeta: () => null, queryEvents: () => rows, db: markerQuery(rows) } } as unknown as Core;
  expect(lastPostedSummary(successor)).toEqual({ fingerprint: first, at: 10_000 });
  expect(summaryDue(first, lastPostedSummary(core), 10_000 + SUMMARY_COOLDOWN_MS)).toBe(false);
  expect(summaryDue(changed, lastPostedSummary(core), 10_000 + SUMMARY_COOLDOWN_MS - 1)).toBe(false);
  expect(summaryDue(changed, lastPostedSummary(core), 10_000 + SUMMARY_COOLDOWN_MS)).toBe(true);
});

test("a newer marker in the channel wins over the local copy, without scanning posts", () => {
  const owner = tnode("alex");
  const { team, create } = createTeam(owner);
  owner.seq = 1;
  const core = makeCore(owner, team, cleanups);
  core.ingest(create, "local");
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex"] });
  const fingerprint = capacityFingerprint(snapshot);
  recordPostedSummary(core, fingerprint, 10_000);
  const orig = core.store.queryEvents.bind(core.store);
  let queries = 0;
  core.store.queryEvents = (filter) => {
    if (filter.channel === SCHEDULE_CHANNEL) queries++;
    return orig(filter);
  };
  const q = core.store.db.query.bind(core.store.db);
  let sql = 0;
  core.store.db.query = ((statement: string) => {
    if (statement.includes("json_extract(body")) sql++;
    return q(statement);
  }) as typeof core.store.db.query;
  expect(lastPostedSummary(core)).toEqual({ fingerprint, at: 10_000 });
  expect(queries).toBe(0);
  expect(sql).toBe(1);
  const later = "bb".repeat(32);
  // Another owner's machine posted it (this lead's own later marker would be one from before a clock correction).
  const bea = tnode("bea");
  core.emit("team.member", { login: bea.login, handle: "bea", role: "owner" });
  core.emit("team.node", { node_id: bea.keys.nodeId, login: bea.login, hostname: bea.hostname, pubkey: bea.keys.pubkey, ip: "127.0.0.1" });
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "bea"] });
  const marker = ev(team, bea, "msg.post", { text: "walkie-talkie-capacity-summary:v1:" + JSON.stringify({ fingerprint: later, at: 50_000 }) }, { channel: SCHEDULE_CHANNEL });
  expect(core.ingest(marker, "remote").status).toBe("accepted");
  queries = 0;
  sql = 0;
  expect(lastPostedSummary(core)?.fingerprint).toBe(later);
  expect(lastPostedSummary(core)?.at).toBe(50_000);
  expect(queries).toBe(0);
  expect(sql).toBe(2);
});

const MARKER_PREFIX = "walkie-talkie-capacity-summary:v1:";
const META = "talkie_capacity_summary_v1";
const HOUR = 3_600_000;

function summaryCore(clock?: () => number): Core {
  const owner = tnode("alex");
  const { team, create } = createTeam(owner);
  owner.seq = 1;
  const core = makeCore(owner, team, cleanups, clock ? { clock } : {});
  core.ingest(create, "local");
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex"] });
  return core;
}

/** The newest schedule-channel post, with its receipt time. `at` is rewritten inside the stored event. */
function rewriteNewestAt(core: Core, at: number): number {
  const row = core.store.db.query<{ id: string; json: string; received_at: number }, [string]>(
    "SELECT id, json, received_at FROM events WHERE channel = ? AND kind = 'msg.post' ORDER BY ts DESC, seq DESC LIMIT 1",
  ).get(SCHEDULE_CHANNEL);
  if (!row) throw new Error("no marker row");
  const event = JSON.parse(row.json) as { body: { text: string } };
  const payload = JSON.parse(event.body.text.slice(MARKER_PREFIX.length)) as { at: number };
  payload.at = at;
  event.body.text = MARKER_PREFIX + JSON.stringify(payload);
  core.store.db.query("UPDATE events SET json = ?, body = ? WHERE id = ?").run(JSON.stringify(event), JSON.stringify(event.body), row.id);
  return row.received_at;
}

test("a local copy 20 hours ahead of this clock is ignored", () => {
  const core = summaryCore();
  const fingerprint = capacityFingerprint(snapshot);
  recordPostedSummary(core, fingerprint, core.clock());
  expect(core.store.getMeta(META)).toContain(fingerprint);
  const future = core.clock() + 20 * HOUR;
  core.store.setMeta(META, JSON.stringify({ fingerprint: "cd".repeat(32), at: future }));
  expect(lastPostedSummary(core)?.fingerprint).toBe(fingerprint);
  expect(lastPostedSummary(core)?.at).toBeLessThan(future);
});

test("a marker 20 hours ahead of when it was received does not hide the previous picture", () => {
  const core = summaryCore();
  const fingerprint = capacityFingerprint(snapshot);
  const at = core.clock();
  recordPostedSummary(core, fingerprint, at);
  core.store.deleteMeta(META);
  expect(core.store.getMeta(META)).toBeNull();
  tick();
  core.emit("msg.post", { text: MARKER_PREFIX + JSON.stringify({ fingerprint: "ab".repeat(32), at: Date.now() + 20 * HOUR }) }, { channel: SCHEDULE_CHANNEL });
  const seen = lastPostedSummary(core);
  expect(seen?.fingerprint).toBe(fingerprint);
  expect(seen?.at).toBe(at);
});

test("an unreadable newer marker does not hide the last valid one", () => {
  const core = summaryCore();
  const fingerprint = capacityFingerprint(snapshot);
  const at = core.clock();
  recordPostedSummary(core, fingerprint, at);
  core.store.deleteMeta(META);
  tick();
  core.emit("msg.post", { text: MARKER_PREFIX + "{not json" }, { channel: SCHEDULE_CHANNEL });
  const limits: number[] = [];
  const q = core.store.db.query.bind(core.store.db);
  core.store.db.query = ((sql: string) => {
    const statement = q(sql);
    if (!sql.includes("author_agent IS NULL") || !sql.includes("json_extract(body, '$.text') LIKE")) return statement;
    const all = statement.all.bind(statement);
    statement.all = ((...args: unknown[]) => {
      if (typeof args[3] === "number") limits.push(args[3]);
      return all(...(args as Parameters<typeof all>));
    }) as typeof statement.all;
    return statement;
  }) as typeof core.store.db.query;
  const seen = lastPostedSummary(core);
  expect(seen?.fingerprint).toBe(fingerprint);
  expect(seen?.at).toBe(at);
  // The newest row does not count, so the repair read looks at the newest eight and no further.
  expect(limits).toEqual([1, SUMMARY_MARKER_ROWS]);
});

const TEN_MIN = 10 * 60_000;

/** Clock and receipt share one time, and that time stays inside the team's trial. `Date.now` is what the store stamps on receipt. */
function agreeingCore(): Core {
  setSystemTime(new Date(now()));
  return summaryCore(() => Date.now());
}

test("a marker ten minutes ahead of the earlier of receipt and this clock still counts, and one second more does not", () => {
  // Honest allowance is ten minutes. One minute used to be the whole window, so a reader a few minutes slow posted again.
  expect(SUMMARY_CLOCK_SKEW_MS).toBe(TEN_MIN);
  const fingerprint = capacityFingerprint(snapshot);
  const kept = agreeingCore();
  recordPostedSummary(kept, fingerprint, kept.clock());
  kept.store.deleteMeta(META);
  const received = rewriteNewestAt(kept, 0);
  rewriteNewestAt(kept, received + TEN_MIN);
  expect(lastPostedSummary(kept)?.at).toBe(received + TEN_MIN);
  const dropped = agreeingCore();
  recordPostedSummary(dropped, fingerprint, dropped.clock());
  dropped.store.deleteMeta(META);
  const receivedLate = rewriteNewestAt(dropped, 0);
  rewriteNewestAt(dropped, receivedLate + TEN_MIN + 1_000);
  expect(lastPostedSummary(dropped)).toBeNull();
});

test("a local copy ten minutes ahead of this clock still counts, and one second more does not", () => {
  const core = summaryCore();
  const fingerprint = capacityFingerprint(snapshot);
  const at = core.clock();
  recordPostedSummary(core, fingerprint, at);
  core.store.setMeta(META, JSON.stringify({ fingerprint, at: at + TEN_MIN }));
  expect(lastPostedSummary(core)?.at).toBe(at + TEN_MIN);
  core.store.setMeta(META, JSON.stringify({ fingerprint: "cd".repeat(32), at: at + TEN_MIN + 1_000 }));
  expect(lastPostedSummary(core)?.at).toBe(at);
});

test("a marker 20 hours ahead of an honest receipt is still ignored", () => {
  const core = agreeingCore();
  const fingerprint = capacityFingerprint(snapshot);
  recordPostedSummary(core, fingerprint, core.clock());
  core.store.deleteMeta(META);
  const received = rewriteNewestAt(core, 0);
  rewriteNewestAt(core, received + 20 * HOUR);
  expect(lastPostedSummary(core)).toBeNull();
});

test("a marker this machine stored while its own clock was fast is ignored once that clock is corrected", () => {
  const core = agreeingCore();
  const wall = core.clock();
  const fingerprint = capacityFingerprint(snapshot);
  setSystemTime(new Date(wall + 20 * HOUR));
  recordPostedSummary(core, fingerprint, core.clock());
  core.store.deleteMeta(META);
  setSystemTime(new Date(wall));
  // Receipt was stamped by the same fast clock, so comparing the marker only with receipt still looks honest.
  expect(lastPostedSummary(core)).toBeNull();
});

test("a real daemon core signs the summary marker in the owner schedule channel", () => {
  const owner = tnode("alex");
  const { team, create } = createTeam(owner);
  owner.seq = 1;
  const core = makeCore(owner, team, cleanups);
  core.ingest(create, "local");
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex"] });
  const fingerprint = capacityFingerprint(snapshot);
  recordPostedSummary(core, fingerprint, 10_000);
  expect(lastPostedSummary(core)).toEqual({ fingerprint, at: 10_000 });
  expect(core.store.channelEventCount(SCHEDULE_CHANNEL)).toBe(1);
});
