// POST /api/license/renew {lic_id, renewal_token} → {key} (docs/BUSINESS.md "Renewal", audit H1/L8).
// The roster authority calls this once a day when its key is close to expiry. A subscription id alone
// authorizes nothing: the token's sha256 must match the one stored at the first bind (constant-time),
// and an unknown subscription answers the same 403 as a wrong token. Then the subscription must be
// `active` (not trialing) and bound to a team; the fresh key is bound to that team.
// With the compute store, a token bound to an authority renews only while that authority is the team's
// enrolled one (RENT-25). A token bound without any authority (released compute-locked binds wrote only the
// team and the hash) renews as before until the team has compute state; from then on only the enrolled
// authority, or the verified successor of the recorded chain after a roster authority move, may use it, by
// adding `proof`: its roster proof plus `expires_at` and `renew_signature` over renewMessage (lane C, go-live
// review O P1-3 and REVIEW-C finding 1). A token bound to an authority newer than the compute record (a signed
// re-bind after a roster authority move) renews the same way, with the same refusals (lane C rounds 3-4). While a
// fork is open, every renewal that would otherwise succeed answers 409 authority_fork_open until the operator
// resolves it (rounds 8-9), a token bound to the enrolled key included.
// Renewal never writes Stripe.
import { requireEnv } from "../_lib/env.js";
import { fail, json, logError } from "../_lib/http.js";
import { defaultDeps, issueKey, LICENSED_STATUS, payloadFor, type Deps } from "../_lib/issue.js";
import { LicenseError, TEAM_ID } from "../_lib/license.js";
import { AUTHORITY_CHAIN_META, AUTHORITY_META, legacyRenewal, RENEW_AUTHORITY_META, RENEW_CHAIN_META,
  RENEW_HASH_META, renewTokenMatches, TEAM_META } from "../_lib/metadata.js";
import { MAX_BODY_BYTES, readJsonObject } from "../_lib/body.js";
import type { ComputeStore } from '../_lib/compute/store.js';
import type { SubscriptionLite } from '../_lib/stripe.js';
import { COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION } from '../_lib/compute/release-gate.js';
import { chainRelation, teamAuthority, type StoredChain, type TeamProof } from '../_lib/compute/team-proof.js';
import { earlierLink, forkOpen, movable } from '../_lib/compute/ownership.js';
import { verifySig } from '../_lib/protocol/keys.js';
import type { Tx } from '../_lib/compute/store.js';
import { rejectedHandoverDigest } from '../_lib/compute/handover.js';
import { refusedFork } from '../_lib/compute/fork-rejection.js';
import { sendAlert } from '../_lib/compute/alerts.js';
import { stderrLog } from '../_lib/compute/deps.js';

export const LIC_ID = /^sub_[A-Za-z0-9]{1,200}$/;
export const RENEWAL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PROOF_MAX_BYTES = 64 * 1024; // the bind's limit for a body carrying a roster proof
const PROOF_TTL_MS = 300_000;

/** What the roster authority signs to renew a token bound without an authority (src/license/renew.ts). */
export const renewMessage = (team: string, license: string, expires: number): string =>
  `walkie-license-renew-v1\n${team}\n${license}\n${expires}`;

type Signer = { key: string; chainId: string; depth: number; chain: string[]; owners: string[] };

/** The authority a fresh, signed renewal proof names, or null when the proof is absent or does not verify. */
function renewSigner(team: string, license: string, proof: unknown, now: number): Signer | null {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return null;
  const { expires_at: expires, renew_signature: signature } = proof as { expires_at?: unknown; renew_signature?: unknown };
  if (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires <= now || expires > now + PROOF_TTL_MS ||
      typeof signature !== 'string') return null;
  const authority = teamAuthority(team, proof as TeamProof);
  return authority && verifySig(authority.key, renewMessage(team, license, expires), signature) ? authority : null;
}

