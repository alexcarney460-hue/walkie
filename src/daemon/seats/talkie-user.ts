// A single dedicated uid for shell-capable WalkieTalkie. The root-owned seat helper creates and destroys it;
// destroy uses the same uid-wide process, service, schedule, mount and file cleanup as a seat.
import { SEATS_GROUP, endProcesses, removeEmptyHome, removeUnusedHome, type AdminResult, type AdminSys } from "./admin.ts";
import { processAlive, selfOp, type OpId } from "./admin-ledger.ts";
import { aclProblem, schedulerProblem } from "./seat-user.ts";
import { withSeatFileLock, withTalkieLock } from "./talkie-lock.ts";

export const TALKIE_USER = "walkie-talkie";
export const TALKIE_UID = 550_000;
const message = (err: unknown): string => err instanceof Error ? err.message : String(err);
const residuePath = (entry: string): string => {
  const suffix = entry.lastIndexOf(" (");
  return suffix < 0 ? entry : entry.slice(0, suffix);
};
const residueFolder = (paths: readonly string[]): string => {
  if (!paths.length) return "";
  const folder = /^\/private\/var\/folders\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(?=\/|$)/.exec(residuePath(paths[0] ?? ""))?.[0];
  if (!folder || paths.some((entry) => {
    const path = residuePath(entry);
    return path !== folder && !path.startsWith(`${folder}/`);
  }))
    throw new Error("invalid dedicated-user per-user residue paths");
  return folder;
};
export const talkieHome = (sys: Pick<AdminSys, "platform" | "homesDir">): string =>
  `${sys.homesDir ?? (sys.platform === "darwin" ? "/Users" : "/var/lib/walkie-seats")}/${TALKIE_USER}`;

/** A deleted or never-created account can leave a row; release it only after every empty-uid check. */
function verifyEmptyUid(sys: AdminSys, home: string): void {
  if (sys.lookup(TALKIE_USER) || sys.nameTaken(TALKIE_USER) || sys.idTaken(TALKIE_UID)
    || sys.stat(home) || sys.procs(TALKIE_UID).length) throw new Error("the dedicated uid or account is not empty");
  if (sys.userMounts(TALKIE_UID).length) throw new Error("mounts of the dedicated uid remain");
  const schedules = sys.removeSchedules(TALKIE_USER, TALKIE_UID, false);
  if (schedules) throw new Error(schedules);
  const swept = sys.verifyEmptyTalkieUid?.(TALKIE_UID);
  if (!swept?.ok) throw new Error(`the empty uid sweep could not be verified${swept?.left.length ? `: ${swept.left.slice(0, 5).join("; ")}` : ""}`);
}

async function verifyDaemonStopped(sys: AdminSys, generation: string | null, owner: number): Promise<void> {
  const row = sys.ledger().talkieOwner(TALKIE_UID);
  if (!row || row.owner !== owner || row.generation !== generation)
    throw new Error("the recorded daemon owner changed before stopped verification");
  const daemon = row.daemon_pid !== null && row.daemon_start !== null
    ? { pid: row.daemon_pid, start: row.daemon_start } : null;
  const stopped = await sys.talkieGenerationStopped?.(generation, owner, daemon);
  if (!stopped?.ok) throw new Error(stopped?.why ?? "the recorded daemon could not be verified stopped");
}

/** Only fixed, read-only facts needed for person-authorized cleanup repair. */
export function talkieStatus(sys: AdminSys): AdminResult {
  try {
    const accountUid = sys.lookup(TALKIE_USER)?.uid ?? null;
    const uidTaken = sys.idTaken(TALKIE_UID);
    const homeExists = sys.stat(talkieHome(sys)) !== null;
    const owner = sys.talkieOwnerReadOnly ? sys.talkieOwnerReadOnly(TALKIE_UID) : sys.ledger().talkieOwner(TALKIE_UID);
    const processes = sys.procs(TALKIE_UID).map((process) => process.pid);
    return { ok: true, status: { accountUid, uidTaken, processes, homeExists,
      ledgerOwner: owner ? `${owner.state} for uid ${owner.owner}` : null,
      generation: owner?.generation ?? null, instance: owner?.instance ?? null } };
  } catch (err) { return { ok: false, code: "refused", why: `could not check ${TALKIE_USER}: ${message(err)}` }; }
}

export async function createTalkieUser(sys: AdminSys, generation: string, instance: string): Promise<AdminResult> {
  try { return await withTalkieLock(sys, true, () => createRecordedTalkieUser(sys, generation, instance)); }
  catch (err) { return { ok: false, code: "refused", why: `could not lock ${TALKIE_USER}: ${message(err)}` }; }
}

