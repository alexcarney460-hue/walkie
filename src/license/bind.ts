// `walkie license activate <activation code>` on the roster authority (audit H3): POST {code, team_id}
// to the license service's /api/license/bind, which binds the subscription to this team (or refuses:
// 409 when another team holds it) and answers with a license bound to this team. The first bind also
// returns the renewal token, which is stored in <home>/license-renew-token (0600) and never on the
// chain. The returned key must verify, name this team and the code's license id before it is activated.
import type { Event } from "../protocol/schemas.ts";
import type { Core } from "../daemon/core.ts";
import { HttpError } from "../daemon/http.ts";
import { activateOnAuthority, verifiedPayload } from "./activate.ts";
import { licenseForTeam } from "./format.ts";
import { loadRenewToken, RENEWAL_TOKEN, saveRenewToken } from "./renew-token.ts";
import { replyKey, type LicenseService, type ServiceReply } from "./service.ts";
import { rosterProof } from '../daemon/compute/team-proof.ts';

/** What happened to the renewal token: stored now, already held for this license, or not available. */
export type RenewalState = "saved" | "kept" | "missing";
export interface CodeActivation { readonly event: Event | null; readonly renewal: RenewalState }

/** True when `key` decodes (signature checked) as an activation code rather than a license. */
export function isActivationCode(core: Pick<Core, "licenseVerifier">, key: string): boolean {
  const r = core.licenseVerifier(key.trim());
  return r.ok && r.payload.kind === "activation";
}

function refusal(r: ServiceReply): HttpError {
  switch (r.status) {
    case 409: return new HttpError(409, "license_bound_elsewhere",
      "this activation code is already activated on another team (each code activates one team; email support if that's wrong)");
    case 402: return new HttpError(402, "subscription_inactive", "this subscription isn't active (canceled or unpaid); nothing on the team was changed");
    case 400: return new HttpError(400, "invalid_license", "the license service refused this activation code");
    case 404: return new HttpError(404, "not_found", "the license service doesn't know this subscription");
    case 503: return new HttpError(503, "billing_not_configured", "the license service isn't configured yet; try again later");
    default: return new HttpError(502, "license_service_unavailable", `the license service answered ${r.status}; try again shortly`);
  }
}

/** Exchanges an activation code for this team's license and activates it. Authority only. */
export async function activateCode(core: Core, service: LicenseService, code: string): Promise<CodeActivation> {
  const c = code.trim();
  const p = verifiedPayload(core, c);
  if (p.kind !== "activation") throw new HttpError(400, "invalid", "not an activation code");
  const team = core.teamId;
  if (!team) throw new HttpError(409, "no_team", "this node is not in a team (run: walkie init or walkie join)");
  if (!core.isAuthority()) {
    const host = core.authority ? core.roster.nodes.get(core.authority)?.hostname : undefined;
    throw new HttpError(409, "not_authority",
      `activation codes are exchanged on the team's roster authority${host ? ` (${host})` : ""}: run \`walkie license activate <code>\` there`);
  }
  let res: ServiceReply;
  try {
    const expires_at = core.clock() + 240_000;
    res = await service.bind(c, team, { ...rosterProof(core), expires_at,
      bind_signature: core.keys.sign(`walkie-license-bind-v1\n${team}\n${p.lic_id}\n${expires_at}`) });
  } catch (err) {
    core.log.warn("license_bind_failed", { err: err instanceof Error ? err.message : String(err) });
    throw new HttpError(502, "license_service_unavailable", "couldn't reach the license service; check the connection and try again");
  }
  if (res.status < 200 || res.status > 299) throw refusal(res);
  const key = replyKey(res);
  const fresh = key ? core.licenseVerifier(key) : null;
  if (!key || !fresh?.ok || !licenseForTeam(fresh.payload, team) || fresh.payload.lic_id !== p.lic_id) {
    throw new HttpError(502, "license_service_unavailable", "the license service answered with a key that isn't this team's license");
  }
  // The token is handed out once: store it before anything else can fail.
  const token = res.body?.renewal_token;
  let renewal: RenewalState;
  if (typeof token === "string" && RENEWAL_TOKEN.test(token)) {
    saveRenewToken(core.paths.home, { lic_id: p.lic_id, team, token });
    renewal = "saved";
  } else {
    const held = loadRenewToken(core.paths.home);
    renewal = held && held.lic_id === p.lic_id && held.team === team ? "kept" : "missing";
  }
  core.log.info("license_bound", { lic_id: p.lic_id, renewal });
  return { event: activateOnAuthority(core, key as string), renewal };
}
