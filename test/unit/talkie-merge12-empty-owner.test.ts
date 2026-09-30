import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";
import { createTalkieUser, destroyTalkieUser, reconcileTalkieUser, repairEmptyTalkieOwner, talkieStatus, TALKIE_UID, TALKIE_USER, talkieHome } from "../../src/daemon/seats/talkie-user.ts";
import { TalkieOsUser } from "../../src/daemon/orchestrator/os-user.ts";
import type { AdminResult } from "../../src/daemon/seats/admin.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const run = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const instance = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function world() {
  const root = mkdtempSync(join(tmpdir(), "walkie-empty-owner-")); roots.push(root);
  const w = fakeSeatWorld(root, join(root, "walkie"));
  w.sys.acl = () => "";
  return { root, w };
}

test("claimed row before account creation needs verified empty sweep and recorded generation", async () => {
  const { root, w } = world();
  const socket = join(root, "daemon.sock");
  const ownerInstance = createHash("sha256").update(socket).digest("hex");
  const op = { pid: 999_991, start: "dead" };
  expect(w.sys.ledger().claimTalkie(TALKIE_UID, w.sys.caller(), run, ownerInstance, op)).toBe(true);
  w.sys.ledger().releaseTalkieOp(TALKIE_UID, op);
  let verified = false;
  let sweeps = 0;
  w.sys.verifyEmptyTalkieUid = () => { sweeps++; return { ok: verified, left: verified ? [] : ["orphan file"] }; };
  expect((await reconcileTalkieUser(w.sys, run, ownerInstance)).ok).toBe(false);
  expect(w.sys.ledger().talkieOwner(TALKIE_UID)?.generation).toBe(run);
  verified = true;
  const calls: string[] = [];
  const admin = async (verb: string, generation?: string, _signal?: AbortSignal, daemon?: string): Promise<AdminResult> => {
    calls.push(`${verb}:${generation ?? ""}`);
    if (verb === "talkie-status") return talkieStatus(w.sys);
    if (verb === "talkie-reconcile") return reconcileTalkieUser(w.sys, generation as string, daemon as string);
    if (verb === "talkie-create") return createTalkieUser(w.sys, generation as string, daemon as string);
    return { ok: true };
  };
  const shell = new TalkieOsUser(socket, () => false, {
    ready: () => true, privateHome: () => null, socketRoot: root, existing: () => false, admin,
    monitor: () => ({ kill: () => undefined }),
  });
  await shell.prepare();
  expect(calls).toContain("talkie-status:");
  expect(calls).toContain(`talkie-reconcile:${run}`);
  expect(sweeps).toBe(2);
  expect(shell.active).toBe(true);
  await shell.destroy();
});

test("crash after account deletion releases only a verified empty recorded generation", async () => {
  const { w } = world();
  expect((await createTalkieUser(w.sys, run, instance)).ok).toBe(true);
  w.users.delete(TALKIE_USER);
  rmSync(talkieHome(w.sys), { recursive: true, force: true });
  w.sys.verifyEmptyTalkieUid = () => ({ ok: true, left: [] });
  expect((await reconcileTalkieUser(w.sys, other, instance)).ok).toBe(false);
  expect(w.sys.ledger().talkieOwner(TALKIE_UID)?.generation).toBe(run);
  expect((await reconcileTalkieUser(w.sys, run, instance)).ok).toBe(true);
  expect(w.sys.ledger().talkieOwner(TALKIE_UID)).toBeNull();
});

test("absent account owner row stays held until stopped proof on destroy and reconcile", async () => {
  for (const verb of ["destroy", "reconcile"] as const) {
    const { w } = world();
    expect((await createTalkieUser(w.sys, run, instance)).ok).toBe(true);
    w.users.delete(TALKIE_USER);
    rmSync(talkieHome(w.sys), { recursive: true, force: true });
    w.sys.verifyEmptyTalkieUid = () => ({ ok: true, left: [] });
    const invoke = () => verb === "destroy" ? destroyTalkieUser(w.sys, run) : reconcileTalkieUser(w.sys, run, instance);
    w.sys.talkieGenerationStopped = async () => ({ ok: false, why: "daemon still live" });
    expect((await invoke()).why).toContain("daemon still live");
    expect(w.sys.ledger().talkieOwner(TALKIE_UID)?.state).toBe("destroying");
    w.sys.talkieGenerationStopped = undefined;
    expect((await invoke()).ok).toBe(false);
    expect(w.sys.ledger().talkieOwner(TALKIE_UID)).not.toBeNull();
    w.sys.talkieGenerationStopped = async () => ({ ok: true });
    expect((await invoke()).ok).toBe(true);
    expect(w.sys.ledger().talkieOwner(TALKIE_UID)).toBeNull();
  }
});

