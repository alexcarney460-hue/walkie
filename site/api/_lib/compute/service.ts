import { bounded, CALL_MS } from './budget.js';
import { enqueueCleanup, drainCleanup } from './cleanup.js';
// The rental-compute control plane's operations (docs/plans/RENT-1.md §5-6): accounts, rent, start, stop, heartbeat.
// The minute tick lives in tick.ts. Pattern for anything that touches a provider: decide and record inside a store
// transaction (account lock, capacity lock), commit, THEN call the driver, then record the outcome in a second
// transaction. A crash in between leaves a rental the tick repairs; it never leaves an unrecorded charge.
import { MIN_HOURS_COVERED, tierSpec } from "./catalog.js";
import { checkOwnership, licenseOwnership, enroll, bindInvite } from "./ownership.js";
import { teamAuthority, chainRelation, type StoredChain } from './team-proof.js';
import { LATEST_MIGRATION } from './migrations.js';
import { handoverKey, heldAccounts, holdHandover, rejectedHandover, seedLegacyEnrollment, type PendingHandover } from './handover.js';
import { noteFirstFunded, observeOwners } from './roster-history.js';
import { bill, refundBoot, capacity, creditNeeded } from "./billing.js";
import { available, assertFresh, launchEligible, launchFrozen, realRental } from "./safety.js";
import { isRealProvider } from "./paid.js";
import type { ComputeDeps } from "./deps.js";
import { newAccountId, newRentalId, newToken, shortSuffix, tokenHash, tokenMatches } from "./tokens.js";
import type { Account, Rental, Tx } from "./store.js";
import { queuePositions, rentalView, stateView } from "./views.js";
import {
  ACTIVE_STATES, IDLE_MINUTES_DEFAULT, type ComputeStateView, type RentalView, type RentReq, type RentResult, type StopReason,
} from "./types.js";
import type { Heartbeat } from "./validate.js";

export class ComputeError extends Error {
  constructor(readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) { super(code); }
}

// ---- accounts ------------------------------------------------------------------------------------------------

