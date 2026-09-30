// Round-11 probe fixture: the builder's in-memory Core from talkie-claim-handover.test.ts (HEAD 288926d), with a
// per-fixture node id, term list, version vector and transfer watermark, so a successor can be built on a partial
// copy of the predecessor's rows (not yet caught up).
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { Schedules } from "../../src/daemon/orchestrator/schedules.ts";
import { type StoredClaim } from "../../src/daemon/orchestrator/schedule-claims.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import type { Core } from "../../src/daemon/core.ts";

export const A = "a".repeat(16), B = "b".repeat(16);
export const ID = "11111111-1111-4111-8111-111111111111";
export const PREFIX = "walkie-talkie-schedule:v1:";
export const CLAIM_PREFIX = "walkie-talkie-claim:v1:";
export const DUE = 36_000_000;
export const MIN = 60_000, HOUR = 60 * MIN;
export type Row = { id: string; origin: string; seq: number; ts: number; json: string };
export type Term = { authority: string; after: string | null; floor: number; ceiling: number | null };
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function fixture(node: string, term: number, rows: Row[], terms: Term[], wall: { value: number },
  vv: Record<string, number>, wm: Record<string, number> | null, extraNodes: readonly string[] = []) {
  const meta = new Map<string, string>();
  const schedule = { id: ID, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" }, enabled: true,
    created_by: "alex", last_run: null, next_run: DUE, last_result: null, failures: 0, run_id: null };
  if (!rows.length) rows.push({ id: "seed:1", origin: A, seq: 1, ts: DUE - 300_000,
    json: JSON.stringify({ body: { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule }) } }) });
  let mono = 0;
  // Claim rows by schedule, rebuilt only when rows were appended (tests with thousands of ids stay fast).
  let indexed = { count: -1, bySchedule: new Map<string, { row: Row; claim: StoredClaim }[]>() };
  const claimsBySchedule = () => {
    if (indexed.count === rows.length) return indexed.bySchedule;
    const bySchedule = new Map<string, { row: Row; claim: StoredClaim }[]>();
    for (const row of rows) {
      const text = JSON.parse(row.json).body.text as string;
      if (!text.startsWith(CLAIM_PREFIX)) continue;
      const claim = JSON.parse(text.slice(CLAIM_PREFIX.length)) as StoredClaim;
      bySchedule.set(claim.schedule, [...(bySchedule.get(claim.schedule) ?? []), { row, claim }]);
    }
    indexed = { count: rows.length, bySchedule };
    return bySchedule;
  };
  const core = {
    nodeId: node, authority: node, authorityLeaseTerm: term, authorityTransferWatermark: wm,
    teamId: "team", hostname: "authority", me: () => ({ handle: "alex", role: "owner" }), myHandle: () => "alex",
    authorityClaimTerms: terms, isAuthority: () => true,
    roster: { nodes: new Map([node, ...extraNodes, ...rows.map((row) => row.origin)].map((id) => [id, { node_id: id, login: "alex" }])), members: new Map([["alex", { role: "owner", handle: "alex" }]]),
      channels: new Map([[SCHEDULE_CHANNEL, { members: ["alex"] }], ["general", {}]]) },
    store: { claimIndexReady: true, getMeta: (key: string) => meta.get(key) ?? null,
      setMeta: (key: string, value: string) => { meta.set(key, value); },
      deleteMeta: (key: string) => { meta.delete(key); },
      transaction: (fn: () => unknown) => fn(), vv: () => vv,
      channelEventCount: () => rows.length,
      queryEvents: (filter: { since_ts?: number; channel?: string }) => rows
        .filter((row) => filter.since_ts === undefined || row.ts > filter.since_ts)
        .filter((row) => filter.channel !== "general" || JSON.parse(row.json).channel === "general")
        .sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id))
        .map((row) => ({ ...row, json: JSON.stringify({ ...JSON.parse(row.json), author: { handle: "alex" } }) })),
      scheduleClaimEvents: (schedule: string, since: number, limit: number) => {
        const matched = [...(claimsBySchedule().get(schedule) ?? [])]
          .sort((a, b) => b.claim.term - a.claim.term || b.row.seq - a.row.seq);
        return matched.slice(0, limit).filter(({ claim }, index) => index === 0 || claim.at >= since)
          .map(({ row }) => row);
      } },
    emit: (_kind: string, body: { text: string }, opts?: { channel?: string }) => {
      const seq = (vv[node] ?? 0) + 1;
      vv[node] = seq;
      const row = { id: `${node}:${String(seq).padStart(6, "0")}`, origin: node, seq, ts: wall.value,
        json: JSON.stringify({ body, channel: opts?.channel }) };
      rows.push(row);
      return row;
    },
    log: { warn: () => {}, debug: () => {}, info: () => {} },
  } as unknown as Core;
  const lead = new Leadership({ core, preferred: () => node, lost: () => {}, now: () => wall.value, monoNow: () => mono });
  mono = 34_000;
  const epoch = lead.grant(node).epoch;
  return { core, lead, epoch, meta };
}

export const idle = { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} };
export function reset(core: Core, at: number) { return new Schedules(core, idle).reset(ID, at); }
export function claimPosts(rows: Row[]) {
  return rows.flatMap((row) => {
    const text = JSON.parse(row.json).body.text as string;
    return text.startsWith(CLAIM_PREFIX) ? [JSON.parse(text.slice(CLAIM_PREFIX.length))] : [];
  });
}
