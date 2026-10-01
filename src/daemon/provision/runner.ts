import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { renameSync } from "node:fs";
import { z } from "zod";
import { readPrivate, writePrivate } from "./files.ts";
import { profile, type ProfileId, type Step } from "./profiles.ts";
import { processAlive, type InstallerProcess } from "./process.ts";
import { ProvisionInterrupted } from "./interrupt.ts";

const State = z.enum(["pending", "started", "done", "drift", "failed", "needs_installer_elevation", "revoked", "uncertain"]);
const Reason = z.enum(["checksum_mismatch", "download_unavailable", "archive_too_large", "unsupported_platform",
  "invalid_lock", "prerequisite_missing", "version_unverified", "installer_timeout", "installer_failed",
  "requires_initial_installer", "authorization_changed", "installer_process_unresolved", "step_failed"]);
const Journal = z.object({
  profile: z.enum(["developer-worker", "freight-worker"]), version: z.number().int().positive(),
  steps: z.array(z.object({ id: z.string(), version: z.string(), state: State, attempts: z.number().int().nonnegative(), at: z.number().int().nonnegative(),
    actor: z.string().max(200).optional(), target: z.string().max(100).optional(),
    process: z.object({ pid: z.number().int().positive(), start: z.string().min(1).max(100) }).strict().optional(), reason: Reason.optional() }).strict()),
}).strict();
export type Journal = z.infer<typeof Journal>;
export interface StepExecutor {
  inspect(step: Step): Promise<"installed" | "missing">;
  execute(step: Step, onProcess?: (identity: InstallerProcess) => void, guard?: Guard): Promise<void | "needs_installer_elevation">;
}
export type Guard = () => string | null;

const pathFor = (home: string, id: ProfileId) => join(home, `provision-${id}.json`);

/** Local person action: migrate evidence into a newer profile after renewed consent. */
export async function resetProfileJournal(home: string, id: ProfileId, consentAt: number,
  alive: (identity: InstallerProcess) => Promise<boolean> = processAlive): Promise<string> {
  const next = profile(id);
  if (!next) throw new Error("unknown profile");
  const path = pathFor(home, id);
  const raw = readPrivate(path);
  if (raw === null) throw new Error("profile_upgrade_required");
  const old = Journal.parse(JSON.parse(raw) as unknown);
  if (old.profile !== id || old.version >= next.version || new Set(old.steps.map((s) => s.id)).size !== old.steps.length) {
    throw new Error("profile_upgrade_required");
  }
  if (old.steps.some((s) => s.at > 0) && consentAt <= Math.max(...old.steps.map((s) => s.at))) {
    throw new Error("new_consent_required");
  }
  for (const prior of old.steps) {
    if (prior.process && await alive(prior.process)) throw new Error("installer_process_unresolved");
    if ((prior.attempts > 0 || prior.state !== "pending") && !next.steps.some((s) => s.id === prior.id)) {
      throw new Error("receipt_migration_required");
    }
  }
  const steps = next.steps.map((step) => {
    const prior = old.steps.find((s) => s.id === step.id);
    if (!prior) return { id: step.id, version: step.version, state: "pending" as const, attempts: 0, at: 0 };
    const uncertain = step.destructive && prior.attempts > 0 && prior.state !== "done" && prior.state !== "drift";
    return { ...prior, version: step.version, state: prior.state === "started" || uncertain ? "uncertain" as const : prior.state };
  });
  const archive = `${path}.${Date.now()}-${randomBytes(4).toString("hex")}.bak`;
  renameSync(path, archive);
  try { save(home, id, { profile: id, version: next.version, steps }); }
  catch (err) { renameSync(archive, path); throw err; }
  return archive;
}

export function profileStatus(home: string, id: ProfileId): Journal {
  const p = profile(id);
  if (!p) throw new Error("unknown profile");
  const raw = readPrivate(pathFor(home, id));
  if (raw !== null) {
    const saved = Journal.parse(JSON.parse(raw) as unknown);
    if (saved.profile !== id || saved.version !== p.version || saved.steps.length !== p.steps.length ||
      saved.steps.some((s, i) => s.id !== p.steps[i]?.id || s.version !== p.steps[i]?.version)) {
      throw new Error("profile journal version mismatch");
    }
    return saved;
  }
  return { profile: id, version: p.version, steps: p.steps.map((s) => ({ id: s.id, version: s.version, state: "pending", attempts: 0, at: 0 })) };
}

/** Read-only observation. A missing recorded success is drift, never permission to repeat an install. */
export async function observedStatus(home: string, id: ProfileId, executor: StepExecutor): Promise<Journal> {
  const journal = profileStatus(home, id);
  const steps = await Promise.all(journal.steps.map(async (receipt, index) => {
    if (receipt.state !== "done") return receipt;
    const step = profile(id)?.steps[index];
    if (!step) return receipt;
    try { return await executor.inspect(step) === "installed" ? receipt : { ...receipt, state: "drift" as const }; }
    catch { return { ...receipt, state: "uncertain" as const }; }
  }));
  return { ...journal, steps };
}

/** A daemon restart cannot prove whether an external installer completed; retain this until inspect reconciles it. */
export function markInterrupted(home: string, id: ProfileId): Journal {
  const current = profileStatus(home, id);
  if (!current.steps.some((s) => s.state === "started")) return current;
  const uncertain = { ...current, steps: current.steps.map((s) => s.state === "started" ? { ...s, state: "uncertain" as const } : s) };
  save(home, id, uncertain);
  return uncertain;
}