/** A new compute account for a team; the token is returned once and only its hash is kept. */
export async function createAccount(d: ComputeDeps, teamId: string, proof?: unknown, allowHandover = true): Promise<{ account_id: string; token: string; adopted_accounts?: { account_id: string; token: string }[]; handover_pending?: { completes_at: number; accounts: readonly string[] } }> {
  try {
    if (d.store.schemaVersion && await d.store.schemaVersion() < LATEST_MIGRATION)
      throw new ComputeError(503, 'compute_state_unavailable');
  } catch {
    d.log('alert_compute_state_unavailable', { team: teamId });
    throw new ComputeError(503, 'compute_state_unavailable');
  }
  const owner = checkOwnership(d, teamId, proof);
  const licensed = await licenseOwnership(d, teamId, owner);
  const token = newToken();
  const id = newAccountId();
  const result = await d.store.tx(async (t) => {
    const previous = await t.enrollment(teamId);
    await t.lockControl(`enrollment-chain:${teamId}`);
    const chain = teamAuthority(teamId, owner)!;
    const oldChain = await t.control(`enrollment-chain:${teamId}`) as StoredChain | undefined;
    const affected = await heldAccounts(t, teamId, d.now());
    if (affected.length) await noteFirstFunded(t, teamId, d.now());
    const pending = await t.control(handoverKey(teamId)) as PendingHandover | undefined;
    if (pending) {
      if (pending.proposed_key !== owner.key || pending.proposed_chain.chainId !== chain.chainId || pending.objected_by)
        return 'conflict';
      if (pending.acknowledged_at || d.now() < pending.expires_at) {
        const held = await holdHandover(d, t, teamId, pending.old_chain, pending.proposed_chain, owner.key,
          pending.owners, pending.proposed_roster, pending.accounts);
        return { pending: held.pending, tokens: held.tokens };
      }
      // The minute tick finalizes due handovers. A request racing it gets an explicit pending reply.
      return 'conflict';
    }
    const relation = oldChain ? chainRelation(oldChain, chain) : 'extends';
    if (!previous && affected.length) {
      const legacy = await seedLegacyEnrollment(t, teamId, owner, oldChain, affected, d.now());
      if (!legacy || chainRelation(legacy, chain) === 'conflict' || chainRelation(legacy, chain) === 'older') {
        d.log('alert_handover_operator_review', { team: teamId, chain: chain.chainId });
        return 'conflict';
      }
      if (!allowHandover) return 'upgrade';
      const held = await holdHandover(d, t, teamId, legacy, chain, owner.key,
        chain.owners, owner, affected);
      return { pending: held.pending, tokens: held.tokens };
    }
    if (previous && oldChain && relation === 'extends') {
      if (await rejectedHandover(t, teamId, oldChain, chain, owner.key)) {
        d.log('alert_handover_rejected_refusal', { team: teamId, old_chain: oldChain.chainId, chain: chain.chainId });
        return 'conflict';
      }
      if (affected.length) {
        if (!allowHandover) return 'upgrade';
        const held = await holdHandover(d, t, teamId, oldChain, chain, owner.key,
          chain.owners, owner, affected);
        return { pending: held.pending, tokens: held.tokens };
      }
    }
    // A pin admits a legacy proposal; it is never approval to move funded tokens.
    if (previous && previous.key !== owner.key && affected.length && (!oldChain || relation === 'equal')) {
      if (d.config.team_authorities[teamId] === owner.key && allowHandover) {
        const root = teamAuthority(teamId, { genesis: owner.genesis });
        if (!oldChain && !root) return 'conflict';
        const held = await holdHandover(d, t, teamId, oldChain ?? root!, chain, owner.key,
          chain.owners, owner, affected);
        return { pending: held.pending, tokens: held.tokens };
      }
      d.log('alert_handover_operator_review', { team: teamId, chain: chain.chainId, eligible_owners: '',
        acknowledged_by: '', objected_by: '' });
      return 'conflict';
    }
    if (await enroll(d, t, teamId, owner, licensed) === 'conflict') return 'conflict';
    const oldOwners = await t.control(`enrollment-owners:${teamId}`) as string[] | undefined;
    if (previous && affected.length && oldOwners &&
        (oldOwners.length !== chain.owners.length || oldOwners.some(k => !chain.owners.includes(k))))
      d.log('alert_enrollment_owners_changed', { team: teamId });
    await observeOwners(t, teamId, chain.owners, d.now());
    await t.setControl(`enrollment-owners:${teamId}`, [...chain.owners]);
    if (previous && previous.key !== owner.key) {
      const accounts = await t.accountsByTeam(teamId);
      if (accounts.length) {
        const adopted = accounts.map((account, index) => ({ account_id: account.id, token: index === 0 ? token : newToken() }));
        for (const item of adopted) await t.setAccount(item.account_id,
          { token_hash: tokenHash(item.token), owner_key: owner.key, authority: owner.key });
        return adopted;
      }
    }
    await t.insertAccount({ id, team_id: teamId, token_hash: tokenHash(token), authority: owner.key, owner_key: owner.key, classification: d.config.internal_teams.includes(teamId) ? "internal" : "customer", status: "active", review: null, created_at: d.now() });
    return [{ account_id: id, token }];
  });
  if (result === 'conflict') throw new ComputeError(403, 'team_ownership_required');
  if (result === 'upgrade') throw new ComputeError(426, 'compute_upgrade_required');
  if (!Array.isArray(result)) {
    d.log('compute_handover_pending', { team: teamId, accounts: result.pending.accounts.length,
      completes_at: result.pending.completes_at });
    return { ...result.tokens[0]!, adopted_accounts: result.tokens,
      handover_pending: { completes_at: result.pending.completes_at ?? result.pending.expires_at,
        accounts: result.pending.accounts } };
  }
  d.log("account_created", { account: result[0]!.account_id, team: teamId });
  return { ...result[0]!, ...(result.length > 1 ? { adopted_accounts: result } : {}) };
}

export async function accountForToken(d: ComputeDeps, token: string): Promise<Account | null> {
  const a = await d.store.tx((t) => t.accountByTokenHash(tokenHash(token)));
  return a && tokenMatches(token, a.token_hash) ? a : null;
}

export async function state(d: ComputeDeps, accountId: string): Promise<ComputeStateView> {
  return d.store.tx(async (t) => {
    const a = await t.lockAccount(accountId);
    if (!a) throw new ComputeError(401, "invalid_token");
    const rentals = await t.rentals(a.id);
    const last = await t.control('last_tick');
    const alerts: NonNullable<ComputeStateView['alerts']> = [];
    if (typeof last !== 'number' || d.now() - last > 180_000) {
      alerts.push('tick_stale');
      d.log('alert_tick_stale', { last_tick_at: typeof last === 'number' ? last : null });
    }
    if (rentals.some(r => r.safety?.alert === 'termination_delayed')) alerts.push('termination_delayed');
    return { ...stateView(a, await t.balance(a.id), rentals, queuePositions(await t.activeRentals())), alerts };
  });
}

// ---- launching -----------------------------------------------------------------------------------------------

