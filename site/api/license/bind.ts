// POST /api/license/bind {code, team_id} → {key, renewal_token?} (docs/BUSINESS.md "Billing", audit H3).
// The roster authority calls this from `walkie license activate <code>`. The code must be an
// activation code we signed; its subscription must be active and either unbound or already bound to
// this team (idempotent). The FIRST bind stores the team id and the sha256 of a fresh 32-byte renewal
// token in the subscription's metadata and returns the token, once; later binds of the same team get a
// fresh key without it. Another team → 409 license_bound_elsewhere.
import { randomBytes } from "node:crypto";
import { optionalEnv, requireEnv } from "../_lib/env.js";
import { fail, json, logError } from "../_lib/http.js";
import { defaultDeps, issueKey, LICENSED_STATUS, payloadFor, verifyActivationCode, type Deps } from "../_lib/issue.js";
import { LicenseError, MAX_KEY_CHARS, TEAM_ID } from "../_lib/license.js";
import { RENEW_AUTHORITY_META, RENEW_CHAIN_META, RENEW_HASH_META, renewHash, TEAM_META } from "../_lib/metadata.js";
import { lockSubscriptionClaim } from '../_lib/subscription-claim.js';
import { readJsonObject } from "../_lib/body.js";
import { teamAuthority, chainRelation } from "../_lib/compute/team-proof.js";
import { verifySig } from "../_lib/protocol/keys.js";
import { AUTHORITY_CHAIN_META, AUTHORITY_DEPTH_META, AUTHORITY_META, authorityPathMetadata, readAuthorityPath } from "../_lib/metadata.js";
import type { PgStore } from '../_lib/compute/pg-store.js';
import type { ComputeStore } from '../_lib/compute/store.js';
import type { Tx } from '../_lib/compute/store.js';
import { sendAlert } from '../_lib/compute/alerts.js';
import { heldAccounts, handoverKey, holdHandover, licenseTransitionKey, rejectedHandover, rejectedHandoverDigest,
  requireHandoverTokenKey, seedLegacyEnrollment } from '../_lib/compute/handover.js';
import { stderrLog } from '../_lib/compute/deps.js';
import { refusedFork } from '../_lib/compute/fork-rejection.js';
import { LATEST_MIGRATION } from '../_lib/compute/migrations.js';
import type { LicenseTransition } from '../_lib/compute/handover.js';
import { MAX_BODY_BYTES } from '../_lib/body.js';
import { ComputeError } from '../_lib/compute/service.js';
import { openBindClaim, sealBindClaim } from '../_lib/compute/bind-claim.js';
import { replayBindWrite } from '../_lib/compute/bind-write.js';
import { computeConfigurationError, COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION } from '../_lib/compute/release-gate.js';

class StripeOperationError extends Error {
  constructor(readonly cause: unknown) { super('stripe_operation_failed'); }
}

export const bindMessage = (team: string, license: string, expires: number): string =>
  `walkie-license-bind-v1\n${team}\n${license}\n${expires}`;

const pools = new Map<string, Promise<PgStore>>();
async function computeStore(url: string): Promise<PgStore> {
  let pool = pools.get(url);
  if (!pool) {
    pool = import('../_lib/compute/pg-store.js').then(({ PgStore }) => PgStore.connect(url));
    pools.set(url, pool);
    void pool.catch(() => pools.delete(url));
  }
  return pool;
}

