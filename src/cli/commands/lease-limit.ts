import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { remoteRunToken } from "../../client/remote-run.ts";
import { MAX_OWN_PERSON_LEASES_PER_HOUR, readOwnLeaseLimit, validOwnLeaseLimit } from "../../daemon/vault-lease-policy.ts";
import { UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import type { Tty } from "../tty.ts";

function setLimit(path: string, value: number): void {
  let current: unknown = {};
  try { current = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new UsageError("config is unreadable or malformed; no setting changed"); }
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new UsageError("config must be an object; no setting changed");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ ...current, vault_own_lease_limit: value }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch { /* renamed or not created */ } }
}

export async function leaseLimit(ctx: Ctx, home: string, admitted: (ctx: Ctx, what: string) => Promise<Tty>): Promise<number> {
  const path = join(home, "config.json");
  const raw = ctx.args.pos[1];
  if (raw !== undefined) {
    if (remoteRunToken()) throw new UsageError("lease-limit changes are local to the account owner's machine");
    const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!validOwnLeaseLimit(value)) throw new UsageError("usage: walkie accounts lease-limit [10..256]");
    const tty = await admitted(ctx, "walkie accounts lease-limit");
    try {
      if (!/^y(es)?$/i.test((await tty.ask(`Allow ${value} hand-outs per owner-launched seat node per hour, up to ${MAX_OWN_PERSON_LEASES_PER_HOUR} total from this vault holder (teammate seats remain at 10)? [y/N] `)).trim())) return EXIT.error;
      setLimit(path, value);
    } finally { tty.close(); }
  }
  const own = readOwnLeaseLimit(path);
  ctx.out(ctx.json ? JSON.stringify({ owner_launched_seat_per_node_per_hour: own,
    own_person_total_per_vault_holder_per_hour: MAX_OWN_PERSON_LEASES_PER_HOUR,
    other_launchers_and_older_peers_per_node_per_hour: 10 })
    : `Account hand-outs per machine/hour: owner-launched ${own}; teammate-launched and older peers 10. Own-person total from this vault holder: ${MAX_OWN_PERSON_LEASES_PER_HOUR}/hour. Host seat caps and account policy still apply.`);
  return EXIT.ok;
}