interface Launch { readonly rental: Rental; readonly code: string; readonly heartbeatToken: string }

function refuseUnlessActive(a: Account | null): Account {
  if (!a) throw new ComputeError(401, "invalid_token");
  if (a.status === "frozen") throw new ComputeError(403, "account_frozen");
  if (a.review) throw new ComputeError(403, "account_under_review");
  return a;
}

/** Persist secrets with the pending request; only the budgeted tick may claim it. */
async function markStarting(t: Tx, r: Rental, code: string, now: number): Promise<Launch> {
  const heartbeatToken = newToken();
  const patch = {
    state: "starting" as const, started_at: null, needs_code_at: null, heartbeat_hash: tokenHash(heartbeatToken),
    safety: { ...r.safety!, claim: 'pending' as const, code, heartbeat_token: heartbeatToken },
  };
  await t.updateRental(r.id, patch);
  return { rental: { ...r, ...patch }, code, heartbeatToken };
}

function newRental(a: Account, tier: Rental["tier"], now: number, idleMinutes: number, ord: number, walkieVersion: string): Rental {
  return {
    id: newRentalId(), account_id: a.id, team_id: a.team_id, tier, name: `rent-${tier}-${shortSuffix()}`, state: "queued",
    price_per_hour_micros: tierSpec(tier).price_per_hour_micros, idle_minutes: idleMinutes, created_at: now, ord, walkie_version: walkieVersion,
    needs_code_at: null, started_at: null, ended_at: null, end_reason: null, instance_id: null, heartbeat_hash: null,
    last_heartbeat_at: null, last_busy_at: null, gpu_hot_since: null, egress_bytes: 0, egress_billed_gib: 0, node_id: null,
    charged_micros: 0, billed_minutes: 0, launch_attempts: 0,
  };
}

async function viewsFor(t: Tx, ids: readonly string[]): Promise<RentalView[]> {
  const positions = queuePositions(await t.activeRentals());
  const out: RentalView[] = [];
  for (const id of ids) {
    const r = await t.rental(id);
    if (r) out.push(rentalView(r, positions));
  }
  return out;
}

/**
 * Rent any number of machines, any mix of tiers. Credit must cover the first hour of every machine asked for. Each
 * machine is reserved for the tick if our quota has room (and nothing older waits for that quota), else it is queued and started
 * by the tick as capacity frees. Idempotent on the request's key.
 */
export async function rent(d: ComputeDeps, accountId: string, req: RentReq): Promise<RentResult> {
  const now = d.now();
  const decided = await d.store.tx(async (t) => {
    const a = await t.lockAccount(accountId);
    if (!a) throw new ComputeError(401, "invalid_token");
    const prior = await t.rentRequest(a.id, req.idempotency_key);
    if (prior) return { replay: prior, launches: [] as Launch[], ids: prior.rental_ids, codeIndex: prior.code_index };
    refuseUnlessActive(a);
    if (await launchFrozen(t, a.team_id)) throw new ComputeError(403, 'team_ownership_required');
    if (d.enabled === false) throw new ComputeError(503, "compute_not_configured");
    await assertFresh(d, t);
    const funds = await available(t, a.id);
    const balance = funds.total;
    const needed = creditNeeded(req.machines, MIN_HOURS_COVERED);
    if (balance < needed) throw new ComputeError(402, "insufficient_credit", { needed_micros: needed, balance_micros: balance });
    const real = req.machines.filter((m) => isRealProvider(d.config, m.tier));
    if (real.length) {
      if (a.classification !== "customer" || !(await launchEligible(d, t, a))) throw new ComputeError(403, "team_ineligible");
      const paid = funds.paid;
      const paidNeeded = creditNeeded(real, MIN_HOURS_COVERED);
      if (paid < paidNeeded) throw new ComputeError(402, "insufficient_credit", { needed_micros: paidNeeded, balance_micros: Math.max(0, paid) });
    }
    await t.lockCapacity();
    const active = await t.activeRentals();
    const cap = capacity(active, d.config);
    const waiting = new Set(active.filter((r) => r.state === "queued").map((r) => d.config.tiers[r.tier].quota_group));
    const launches: Launch[] = [];
    const ids: string[] = [];
    const codeIndex: Record<string, number> = {};
    let i = 0;
    for (const m of req.machines) {
      for (let k = 0; k < m.count; k++, i++) {
        const base = newRental(a, m.tier, now, req.idle_minutes ?? IDLE_MINUTES_DEFAULT, i, req.walkie_version);
        const provider = d.config.tiers[m.tier].provider;
        const r: Rental = { ...base, safety: { provider, cost_per_hour_micros: d.config.tiers[m.tier].cost_per_hour_micros, reserved: base.price_per_hour_micros, claim: 'pending', key: base.id } };
        const providers = (await t.control('providers') ?? []) as string[];
        await t.setControl('providers', [...new Set([...providers, provider])]);
        await bindInvite(t, a, req.codes[i]!, r.id, now);
        await t.insertRental(r);
        ids.push(r.id);
        const group = d.config.tiers[m.tier].quota_group;
        if (waiting.has(group) || !cap.take(m.tier)) {
          waiting.add(group); // keep FIFO: nothing later in this group jumps the queue either
          continue;
        }
        codeIndex[r.id] = i;
        launches.push(await markStarting(t, r, req.codes[i] as string, now));
      }
    }
    await t.insertRentRequest({ account_id: a.id, idem_key: req.idempotency_key, rental_ids: ids, code_index: codeIndex, created_at: now });
    d.log("rent", { account: a.id, machines: ids.length, starting: launches.length });
    return { replay: null, launches, ids, codeIndex };
  });

  return d.store.tx(async (t) => {
    const rentals = await viewsFor(t, decided.ids);
    return {
      rentals, started: Object.keys(decided.codeIndex).length, queued: rentals.filter((r) => r.state === "queued").length,
      code_index: { ...decided.codeIndex }, balance_micros: await t.balance(accountId), replay: decided.replay !== null,
    };
  });
}

