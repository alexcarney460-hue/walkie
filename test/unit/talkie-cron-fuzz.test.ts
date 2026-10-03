// TALKIE-CRON fuzz (WALK-78): the authority and three leads on the N-node world (test/helpers/talkie-cron-world.ts) with a
// fake clock, lossy requests and acknowledgements, partitions, lead changes, authority transfers, owner edits and resets,
// run-now, and exact wire replays. Ported from the independent final review's fuzz, with the WALK-78 invariants added.
// Defaults are small; the soak is `FUZZ_SEEDS=200 FUZZ_STEPS=200 bun test test/unit/talkie-cron-fuzz.test.ts`
// (also FUZZ_START, FUZZ_COMPACK, FUZZ_COMPREQ, FUZZ_EDITP, FUZZ_WIRELOST=0, FUZZ_VERBOSE=1, FUZZ_TRACE=<seed>).
// Invariants:
//   A  at-most-once: no slot executed twice, executed without an accepted claim, or accepted twice
//   B  an acknowledged completion is the one that was sent
//   C  after a full sync every replica folds the same schedule state as the authority
//   D  a start preserves the authority's failure count and last result
//   E  last_run never decreases inside an epoch and a run id becomes current at most once per epoch
//   F  at every step, no enabled schedule has next_run at or before last_run (WALK-78 item 8); leads run up to 4.9 s ahead
//      of the authority's clock (FUZZ_SKEW=0 turns that off), so an owner edit can land in a started slot's skew window
//   G  after sync and a status read, no unresolved entry survives for a recorded completion
//   H  every peer response matches its production schema
//   I  every captured completion ends recorded, unresolved, held and visible, or named (run id) by a supersession note (items 5, 6)
//   J  every recorded completion that paused the schedule is announced exactly once in #general (item 9)
//   K  a supersession note in #general carries run ids and counts only: never a result (only owners may read results)
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { iso, makeWorld, type Wire, type WorldNode } from "../helpers/talkie-cron-world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; }; }
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 6);
const START = Number(process.env.FUZZ_START ?? 1);
const STEPS = Number(process.env.FUZZ_STEPS ?? 90);
const VERBOSE = process.env.FUZZ_VERBOSE === "1";
const TRACE = Number(process.env.FUZZ_TRACE ?? 0);
const COMP_ACK = Number(process.env.FUZZ_COMPACK ?? 0.14); // acknowledgement-loss probability for completion puts
const COMP_REQ = Number(process.env.FUZZ_COMPREQ ?? 0.06);
const EDITP = Number(process.env.FUZZ_EDITP ?? 0.05);
const SKEW = process.env.FUZZ_SKEW !== "0";
const SKEWS = [0, 0, 1_000, 2_500, 4_000, 4_900]; // all under the authority's five-second claim window
const PREFIX = "walkie-talkie-schedule:v1:";
const UNRESOLVED = "schedule_completion_unresolved";