/**
 * The roster authority moved on by signed transfers without touching compute, so the enrollment still names an
 * earlier authority: accept the verified successor of `recorded` (the stored chain, or the enrolled authority's
 * place in the signer's chain), the way a bind accepts an extending chain. Never while a handover is held, a fork
 * is flagged, or the chain (or its old chain) was rejected or expired.
 */
async function recordedSuccessor(t: Tx, team: string, recorded: StoredChain | null | undefined, signer: Signer): Promise<boolean> {
  return !!recorded && chainRelation(recorded, signer) === 'extends' && await movable(t, team, recorded, signer);
}

const pools = new Map<string, Promise<ComputeStore>>();
function renewalStore(url: string): Promise<ComputeStore> {
  let pool = pools.get(url);
  if (!pool) {
    pool = import('../_lib/compute/pg-store.js').then(({ PgStore }) => PgStore.connect(url));
    pools.set(url, pool);
    void pool.catch(() => pools.delete(url));
  }
  return pool;
}

export function makeRenew(deps: Deps & { computeStore?: () => ComputeStore | null; previewCompute?: boolean }): (req: Request) => Promise<Response> {
  return async (req) => {
    const env = requireEnv(deps.env, ["STRIPE_SECRET_KEY", "WALKIE_LICENSE_SIGNING_KEY"]);
    if (!env.ok) return env.response;
    // The deployed entrypoint never opts into preview mode: released builds keep the released body limit.
    const computeAvailable = COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION || deps.previewCompute === true;
    const body = await readJsonObject(req, computeAvailable ? PROOF_MAX_BYTES : MAX_BODY_BYTES, MAX_BODY_BYTES);
    if ("response" in body) return body.response;
    const { lic_id: licId, renewal_token: token } = body.value;
    const proof = computeAvailable ? body.value.proof : undefined;
    if (typeof licId !== "string" || !LIC_ID.test(licId)) return fail(400, "invalid_lic_id");
    if (typeof token !== "string" || !RENEWAL_TOKEN.test(token)) return fail(400, "invalid_renewal_token");
    const stripe = deps.stripe();
    try {
      const store = computeAvailable ? deps.computeStore?.() ?? (deps.env.DATABASE_URL?.trim()
        ? await renewalStore(deps.env.DATABASE_URL.trim()) : null) : null;
      const check = async (sub: SubscriptionLite | null) => {
        if (!sub || !renewTokenMatches(token, sub.metadata[RENEW_HASH_META])) return fail(403, "invalid_renewal");
        const team = sub.metadata[TEAM_META];
        if (!team || !TEAM_ID.test(team)) return fail(403, "invalid_renewal");
        if (sub.status !== LICENSED_STATUS) return fail(402, "subscription_inactive");
        return json({ key: issueKey(payloadFor(sub, deps.env, deps.now(), team), deps.env) });
      };
      if (!store) return await check(await stripe.getSubscription(licId));
      let forked: { team: string; chain: string } | undefined;
      const response = await store.tx(async t => {
        const initial = await stripe.getSubscription(licId);
        const team = initial?.metadata[TEAM_META];
        if (!team || !TEAM_ID.test(team)) return fail(403, 'invalid_renewal');
        await t.lockControl(`enrollment-chain:${team}`);
        const sub = await stripe.getSubscription(licId);
        if (sub?.metadata[TEAM_META] !== team) return fail(403, 'invalid_renewal');
        const enrollment = await t.enrollment(team);
        const latest = await t.control(`enrollment-chain:${team}`) as StoredChain | undefined;
        if (legacyRenewal(sub.metadata)) {
          if (!enrollment && !latest) return check(sub);
          // The team has compute state: the token alone no longer proves who holds it. The token is checked
          // first, so only its holder gets a roster proof verified.
          if (!renewTokenMatches(token, sub.metadata[RENEW_HASH_META])) return fail(403, 'invalid_renewal');
          const signer = renewSigner(team, licId, proof, deps.now());
          if (!signer) return fail(403, 'invalid_renewal');
          const enrolled = (!enrollment || enrollment.key === signer.key) && (!latest || latest.chainId === signer.chainId);
          // An open fork pauses every signed renewal of a legacy token, the enrolled signer's too: the token is shared,
          // and the operator decides which branch keeps it (lane C round 8). Anyone else stays an invalid renewal.
          if ((enrolled || (latest && chainRelation(latest, signer) === 'extends')) && await forkOpen(t, team))
            return fail(409, 'authority_fork_open');
          // A verified holder of the token on a branch that conflicts with the recorded chain: flag the fork for the
          // operator the way enroll() does, instead of a silent refusal (lane C round 10, PROBE G3). Rejected digests
          // and refused forks stay refused; an open fork keeps its candidate.
          if (!enrolled && latest && chainRelation(latest, signer) === 'conflict') {
            if (!await rejectedHandoverDigest(t, team, signer, 0, signer.key) &&
                !await refusedFork(t, team, latest, signer, proof as TeamProof) && !await forkOpen(t, team)) {
              await t.setControl(`enrollment-fork:${team}`, deps.now());
              await t.setControl(`enrollment-fork-candidate:${team}`, { chain: signer, roster: proof });
              forked = { team, chain: signer.chainId };
            }
            return fail(403, 'invalid_renewal');
          }
          if (!enrolled && !await recordedSuccessor(t, team, latest, signer)) return fail(403, 'invalid_renewal');
          return check(sub);
        }
        const authority = sub.metadata[AUTHORITY_META];
        const chain = sub.metadata[AUTHORITY_CHAIN_META];
        if ((authority && !enrollment && !latest) || (!authority && (enrollment || latest)) ||
            sub.metadata[RENEW_AUTHORITY_META] !== (authority ?? 'legacy') ||
            sub.metadata[RENEW_CHAIN_META] !== (chain ?? 'legacy'))
          return fail(403, 'invalid_renewal');
        if ((enrollment && enrollment.key !== authority) || (latest && latest.chainId !== chain)) {
          // A signed re-bind after a roster authority move bound the licence to an authority newer than the compute
          // record, which moves only through compute's enrollment. The licence's own authority renews with its
          // signed proof when it is the verified successor of the recorded chain (round 2), or, for records written
          // before round 4, when the recorded chain is its chain and the enrolled key an earlier link of it (round 3).
          // A superseded authority's chain is older than the record and stays refused. The token is checked first.
          if (!renewTokenMatches(token, sub.metadata[RENEW_HASH_META])) return fail(403, 'invalid_renewal');
          const signer = renewSigner(team, licId, proof, deps.now());
          if (!signer || signer.key !== authority || signer.chainId !== chain) return fail(403, 'invalid_renewal');
          const recorded = latest && latest.chainId === chain
            ? (enrollment ? earlierLink(proof as TeamProof, signer, enrollment.key) : null) : latest;
          if (recorded && chainRelation(recorded, signer) === 'extends' && await forkOpen(t, team))
            return fail(409, 'authority_fork_open');
          if (!await recordedSuccessor(t, team, recorded, signer)) return fail(403, 'invalid_renewal');
        }
        // The fork pauses this path as well, even for a token bound to the enrolled key: every renewal of the team's
        // licence waits for the operator's resolve_fork (lane C round 9). The token is checked first.
        if (renewTokenMatches(token, sub.metadata[RENEW_HASH_META]) && await forkOpen(t, team))
          return fail(409, 'authority_fork_open');
        return check(sub);
      });
      if (forked) await sendAlert({ store, env: deps.env, now: deps.now, log: stderrLog }, 'authority_fork', forked);
      return response;
    } catch (err) {
      if (err instanceof LicenseError) {
        logError("renew", { type: "license", code: err.code });
        return fail(500, "license_unavailable");
      }
      logError("renew", err);
      return fail(502, "stripe_unavailable");
    }
  };
}

export async function POST(req: Request): Promise<Response> {
  return makeRenew(defaultDeps())(req);
}