/** The owner's daemon supplies a fresh join code for a rental waiting in `needs_code`. */
export async function start(d: ComputeDeps, accountId: string, rentalId: string, code: string, walkieVersion?: string): Promise<RentalView> {
  await d.store.tx(async (t) => {
    const a = refuseUnlessActive(await t.lockAccount(accountId));
    if (await launchFrozen(t, a.team_id)) throw new ComputeError(403, 'handover_pending');
    await assertFresh(d, t);
    const r = await t.rental(rentalId);
    if (!r || r.account_id !== accountId) throw new ComputeError(404, "not_found");
    if (r.state !== "needs_code") throw new ComputeError(409, "not_waiting_for_code", { state: r.state });
    if (realRental(r) && (a.classification !== "customer" || !(await launchEligible(d, t, a)))) throw new ComputeError(403, 'team_ineligible');
    const funds = await available(t, accountId, r.id);
    const balance = realRental(r) ? funds.paid : funds.total;
    if (balance < r.price_per_hour_micros) throw new ComputeError(402, "insufficient_credit", { needed_micros: r.price_per_hour_micros, balance_micros: Math.max(0, balance) });
    await bindInvite(t, a, code, r.id, d.now());
    if (walkieVersion) await t.updateRental(r.id, { walkie_version: walkieVersion });
    await markStarting(t, r, code, d.now());
  });

  return d.store.tx(async (t) => (await viewsFor(t, [rentalId]))[0] as RentalView);
}

// ---- stopping ------------------------------------------------------------------------------------------------

/**
 * Inside an account-locked transaction: bills to now and moves each rental to `stopping` (a machine exists or may) or
 * straight to `ended` (queued, never launched). v1 stop = terminate + wipe: no kept disks. Returns what to terminate.
 */
export async function markStopped(t: Tx, rentals: readonly Rental[], reason: StopReason, now: number): Promise<Rental[]> {
  const toTerminate: Rental[] = [];
  for (const r0 of rentals) {
    if (!ACTIVE_STATES.has(r0.state) || r0.state === "stopping") continue;
    const r = await bill(t, r0, now);
    const hasMachine = r.state === "starting" || r.state === "running";
    const patch = { state: hasMachine ? "stopping" as const : "ended" as const, ended_at: hasMachine ? null : now, end_reason: reason, heartbeat_hash: null,
      ...(r.safety ? { safety: { ...r.safety, claim: "cancelled" as const, code: undefined, heartbeat_token: undefined } } : {}) };
    await t.updateRental(r.id, patch);
    if (hasMachine) {
      toTerminate.push({ ...r, ...patch });
      await enqueueCleanup(t, r.safety?.provider ?? 'unknown', r.instance_id ?? '', r.id);
    }
  }
  return toTerminate;
}

