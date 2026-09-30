import { join } from "node:path";
import { z } from "zod";
import type { WalkieClient } from "../../client/index.ts";
import { defaultHome } from "../../daemon/paths.ts";
import { repairTalkieCleanup, repairEmptyTalkieOwner, type RepairSnapshot } from "../../daemon/orchestrator/cleanup-repair.ts";
import type { AdminResult } from "../../daemon/seats/admin.ts";
import { adminCall, SPAWN_ENV } from "../../daemon/seats/runner-child.ts";
import { DEFAULT_ADMIN } from "../../daemon/seats/seat-user.ts";
import { EXIT, type Ctx } from "../context.ts";

const Status = z.object({
  accountUid: z.number().int().nonnegative().nullable(),
  uidTaken: z.boolean(),
  processes: z.array(z.number().int().nonnegative()),
  homeExists: z.boolean(),
  ledgerOwner: z.string().nullable(),
  generation: z.string().nullable().optional(),
  instance: z.string().nullable().optional(),
});

/** The installed root helper returns all repair facts in one read-only JSON response. */
export async function inspectTalkieStatus(call: (argv: string[]) => Promise<AdminResult | null> = (argv) => adminCall(argv, 10_000)):
  Promise<RepairSnapshot> {
  const result = await call(["sudo", "-n", DEFAULT_ADMIN, "seat-admin", "talkie-status"]);
  if (!result?.ok) throw new Error(`WalkieTalkie cleanup status could not be checked: ${result?.why ?? "the seat helper did not answer"}`);
  const parsed = Status.safeParse(result.status);
  if (!parsed.success) throw new Error("WalkieTalkie cleanup status response was incomplete");
  return parsed.data;
}

/** A fresh sudo authentication is required for the person-only row release. */
export function personRepairArgv(generation: string | null): string[] {
  return ["sudo", "-k", DEFAULT_ADMIN, "seat-admin", "talkie-repair", generation ?? "legacy"];
}

export function parsePersonRepairAnswer(exitCode: number | null, output: string): AdminResult {
  const line = output.trim().split("\n").pop() ?? "";
  const answer: unknown = JSON.parse(line);
  if (exitCode === 0 && answer && typeof answer === "object" && "ok" in answer && answer.ok === true)
    return answer as AdminResult;
  if (answer && typeof answer === "object" && "ok" in answer && answer.ok === false)
    return answer as AdminResult;
  return { ok: false, why: "the root helper returned an invalid repair result" };
}

function personRepairCall(generation: string | null): AdminResult {
  if (!process.stdin.isTTY) return { ok: false, why: "run walkie talkie cleanup --repair in a terminal to enter your sudo password" };
  try {
    const result = Bun.spawnSync(personRepairArgv(generation), {
      stdin: "inherit", stdout: "pipe", stderr: "inherit", cwd: "/", env: SPAWN_ENV, timeout: 180_000,
    });
    return parsePersonRepairAnswer(result.exitCode, result.stdout.toString());
  } catch {
    return { ok: false, why: "sudo or the root helper failed; run the repair command in your terminal" };
  }
}

/** Person-only, local repair when the privileged cleanup helper cannot complete removal. */
export async function talkieRepair(ctx: Ctx, client: WalkieClient): Promise<number> {
  const path = join(defaultHome(), "orchestrator-uid-cleanup.sqlite");
  const snapshot = await inspectTalkieStatus();
  const result = snapshot.ledgerOwner !== null
    ? await repairEmptyTalkieOwner(path, inspectTalkieStatus, async (generation) => personRepairCall(generation), ctx)
    : await repairTalkieCleanup(path, inspectTalkieStatus, ctx, async () => {
    try {
      const response = await adminCall(["sudo", "-n", DEFAULT_ADMIN, "seat-admin", "talkie-reconcile"]);
      return response?.ok ? null : `dedicated-user sweep could not finish: ${response?.why ?? "the seat helper did not answer"}`;
    } catch (err) {
      return `dedicated-user sweep could not finish: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
  if (!result.repaired) {
    ctx.err(`not repairable: ${result.remaining.join("; ")}`);
    return EXIT.error;
  }
  try { await client.orchestratorCleanupRepaired(); }
  catch { /* The monitor also observes the completed generation after its next retry. */ }
  ctx.out("WalkieTalkie empty uid and owner row verified; cleanup state repaired");
  return EXIT.ok;
}
