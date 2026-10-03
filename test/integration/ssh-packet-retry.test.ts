// WALK-67 lane 8 (review finding F6): the one-use owner SSH packet is spent only when nothing that can fail before the
// owner key is written still can. The join page and the desktop app now send the packet, so a refusal before the key
// (a missing root marker, a failed snapshot, a failed gate or grant write) must leave the same link usable, while a
// grant that really installed the key still refuses a replay (owner_ssh_spent). Real daemons in a Cluster, a loopback
// echo server for sshd, a scratch SSH home: nothing on the host.
import { afterAll, beforeAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Cluster } from "../helpers/cluster.ts";
import { echoServer, isolatedTeam, profile, publicKey, type IsolatedTeam } from "../helpers/ssh-team.ts";
import { consentText } from "../../src/daemon/provision/consent.ts";
import { readGrant } from "../../src/daemon/provision/grant.ts";
import * as realMarker from "../../src/daemon/provision/root-marker.ts";
import * as realEnrollment from "../../src/daemon/ssh/enrollment.ts";
import { hasOwnerKey } from "../../src/daemon/ssh/authorized-keys.ts";
import { mintOwnerSshGrant, type OwnerSshGrant } from "../../src/daemon/ssh/grant.ts";

setDefaultTimeout(90_000);
let sshd: Awaited<ReturnType<typeof echoServer>>;
beforeAll(async () => { sshd = await echoServer(); });
afterAll(async () => { await sshd?.close(); });

// What the stand-in enrollment root and installer do right now: the real ones, unless a test says otherwise. The real
// functions are captured BEFORE the modules are mocked: mock.module rewrites the module's exports in place, so a wrapper
// that called `realMarker.requireEnrollmentRoot(...)` would call itself (forever: it is a tail call).
let markerMissing = false;
const inject: { at: realEnrollment.InstallStep | null; dirtyRollback: boolean } = { at: null, dirtyRollback: false };
const realRequireMarker = realMarker.requireEnrollmentRoot;
const realInstall = realEnrollment.installSshGrant;
mock.module("../../src/daemon/provision/root-marker.ts", () => ({
  ...realMarker,
  requireEnrollmentRoot: (home: string) => {
    if (markerMissing) throw new Error("root enrollment marker is required before consent is recorded");
    return realRequireMarker(home);
  },
}));
mock.module("../../src/daemon/ssh/enrollment.ts", () => ({
  ...realEnrollment,
  installSshGrant: (...args: Parameters<typeof realInstall>) => {
    // This module mock remains installed for later files; preserve their callbacks and dependencies.
    const [home, sshHome, input, afterWrite, revoke, ...dependencies] = args;
    return realInstall(home, sshHome, input, inject.at === null ? afterWrite : (step) => {
      afterWrite?.(step);
      if (inject.at === step) throw new Error(`injected failure at ${step}`);
    }, inject.dirtyRollback ? () => { throw new Error("injected revoke failure"); } : revoke, ...dependencies);
  },
}));

function reset(): void { markerMissing = false; inject.at = null; inject.dirtyRollback = false; }

interface Scenario { t: IsolatedTeam; packet: OwnerSshGrant; body: Record<string, unknown>; post: () => Promise<string>; usedFile: string; spent: () => boolean }

/** One team, one packet for the machine's own invite, and a way to post the one consent that carries it. */
async function scenario(isolated: Cluster, name: string): Promise<Scenario> {
  const t = await isolatedTeam(isolated, name, sshd.port);
  const recipient = t.worker.d.core.me()?.handle as string;
  const packet = mintOwnerSshGrant(t.lead.d.core.keys, { team_id: t.lead.d.core.teamId as string, owner_handle: "alex", recipient,
    invite_id: t.inviteId, public_key: publicKey(), expires_at: Date.now() + 120_000 });
  const body = { owner_node: t.lead.d.nodeId, launchers: ["@alex"], seat_cap: 2, profiles: [profile], company_mode: true, owner_ssh: packet,
    consent_version: 1, consented: true, consent_text: consentText("alex", ["@alex"], 2, [profile], undefined, packet),
    confirmation: { surface: "desktop", typed_phrase: "yes" } };
  const usedFile = join(t.worker.home, "owner-ssh-packets-used.json");
  const fingerprint = createHash("sha256").update(packet.signature).digest("hex");
  return { t, packet, body, usedFile,
    post: () => t.worker.client().request("POST", "/v1/provision/grant", body).then(() => "granted", (e: { status?: number; code?: string }) => `${e.status} ${e.code}`),
    spent: () => existsSync(usedFile) && (JSON.parse(readFileSync(usedFile, "utf8")) as string[]).includes(fingerprint) };
}
const keyPresent = (s: Scenario): boolean => hasOwnerKey(s.t.home, s.packet.team_id, s.packet.owner_handle, s.packet.public_key);