async function createRecordedTalkieUser(sys: AdminSys, generation: string, instance: string): Promise<AdminResult> {
  const home = talkieHome(sys);
  let made = false;
  let op: OpId;
  try { op = (sys.self ?? selfOp)(); }
  catch (err) { return { ok: false, code: "refused", why: `could not identify the helper operation: ${message(err)}` }; }
  try {
    const owner = sys.caller();
    const claimed = sys.talkieOwnerReadOnly ? sys.talkieOwnerReadOnly(TALKIE_UID) : sys.ledger().talkieOwner(TALKIE_UID);
    if (claimed?.instance && claimed.instance !== instance) {
      return { ok: false, code: "busy", why: "another Walkie daemon owns shell access on this machine" };
    }
    if (sys.nameTaken(TALKIE_USER) || sys.idTaken(TALKIE_UID) || sys.stat(home)) {
      return { ok: false, code: "used", why: `${TALKIE_USER} or uid ${TALKIE_UID} already exists; ${TALKIE_USER} not created by Walkie is refused` };
    }
    const residues = sys.ledger().talkieResidues(TALKIE_UID);
    if (residues.some((residue) => residue.owner !== owner || residueFolder(residue.paths) !== residue.folder))
      throw new Error("the previous dedicated user's per-user residue belongs to another owner or is invalid");
    // A reservation serializes helpers, but is not yet proof of a created account.
    const daemon = sys.talkieDaemonIdentity?.(owner, instance) ?? null;
    if (!sys.ledger().claimTalkie(TALKIE_UID, owner, generation, instance, op, daemon)) throw new Error("the dedicated user is already claimed");
    // A createUser failure may have found an external directory account or left a partial local one.
    // Neither case authorizes a uid-wide kill.
    sys.createUser({ name: TALKIE_USER, uid: TALKIE_UID, home });
    sys.ledger().markTalkieCreated(TALKIE_UID, owner, generation, op);
    made = true;
    sys.makeHome(home, TALKIE_UID);
    await withSeatFileLock(`${sys.ledger().path}.schedulers.lock`, !!sys.talkieLockRoot,
      async () => sys.denySchedulers(TALKIE_USER));
    const u = sys.lookup(TALKIE_USER);
    const group = sys.lookup(SEATS_GROUP)?.gid;
    const extra = u?.gids.filter((g) => g !== TALKIE_UID && g !== group) ?? [];
    const implicit = new Set(extra.length && sys.implicitGroups ? sys.implicitGroups(TALKIE_USER, extra) : []);
    const st = sys.stat(home);
    if (!u || u.uid !== TALKIE_UID || u.gid !== TALKIE_UID || extra.some((g) => !implicit.has(g))
      || !st?.dir || st.symlink || st.uid !== TALKIE_UID || (st.mode & 0o777) !== 0o700
      || aclProblem(home, sys.acl(home), sys.platform) || schedulerProblem([TALKIE_USER], sys.schedulerFiles, sys.readSchedulerFile)) {
      throw new Error("the dedicated user did not pass its identity, home, ACL or scheduler checks");
    }
    sys.ledger().releaseTalkieOp(TALKIE_UID, op);
    return { ok: true, name: TALKIE_USER, uid: TALKIE_UID, home, generation };
  } catch (err) {
    if (!made) return { ok: false, code: "refused", why: `could not check ${TALKIE_USER}: ${message(err)}` };
    const undone = await destroyRecordedTalkieUser(sys, generation);
    return { ok: false, code: "failed", why: `could not create ${TALKIE_USER}: ${message(err)}${undone.ok ? "" : `; cleanup: ${undone.why}`}` };
  }
}

export async function destroyTalkieUser(sys: AdminSys, generation: string): Promise<AdminResult> {
  return lockedDestroyTalkieUser(sys, generation);
}

/** The expected generation and machine-wide daemon owner are checked under the root lock. */
export async function reconcileTalkieUser(sys: AdminSys, generation: string, instance: string): Promise<AdminResult> {
  return lockedDestroyTalkieUser(sys, generation, instance);
}

/** Person-confirmed recovery for an absent account whose owner row predates or belongs to another daemon. */
export async function repairEmptyTalkieOwner(sys: AdminSys, generation: string | null): Promise<AdminResult> {
  try {
    return await withTalkieLock(sys, false, async () => {
      const op = (sys.self ?? selfOp)();
      const owner = sys.caller();
      const claim = sys.ledger().takeEmptyTalkieForRepair(TALKIE_UID, owner, generation, op);
      if (!claim.ok) return { ok: false, code: "refused", why: claim.why };
      let released = false;
      try {
        verifyEmptyUid(sys, talkieHome(sys));
        await verifyDaemonStopped(sys, generation, owner);
        sys.ledger().releaseTalkie(TALKIE_UID, owner, op);
        released = true;
        return { ok: true, name: TALKIE_USER, uid: TALKIE_UID };
      } finally { if (!released) sys.ledger().releaseTalkieOp(TALKIE_UID, op); }
    });
  } catch (err) { return { ok: false, code: "refused", why: `empty owner repair failed: ${message(err)}` }; }
}