test(`fuzz seeds ${START}..${START + SEEDS - 1} x ${STEPS} steps`, async () => {
  const violations: string[] = [];
  const totals: Record<string, number> = { steps: 0, runs: 0, completionsCommitted: 0, captured: 0, capCommitted: 0, capUnresolved: 0,
    capHeld: 0, capReported: 0, capSilent: 0, pausesRecorded: 0, orphanUnresolved: 0 };
  const checkedB = new WeakSet<Wire>();
  for (let seed = START; seed < START + SEEDS; seed++) {
    const rand = rng(seed * 104729);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const w = await makeWorld(cleanups, { wireLost: process.env.FUZZ_WIRELOST !== "0" });
    const { nodes, pref, net, at, wall } = w;
    const leadNames = ["mira", "bea", "cy"];
    const down = new Set<string>();
    net.plan = (i) => {
      if (down.has(i.from)) return "req-lost";
      const r = rand();
      const isCompletion = i.path === "schedule-progress" && i.body?.change?.completion_run;
      const pReq = isCompletion ? COMP_REQ : 0.06, pAck = isCompletion ? COMP_ACK : 0.14;
      return r < pReq ? "req-lost" : r < pReq + pAck ? "ack-lost" : "ok";
    };
    pref.v = nodes.mira!.core.nodeId;
    if (SKEW) for (const lead of leadNames) w.skews[lead] = pick(SKEWS);
    const ids: string[] = [];
    for (const [name, cron] of [["A", "*/5 * * * *"], ["B", "*/10 * * * *"]] as const)
      ids.push(nodes.alex!.s.add({ name, cron, task: { prompt: name } }, "alex").id);
    w.syncAll();
    at(wall.value + 3 * 60_000);
    const viol = (step: number, msg: string) => violations.push(`seed ${seed} step ${step}: ${msg}`);
    const stalled = new Set<string>();
    let lastStep = "";
    const check = (step: number, full: boolean) => {
      for (const p of w.audit()) viol(step, `[A] ${p} (after ${lastStep})`);
      for (const rec of net.wires) { // B: every ok completion response equals its request
        if (rec.path !== "schedule-progress" || rec.result !== "ok" || checkedB.has(rec)) continue;
        checkedB.add(rec);
        const change = rec.wire.body.change;
        if (change.op !== "put" || !change.completion_run) continue;
        const text: string = rec.body?.body?.text ?? "";
        if (!text.startsWith(PREFIX)) { viol(step, `[B] completion ack is not a schedule event: ${String(text).slice(0, 40)}`); continue; }
        const got = JSON.parse(text.slice(PREFIX.length));
        if (got.completion_run !== change.completion_run || got.schedule.run_id !== change.schedule.run_id)
          viol(step, `[B] ack for run ${change.completion_run.slice(0, 4)} returned event for run ${got.completion_run?.slice(0, 4)}`);
        else if (got.schedule.failures !== change.schedule.failures || got.schedule.last_result !== change.schedule.last_result)
          viol(step, `[B] ack for a completion (fail=${change.schedule.failures}) returned a DIFFERENT recorded completion (fail=${got.schedule.failures}) (fault=${rec.fault})`);
      }
      const auth = w.authority(); // D/E: a mini-fold per schedule over the authority's stream
      const changes = w.changePosts(auth).sort((a: any, b: any) => (a.term ?? 0) - (b.term ?? 0) || a.seq - b.seq);
      for (const id of ids) {
        let state: any = null; let epoch = -1; const became = new Set<string>(); let lastRun: number | null = null;
        for (const c of changes) {
          const cid = c.op === "put" ? c.schedule.id : c.id;
          if (cid !== id) continue;
          if (c.op === "remove") { state = null; continue; }
          if (c.op === "note") { if (state && state.run_id === c.run_id) state = { ...state, last_result: c.text }; continue; }
          const sameEpoch = (c.epoch ?? 0) === epoch;
          if (!sameEpoch) { epoch = c.epoch ?? 0; became.clear(); lastRun = null; }
          if (state && sameEpoch && c.schedule.run_id !== state.run_id) {
            if (c.schedule.failures !== state.failures) viol(step, `[D] a start changed failures ${state.failures} -> ${c.schedule.failures}`);
            if (state.last_result !== null && c.schedule.last_result !== state.last_result)
              viol(step, `[D] a start changed last_result ${JSON.stringify(state.last_result)} -> ${JSON.stringify(c.schedule.last_result)}`);
            if (c.schedule.run_id) { if (became.has(c.schedule.run_id)) viol(step, `[E] run ${c.schedule.run_id.slice(0, 4)} became current twice`); became.add(c.schedule.run_id); }
          } else if (!state && c.schedule.run_id) became.add(c.schedule.run_id);
          if (c.schedule.last_run !== null) { if (lastRun !== null && c.schedule.last_run < lastRun) viol(step, `[E] last_run decreased ${iso(lastRun)} -> ${iso(c.schedule.last_run)}`); lastRun = c.schedule.last_run; }
          state = c.schedule;
        }
      }
      for (const id of ids) { // F: the authority never holds an enabled schedule whose next slot is one that already started
        const v = w.view(auth, id);
        if (v && v.enabled && v.next_run !== null && v.last_run !== null && v.next_run <= v.last_run && !stalled.has(`${id}:${v.next_run}`)) {
          stalled.add(`${id}:${v.next_run}`);
          viol(step, `[F] STALL enabled next_run ${iso(v.next_run)} <= last_run ${iso(v.last_run)} (schedule ${id.slice(0, 4)}, after ${lastStep})`);
        }
      }
      if (!full) return;
      w.syncAll();
      const fold = (n: WorldNode) => JSON.stringify(readSchedules(n.core));
      const ref = fold(auth);
      for (const n of Object.values(nodes)) if (fold(n) !== ref) viol(step, `[C] ${n.name} folds differently from authority ${auth.name}`);
      const recorded = new Set(w.completions(auth).map((c: any) => `${c.schedule.id}:${c.completion_run}:${c.completion_claim.term}/${c.completion_claim.seq}/${c.completion_claim.generation}`));
      for (const n of Object.values(nodes)) {
        n.s.status();
        const raw = n.core.store.getMeta(UNRESOLVED);
        if (raw) for (const e of JSON.parse(raw)) if (e.claim && recorded.has(`${e.id}:${e.run}:${e.claim.term}/${e.claim.seq}/${e.claim.generation}`))
          viol(step, `[G] ${n.name} keeps an unresolved entry for a RECORDED completion after sync`);
      }
    };
    for (let step = 0; step < STEPS; step++) {
      totals.steps!++;
      const r = rand();
      try {
        if (r < 0.34) {
          const dt = pick([1_000, 2_000, 3_000, 5_000, 15_000, 15_000, 30_000, 60_000, 240_000, 330_000]);
          if (SKEW && rand() < 0.1) w.skews[pick(leadNames)] = pick(SKEWS);
          lastStep = `advance ${dt}`;
          await w.advance(dt, { step: dt <= 60_000 ? Math.min(pick([1_000, 2_000, 15_000]), dt) : 15_000, order: [...w.names].sort(() => rand() - 0.5) });
        } else if (r < 0.52) {
          lastStep = "reply";
          const cands = Object.values(nodes).flatMap((n) => n.turns.filter((t) => !n.replies.has(`turn-${t.run}`)).map((t) => ({ n, t })));
          if (cands.length) { const { n, t } = pick(cands); n.replies.set(`turn-${t.run}`, rand() < 0.5 ? { text: "ok", ok: true } : { text: "fail " + t.run.slice(0, 4), ok: false }); }
        } else if (r < 0.62) {
          lastStep = "sync";
          if (rand() < 0.4) w.syncAll(); else w.syncFrom(w.authority(), nodes[pick(w.names)]!);
        } else if (r < 0.70) {
          lastStep = "partition";
          down.clear(); if (rand() < 0.7) down.add(pick(leadNames));
        } else if (r < 0.75) {
          lastStep = "lead change";
          pref.v = nodes[pick(leadNames)]!.core.nodeId;
        } else if (r < 0.75 + EDITP) {
          lastStep = "edit";
          try { w.authority().s.edit(pick(ids), pick([{ name: "N" + step }, { enabled: false }, { enabled: true }, { task: { prompt: "P" + step } }, { cron: pick(["*/5 * * * *", "*/10 * * * *", "0 * * * *"]) }])); } catch { /* not authority, or catching up */ }
        } else if (r < 0.78 + EDITP) {
          lastStep = "reset";
          try { w.authority().s.reset(pick(ids), wall.value); } catch { /* refusals */ }
        } else if (r < 0.83 + EDITP) {
          lastStep = "run-now";
          const n = nodes[pick(leadNames)]!;
          try { await n.lead.acquire(); await n.s.runNow(pick(ids), wall.value); } catch { /* refusals */ }
        } else if (r < 0.86 + EDITP) {
          lastStep = "transfer";
          w.syncAll();
          try { w.transfer(pick(w.names.filter((n) => n !== w.authority().name))); } catch { /* refused */ }
        } else if (SKEW && r < 0.90 + EDITP) {
          // an owner edit inside a started slot's skew window: the lead (clock ahead) starts the slot, then the authority edits
          lastStep = "skew edit";
          const lead = w.byId(pref.v)!;
          const id = pick(ids);
          const v = w.view(w.authority(), id);
          if ((w.skews[lead.name] ?? 0) >= 1_000 && v?.enabled && v.next_run !== null && v.next_run - 1_000 > wall.value) {
            at(v.next_run - 1_000);
            await w.stepNode(lead);
            try { w.authority().s.edit(id, { name: "W" + step }); } catch { /* not authority, or catching up */ }
          }
        } else {
          lastStep = "replay";
          const recs = net.wires.filter((x) => x.path !== "lease" && wall.value - (x.t ?? 0) < 110_000);
          if (recs.length) { const rec = pick(recs.slice(-15)); try { await w.call(nodes[rec.from]!, rec.path, rec.wire); } catch { /* refused */ } }
        }
      } catch (e) { viol(step, `HARNESS/OP THREW (${lastStep}): ${(e as Error).message}`); }
      if (process.env.FUZZ_MUTATE === "1" && step === 10) {
        // negative control: forge a run whose put overwrites the recorded failure and result, and an unclaimed execution
        const a = w.authority(); const cur = w.view(a, ids[0]!)!; const top = w.changePosts(a).filter((c: any) => (c.op === "put" ? c.schedule.id : c.id) === ids[0]).at(-1);
        a.core.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: a.core.authorityLeaseTerm, after: null, epoch: top?.epoch ?? 0, rev: (top?.rev ?? 0) + 1, schedule: { ...cur, run_id: "99999999-9999-4999-8999-999999999999", failures: (cur.failures + 1) % 3, last_result: "MUTATED" } }) }, { channel: "talkie-schedules" });
        nodes.mira!.turns.push({ run: "88888888-8888-4888-8888-888888888888", at: 0 });
      }
      check(step, step % 12 === 11);
      if (TRACE === seed) console.log(`T${step} ${iso(wall.value)} ${lastStep} auth=${w.authority().name} | ${ids.map((id) => w.show(w.authority(), id)).join(" || ")}`);
    }
    // heal and drain: full connectivity, an answer for every turn, a long advance, then the final checks
    down.clear(); net.plan = () => "ok";
    const answerAll = () => { for (const n of Object.values(nodes)) for (const t of n.turns) if (!n.replies.has(`turn-${t.run}`)) n.replies.set(`turn-${t.run}`, { text: "late ok", ok: true }); };
    answerAll();
    lastStep = "drain";
    for (let round = 0; round < 6; round++) { await w.advance(120_000, { step: 15_000 }); w.syncAll(); answerAll(); }
    check(STEPS, true);
    w.syncAll();
    for (const n of Object.values(nodes)) await w.stepNode(n); // one more tick on each: what the last sync delivered gets settled
    w.syncAll();
    for (const n of Object.values(nodes)) n.s.status();
    w.syncAll();
    for (const b of net.badResponses) viol(STEPS, `[H] peer response failed the production schema on ${b.path}: ${b.issues}`);
    const authorityNode = w.authority();
    const recordedRuns = new Set(w.completions().map((c: any) => `${c.schedule.id}:${c.completion_run}`));
    const posts = w.generalPosts(authorityNode);
    const pausesExpected = new Map<string, number>(); // J: announcements owed, by the pause text they end with
    // the run's own id in a posted note, or in the note still waiting to post
    const named = (n: WorldNode, run: string) => w.generalPosts(n).some((p) => p.includes("superseded by later runs") && p.includes(`run ${run.slice(0, 8)}`))
      || Object.values(JSON.parse(n.core.store.getMeta("schedule_completion_supersession_notes") ?? "{}") as Record<string, { runs?: { run: string }[] }>)
        .some((e) => e.runs?.some((r) => r.run === run.slice(0, 8)));
    for (const n of Object.values(nodes) as WorldNode[]) {
      const unresolved: any[] = JSON.parse(n.core.store.getMeta(UNRESOLVED) ?? "[]");
      const held = w.held(n);
      for (const c of n.captured) {
        totals.captured!++;
        const key = `${c.schedule}:${c.run}`;
        if (recordedRuns.has(key)) {
          totals.capCommitted!++;
          if (c.paused) { totals.pausesRecorded!++; const tail = c.result.slice(0, 300); pausesExpected.set(tail, (pausesExpected.get(tail) ?? 0) + 1); }
        } else if (unresolved.some((e) => e.id === c.schedule && e.run === c.run)) totals.capUnresolved!++;
        else if (held.get(c.schedule)?.run === c.run) {
          totals.capHeld!++;
          if (!n.lead.valid && !(n.s.status() ?? "").includes("held until this machine leads again"))
            viol(STEPS, `[I] ${n.name} holds run ${c.run.slice(0, 4)}'s completion without saying so`);
        } else if (n.superseded.has(c.run) || n.unresolvedLogged.has(c.run)) {
          totals.capReported!++;
          if (!named(n, c.run)) viol(STEPS, `[I] ${n.name}'s completion of run ${c.run.slice(0, 8)} was given up but no supersession note posted or pending names it`);
        } else { totals.capSilent!++; viol(STEPS, `[I] ${n.name}'s captured completion of run ${c.run.slice(0, 4)} (fail=${c.failures}) was lost: not recorded, unresolved, held or reported`); }
      }
      for (const e of unresolved) if (!recordedRuns.has(`${e.id}:${e.run}`)) totals.orphanUnresolved!++;
    }
    for (const p of new Set(w.generalPosts(authorityNode)))
      if (p.includes("superseded by later runs") && p.includes('"')) viol(STEPS, `[K] result text in #general: ${p.slice(0, 120)}`);
    for (const [tail, want] of pausesExpected) {
      const seen = posts.filter((p) => p.includes("paused after three failures: ") && p.endsWith(tail)).length;
      if (seen !== want) viol(STEPS, `[J] ${want} recorded pausing completion(s) ending ${JSON.stringify(tail.slice(0, 40))} but ${seen} pause posts`);
    }
    totals.runs! += Object.values(nodes).reduce((a, n) => a + n.turns.length, 0);
    totals.completionsCommitted! += w.completions().length;
    if (VERBOSE) console.log(`seed ${seed} done: violations so far ${violations.length}`);
    while (cleanups.length) cleanups.pop()?.();
  }
  console.log("FUZZ totals", JSON.stringify(totals));
  console.log("FUZZ violations:", violations.length);
  for (const v of violations.slice(0, 25)) console.log("  " + v);
  expect(violations).toEqual([]);
}, 3_600_000);