test("a missing root marker answers 409, spends nothing, and the same packet succeeds once the marker exists", async () => {
  const isolated = new Cluster();
  try {
    reset();
    const s = await scenario(isolated, "retry-marker");
    markerMissing = true;
    expect(await s.post()).toBe("409 root_marker_required");
    expect([s.spent(), keyPresent(s), readGrant(s.t.worker.home)]).toEqual([false, false, null]);
    expect(await s.post()).toBe("409 root_marker_required"); // still not spent after a second refusal
    markerMissing = false; // the person installs the marker and runs the same link again
    expect(await s.post()).toBe("granted");
    expect(readGrant(s.t.worker.home)?.ssh_state).toBe("active");
    expect([keyPresent(s), s.spent()]).toEqual([true, true]);
  } finally { reset(); await isolated.close(); }
});

test("a grant that installed the key still refuses a replay: after a revoke the same packet is owner_ssh_spent", async () => {
  const isolated = new Cluster();
  try {
    reset();
    const s = await scenario(isolated, "retry-spent");
    expect(await s.post()).toBe("granted");
    expect(await s.post()).toBe("409 grant_exists"); // a second post while the grant stands
    await s.t.worker.client().provisionRevoke();
    expect(keyPresent(s)).toBe(false);
    expect(await s.post()).toBe("403 owner_ssh_spent"); // the replay of a used link
    expect(s.spent()).toBe(true);
  } finally { reset(); await isolated.close(); }
});

test("a snapshot failure before any change leaves the packet usable", async () => {
  const isolated = new Cluster();
  try {
    reset();
    const s = await scenario(isolated, "retry-snapshot");
    const keys = join(s.t.home, ".ssh", "authorized_keys");
    mkdirSync(keys, { recursive: true }); // authorized_keys is a directory: Walkie refuses to touch it
    expect((await s.post()).startsWith("409 owner_key_install_failed")).toBe(true);
    expect([s.spent(), keyPresent(s)]).toEqual([false, false]);
    rmSync(keys, { recursive: true, force: true });
    expect(await s.post()).toBe("granted");
  } finally { reset(); await isolated.close(); }
});

for (const at of ["gate_pending", "grant_pending", "record_prepared", "before_rename"] as const) {
  test(`an install that fails at ${at}, before the key is written, rolls back and leaves the packet usable`, async () => {
    const isolated = new Cluster();
    try {
      reset();
      const s = await scenario(isolated, `retry-${at}`);
      inject.at = at;
      expect((await s.post()).split(" ").slice(0, 2).join(" ")).toBe("409 owner_key_install_failed");
      expect([s.spent(), keyPresent(s)]).toEqual([false, false]);
      inject.at = null;
      expect(await s.post()).toBe("granted");
      expect([readGrant(s.t.worker.home)?.ssh_state, keyPresent(s)]).toEqual(["active", true]);
    } finally { reset(); await isolated.close(); }
  });
}

test("a failure after the key was written, completely rolled back, also leaves the packet usable", async () => {
  const isolated = new Cluster();
  try {
    reset();
    const s = await scenario(isolated, "retry-rolled-back");
    inject.at = "before_grant_active";
    expect((await s.post()).startsWith("409 owner_key_install_failed")).toBe(true);
    expect(keyPresent(s)).toBe(false); // the rollback removed it
    expect(s.spent()).toBe(false);
    inject.at = null;
    expect(await s.post()).toBe("granted");
    expect(keyPresent(s)).toBe(true);
  } finally { reset(); await isolated.close(); }
});

test("a rollback that did not finish keeps the packet spent: the state is unknown, so it is not given back", async () => {
  const isolated = new Cluster();
  try {
    reset();
    const s = await scenario(isolated, "retry-dirty");
    inject.at = "before_grant_active";
    inject.dirtyRollback = true;
    const answer = await s.post();
    expect(answer.startsWith("409 owner_key_install_failed")).toBe(true);
    expect(s.spent()).toBe(true);
  } finally { reset(); await isolated.close(); }
});