/** Terminates (idempotently) and records `ended`; a failure leaves it `stopping` for the tick to retry. */
export async function terminate(d: ComputeDeps, r: Rental, timeoutMs = CALL_MS): Promise<boolean> {
  if (r.safety?.retry_at && d.now() < r.safety.retry_at) return false;
  if (!r.instance_id && r.safety?.claimed_at) return false; // uncertain create: reconcile owns confirmation
  if (r.instance_id) {
    const driver = d.driver(r.safety?.provider ?? d.config.tiers[r.tier].provider);
    if (!driver) { d.log('alert_provider_unavailable', { rental: r.id }); return false; }
    try {
      await bounded(signal => driver.terminate(r.instance_id!, signal), timeoutMs);
    } catch (err) {
      d.log("terminate_failed", { rental: r.id, instance: r.instance_id, error: err instanceof Error ? err.name : "error" });
      await d.store.tx(async t => {
        await t.lockAccount(r.account_id);
        const cur = await t.rental(r.id);
        if (!cur?.safety || cur.state !== 'stopping') return;
        const attempts = (cur.safety.terminate_attempts ?? 0) + 1;
        await t.updateRental(r.id, { safety: { ...cur.safety, terminate_attempts: attempts,
          retry_at: d.now() + Math.min(60_000 * 2 ** (attempts - 1), 900_000),
          ...(attempts >= 3 ? { alert: 'termination_delayed' } : {}) } });
        if (attempts >= 3) d.log('alert_termination_delayed', { rental: r.id, attempts });
      });
      return false;
    }
  }
  await d.store.tx(async (t) => {
    await t.lockAccount(r.account_id);
    const cur = await t.rental(r.id);
    if (cur?.state === "stopping") {
      const billed = await bill(t, cur, d.now());
      if (cur.end_reason === "boot_timeout") await refundBoot(t, billed, d.now());
      await t.updateRental(r.id, { state: "ended", ended_at: d.now() });
    }
  });
  d.log("ended", { rental: r.id, reason: r.end_reason ?? "user" });
  return true;
}

export async function stop(d: ComputeDeps, accountId: string, target: { rental_id: string } | { all: true }): Promise<{ stopped: number; rentals: RentalView[] }> {
  const { ids } = await d.store.tx(async (t) => {
    const a = await t.lockAccount(accountId);
    if (!a) throw new ComputeError(401, "invalid_token");
    let rs: Rental[];
    if ("all" in target) {
      rs = (await t.rentals(a.id, 0)).filter((r) => ACTIVE_STATES.has(r.state));
    } else {
      const r = await t.rental(target.rental_id);
      if (!r || r.account_id !== a.id) throw new ComputeError(404, "not_found");
      rs = [r];
    }
    return { toTerminate: await markStopped(t, rs, "user", d.now()), ids: rs.map((r) => r.id) };
  });
  await drainCleanup(d, Math.min(d.deadline ?? Infinity, Date.now() + 5_000));
  const rentals = await d.store.tx((t) => viewsFor(t, ids));
  return { stopped: ids.length, rentals };
}

// ---- heartbeat -----------------------------------------------------------------------------------------------

/** GPU at or above this with no seat and no pool job counts toward the mining heuristic. */
export const GPU_HOT_PCT = 95;

/** A rented machine reports liveness and load (per-rental token). Returns its state so the box can tell it's done. */
export async function heartbeat(d: ComputeDeps, hb: Heartbeat): Promise<{ state: string }> {
  const now = d.now();
  return d.store.tx(async (t) => {
    const r0 = await t.rental(hb.rental_id);
    if (!r0 || !tokenMatches(hb.token, r0.heartbeat_hash)) throw new ComputeError(403, "invalid_heartbeat");
    await t.lockAccount(r0.account_id);
    const r = (await t.rental(hb.rental_id)) as Rental;
    if (r.state !== "starting" && r.state !== "running") return { state: r.state };
    if (hb.bootstrap_failed) {
      if (r.state !== 'starting' || r.last_heartbeat_at !== null || r.node_id !== null) {
        d.log('alert_bootstrap_failure_ignored', { rental: r.id });
        return { state: r.state };
      }
      await markStopped(t, [r], 'boot_timeout', now);
      d.log('bootstrap_failed', { rental: r.id });
      return { state: 'stopping' };
    }
    if (!r.instance_id) return { state: r.state };
    const busy = hb.busy_seats > 0 || hb.pool_jobs > 0;
    const hot = !busy && (hb.gpu_pct ?? 0) >= GPU_HOT_PCT;
    await t.updateRental(r.id, {
      state: "running", last_heartbeat_at: now,
      last_busy_at: busy || r.last_busy_at === null ? now : r.last_busy_at,
      gpu_hot_since: hot ? (r.gpu_hot_since ?? now) : null,
      egress_bytes: Math.max(r.egress_bytes, hb.egress_bytes),
      ...(hb.node_id && !r.node_id ? { node_id: hb.node_id } : {}),
    });
    return { state: "running" };
  });
}