async function lockedDestroyTalkieUser(sys: AdminSys, generation: string, instance?: string): Promise<AdminResult> {
  try { return await withTalkieLock(sys, false, () => destroyRecordedTalkieUser(sys, generation, instance), async (createError) => {
    // When a full volume prevents a first lock inode, an entirely absent uid needs no mutation.
    // Any recorded ownership or uncertain OS fact still requires the lock and fails closed.
    if (!sys.talkieOwnerReadOnly || sys.talkieOwnerReadOnly(TALKIE_UID) !== null
      || sys.lookup(TALKIE_USER) || sys.idTaken(TALKIE_UID) || sys.stat(talkieHome(sys))
      || sys.procs(TALKIE_UID).length) throw createError;
    return { ok: true, name: TALKIE_USER, uid: TALKIE_UID };
  }); }
  catch (err) { return { ok: false, name: TALKIE_USER, uid: TALKIE_UID, why: `could not lock ${TALKIE_USER}: ${message(err)}` }; }
}

async function destroyRecordedTalkieUser(sys: AdminSys, generation: string, instance?: string): Promise<AdminResult> {
  const home = talkieHome(sys);
  let taken = false;
  let op: OpId;
  try { op = (sys.self ?? selfOp)(); }
  catch (err) { return { ok: false, name: TALKIE_USER, uid: TALKIE_UID, why: `could not identify the helper operation: ${message(err)}` }; }
  try {
    const owner = sys.caller();
    const recordedOwner = sys.talkieOwnerReadOnly ? sys.talkieOwnerReadOnly(TALKIE_UID) : sys.ledger().talkieOwner(TALKIE_UID);
    if (recordedOwner === null) {
      if (sys.lookup(TALKIE_USER) || sys.idTaken(TALKIE_UID) || sys.stat(home) || sys.procs(TALKIE_UID).length)
        throw new Error(`${TALKIE_USER} was not created by Walkie; refusing cleanup`);
      // A concurrent daemon or monitor may have just verified removal. A generation-qualified retry is
      // idempotently clean only when the fixed uid, account and home are all absent.
      return { ok: true, name: TALKIE_USER, uid: TALKIE_UID };
    }
    if (instance && recordedOwner.instance !== instance) {
      throw new Error(recordedOwner.instance ? "another Walkie daemon owns shell access on this machine"
        : "the dedicated account has no daemon owner; run walkie talkie cleanup --repair");
    }
    let claim: ReturnType<ReturnType<AdminSys["ledger"]>["takeTalkieForDestroy"]>;
    try { claim = sys.ledger().takeTalkieForDestroy(TALKIE_UID, owner, generation, op); }
    catch (writeError) {
      // A full volume can prevent the claim but must not let an already-created uid keep running.
      // The read-only record is proof only for this person and generation; no account is deleted here.
      if (generation !== undefined) {
        try {
          const record = sys.talkieOwnerReadOnly ? sys.talkieOwnerReadOnly(TALKIE_UID) : sys.ledger().talkieOwner(TALKIE_UID);
          const otherLiveOp = record?.op_pid != null && record.op_start != null
            && (record.op_pid !== op.pid || record.op_start !== op.start)
            && processAlive({ pid: record.op_pid, start: record.op_start });
          if (record?.owner === owner && record.generation === generation
            && (record.state === "created" || record.state === "destroying") && !otherLiveOp) {
            const u = sys.lookup(TALKIE_USER);
            if (u && u.uid !== TALKIE_UID) throw new Error(`${TALKIE_USER} belongs to uid ${u.uid}, not ${TALKIE_UID}`);
            if (!u && sys.idTaken(TALKIE_UID)) throw new Error(`uid ${TALKIE_UID} belongs to another account`);
            const verifyOwner = () => {
              const current = sys.talkieOwnerReadOnly ? sys.talkieOwnerReadOnly(TALKIE_UID) : sys.ledger().talkieOwner(TALKIE_UID);
              if (current?.owner !== owner || current.generation !== generation
                || (current.state !== "created" && current.state !== "destroying")) {
                throw new Error("recorded owner or generation changed during read-only stop");
              }
              if (current.op_pid != null && current.op_start != null
                && (current.op_pid !== op.pid || current.op_start !== op.start)
                && processAlive({ pid: current.op_pid, start: current.op_start })) {
                throw new Error("another helper took the dedicated user during read-only stop");
              }
            };
            verifyOwner();
            await endProcesses(TALKIE_UID, sys, verifyOwner);
            verifyOwner();
            let services: string | null;
            try { services = sys.stopUserServices(TALKIE_UID); }
            catch (err) { services = message(err); }
            await endProcesses(TALKIE_UID, sys, verifyOwner);
            if (services) throw new Error(services);
          }
        } catch (stopError) {
          throw new Error(`could not write the destroy claim: ${message(writeError)}; read-only stop failed: ${message(stopError)}`);
        }
      }
      throw writeError;
    }
    if (!claim.ok) throw new Error(claim.why);
    taken = true;
    if (claim.state !== "created" && claim.state !== "destroying") {
      verifyEmptyUid(sys, home);
      await verifyDaemonStopped(sys, generation, owner);
      sys.ledger().releaseTalkie(TALKIE_UID, owner, op);
      taken = false;
      return { ok: true, name: TALKIE_USER, uid: TALKIE_UID };
    }
    const u = sys.lookup(TALKIE_USER);
    if (u && u.uid !== TALKIE_UID) throw new Error(`${TALKIE_USER} belongs to uid ${u.uid}, not ${TALKIE_UID}`);
    if (!u && sys.idTaken(TALKIE_UID)) throw new Error(`uid ${TALKIE_UID} belongs to another account`);
    await endProcesses(TALKIE_UID, sys);
    const services = sys.stopUserServices(TALKIE_UID);
    if (services) throw new Error(services);
    const schedules = sys.removeSchedules(TALKIE_USER, TALKIE_UID, !!u);
    if (schedules) throw new Error(schedules);
    await endProcesses(TALKIE_UID, sys);
    for (const mount of sys.userMounts(TALKIE_UID)) sys.unmount(mount);
    if (sys.userMounts(TALKIE_UID).length) throw new Error("mounts of the dedicated user remain");
    const unused = removeUnusedHome(home, TALKIE_UID, sys);
    if (unused) throw new Error(unused);
    if (u) {
      const previous = sys.ledger().talkieResidues(TALKIE_UID);
      if (previous.some((residue) => residue.owner !== owner || residueFolder(residue.paths) !== residue.folder))
        throw new Error("a previous dedicated user's per-user residue record is invalid");
      const swept = await sys.sweepAsUser(TALKIE_USER, TALKIE_UID, sys.extraRoots(), previous.map((r) => r.folder));
      if (!swept.ok) throw new Error(`files of the dedicated user remain: ${swept.left.slice(0, 5).join("; ")}`);
      const paths = swept.leftoverDirs ?? [];
      const byFolder = new Map<string, string[]>();
      for (const path of paths) {
        const folder = residueFolder([path]);
        byFolder.set(folder, [...(byFolder.get(folder) ?? []), path]);
      }
      for (const record of previous) sys.ledger().saveTalkieResidue(TALKIE_UID, owner, record.folder, byFolder.get(record.folder) ?? []);
      for (const [folder, entries] of byFolder) if (!previous.some((record) => record.folder === folder))
        sys.ledger().saveTalkieResidue(TALKIE_UID, owner, folder, entries);
      await endProcesses(TALKIE_UID, sys);
    }
    const homeProblem = removeEmptyHome(home, TALKIE_UID, sys);
    if (homeProblem) throw new Error(homeProblem);
    await endProcesses(TALKIE_UID, sys);
    if (u) sys.deleteUser(TALKIE_USER);
    if (sys.procs(TALKIE_UID).length || sys.nameTaken(TALKIE_USER) || sys.idTaken(TALKIE_UID) || sys.stat(home)) {
      throw new Error("the dedicated user was not verified removed");
    }
    const remaining = sys.removeSchedules(TALKIE_USER, TALKIE_UID, false);
    if (remaining) throw new Error(remaining);
    if (!u) {
      verifyEmptyUid(sys, home);
      await verifyDaemonStopped(sys, generation, owner);
    }
    sys.ledger().releaseTalkie(TALKIE_UID, owner, op);
    taken = false;
    return { ok: true, name: TALKIE_USER, uid: TALKIE_UID };
  } catch (err) {
    return { ok: false, name: TALKIE_USER, uid: TALKIE_UID, why: message(err) };
  } finally {
    if (taken) { try { sys.ledger().releaseTalkieOp(TALKIE_UID, op); } catch { /* process exit releases the operation */ } }
  }
}
