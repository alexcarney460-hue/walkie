// Round-10 probe fixture: the builder's in-memory Core from talkie-claim-handover.test.ts (HEAD eacf71b),
// extended with the audit fields reset now requires and an emit ts that follows Core.emit's real rule
// (ts = max(clock, min(maxTs(self), clock + FUTURE_SKEW_MS))).
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { Schedules } from "../../src/daemon/orchestrator/schedules.ts";
import { type StoredClaim } from "../../src/daemon/orchestrator/schedule-claims.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import type { Core } from "../../src/daemon/core.ts";

export const A = "a".repeat(16);
export const ID = "11111111-1111-4111-8111-111111111111";
export const RUN = "22222222-2222-4222-8222-222222222222";
export const PREFIX = "walkie-talkie-schedule:v1:";
export const CLAIM_PREFIX = "walkie-talkie-claim:v1:";
export const DUE = 36_000_000;
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export type Row = { id: string; origin: string; seq: number; ts: number; json: string };
export const T0 = [{ authority: A, after: null, floor: 0, ceiling: null }];

export function fixture(rows: Row[], wall: { value: number }, over: Record<string, unknown> = {}) {
  const node = A;
  const vv: Record<string, number> = { [A]: 1 };
  const meta = new Map<string, string>();
  const schedule = { id: ID, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" }, enabled: true,
    created_by: "alex", last_run: null, next_run: DUE, last_result: null, failures: 0, run_id: null, ...over };
  if (!rows.length) rows.push({ id: "seed:1", origin: A, seq: 1, ts: DUE - 300_000,
    json: JSON.stringify({ body: { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule }) } }) });
  let mono = 0;
  const core = {
    nodeId: node, authority: node, authorityLeaseTerm: 0, authorityTransferWatermark: null,
    teamId: "team", hostname: "authority", me: () => ({ handle: "alex", role: "owner" }), myHandle: () => "alex",
    authorityClaimTerms: T0, isAuthority: () => true,
    roster: { nodes: new Map([node, ...rows.map((row) => row.origin)].map((id) => [id, { node_id: id, login: "alex" }])), members: new Map([["alex", { role: "owner", handle: "alex" }]]),
      channels: new Map([[SCHEDULE_CHANNEL, { members: ["alex"] }], ["general", {}]]) },
    store: { claimIndexReady: true, getMeta: (key: string) => meta.get(key) ?? null,
      setMeta: (key: string, value: string) => { meta.set(key, value); },
      deleteMeta: (key: string) => { meta.delete(key); },
      transaction: (fn: () => unknown) => fn(), vv: () => vv,
      channelEventCount: () => rows.length,
      queryEvents: (filter: { since_ts?: number }) => rows
        .filter((row) => filter.since_ts === undefined || row.ts > filter.since_ts)
        .sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id))
        .map((row) => ({ ...row, json: JSON.stringify({ ...JSON.parse(row.json), author: { handle: "alex" } }) })),
      scheduleClaimEvents: (sched: string, since: number, limit: number) => {
        const matched = rows.flatMap((row) => {
          const text = JSON.parse(row.json).body.text as string;
          if (!text.startsWith(CLAIM_PREFIX)) return [];
          const claim = JSON.parse(text.slice(CLAIM_PREFIX.length)) as StoredClaim;
          return claim.schedule === sched ? [{ row, claim }] : [];
        }).sort((a, b) => b.claim.term - a.claim.term || b.row.seq - a.row.seq);
        return matched.slice(0, limit).filter(({ claim }, index) => index === 0 || claim.at >= since)
          .map(({ row }) => row);
      } },
    emit: (_kind: string, body: { text: string }) => {
      const seq = (vv[node] ?? 0) + 1;
      vv[node] = seq;
      const maxTs = rows.filter((r) => r.origin === node).reduce((m, r) => Math.max(m, r.ts), 0);
      const ts = Math.max(wall.value, Math.min(maxTs, wall.value + 5 * MIN));
      const row = { id: `${node}:${String(seq).padStart(6, "0")}`, origin: node, seq, ts, json: JSON.stringify({ body }) };
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

export function reset(core: Core, at: number) {
  return new Schedules(core, { valid: () => true, claim: async () => false, turn: () => "",
    reply: () => null, interrupt: () => {} }).reset(ID, at);
}

export function claimPosts(rows: Row[]) {
  return rows.flatMap((row) => {
    const text = JSON.parse(row.json).body.text as string;
    return text.startsWith(CLAIM_PREFIX) ? [JSON.parse(text.slice(CLAIM_PREFIX.length))] : [];
  });
}

/** A holder that is the authority: every tick claims through the real Leadership and records the decision. */
export function ticker(core: Core, lead: Leadership, epoch: number) {
  const decisions: { slot: number; result: unknown }[] = [];
  const schedules = new Schedules(core, {
    valid: () => true,
    claim: async (id, slot, run, runNow, targets) => {
      const result = lead.claimFromPeer(A, { schedule: id, slot, run, epoch,
        ...(runNow ? { run_now: true } : {}), ...(targets ? { capacity_targets: [...targets] } : {}) });
      decisions.push({ slot, result });
      return result;
    },
    turn: () => "turn", reply: () => ({ text: "ok", ok: true }), interrupt: () => {},
  });
  return { schedules, decisions };
}
