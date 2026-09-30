import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";
import { createTalkieUser, destroyTalkieUser, reconcileTalkieUser, talkieStatus, TALKIE_UID } from "../../src/daemon/seats/talkie-user.ts";
import { TalkieOsUser } from "../../src/daemon/orchestrator/os-user.ts";
import type { AdminResult } from "../../src/daemon/seats/admin.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const daemonA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const daemonB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("queued stale reconcile cannot remove a newer generation from the same daemon", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-fence-")); roots.push(root);
  const world = fakeSeatWorld(root, join(root, "walkie"));
  world.sys.acl = () => "";
  expect((await reconcileTalkieUser(world.sys, first, daemonA)).ok).toBe(true);
  expect((await createTalkieUser(world.sys, second, daemonA)).ok).toBe(true);
  const stale = await reconcileTalkieUser(world.sys, first, daemonA);
  expect(stale.ok).toBe(false);
  expect(world.users.get("walkie-talkie")?.uid).toBe(TALKIE_UID);
  expect(world.sys.ledger().talkieOwner(TALKIE_UID)?.generation).toBe(second);
});

test("a second daemon cannot reconcile or create over another daemon's uid", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-fence-")); roots.push(root);
  const world = fakeSeatWorld(root, join(root, "walkie"));
  world.sys.acl = () => "";
  expect((await createTalkieUser(world.sys, first, daemonA)).ok).toBe(true);
  const reconcile = await reconcileTalkieUser(world.sys, first, daemonB);
  const create = await createTalkieUser(world.sys, second, daemonB);
  expect(reconcile.ok).toBe(false);
  expect(create.ok).toBe(false);
  expect(create.why).toContain("another Walkie daemon");
  expect(world.users.get("walkie-talkie")?.uid).toBe(TALKIE_UID);
  expect(world.sys.ledger().talkieOwner(TALKIE_UID)?.instance).toBe(daemonA);
  expect((await reconcileTalkieUser(world.sys, first, daemonA)).ok).toBe(true);
  expect((await createTalkieUser(world.sys, second, daemonB)).ok).toBe(true);
  const queuedOld = await reconcileTalkieUser(world.sys, first, daemonA);
  expect(queuedOld.ok).toBe(false);
  expect(world.users.get("walkie-talkie")?.uid).toBe(TALKIE_UID);
  expect(world.sys.ledger().talkieOwner(TALKIE_UID)?.instance).toBe(daemonB);
});

test("a different socket's daemon refuses shell access while the first owns the uid", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-fence-")); roots.push(root);
  const world = fakeSeatWorld(root, join(root, "walkie"));
  world.sys.acl = () => "";
  const admin = async (verb: string, generation?: string, _signal?: AbortSignal, instance?: string): Promise<AdminResult> => {
    if (verb === "talkie-status") return talkieStatus(world.sys);
    if (verb === "talkie-create") return createTalkieUser(world.sys, generation as string, instance as string);
    if (verb === "talkie-reconcile") return reconcileTalkieUser(world.sys, generation as string, instance as string);
    return destroyTalkieUser(world.sys, generation as string);
  };
  const deps = { ready: () => true, privateHome: () => null, socketRoot: root, admin,
    existing: () => world.users.has("walkie-talkie"), monitor: () => ({ kill: () => undefined }) };
  const primary = new TalkieOsUser(join(root, "first.sock"), () => false, deps);
  const other = new TalkieOsUser(join(root, "other.sock"), () => false, deps);
  try {
    await primary.prepare();
    await expect(other.prepare()).rejects.toThrow("Another Walkie daemon owns shell access");
    expect(primary.active).toBe(true);
    expect(world.users.get("walkie-talkie")?.uid).toBe(TALKIE_UID);
  } finally { await primary.destroy(); }
});

test("an aborted prepare's queued reconcile cannot remove a later Start's uid", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-fence-")); roots.push(root);
  const world = fakeSeatWorld(root, join(root, "walkie"));
  world.sys.acl = () => "";
  let entered!: () => void;
  let release!: () => void;
  let staleDone!: (result: AdminResult) => void;
  const queued = new Promise<void>((resolve) => { release = resolve; });
  const called = new Promise<void>((resolve) => { entered = resolve; });
  const staleResult = new Promise<AdminResult>((resolve) => { staleDone = resolve; });
  const admin = async (verb: string, generation?: string, _signal?: AbortSignal, instance?: string): Promise<AdminResult> => {
    if (verb === "talkie-status") return talkieStatus(world.sys);
    if (verb === "talkie-reconcile") {
      entered();
      await queued; // The root helper survives the aborted sudo and reaches its lock later.
      const result = await reconcileTalkieUser(world.sys, generation as string, instance as string);
      staleDone(result);
      return result;
    }
    if (verb === "talkie-create") return createTalkieUser(world.sys, generation as string, instance as string);
    return destroyTalkieUser(world.sys, generation as string);
  };
  const deps = { ready: () => true, privateHome: () => null, socketRoot: root, admin,
    existing: () => world.users.has("walkie-talkie"), monitor: () => ({ kill: () => undefined }) };
  const socket = join(root, "daemon.sock");
  const cancelled = new TalkieOsUser(socket, () => false, deps);
  const newer = new TalkieOsUser(socket, () => false, { ...deps, admin: async (verb, generation, signal, instance) => {
    if (verb === "talkie-reconcile") return reconcileTalkieUser(world.sys, generation as string, instance as string);
    return admin(verb, generation, signal, instance);
  } });
  const controller = new AbortController();
  try {
    const old = cancelled.prepare(controller.signal);
    await called;
    controller.abort();
    await expect(old).rejects.toThrow("cancelled");
    await newer.prepare();
    release();
    expect((await staleResult).ok).toBe(false);
    expect(newer.active).toBe(true);
    expect(world.users.get("walkie-talkie")?.uid).toBe(TALKIE_UID);
    expect(world.sys.ledger().talkieOwner(TALKIE_UID)?.generation).toBe((newer as any).generation);
  } finally { release(); await newer.destroy(); }
});
