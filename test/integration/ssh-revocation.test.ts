// Revoking owner SSH (round 12): the durable local revocation comes first, the team receipt is sent after it with a
// short bound per peer, in parallel, and a failing close() or a concurrent revoke cannot undo any of it.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { consentSsh, echoServer, grantFor, isolatedTeam as sharedTeam, type IsolatedTeam } from "../helpers/ssh-team.ts";
import { decodeInvite } from "../../src/daemon/invite.ts";
import { readGrant } from "../../src/daemon/provision/grant.ts";
import { sshGateProblem, sshRevocationProblem } from "../../src/daemon/ssh/state.ts";
import { publishSshRevocation, RECEIPT_PEER_TIMEOUT_MS, teamSshRevoked } from "../../src/daemon/ssh/team-revocation.ts";
import { sshTunnelGrant } from "../../src/daemon/ssh/tunnel.ts";

setDefaultTimeout(30_000);
let sshd: Awaited<ReturnType<typeof echoServer>>;
beforeAll(async () => { sshd = await echoServer(); });
afterAll(async () => { await sshd?.close(); });
const isolatedTeam = (isolated: Cluster, name: string) => sharedTeam(isolated, name, sshd.port);

test("the revocation is already on disk while a slow authority still holds the team receipt", async () => {
  const isolated = new Cluster();
  let release = (): void => undefined;
  try {
    const team = await isolatedTeam(isolated, "ssh-order");
    const { worker } = team;
    await consentSsh(team);
    await waitFor(() => worker.d.sync.sshTeamConfirmed(), { what: "baseline confirmation" });
    const send = worker.d.client.sshRevoke.bind(worker.d.client);
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered = (): void => undefined;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    worker.d.client.sshRevoke = async (addr, packet, ms) => { entered(); await held; return send(addr, packet, ms); };
    const pending = worker.client().request("POST", "/v1/ssh/revoke", {}).then(() => "done", (err: Error) => `error: ${err.message}`);
    await reached;
    // What a daemon restarted right now would find: copy the home and run the real checks on the copy.
    const copy = mkdtempSync(join(tmpdir(), "walkie-revoke-copy-"));
    try {
      cpSync(worker.home, copy, { recursive: true, filter: (src) => !src.endsWith(".sock") });
      expect(existsSync(join(copy, "owner-ssh-revocation.json"))).toBe(true);
      expect(readGrant(copy)?.ssh_state).toBe("denied");
      expect(sshGateProblem(copy)).toBe("ssh_denied");
      expect(sshRevocationProblem(copy)).not.toBeNull();
    } finally { rmSync(copy, { recursive: true, force: true }); }
    release();
    expect(await pending).toBe("done");
  } finally { release(); await isolated.close(); }
});

test("an authority that never answers delays the revoke by one short bound, with the revocation saved", async () => {
  const isolated = new Cluster();
  try {
    const team = await isolatedTeam(isolated, "ssh-bound");
    const { worker } = team;
    const grant = await consentSsh(team);
    await waitFor(() => worker.d.sync.sshTeamConfirmed(), { what: "baseline confirmation" });
    worker.d.client.sshRevoke = () => new Promise<never>(() => undefined);
    const started = Date.now();
    await expect(worker.client().request("POST", "/v1/ssh/revoke", {})).rejects.toMatchObject({ code: "ssh_team_receipt_unavailable" });
    const took = Date.now() - started;
    expect(RECEIPT_PEER_TIMEOUT_MS).toBe(3_000);
    expect(took).toBeGreaterThanOrEqual(RECEIPT_PEER_TIMEOUT_MS - 200);
    expect(took).toBeLessThan(RECEIPT_PEER_TIMEOUT_MS + 2_000);
    expect(readGrant(worker.home)?.ssh_state).toBe("denied");
    expect(sshRevocationProblem(worker.home)).not.toBeNull();
    expect(readGrant(worker.home)?.created_at).toBe(grant.created_at);
  } finally { await isolated.close(); }
}, 40_000);