function save(home: string, id: ProfileId, value: Journal): void { writePrivate(pathFor(home, id), value); }
function setStep(j: Journal, i: number, state: z.infer<typeof State>, ctx?: ApplyContext, reason?: z.infer<typeof Reason>): Journal {
  return { ...j, steps: j.steps.map((s, n) => n === i ? { ...s, state, attempts: s.attempts + (state === "started" ? 1 : 0), at: Date.now(),
    reason,
    ...(state === "started" ? { process: undefined } : {}),
    ...(state === "started" ? { ...(ctx?.actor ? { actor: ctx.actor } : {}), ...(ctx?.target ? { target: ctx.target } : {}) } : {}) } : s) };
}

export interface ApplyResult { readonly state: "done" | "drift" | "failed" | "needs_installer_elevation" | "revoked" | "uncertain"; readonly journal: Journal; readonly reason?: string }
export interface ApplyContext { readonly actor?: string; readonly target?: string; readonly onTransition?: (step: Step, state: z.infer<typeof State>) => void;
  readonly processAlive?: (identity: InstallerProcess) => Promise<boolean> }

function safeReason(err: unknown): z.infer<typeof Reason> {
  const message = err instanceof Error ? err.message : "";
  if (message.startsWith("Node archive checksum mismatch")) return "checksum_mismatch";
  if (message.startsWith("Node archive unavailable")) return "download_unavailable";
  if (message.startsWith("Node archive too large")) return "archive_too_large";
  if (message.startsWith("unsupported platform")) return "unsupported_platform";
  if (["invalid_lock", "wrong_lock_version", "unverified_package"].includes(message)) return "invalid_lock";
  if (message.startsWith("pinned Node/npm is not installed")) return "prerequisite_missing";
  if (message.includes("version mismatch")) return "version_unverified";
  if (message === "installer_timeout") return "installer_timeout";
  if (message === "verified_installer_failed") return "installer_failed";
  return "step_failed";
}

/** Inspect first, persist `started` before every action, and never re-run a recorded success. */
export async function applyProfile(home: string, id: ProfileId, guard: Guard, executor: StepExecutor, ctx: ApplyContext = {}): Promise<ApplyResult> {
  const p = profile(id);
  if (!p) throw new Error("unknown profile");
  const recorded = profileStatus(home, id);
  const observed = await observedStatus(home, id, executor);
  let journal = recorded;
  const reportedJournal = (): Journal => ({ ...journal, steps: journal.steps.map((receipt, i) =>
    recorded.steps[i]?.state === "done" && receipt.state === "done" ? observed.steps[i] ?? receipt : receipt) });
  let needsInstaller = false;
  const transition = (i: number, state: z.infer<typeof State>, reason?: z.infer<typeof Reason>): void => {
    journal = setStep(journal, i, state, ctx, reason);
    save(home, id, journal);
    ctx.onTransition?.(p.steps[i] as Step, state);
  };
  for (let i = 0; i < p.steps.length; i++) {
    const step = p.steps[i] as Step;
    if (recorded.steps[i]?.state === "done" || recorded.steps[i]?.state === "drift") continue;
    const prior = journal.steps[i];
    if (prior?.state === "uncertain" && step.destructive && (!prior.process || await (ctx.processAlive ?? processAlive)(prior.process))) {
      return { state: "uncertain", journal: reportedJournal(), reason: "installer_process_unresolved" };
    }
    const denied = guard();
    if (denied) {
      transition(i, "revoked");
      return { state: "revoked", journal: reportedJournal(), reason: denied };
    }
    try {
      const present = await executor.inspect(step);
      const changed = guard();
      if (changed) { transition(i, "revoked"); return { state: "revoked", journal: reportedJournal(), reason: changed }; }
      if (present === "installed") {
        transition(i, "done");
        continue;
      }
      // The step may be retried only after inspect confirms the desired state is still absent.
      transition(i, "started");
      const beforeAction = guard();
      if (beforeAction) { transition(i, "revoked"); return { state: "revoked", journal: reportedJournal(), reason: beforeAction }; }
      const result = await executor.execute(step, (identity) => {
        journal = { ...journal, steps: journal.steps.map((s, n) => n === i ? { ...s, process: identity } : s) };
        save(home, id, journal);
      }, guard);
      if (result === "needs_installer_elevation") {
        transition(i, result, "requires_initial_installer");
        needsInstaller = true;
        continue;
      }
      if (guard()) {
        transition(i, "uncertain", "authorization_changed");
        return { state: "revoked", journal: reportedJournal(), reason: "authorization_changed" };
      }
      // An installer reporting success is not proof. Verify the pinned version before recording `done`.
      if (await executor.inspect(step) !== "installed") {
        transition(i, "failed", "version_unverified");
        return { state: "failed", journal: reportedJournal(), reason: "version_unverified" };
      }
      transition(i, "done");
    } catch (err) {
      if (err instanceof ProvisionInterrupted) {
        transition(i, "uncertain", "authorization_changed");
        return { state: "revoked", journal: reportedJournal(), reason: err.reason };
      }
      const reason = safeReason(err);
      transition(i, "failed", reason);
      return { state: "failed", journal: reportedJournal(), reason };
    }
  }
  const reported = reportedJournal();
  return { state: reported.steps.some((s) => s.state === "uncertain") ? "uncertain"
    : reported.steps.some((s) => s.state === "drift") ? "drift" : needsInstaller ? "needs_installer_elevation" : "done", journal: reported };
}
