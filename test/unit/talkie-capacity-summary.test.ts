import { afterEach, expect, test } from "bun:test";
import { capacityFingerprint, lastPostedSummary, recordPostedSummary, summaryDue, SUMMARY_COOLDOWN_MS } from "../../src/daemon/orchestrator/capacity-summary.ts";
import type { Core } from "../../src/daemon/core.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const snapshot = { machines: [{ node: "a", online: true }], seats: [{ node: "a", free: 2 }],
  accounts: [{ key: "alex:acct", state: "ok", windows: [{ kind: "session", scope: null, used_pct: 21 }] }] };

test("capacity fingerprint is ordered and buckets account windows", () => {
  const first = capacityFingerprint(snapshot);
  expect(capacityFingerprint({ ...snapshot, accounts: [{ ...snapshot.accounts[0]!, windows: [{ kind: "session", scope: null, used_pct: 29 }] }] })).toBe(first);
  expect(capacityFingerprint({ ...snapshot, seats: [{ node: "a", free: 1 }] })).not.toBe(first);
  expect(capacityFingerprint({ ...snapshot, machines: [{ node: "a", online: false }] })).not.toBe(first);
  expect(capacityFingerprint({ ...snapshot, accounts: [{ ...snapshot.accounts[0]!, windows: [{ kind: "session", scope: null, used_pct: 30 }] }] })).not.toBe(first);
});

test("only a changed fingerprint after the cooldown is due; posting persists exact time", () => {
  const values = new Map<string, string>();
  const rows: { json: string }[] = [];
  const core = { store: { getMeta: (key: string) => values.get(key) ?? null,
    setMeta: (key: string, value: string) => { values.set(key, value); }, queryEvents: () => rows },
    emit: (_kind: string, body: { text: string }) => { rows.push({ json: JSON.stringify({ body, author: { handle: "alex" } }) }); } } as unknown as Core;
  const first = capacityFingerprint(snapshot);
  const changed = capacityFingerprint({ ...snapshot, seats: [{ node: "a", free: 1 }] });
  expect(summaryDue(first, lastPostedSummary(core), 10_000)).toBe(true);
  recordPostedSummary(core, first, 10_000);
  expect(lastPostedSummary(core)).toEqual({ fingerprint: first, at: 10_000 });
  const successor = { store: { getMeta: () => null, queryEvents: () => rows } } as unknown as Core;
  expect(lastPostedSummary(successor)).toEqual({ fingerprint: first, at: 10_000 });
  expect(summaryDue(first, lastPostedSummary(core), 10_000 + SUMMARY_COOLDOWN_MS)).toBe(false);
  expect(summaryDue(changed, lastPostedSummary(core), 10_000 + SUMMARY_COOLDOWN_MS - 1)).toBe(false);
  expect(summaryDue(changed, lastPostedSummary(core), 10_000 + SUMMARY_COOLDOWN_MS)).toBe(true);
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
