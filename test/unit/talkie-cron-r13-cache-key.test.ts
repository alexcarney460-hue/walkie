// Round 13 item 4 (Opus R12 attack 4a, adapted): the fold's epoch bound depends on core.authorityClaimTerms, so the
// schedule cache key must include it. A replica that folds a reset record before it has the team.authority transfer
// naming that record's term must refold when the transfer arrives; otherwise a PAUSED schedule runs once that replica
// becomes authority + holder.
import { expect, test } from "bun:test";
import { Schedules, foldSchedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { A, B, DUE, ID, MIN, fixture, idle, type Row, type Term } from "./talkie-cron-round12-fixture.ts";

const R = "c".repeat(16);
const eventsOf = (rows: Row[]) => rows.map((row) => ({ body: { text: JSON.parse(row.json).body.text as string },
  origin: row.origin, seq: row.seq, ts: row.ts }));

test("A4a the cache refolds when a later authority term arrives: a paused schedule stays paused on a replica that becomes authority", async () => {
  // B is authority in term 1 (caught up); it resets ID and then a person pauses ID.
  const rowsB: Row[] = [];
  const wallB = { value: DUE + MIN };
  const termsB: Term[] = [{ authority: A, after: null, floor: 0, ceiling: 100 }, { authority: B, after: "transfer:1", floor: 0, ceiling: null }];
  const b = fixture(B, 1, rowsB, termsB, wallB, { [A]: 1, [B]: 0 }, { [A]: 1 });
  new Schedules(b.core, idle).reset(ID, wallB.value);
  const paused = new Schedules(b.core, idle).edit(ID, { enabled: false });
  console.log("A4a on B after reset + pause: enabled =", readSchedules(b.core)[0]!.enabled, "| edit returned enabled =", paused.enabled);

  // Replica R has every schedule-channel row but not yet the team.authority transfer (terms = [A]).
  const rowsR: Row[] = rowsB.map((row) => ({ ...row }));
  const termsR: Term[] = [{ authority: A, after: null, floor: 0, ceiling: null }];
  const wallR = { value: DUE + MIN };
  const vvR: Record<string, number> = { [A]: 1, [B]: rowsB.filter((r) => r.origin === B).length, [R]: 0 };
  const r = fixture(R, 0, rowsR, termsR, wallR, vvR, null);
  console.log("A4a replica R fold before it has the transfer: enabled =", readSchedules(r.core)[0]!.enabled);

  // The transfer entries arrive (B's term, then R's own term: R becomes authority). No talkie-schedules row changes.
  termsR[0] = { ...termsR[0]!, ceiling: 100 };
  termsR.push({ authority: B, after: "transfer:1", floor: 0, ceiling: 50 }, { authority: R, after: "transfer:2", floor: 0, ceiling: null });
  (r.core as unknown as { authorityLeaseTerm: number }).authorityLeaseTerm = 2;
  (r.core as unknown as { authorityTransferWatermark: Record<string, number> }).authorityTransferWatermark = { [B]: vvR[B]! };
  const cached = readSchedules(r.core)[0]!;
  const full = foldSchedules(eventsOf(rowsR), termsR)[0]!;
  console.log(`A4a after the terms arrive: cached fold enabled=${cached.enabled} next_run=DUE+${(cached.next_run! - DUE) / MIN}m | full refold enabled=${full.enabled}`);

  // R is now authority and WalkieTalkie holder; its tick uses the cached fold.
  const epoch = r.lead.grant(R).epoch;
  const turns: string[] = [];
  const runner = { valid: () => true, turn: (p: string, id: string) => { turns.push(p); return `t-${id}`; }, reply: () => null, interrupt: () => {},
    claim: async (id: string, slot: number, run: string) => r.lead.claimFromPeer(R, { schedule: id, slot, run, epoch }) };
  const s = new Schedules(r.core, runner);
  const log: string[] = [];
  for (const at of [DUE + MIN + 10_000, DUE + 5 * MIN + 10_000]) {
    wallR.value = at;
    await s.tick(at);
    const view = readSchedules(r.core)[0]!;
    log.push(`t=DUE+${Math.round((at - DUE) / MIN)}m next_run=DUE+${(view.next_run! - DUE) / MIN}m enabled=${view.enabled} turns=${turns.length}`);
  }
  console.log("A4a R ticks:", log.join(" | "));
  expect(full.enabled).toBe(false);
  expect(cached.enabled).toBe(full.enabled);     // the cache agrees with a full refold of the same rows + terms
  expect(turns.length).toBe(0);                  // the paused schedule did not run
});
