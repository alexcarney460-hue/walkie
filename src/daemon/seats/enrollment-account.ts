import type { AccountView, TeamPolicy } from "../../protocol/accounts.ts";
import type { AnySeatRun } from "../../protocol/seats.ts";
import { isV2 } from "../../protocol/seats.ts";
import type { Grant } from "../provision/grant.ts";
import { planSeatAccount } from "./account.ts";

/** A company enrollment never inherits the recipient's provider login. */
export function requiredWorkerAccount(grant: Grant | null, run: AnySeatRun, now = Date.now(), enrolled = true): string | null {
  if (!grant) return enrolled ? "enrollment grant is missing: restore it through local consent or explicitly un-enroll" : null;
  if (!enrolled) return "root enrollment marker is missing: this grant cannot authorize company seats";
  if (grant.revoked_at) return "enrollment grant revoked: owner account seats are stopped";
  if (grant.owner_ssh && grant.ssh_state !== "active") return "enrollment SSH grant pending or denied: seats are stopped";
  if (grant.expires_at <= now) return "enrollment grant expired: renew local consent";
  if (!isV2(run) || run.runtime === "kimi" || run.runtime === "grok") return "enrollment needs a v2 Claude or Codex seat with a named owner account";
  const required = grant.worker_accounts?.[run.runtime];
  if (!required) return "waiting for owner account: the provisioned seat needs its named account";
  if (run.account && run.account !== required) return "this seat does not name the provisioned owner account";
  return null;
}

export function bindWorkerAccount(grant: Grant | null, run: AnySeatRun): AnySeatRun {
  if (!grant || (grant.owner_ssh && grant.ssh_state !== "active") || !isV2(run) || run.runtime === "kimi" || run.runtime === "grok" || run.account) return run;
  const account = grant.worker_accounts?.[run.runtime];
  return account ? { ...run, account } : run;
}

export type WorkerAccountCheck = { ok: boolean; what: string; fix?: string; lease?: { account: string; node: string; provider: "claude" | "codex" } };

/** Doctor uses the published vault view; the owner still rechecks policy, reserve and expiry on each lease. */
export function workerAccountChecks(grant: Grant | null, o: {
  me: string; owner: string; accounts: readonly AccountView[]; team: TeamPolicy; role: string | null; now?: number;
}): WorkerAccountCheck[] {
  if (!grant) return [];
  const reason = grant.revoked_at ? "grant revoked" : grant.owner_ssh && grant.ssh_state !== "active"
    ? "SSH grant pending or denied" : grant.expires_at <= (o.now ?? Date.now()) ? "grant expired" : null;
  return (["claude", "codex"] as const).map((runtime) => {
    const name = `owner ${runtime === "claude" ? "Claude" : "Codex"} account`;
    const key = grant.worker_accounts?.[runtime];
    if (reason) return { ok: false, what: `${name}: ${reason}` };
    if (!key) return { ok: false, what: `${name}: waiting for owner account`, fix: "the owner enrolls a subscription login in their vault and selects its key before local consent" };
    if (!key.startsWith(`${o.owner}:`)) return { ok: false, what: `${name}: selected account is not the current owner` };
    const plan = planSeatAccount(key, { runtime, me: o.me, launcher: o.owner, vault: [], pooled: o.accounts,
      pool: { team: o.team, roleOf: (handle) => handle === o.me ? o.role : handle === o.owner ? "owner" : null } });
    return plan.kind === "peer" ? { ok: true, what: `${name}: ${key}`, lease: { account: plan.id, node: plan.node, provider: runtime } }
      : { ok: false, what: `${name}: waiting for owner account`, fix: plan.kind === "refused" ? plan.why : "the selected account is not held on the owner's machine" };
  });
}

/** A doctor pass checks owner policy and account health without issuing a hand-out. */
export async function probeWorkerLeases(checks: readonly WorkerAccountCheck[], probe: (b: NonNullable<WorkerAccountCheck["lease"]>) => Promise<{ ready: true }>): Promise<WorkerAccountCheck[]> {
  return Promise.all(checks.map(async (check) => {
    if (!check.ok || !check.lease) return check;
    const { lease: request } = check;
    try {
      const result = await probe(request);
      return result.ready === true ? { ok: true, what: `${check.what}: lease eligible` }
        : { ok: false, what: `${check.what}: lease unavailable` };
    } catch {
      return { ok: false, what: `${check.what}: lease unavailable` };
    }
  }));
}

/** Recheck a running seat's lease and consent; one failed check stops it once. */
export function superviseWorkerAccount(o: { allowed: () => boolean; stop: () => Promise<void>; error?: (err: unknown) => void; everyMs?: number }): () => void {
  let ended = false;
  const cancel = () => { ended = true; clearInterval(timer); };
  const check = () => {
    if (ended) return;
    let allowed = false;
    try { allowed = o.allowed(); } catch { allowed = false; }
    if (!allowed) { cancel(); void o.stop().catch((err: unknown) => o.error?.(err)); }
  };
  const timer = setInterval(check, o.everyMs ?? 10_000);
  timer.unref?.();
  return cancel;
}