export function makeBind(deps: Deps & { computeStore?: () => ComputeStore | null; previewCompute?: boolean }): (req: Request) => Promise<Response> {
  return async (req) => {
    const env = requireEnv(deps.env, ["STRIPE_SECRET_KEY", "WALKIE_LICENSE_SIGNING_KEY"]);
    if (!env.ok) return env.response;
    const body = await readJsonObject(req, 64 * 1024, MAX_BODY_BYTES);
    if ("response" in body) return body.response;
    // The deployed entrypoint never opts into preview mode. Keep released bind semantics for every client.
    const computeAvailable = COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION || deps.previewCompute === true;
    const { code, team_id: team } = body.value;
    const proof = computeAvailable ? body.value.proof : undefined;
    if (typeof code !== "string" || code.length > MAX_KEY_CHARS) return fail(400, "invalid_code");
    if (typeof team !== "string" || !TEAM_ID.test(team)) return fail(400, "invalid_team_id");
    const stripe = deps.stripe();
    const bindDeadline = Date.now() + 8_000; // Leave time inside the 10 s function for reconciliation.
    let releaseClaim: (() => void) | undefined;
    try {
      const stripeRead = async (id: string) => {
        try { return await stripe.getSubscription(id); }
        catch (err) { throw new StripeOperationError(err); }
      };
      let stripeWrote = false;
      let txAborted = false;
      let inFlightStripeWrite: Promise<void> | undefined;
      let pendingClaim: { token: string; hash: string; key: string } | undefined;
      let claimSettled = false;
      const stripeWrite = async (id: string, metadata: Record<string, string>, idempotencyKey?: string) => {
        if (txAborted) throw new Error('bind_transaction_closed');
        const remaining = bindDeadline - Date.now();
        if (store && remaining < 1_500) throw new ComputeError(503, 'compute_state_unavailable');
        const writeKey = pendingClaim && store ? `walkie-db-bind-v2-${randomBytes(16).toString('hex')}` : idempotencyKey;
        const options = store
          ? { ...(writeKey ? { idempotencyKey: writeKey } : {}),
              timeout: Math.min(3_000, remaining - 1_000), maxNetworkRetries: 0 } : undefined;
        if (pendingClaim && handoverTokenKey) {
          if (!store?.saveBindClaim) throw new ComputeError(503, 'bind_claim_unavailable');
          if (!writeKey || !await store.saveBindClaim(id, {
            ...sealBindClaim(handoverTokenKey, id, team, pendingClaim.token,
              metadata[AUTHORITY_META], metadata[AUTHORITY_CHAIN_META]),
            write: { key: writeKey, metadata: { ...metadata } },
          }))
            throw new ComputeError(503, 'bind_claim_unavailable');
        }
        const write = stripe.setSubscriptionMetadata(id, metadata, options);
        inFlightStripeWrite = write;
        try { await write; stripeWrote = true; }
        catch (err) { throw new StripeOperationError(err); }
        finally { if (inFlightStripeWrite === write) inFlightStripeWrite = undefined; }
        if (txAborted) throw new Error('bind_transaction_closed');
      };
      const p = verifyActivationCode(code, deps.env);
      if (!p) return fail(400, "invalid_code");
      const dbUrl = computeAvailable ? deps.env.DATABASE_URL?.trim() : undefined;
      const store = computeAvailable ? deps.computeStore?.() ?? (dbUrl ? await computeStore(dbUrl) : null) : null;
      if (store) releaseClaim = await lockSubscriptionClaim(p.lic_id);
      const readOnlyCompute = optionalEnv(deps.env, 'COMPUTE_ENABLED') !== '1';
      const chainKey = `enrollment-chain:${team}`;
      const forkKey = `enrollment-fork:${team}`;
      const initialSub = await stripeRead(p.lic_id);
      if (!initialSub) return fail(404, "not_found");
      if (initialSub.status !== LICENSED_STATUS) return fail(402, "subscription_inactive");
      let sub = initialSub;
      const unavailable = async (): Promise<Response> => {
        await sendAlert({ store: null, env: deps.env, now: deps.now, log: stderrLog },
          'compute_state_unavailable', { team });
        return fail(503, 'compute_state_unavailable');
      };
      if (!readOnlyCompute && !store) return unavailable();
      const handoverTokenKey = store ? requireHandoverTokenKey(deps.env) : undefined;
      let allowLegacyMissingTables = false;
      if (store?.schemaVersion) {
        let version: number;
        try { version = await store.schemaVersion(); }
        catch { return unavailable(); }
        if (version < LATEST_MIGRATION) {
          if (version !== 0 || !readOnlyCompute) return unavailable();
          allowLegacyMissingTables = true;
        }
      }
      const claimIsCurrent = async (t: Tx, claimed: { authority?: string; chain?: string },
        current: { metadata: Record<string, string> }): Promise<boolean> => {
        if (claimed.authority && (current.metadata[AUTHORITY_META] !== claimed.authority ||
            current.metadata[AUTHORITY_CHAIN_META] !== claimed.chain)) return false;
        if (!claimed.authority && current.metadata[AUTHORITY_META]) return false;
        if (allowLegacyMissingTables) return true;
        const enrollment = await t.enrollment(team);
        const latest = await t.control(chainKey) as { chainId?: string } | undefined;
        if (await t.control(handoverKey(team))) return false;
        if (enrollment && enrollment.key !== claimed.authority) return false;
        if (latest && latest.chainId !== claimed.chain) return false;
        if (!claimed.authority && (enrollment || latest)) return false;
        return true;
      };
      if (handoverTokenKey && await store?.bindClaim?.(p.lic_id)) {
        const recovered = await store!.tx(async t => {
          await t.lockSubscriptionBind(p.lic_id);
          if (allowLegacyMissingTables) await t.lockLegacyBind(chainKey);
          else if (readOnlyCompute) await t.lockTeamBind(chainKey);
          else await t.lockControl(chainKey);
          const prior = await t.bindClaim(p.lic_id);
          if (!prior) return null;
          let current;
          try { current = await replayBindWrite(stripe, p.lic_id, prior); }
          catch { return unavailable(); }
          if (!current || current.status !== LICENSED_STATUS) return unavailable();
          if (current.metadata[TEAM_META] && current.metadata[TEAM_META] !== team)
            return fail(409, 'license_bound_elsewhere');
          if (prior.team !== team) return current.metadata[TEAM_META] === prior.team
            ? fail(409, 'license_bound_elsewhere') : unavailable();
          // A proposal does not replace current authority. Approval must resolve this claim first.
          if (!allowLegacyMissingTables && await t.control(handoverKey(team)))
            return fail(403, 'team_ownership_required');
          if (!await claimIsCurrent(t, prior, current)) {
            return fail(403, 'team_ownership_required');
          }
          if (current.metadata[TEAM_META] !== team || current.metadata[RENEW_HASH_META] !== prior.hash)
            return unavailable(); // The timed-out remote write may still arrive.
          if (prior.authority) {
            const retry = proof && typeof proof === 'object' && !Array.isArray(proof)
              ? teamAuthority(team, proof as Parameters<typeof teamAuthority>[1]) : null;
            const signed = proof as { expires_at?: unknown; bind_signature?: unknown } | null;
            if (!retry || retry.key !== prior.authority || retry.chainId !== prior.chain || !signed ||
                !Number.isSafeInteger(signed.expires_at) || (signed.expires_at as number) <= deps.now() ||
                (signed.expires_at as number) > deps.now() + 300_000 ||
                typeof signed.bind_signature !== 'string' ||
                !verifySig(retry.key, bindMessage(team, p.lic_id, signed.expires_at as number), signed.bind_signature))
              return fail(403, 'team_ownership_required');
          } else if (proof) return fail(403, 'team_ownership_required');
          const token = openBindClaim(handoverTokenKey, p.lic_id, prior);
          const key = issueKey(payloadFor(current, deps.env, deps.now(), team), deps.env);
          await t.clearBindClaim(p.lic_id, prior.hash);
          return json({ key, renewal_token: token });
        });
        if (recovered) return recovered;
      }
      const clearSettledClaim = async (): Promise<void> => {
        if (claimSettled && pendingClaim) {
          try { await store?.clearBindClaim?.(p.lic_id, pendingClaim.hash); }
          catch (err) { logError('bind_claim_cleanup', err); }
        }
      };
      const refreshSub = async (): Promise<Response | null> => {
        const current = await stripeRead(p.lic_id);
        if (txAborted) throw new Error('bind_transaction_closed');
        if (!current) return fail(404, 'not_found');
        if (current.status !== LICENSED_STATUS) return fail(402, 'subscription_inactive');
        sub = current;
        return null;
      };
      const recoverClaim = async (): Promise<Response | undefined> => {
        const attempted = pendingClaim;
        if (!attempted || !store?.bindClaim || !await store.bindClaim(p.lic_id)) return undefined;
        try { return await store.tx(async t => {
          await t.lockSubscriptionBind(p.lic_id);
          await lockBind(t);
          const prior = await t.bindClaim(p.lic_id);
          if (!prior || prior.team !== team || prior.hash !== attempted.hash) return undefined;
          const current = await replayBindWrite(stripe, p.lic_id, prior);
          if (!current || !await claimIsCurrent(t, prior, current) ||
              current.metadata[TEAM_META] !== team || current.metadata[RENEW_HASH_META] !== prior.hash) return undefined;
          claimSettled = true;
          return json({ key: attempted.key, renewal_token: attempted.token });
        }); } catch { return undefined; }
      };
      const claimConflict = async (err: unknown, expectedAuthority?: string): Promise<Response | undefined> => {
        const cause = err instanceof StripeOperationError ? err.cause as { code?: unknown; rawType?: unknown; type?: unknown } | null : null;
        if (cause?.code !== 'idempotency_error' && cause?.rawType !== 'idempotency_error' &&
            cause?.type !== 'StripeIdempotencyError') return undefined;
        const current = await stripeRead(p.lic_id);
        if (current?.metadata[TEAM_META] && current.metadata[TEAM_META] !== team)
          return fail(409, 'license_bound_elsewhere');
        if (current?.metadata[TEAM_META] === team && expectedAuthority &&
            current.metadata[AUTHORITY_META] !== expectedAuthority)
          return fail(403, 'team_ownership_required');
        return unavailable();
      };
      const settleWrite = async (): Promise<void> => {
        if (inFlightStripeWrite) await inFlightStripeWrite.catch(() => undefined);
      };
      const lockBind = async (t: Tx): Promise<void> => {
        if (allowLegacyMissingTables) await t.lockLegacyBind(chainKey);
        else if (readOnlyCompute) await t.lockTeamBind(chainKey);
        else await t.lockControl(chainKey);
      };
      const emptyUnderLock = async (t: Tx): Promise<boolean> =>
        !allowLegacyMissingTables || await t.legacyEmpty();
      if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
        const bindLegacy = async (t?: Tx): Promise<Response> => {
        const bound = sub.metadata[TEAM_META];
          if (bound && bound !== team) return fail(409, 'license_bound_elsewhere');
          if (bound === team) {
            const key = issueKey(payloadFor(sub, deps.env, deps.now(), team), deps.env);
            return json({ key });
          }
          if (t && !allowLegacyMissingTables) {
            const hasState = Boolean(await t.enrollment(team)) ||
              (await (readOnlyCompute ? t.accountsByTeamUnlocked(team) : t.accountsByTeam(team))).length > 0 ||
              (await t.control(chainKey)) != null || (await t.control(handoverKey(team))) != null ||
              (await t.control(forkKey)) != null;
            if (hasState) return fail(409, 'update_walkie_to_bind_license');
          }
          const key = issueKey(payloadFor(sub, deps.env, deps.now(), team), deps.env);
          const token = randomBytes(32).toString('base64url');
          const hash = renewHash(token);
          pendingClaim = { token, hash, key };
          await stripeWrite(sub.id, { [TEAM_META]: team, [RENEW_HASH_META]: hash,
            ...(store ? { [RENEW_AUTHORITY_META]: 'legacy', [RENEW_CHAIN_META]: 'legacy' } : {}) },
            store ? `walkie-db-bind-v1-${renewHash(p.lic_id)}` : undefined);
          const after = await stripeRead(sub.id);
          if (after?.metadata[TEAM_META] !== team || after.metadata[RENEW_HASH_META] !== hash)
            return fail(409, 'license_bound_elsewhere');
          claimSettled = true;
          return json({ key, renewal_token: token });
        };
        if (!store) return await bindLegacy();
        let callbackError: unknown;
        let capturedResponse: Response | undefined;
        try {
          const result = await store.tx(async t => {
            try {
              await t.lockSubscriptionBind(p.lic_id);
              await lockBind(t);
              if (!await emptyUnderLock(t)) return unavailable();
              const changed = await refreshSub();
              if (changed) return changed;
              const response = await bindLegacy(allowLegacyMissingTables ? undefined : t);
              if (stripeWrote && response.ok) capturedResponse = response;
              return response;
            } catch (err) { callbackError = err; throw err; }
          });
          await clearSettledClaim();
          return result;
        } catch (err) {
          txAborted = true;
          await settleWrite();
          if (capturedResponse && !pendingClaim) { await unavailable(); return capturedResponse; }
          const recovered = await recoverClaim();
          if (recovered) { await unavailable(); await clearSettledClaim(); return recovered; }
          const conflict = await claimConflict(callbackError);
          if (conflict) return conflict;
          if (pendingClaim && callbackError instanceof StripeOperationError) return unavailable();
          if (callbackError instanceof LicenseError || callbackError instanceof StripeOperationError) throw callbackError;
          return unavailable();
        }
      }
      const authority = proof && typeof proof === 'object' ? teamAuthority(team, proof as Parameters<typeof teamAuthority>[1]) : null;
      const claim = proof as { expires_at?: unknown; bind_signature?: unknown } | null;
      if (!authority || !claim || !Number.isSafeInteger(claim.expires_at) ||
          (claim.expires_at as number) <= deps.now() || (claim.expires_at as number) > deps.now() + 300_000 ||
          typeof claim.bind_signature !== 'string' ||
          !verifySig(authority.key, bindMessage(team, p.lic_id, claim.expires_at as number), claim.bind_signature)) return fail(403, 'team_ownership_required');
      let forked = false;
      let rejected = false;
      let review = false;
      let capturedResponse: Response | undefined;
      const recordFork = async (t: Tx, kept: { depth: number; chainId: string; chain?: string[] }): Promise<void> => {
        if (await rejectedHandoverDigest(t, team, authority, 0, authority.key)) { rejected = true; return; }
        const refusal = await refusedFork(t, team, kept, authority, proof as Parameters<typeof refusedFork>[4]);
        if (refusal) { rejected = true; return; }
        if (readOnlyCompute) return;
        await t.setControl(forkKey, deps.now());
        await t.setControl(`enrollment-fork-candidate:${team}`, { chain: authority, roster: proof });
        forked = true;
      };
      const bindLocked = async (t?: Tx): Promise<Response> => {
      let approvedTransition = false;
      let renewalRequired = false;
      let transition: LicenseTransition | undefined;
      if (t) {
        await lockBind(t);
        const changed = await refreshSub();
        if (changed) return changed;
      }
      const bound = sub.metadata[TEAM_META];
      if (bound && bound !== team) return fail(409, "license_bound_elsewhere");
      if (t) {
        const latest = await t.control(chainKey) as { depth: number; chainId: string; chain?: string[]; version?: number } | undefined;
        const current = latest ? chainRelation(latest, authority) : 'extends';
        if (current === 'conflict') {
          await recordFork(t, latest!);
          return fail(403, 'team_ownership_required');
        }
        if (current === 'older') return fail(403, 'team_ownership_required');
        const enrollment = await t.enrollment(team);
        const held = await heldAccounts(t, team, deps.now());
        if (!enrollment && held.length) {
          if (!readOnlyCompute) {
            const legacy = await seedLegacyEnrollment(t, team, proof as Parameters<typeof teamAuthority>[1],
              latest, held, deps.now());
            if (legacy && ['equal', 'extends'].includes(chainRelation(legacy, authority)))
              await holdHandover({ now: deps.now, log: stderrLog,
                handoverTokenKey },
                t, team, legacy, authority,
                authority.key, authority.owners, proof as Parameters<typeof teamAuthority>[1], held);
          }
          review = true;
          return fail(403, 'team_ownership_required');
        }
        const rotating = (enrollment && enrollment.key !== authority.key) ||
          (bound === team && sub.metadata[AUTHORITY_META] && sub.metadata[AUTHORITY_META] !== authority.key);
        if (rotating &&
            (held.length || await t.control(handoverKey(team)))) {
          transition = await t.control(licenseTransitionKey(team)) as LicenseTransition | undefined;
          const license = transition?.subscriptions?.[sub.id];
          approvedTransition = !readOnlyCompute && bound === team &&
            sub.metadata[AUTHORITY_META] !== authority.key && transition?.chainId === authority.chainId &&
            transition?.key === authority.key && enrollment?.key === authority.key && current === 'equal' &&
            license?.fulfilled === false && license.oldKey === sub.metadata[AUTHORITY_META] &&
            license.oldChainId === sub.metadata[AUTHORITY_CHAIN_META];
          renewalRequired = approvedTransition;
          if (!approvedTransition) {
            review = true;
            return fail(403, 'team_ownership_required');
          }
        }
        if (latest && current === 'extends') {
          if (await rejectedHandover(t, team, latest, authority, authority.key)) {
            rejected = true;
            return fail(403, 'team_ownership_required');
          }
          if ((await heldAccounts(t, team, deps.now())).length || await t.control(handoverKey(team)))
            return fail(403, 'team_ownership_required');
        }
      }
      const oldDepth = Number(sub.metadata[AUTHORITY_DEPTH_META]);
      const oldId = sub.metadata[AUTHORITY_CHAIN_META];
      const relation = bound && Number.isSafeInteger(oldDepth) && oldId
        ? chainRelation({ depth: oldDepth, chainId: oldId, chain: readAuthorityPath(sub.metadata) }, authority)
        : 'extends';
      if (relation === 'older' || (relation === 'conflict' && !approvedTransition)) {
        if (relation === 'conflict' && t) {
          await recordFork(t, { depth: oldDepth, chainId: oldId!, chain: readAuthorityPath(sub.metadata) });
        }
        return fail(403, 'team_ownership_required');
      }
      if (bound && sub.metadata[AUTHORITY_META] !== authority.key &&
          relation !== 'extends' && sub.metadata[AUTHORITY_META] && !approvedTransition)
        return fail(403, 'team_ownership_required');
      // Pre-RENT-25 hashes have no token authority. Replace one only after signed proof
      // and the current chain have passed the checks above; never infer its old holder.
      const replaceLegacyToken = Boolean(store && sub.metadata[AUTHORITY_META] === authority.key &&
        sub.metadata[AUTHORITY_CHAIN_META] === authority.chainId &&
        (!sub.metadata[RENEW_AUTHORITY_META] || !sub.metadata[RENEW_CHAIN_META]));
      if (replaceLegacyToken) {
        const enrollment = await t?.enrollment(team);
        const latest = await t?.control(chainKey) as { chainId?: string } | undefined;
        if (enrollment ? enrollment.key !== authority.key : latest?.chainId !== authority.chainId)
          return fail(403, 'team_ownership_required');
      }
      const replaceChangedAuthority = Boolean(store &&
        (sub.metadata[AUTHORITY_META] !== authority.key ||
          sub.metadata[AUTHORITY_CHAIN_META] !== authority.chainId));
      if (t && await t.control(handoverKey(team)) &&
          (!bound || sub.metadata[AUTHORITY_META] !== authority.key ||
            sub.metadata[AUTHORITY_CHAIN_META] !== authority.chainId || replaceLegacyToken))
        return fail(403, 'team_ownership_required');
      const key = issueKey(payloadFor(sub, deps.env, deps.now(), team), deps.env);
      if (bound === team) {
        if (sub.metadata[AUTHORITY_META] !== authority.key || replaceLegacyToken || replaceChangedAuthority) {
          const token = renewalRequired || replaceLegacyToken || replaceChangedAuthority
            ? randomBytes(32).toString('base64url') : undefined;
          const hash = token ? renewHash(token) : undefined;
          if (token && hash) pendingClaim = { token, hash, key };
          await stripeWrite(sub.id,
            { [AUTHORITY_META]: authority.key, [AUTHORITY_DEPTH_META]: String(authority.depth), [AUTHORITY_CHAIN_META]: authority.chainId,
              ...authorityPathMetadata(authority.chain), ...(hash ? { [RENEW_HASH_META]: hash,
                [RENEW_AUTHORITY_META]: authority.key, [RENEW_CHAIN_META]: authority.chainId } : {}) });
          const after = await stripeRead(sub.id);
          if (after?.metadata[AUTHORITY_META] !== authority.key || after.metadata[AUTHORITY_CHAIN_META] !== authority.chainId ||
              (hash && (after.metadata[RENEW_HASH_META] !== hash ||
                after.metadata[RENEW_AUTHORITY_META] !== authority.key ||
                after.metadata[RENEW_CHAIN_META] !== authority.chainId)))
            return fail(409, 'license_bound_elsewhere');
          if (token) claimSettled = true;
          capturedResponse = json({ key, ...(token ? { renewal_token: token } : {}) });
          if (approvedTransition && t && transition) {
            const subscriptions = { ...transition.subscriptions, [sub.id]: { ...transition.subscriptions[sub.id], fulfilled: true } };
            await t.setControl(licenseTransitionKey(team), Object.values(subscriptions).every(item => item.fulfilled)
              ? null : { ...transition, subscriptions });
          }
        }
        if (t && !readOnlyCompute) await updateChain(t);
        return capturedResponse ?? json({ key });
      }
      const token = randomBytes(32).toString("base64url");
      const hash = renewHash(token);
      pendingClaim = { token, hash, key };
      await stripeWrite(sub.id, { [TEAM_META]: team, [AUTHORITY_META]: authority.key,
        [AUTHORITY_DEPTH_META]: String(authority.depth), [AUTHORITY_CHAIN_META]: authority.chainId, [RENEW_HASH_META]: hash,
        ...(store ? { [RENEW_AUTHORITY_META]: authority.key, [RENEW_CHAIN_META]: authority.chainId } : {}),
        ...authorityPathMetadata(authority.chain) }, store ? `walkie-db-bind-v1-${renewHash(p.lic_id)}` : undefined);
      const after = await stripeRead(sub.id);
      if (after?.metadata[TEAM_META] !== team || after.metadata[AUTHORITY_META] !== authority.key ||
          after.metadata[AUTHORITY_CHAIN_META] !== authority.chainId || after.metadata[RENEW_HASH_META] !== hash)
        return fail(409, "license_bound_elsewhere");
      claimSettled = true;
      capturedResponse = json({ key, renewal_token: token });
      if (t && !readOnlyCompute) await updateChain(t);
      return capturedResponse;
      };
      const updateChain = async (t: Tx): Promise<void> => {
        const latest = await t.control(chainKey) as { depth: number; chainId: string; chain?: string[]; version?: number } | undefined;
        const relation = latest ? chainRelation(latest, authority) : 'extends';
        if (relation === 'older' || relation === 'conflict') throw new Error('stale_authority_chain');
        const enrollment = await t.enrollment(team);
        if (await t.control(handoverKey(team)) || latest && enrollment && enrollment.key !== authority.key &&
            relation === 'extends' && (await heldAccounts(t, team)).length) return;
        if (relation === 'extends' || !latest)
          await t.setControl(chainKey, { depth: authority.depth, chainId: authority.chainId, chain: authority.chain, version: (latest?.version ?? 0) + 1 });
      };
      let response: Response;
      if (!store) response = await bindLocked();
      else {
        let callbackError: unknown;
        try {
          response = await store.tx(async t => {
            try {
              await t.lockSubscriptionBind(p.lic_id);
              if (allowLegacyMissingTables) {
                await lockBind(t);
                if (!await emptyUnderLock(t)) return unavailable();
                const changed = await refreshSub();
                if (changed) return changed;
              }
              const result = await bindLocked(allowLegacyMissingTables ? undefined : t);
              if (stripeWrote && result.ok) capturedResponse = result;
              return result;
            }
            catch (err) { callbackError = err; throw err; }
          });
          await clearSettledClaim();
        } catch (err) {
          txAborted = true;
          await settleWrite();
          if (capturedResponse && !pendingClaim) { await unavailable(); return capturedResponse; }
          const recovered = await recoverClaim();
          if (recovered) { await unavailable(); await clearSettledClaim(); return recovered; }
          const conflict = await claimConflict(callbackError, authority.key);
          if (conflict) return conflict;
          if (pendingClaim && callbackError instanceof StripeOperationError) return unavailable();
          if (callbackError instanceof LicenseError || callbackError instanceof StripeOperationError) throw callbackError;
          return unavailable();
        }
      }
      if (forked && store) await sendAlert({ store, env: deps.env, now: deps.now, log: () => {} }, 'authority_fork', { team });
      if (rejected && store) await sendAlert({ store: readOnlyCompute ? null : store, env: deps.env, now: deps.now, log: stderrLog },
        'handover_rejected_refusal', { team, chain: authority.chainId });
      if (review) await sendAlert({ store: readOnlyCompute ? null : store, env: deps.env, now: deps.now, log: stderrLog },
        'handover_operator_review', { team, chain: authority.chainId });
      return response;
    } catch (err) {
      if (err instanceof ComputeError) return fail(err.status, err.code, err.extra);
      if (err instanceof RangeError && err.message === 'authority_chain_metadata_limit')
        return fail(400, 'authority_chain_metadata_limit');
      if (err instanceof LicenseError) {
        logError("bind", { type: "license", code: err.code });
        return fail(500, "license_unavailable");
      }
      logError("bind", err instanceof StripeOperationError ? err.cause : err);
      return fail(502, "stripe_unavailable");
    } finally { releaseClaim?.(); }
  };
}

export async function POST(req: Request): Promise<Response> {
  return computeConfigurationError(process.env) ?? makeBind(defaultDeps())(req);
}