test("an authority target sends its receipt to all peers at once, each bounded", async () => {
  const isolated = new Cluster();
  try {
    const lead = await isolated.add({ name: "lead", login: "-", direct: true });
    const first = await isolated.add({ name: "first", login: "-", direct: true });
    const second = await isolated.add({ name: "second", login: "-", direct: true });
    await lead.client().init("ssh-parallel", "alex");
    for (const [node, handle] of [[first, "kira"], [second, "other"]] as const) {
      const invite = await lead.client().inviteCode(handle);
      if ("error" in decodeInvite(invite.code)) throw new Error("test invite malformed");
      expect((await node.client().join(invite.code)).admitted).toBe(true);
    }
    await waitFor(() => lead.d.core.roster.nodes.has(first.d.nodeId) && lead.d.core.roster.nodes.has(second.d.nodeId), { what: "peers admitted" });
    const bound = 800;
    const calls: string[] = [];
    lead.d.client.sshRevoke = (addr) => { calls.push(String(addr.pubkey)); return new Promise<never>(() => undefined); };
    const started = Date.now();
    await publishSshRevocation(lead.d.core, lead.d.client, grantFor(lead), bound);
    const took = Date.now() - started;
    expect(calls).toHaveLength(2);
    expect(took).toBeGreaterThanOrEqual(bound - 50);
    expect(took).toBeLessThan(bound * 1.9); // serial would take at least 2 x bound
  } finally { await isolated.close(); }
}, 15_000);

/**
 * Makes `node`'s peer client behave toward a released pre.10 / pre.10.1 peer: the receipt goes to a path that server
 * does not serve, so the answer is the real 404 `not_found` of a daemon without POST /peer/v1/ssh/revocation.
 * Returns how many receipt calls were made.
 */
function olderPeers(node: TestNode): { calls: () => number } {
  let calls = 0;
  const client = node.d.client as unknown as { call: (...args: unknown[]) => Promise<unknown> };
  node.d.client.sshRevoke = (addr, packet, ms) => {
    calls++;
    return client.call(addr, "POST", "/peer/v1/ssh/revocation-an-older-daemon-lacks", z.object({ event_id: z.string() }), packet, ms) as Promise<{ event_id: string }>;
  };
  return { calls: () => calls };
}

test("an authority that lacks the receipt route (404) is asked once, never retried, and the person is told to update it", async () => {
  const isolated = new Cluster();
  try {
    const team = await isolatedTeam(isolated, "ssh-old-authority");
    const { worker } = team;
    const grant = await consentSsh(team);
    await waitFor(() => worker.d.sync.sshTeamConfirmed(), { what: "baseline confirmation" });
    const old = olderPeers(worker);
    const err = await worker.client().request("POST", "/v1/ssh/revoke", {}).then(() => null, (e: { code?: string; message?: string }) => e);
    expect(err).toMatchObject({ code: "ssh_team_receipt_unavailable" });
    expect(err?.message).toContain("older Walkie");
    expect(err?.message).toContain("update the roster authority");
    expect(old.calls()).toBe(1);
    // No retry loop behind it: several sync rounds later it is still the one call.
    await Bun.sleep(2_500);
    expect(old.calls()).toBe(1);
    // The revocation itself is saved here, whatever the authority could not hold.
    expect(readGrant(worker.home)?.ssh_state).toBe("denied");
    expect(readGrant(worker.home)?.created_at).toBe(grant.created_at);
    expect(sshRevocationProblem(worker.home)).not.toBeNull();
    expect(sshGateProblem(worker.home)).toBe("ssh_denied");
  } finally { await isolated.close(); }
}, 40_000);

test("an authority target keeps its own receipt when every older peer answers 404: one call each, no error", async () => {
  const isolated = new Cluster();
  try {
    const lead = await isolated.add({ name: "lead", login: "-", direct: true });
    const first = await isolated.add({ name: "first", login: "-", direct: true });
    const second = await isolated.add({ name: "second", login: "-", direct: true });
    await lead.client().init("ssh-old-peers", "alex");
    for (const [node, handle] of [[first, "kira"], [second, "other"]] as const) {
      const invite = await lead.client().inviteCode(handle);
      if ("error" in decodeInvite(invite.code)) throw new Error("test invite malformed");
      expect((await node.client().join(invite.code)).admitted).toBe(true);
    }
    await waitFor(() => lead.d.core.roster.nodes.has(first.d.nodeId) && lead.d.core.roster.nodes.has(second.d.nodeId), { what: "peers admitted" });
    const old = olderPeers(lead);
    await publishSshRevocation(lead.d.core, lead.d.client, grantFor(lead));
    expect(old.calls()).toBe(2);
    // If its own log could not take the receipt either (here: a grant too old to be stored), the same two answers read
    // as "no machine asked can hold it", not as a fault, and each peer was still asked only once more.
    await expect(publishSshRevocation(lead.d.core, lead.d.client, grantFor(lead, lead, 1))).rejects.toThrow("older Walkie");
    expect(old.calls()).toBe(4);
  } finally { await isolated.close(); }
}, 30_000);