test("destroy passes the root-recorded daemon identity to stopped verification", async () => {
  const { w } = world();
  const daemon = { pid: 1234, start: "recorded start" };
  w.sys.talkieDaemonIdentity = () => daemon;
  expect((await createTalkieUser(w.sys, run, instance)).ok).toBe(true);
  expect(w.sys.ledger().talkieOwner(TALKIE_UID)).toMatchObject({ daemon_pid: daemon.pid, daemon_start: daemon.start });
  w.users.delete(TALKIE_USER);
  rmSync(talkieHome(w.sys), { recursive: true, force: true });
  w.sys.talkieGenerationStopped = async (_generation, _owner, recorded) => ({ ok: recorded?.pid === daemon.pid && recorded.start === daemon.start });
  expect((await destroyTalkieUser(w.sys, run)).ok).toBe(true);
});

test("person repair fences the recorded generation and refuses a live or unswept uid", async () => {
  const { w } = world();
  const op = { pid: 999_991, start: "dead" };
  expect(w.sys.ledger().claimTalkie(TALKIE_UID, w.sys.caller(), run, instance, op)).toBe(true);
  w.sys.ledger().releaseTalkieOp(TALKIE_UID, op);
  w.sys.verifyEmptyTalkieUid = () => ({ ok: false, left: ["orphan file"] });
  expect((await repairEmptyTalkieOwner(w.sys, run)).ok).toBe(false);
  w.sys.verifyEmptyTalkieUid = () => ({ ok: true, left: [] });
  expect((await repairEmptyTalkieOwner(w.sys, other)).ok).toBe(false);
  expect((await repairEmptyTalkieOwner(w.sys, run)).ok).toBe(true);
  expect(w.sys.ledger().talkieOwner(TALKIE_UID)).toBeNull();
});

test("person repair refuses a live daemon lease or socket for the recorded generation", async () => {
  const { w } = world();
  const op = { pid: 999_991, start: "dead" };
  expect(w.sys.ledger().claimTalkie(TALKIE_UID, w.sys.caller(), run, instance, op)).toBe(true);
  w.sys.ledger().releaseTalkieOp(TALKIE_UID, op);
  w.sys.verifyEmptyTalkieUid = () => ({ ok: true, left: [] });
  w.sys.talkieGenerationStopped = async () => ({ ok: false, why: "the recorded daemon lease is still live" });
  expect((await repairEmptyTalkieOwner(w.sys, run)).why).toContain("lease is still live");
  expect(w.sys.ledger().talkieOwner(TALKIE_UID)?.generation).toBe(run);
  w.sys.talkieGenerationStopped = async () => ({ ok: false, why: "the shell socket still has a live owner" });
  expect((await repairEmptyTalkieOwner(w.sys, run)).why).toContain("socket still has a live owner");
  expect(w.sys.ledger().talkieOwner(TALKIE_UID)?.generation).toBe(run);
  w.sys.talkieGenerationStopped = async () => ({ ok: true });
  expect((await repairEmptyTalkieOwner(w.sys, run)).ok).toBe(true);
});

test("person repair can clear a legacy null-generation owner row only when the uid is empty", async () => {
  const { root, w } = world();
  const op = { pid: 999_991, start: "dead" };
  w.sys.ledger().claimTalkie(TALKIE_UID, w.sys.caller(), run, instance, op);
  w.sys.ledger().releaseTalkieOp(TALKIE_UID, op);
  const db = new Database(join(root, "seat-admin.sqlite"));
  try { db.query("UPDATE talkie_owner SET generation = NULL, instance = NULL WHERE uid = ?").run(TALKIE_UID); }
  finally { db.close(); }
  w.sys.verifyEmptyTalkieUid = () => ({ ok: true, left: [] });
  expect((await repairEmptyTalkieOwner(w.sys, run)).ok).toBe(false);
  expect((await repairEmptyTalkieOwner(w.sys, null)).ok).toBe(true);
  expect(w.sys.ledger().talkieOwner(TALKIE_UID)).toBeNull();
});
