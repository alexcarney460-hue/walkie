import { CleanupObligation } from "./cleanup-obligation.ts";
import { TALKIE_UID, TALKIE_USER } from "../seats/talkie-user.ts";
import { requirePerson, type Ctx } from "../../cli/context.ts";

/** A read-only snapshot of the fixed account, uid, home, and root ownership ledger. */
export interface RepairSnapshot {
  accountUid: number | null;
  uidTaken: boolean;
  processes: readonly number[];
  homeExists: boolean;
  ledgerOwner: string | null;
  generation?: string | null;
  instance?: string | null;
}

export interface RepairResult { repaired: boolean; remaining: string[] }

function remainingItems(snapshot: RepairSnapshot): string[] {
  const remaining: string[] = [];
  if (snapshot.accountUid !== null) remaining.push(`${TALKIE_USER} account remains (uid ${snapshot.accountUid}): run cleanup`);
  if (snapshot.uidTaken) remaining.push(`uid ${TALKIE_UID} is still taken`);
  if (snapshot.processes.length) remaining.push(`uid ${TALKIE_UID} still has ${snapshot.processes.map((pid) => `process ${pid}`).join(", ")}`);
  if (snapshot.homeExists) remaining.push(`${TALKIE_USER} home remains`);
  if (snapshot.ledgerOwner !== null) remaining.push(`ownership ledger still records ${snapshot.ledgerOwner}`);
  return remaining;
}

/** The caller must be the local person; a failed or incomplete probe never clears the obligation. */
export async function repairTalkieCleanup(path: string, inspect: () => Promise<RepairSnapshot>, ctx: Ctx,
  resweep?: () => Promise<string | null>): Promise<RepairResult> {
  await requirePerson(ctx, "repair WalkieTalkie cleanup", "yes");
  const obligation = new CleanupObligation(path);
  const pending = obligation.read();
  if (!pending) return { repaired: false, remaining: ["no uid cleanup obligation is pending"] };
  if (resweep) {
    const problem = await resweep();
    if (problem) return { repaired: false, remaining: [problem] };
  }
  for (let check = 0; check < 2; check++) {
    const remaining = remainingItems(await inspect());
    if (remaining.length) return { repaired: false, remaining };
  }
  if (!obligation.clear(pending.generation)) return { repaired: false, remaining: ["cleanup generation changed during repair"] };
  return { repaired: true, remaining: [] };
}

/** Manual recovery for a stranded owner row. The helper rechecks the generation and empty uid under its root lock. */
export async function repairEmptyTalkieOwner(path: string, inspect: () => Promise<RepairSnapshot>,
  release: (generation: string | null) => Promise<{ ok: boolean; why?: string }>, ctx: Ctx): Promise<RepairResult> {
  const first = await inspect();
  if (first.ledgerOwner === null) return { repaired: false, remaining: ["no dedicated uid owner row remains"] };
  if (first.generation === undefined) return { repaired: false, remaining: ["the recorded owner generation could not be checked"] };
  const blockers = remainingItems({ ...first, ledgerOwner: null });
  if (blockers.length) return { repaired: false, remaining: blockers };
  const label = first.generation ?? "legacy null generation";
  await requirePerson(ctx, `release the empty dedicated uid owner row for recorded generation ${label}`, "yes");
  const result = await release(first.generation);
  if (!result.ok) return { repaired: false, remaining: [result.why ?? "the root helper refused owner repair"] };
  for (let check = 0; check < 2; check++) {
    const remaining = remainingItems(await inspect());
    if (remaining.length) return { repaired: false, remaining };
  }
  const obligation = new CleanupObligation(path);
  const pending = obligation.read();
  if (pending && !obligation.clear(pending.generation))
    return { repaired: false, remaining: ["cleanup generation changed during repair"] };
  return { repaired: true, remaining: [] };
}