/** A tunnel end that is live in the daemon and whose close() throws the first time, as a broken stream might. */
function liveEndWithBrokenClose(team: IsolatedTeam): { release: () => void } {
  let closes = 0;
  let finish = (): void => undefined;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const end = { read: () => done.then(() => null), write: async () => undefined,
    close: () => { if (closes++ === 0) throw new Error("injected: close failed"); finish(); }, done };
  // A stream whose close failed can outlive the daemon; its own cleanup then meets a closed store, which is not under test.
  void sshTunnelGrant(team.worker.d.core, team.lead.d.nodeId, sshd.port, team.home, { caller: "person" }).accept(end as never).catch(() => undefined);
  return { release: finish };
}

test("a stream whose close() throws cannot abort a revocation", async () => {
  const isolated = new Cluster();
  let live: { release: () => void } | null = null;
  try {
    const team = await isolatedTeam(isolated, "ssh-close-revoke");
    const { worker } = team;
    const grant = await consentSsh(team);
    await waitFor(() => worker.d.sync.sshTeamConfirmed(), { what: "baseline confirmation" });
    live = liveEndWithBrokenClose(team);
    await Bun.sleep(200);
    await worker.client().request("POST", "/v1/ssh/revoke", {});
    expect(readGrant(worker.home)?.ssh_state).toBe("denied");
    expect(existsSync(join(worker.home, "owner-ssh-revocation.json"))).toBe(true);
    await waitFor(() => teamSshRevoked(worker.d.core, grant), { what: "the team receipt" });
  } finally { live?.release(); await isolated.close(); }
});

test("a stream whose close() throws cannot abort turning remote admin off", async () => {
  const isolated = new Cluster();
  let live: { release: () => void } | null = null;
  try {
    const team = await isolatedTeam(isolated, "ssh-close-switch");
    const { worker } = team;
    await consentSsh(team);
    await waitFor(() => worker.d.sync.sshTeamConfirmed(), { what: "baseline confirmation" });
    live = liveEndWithBrokenClose(team);
    await Bun.sleep(200);
    expect((await worker.client().adminSwitches({ remote_admin: false })).remote_admin).toBe(false);
    expect((await worker.client().adminSwitches({ remote_admin: true })).remote_admin).toBe(true);
  } finally { live?.release(); await isolated.close(); }
});

test("a stream whose close() throws cannot abort the daemon's shutdown", async () => {
  const isolated = new Cluster();
  let live: { release: () => void } | null = null;
  try {
    const team = await isolatedTeam(isolated, "ssh-close-stop");
    const { worker } = team;
    await consentSsh(team);
    await waitFor(() => worker.d.sync.sshTeamConfirmed(), { what: "baseline confirmation" });
    live = liveEndWithBrokenClose(team);
    await Bun.sleep(200);
    await worker.stop();
    expect(worker.daemon).toBeNull();
  } finally { live?.release(); await isolated.close(); }
});

test("a provision revoke that runs while ssh revoke waits on the authority leaves one clean revocation", async () => {
  const isolated = new Cluster();
  let release = (): void => undefined;
  try {
    const team = await isolatedTeam(isolated, "ssh-race");
    const { worker } = team;
    await consentSsh(team);
    await waitFor(() => worker.d.sync.sshTeamConfirmed(), { what: "baseline confirmation" });
    const send = worker.d.client.sshRevoke.bind(worker.d.client);
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered = (): void => undefined;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    worker.d.client.sshRevoke = async (addr, packet, ms) => { entered(); await held; return send(addr, packet, ms); };
    const first = worker.client().request("POST", "/v1/ssh/revoke", {}).then(() => "ok", (err: Error) => `error: ${err.message}`);
    await reached;
    await worker.client().request("POST", "/v1/provision/revoke", {}); // the second command finishes while the first waits
    release();
    expect(await first).toBe("ok");
    expect(readGrant(worker.home)?.revoked_at).toBeTruthy();
    expect(sshRevocationProblem(worker.home)).toBe("revoked"); // not "grant state write"
  } finally { release(); await isolated.close(); }
});
