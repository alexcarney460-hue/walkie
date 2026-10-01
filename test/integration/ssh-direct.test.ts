import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { connect, createServer, type Server } from "node:net";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { consentSsh, everyWriteFails, failWrite, isolatedTeam as sharedTeam, profile, publicKey } from "../helpers/ssh-team.ts";
import { mintOwnerSshGrant } from "../../src/daemon/ssh/grant.ts";
import { consentText } from "../../src/daemon/provision/consent.ts";
import { PeerCallError } from "../../src/daemon/peer-client.ts";
import { TunnelRefused } from "../../src/daemon/direct/net.ts";
import { decodeInvite } from "../../src/daemon/invite.ts";
import { runAsPerson } from "../helpers/person-cli.ts";
import { classifySshCaller } from "../../src/daemon/ssh/caller.ts";
import { sshBridgePath } from "../../src/daemon/ssh/bridge.ts";
import { readProcessStartTime, readProcessTable } from "../../src/cli/agent-detect.ts";
import { readGrant, type Grant } from "../../src/daemon/provision/grant.ts";
import { denyAndCloseSsh, revokeSshAccess } from "../../src/daemon/ssh/revoke.ts";
import { REVOCATION_UNSAVED_MESSAGE, setSshGate } from "../../src/daemon/ssh/state.ts";
import { publishSshRevocation, signSshRevocation, teamSshRevoked } from "../../src/daemon/ssh/team-revocation.ts";
import { sshTunnelProblem } from "../../src/daemon/ssh/tunnel.ts";

setDefaultTimeout(60_000);
let cluster: Cluster;
let owner: TestNode;
let target: TestNode;
let outsider: TestNode;
let second: TestNode;
let secondInviteId = "";
let fake: Server;
let port = 0;
let sshHome = "";
let targetInviteId = "";
let signedGrant: ReturnType<typeof mintOwnerSshGrant>;
const isolatedTeam = (isolated: Cluster, teamName: string) => sharedTeam(isolated, teamName, port);

beforeAll(async () => {
  fake = createServer((socket) => { socket.on("data", (bytes) => socket.write(bytes)); });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  port = (fake.address() as { port: number }).port;
  cluster = new Cluster();
  sshHome = join(cluster.root, "ssh-user");
  mkdirSync(sshHome);
  owner = await cluster.add({ name: "owner", login: "-", hostname: "owner-mac", direct: true });
  target = await cluster.add({ name: "target", login: "-", hostname: "target-mac", direct: true, sshUserHome: sshHome, sshPort: port });
  outsider = await cluster.add({ name: "outsider", login: "-", hostname: "outsider-mac", direct: true });
  await owner.client().init("ssh-team", "alex");
  for (const [node, handle] of [[target, "kira"], [outsider, "other"]] as const) {
    const invite = await owner.client().inviteCode(handle);
    if (handle === "kira") {
      const decoded = decodeInvite(invite.code);
      if ("error" in decoded) throw new Error("test invite malformed");
      targetInviteId = decoded.id;
    }
    expect((await node.client().join(invite.code)).admitted).toBe(true);
  }
  await waitFor(() => target.d.core.roster.nodes.has(owner.d.nodeId) && target.d.core.roster.nodes.has(outsider.d.nodeId)
    && target.d.core.roster.invites?.has(targetInviteId), { what: "SSH roster sync" });
  const signed = mintOwnerSshGrant(owner.d.core.keys, { team_id: owner.d.core.teamId as string, owner_handle: "alex", recipient: "kira",
    invite_id: targetInviteId, public_key: publicKey(), expires_at: Date.now() + 60_000 });
  signedGrant = signed;
  await target.client().request("POST", "/v1/provision/grant", { owner_node: owner.d.nodeId, launchers: ["@alex"], seat_cap: 2,
    profiles: [profile], company_mode: true, owner_ssh: signed, consent_version: 1, consented: true,
    consent_text: consentText("alex", ["@alex"], 2, [profile], undefined, signed), confirmation: { surface: "desktop", typed_phrase: "yes" } });
  second = await cluster.add({ name: "second", login: "-", hostname: "second-mac", direct: true, sshUserHome: sshHome, sshPort: port });
  const secondInvite = await owner.client().inviteCode("kira");
  const decoded = decodeInvite(secondInvite.code);
  if ("error" in decoded) throw new Error("test invite malformed");
  secondInviteId = decoded.id;
  expect((await second.client().join(secondInvite.code)).admitted).toBe(true);
  await waitFor(() => target.d.core.roster.nodes.has(second.d.nodeId), { what: "same-recipient roster sync" });
});


afterAll(async () => {
  await cluster?.close();
  await new Promise<void>((resolve) => fake?.close(() => resolve()));
});

const address = () => ({ ip: "", port: 7458, pubkey: target.d.core.keys.pubkey });

test("owner reaches a fake loopback sshd over Direct; unrelated member is refused", async () => {
  const info = await owner.client().request<{ user: string }>("GET", "/v1/ssh/target?machine=target-mac");
  expect(info.user).toBe(userInfo().username);
  const end = await owner.d.client.tunnelTo(address(), "/peer/v1/ssh");
  await end.write(Buffer.from("hello"));
  expect(Buffer.from((await end.read()) as Uint8Array).toString()).toBe("hello");
  end.close();
  await end.done;
  try { await outsider.d.client.tunnelTo(address(), "/peer/v1/ssh"); throw new Error("expected refusal"); }
  catch (err) { expect((err as PeerCallError).code).toBe("not_authorized"); }
  await waitFor(() => readFileSync(join(target.home, "admin-audit.jsonl"), "utf8").includes("bytes_in=5"), { what: "SSH audit" });
  expect(readFileSync(join(target.home, "admin-audit.jsonl"), "utf8")).not.toContain("hello");
});

test("a tunnel that presents an invalid peer signature is refused before the SSH gate, as for every peer route", async () => {
  const direct = owner.d.client.transports.direct;
  if (!direct?.openTunnel) throw new Error("the test owner has no Direct transport");
  const headers = { "X-Walkie-Node": owner.d.nodeId, "X-Walkie-Team": owner.d.core.teamId as string, "X-Walkie-Sig": "invalid" };
  const refused = await direct.openTunnel(address(), "/peer/v1/ssh", headers, AbortSignal.timeout(10_000)).then(() => null, (err: unknown) => err);
  expect(refused).toBeInstanceOf(TunnelRefused);
  expect((refused as TunnelRefused).status).toBe(403);
  expect(JSON.parse((refused as TunnelRefused).body)).toMatchObject({ error: { code: "bad_peer_sig" } });
});

test("an older authority without SSH revocation receipts cannot confirm the gate", async () => {
  const state = target.d.sync.peerState(owner.d.nodeId);
  if (!state) throw new Error("authority sync missing");
  const prior = state.sshRevocationCap;
  state.sshRevocationCap = false;
  try { expect(sshTunnelProblem(target.d.core, owner.d.nodeId, sshHome)).toBe("ssh_team_waiting"); }
  finally { state.sshRevocationCap = prior; }
});

test("enrolled owner SSH survives daemon restart and refuses an unreadable gate", async () => {
  await target.restart();
  await waitFor(() => target.d.sync.sshTeamConfirmed(), { what: "SSH team confirmation after restart" });
  const end = await owner.d.client.tunnelTo(address(), "/peer/v1/ssh");
  await end.write(Buffer.from("restart"));
  expect(Buffer.from((await end.read()) as Uint8Array).toString()).toBe("restart");
  end.close();
  await end.done;
  const gate = join(target.home, "owner-ssh-gate.json");
  chmodSync(gate, 0o644);
  try {
    await expect(owner.d.client.tunnelTo(address(), "/peer/v1/ssh"))
      .rejects.toMatchObject({ code: "ssh_gate_invalid" });
  } finally { chmodSync(gate, 0o600); }
});

test("a forged caller header is reported by the authenticated node and grants no access", async () => {
  const before = readFileSync(join(target.home, "admin-audit.jsonl"), "utf8").length;
  const end = await owner.d.client.tunnelTo(address(), "/peer/v1/ssh", { caller: "codex" });
  end.close();
  await end.done;
  const entries = readFileSync(join(target.home, "admin-audit.jsonl"), "utf8").slice(before)
    .trim().split("\n").map((line) => JSON.parse(line) as { actor: string; action: string });
  expect(entries[0]?.actor).toBe(`@alex/${owner.d.nodeId}`);
  expect(entries[0]?.action).toContain("opened from owner-mac (owner alex); reported caller: agent codex (reported by owner-mac)");
  await expect(outsider.d.client.tunnelTo(address(), "/peer/v1/ssh", { caller: "person" }))
    .rejects.toMatchObject({ code: "not_authorized" });
});

test("a different node of the machine person cannot relay an owner SSH session", async () => {
  await expect(second.d.client.tunnelTo(address(), "/peer/v1/ssh"))
    .rejects.toMatchObject({ code: "not_authorized" });
});

test("walkie tunnel ssh bridges stdin and stdout through the daemon socket", async () => {
  const cli = join(import.meta.dir, "../../src/cli/main.ts");
  const child = Bun.spawn([process.execPath, cli, "tunnel", "ssh", "target-mac"], {
    env: { PATH: process.env.PATH ?? "", WALKIE_HOME: owner.home, WALKIE_SOCKET: owner.socket },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write("bridge-check");
  const reader = child.stdout.getReader();
  const output = await Promise.race([reader.read(), Bun.sleep(2000).then(() => { throw new Error("bridge gave no response"); })]);
  expect(Buffer.from(output.value ?? []).toString()).toBe("bridge-check");
  child.kill();
  await child.exited;
});

test("a person's WALKIE_AGENT spoof is logged as a source-reported claim", async () => {
  const before = readFileSync(join(target.home, "admin-audit.jsonl"), "utf8").length;
  const cli = join(import.meta.dir, "../../src/cli/main.ts");
  const result = await runAsPerson([process.execPath, cli, "tunnel", "ssh", "target-mac"],
    { PATH: process.env.PATH ?? "", WALKIE_HOME: owner.home, WALKIE_SOCKET: owner.socket, WALKIE_AGENT: "codex" });
  expect(result.code).toBe(0);
  const audit = readFileSync(join(target.home, "admin-audit.jsonl"), "utf8").slice(before);
  expect(audit).toContain(`@alex/${owner.d.nodeId}`);
  expect(audit).toContain("reported claim: agent codex (reported by owner-mac)");
});

test("a shell wrapper named like an agent creates no caller claim", async () => {
  const wrapper = join(cluster.root, "codex");
  writeFileSync(wrapper, '#!/bin/sh\n"$@"\n', { mode: 0o700 });
  const before = readFileSync(join(target.home, "admin-audit.jsonl"), "utf8").length;
  const direct = `const { connect } = require("node:net");
    const s = connect(process.env.BRIDGE_SOCKET);
    s.on("connect", () => s.write('{"machine":"target-mac"}\\n'));
    s.on("data", (part) => { if (part.toString().startsWith("OK\\n")) s.write("marker-free"); else { process.stdout.write(part); s.end(); } });`;
  const child = Bun.spawn([wrapper, process.execPath, "-e", direct], {
    env: { PATH: process.env.PATH ?? "", BRIDGE_SOCKET: sshBridgePath(owner.home) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const output = await Promise.race([child.stdout.getReader().read(), Bun.sleep(2000).then(() => { throw new Error("bridge gave no response"); })]);
  expect(Buffer.from(output.value ?? []).toString()).toBe("marker-free");
  child.kill();
  await child.exited;
  const audit = readFileSync(join(target.home, "admin-audit.jsonl"), "utf8").slice(before);
  expect(audit).toContain(`@alex/${owner.d.nodeId}`);
  expect(audit).toContain("reported caller:");
  expect(audit).not.toContain("reported claim:");
});

test("a direct bridge socket claim cannot replace observed caller attribution", async () => {
  const expected = classifySshCaller(process.pid, readProcessTable(), undefined, readProcessStartTime(process.pid)).caller;
  const before = readFileSync(join(target.home, "admin-audit.jsonl"), "utf8").length;
  const socket = connect(sshBridgePath(owner.home));
  const response = await new Promise<string>((resolve, reject) => {
    socket.once("connect", () => socket.write('{"machine":"target-mac","agent":"fake-other-agent"}\n'));
    socket.once("data", (part) => resolve(part.toString()));
    socket.once("error", reject);
  });
  expect(response).toStartWith("OK\n");
  socket.destroy();
  const audit = readFileSync(join(target.home, "admin-audit.jsonl"), "utf8").slice(before);
  expect(audit).toContain(`@alex/${owner.d.nodeId}`);
  expect(audit).toContain(`reported caller: ${expected === "person" || expected === "unverified caller" ? expected : `agent ${expected}`} (reported by owner-mac)`);
  expect(audit).toContain("reported claim: agent fake-other-agent (reported by owner-mac)");
  expect(audit).not.toContain("reported caller: agent fake-other-agent");
});

test("agent SSH session names its observed caller and claim in audit and one person summary", async () => {
  const priorPosts = await target.client().events({ channel: "general", kinds: "msg.post", limit: 200 });
  const priorIds = new Set(priorPosts.events.map((event) => event.id));
  const cli = join(import.meta.dir, "../../src/cli/main.ts");
  const child = Bun.spawn([process.execPath, cli, "tunnel", "ssh", "target-mac"], {
    env: { PATH: process.env.PATH ?? "", WALKIE_HOME: owner.home, WALKIE_SOCKET: owner.socket, WALKIE_AGENT: "codex" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write("agent-check");
  const reader = child.stdout.getReader();
  const output = await Promise.race([reader.read(), Bun.sleep(2000).then(() => { throw new Error("agent bridge gave no response"); })]);
  expect(Buffer.from(output.value ?? []).toString()).toBe("agent-check");
  const caller = classifySshCaller(child.pid, readProcessTable(), undefined, readProcessStartTime(child.pid)).caller;
  child.kill();
  await child.exited;
  const audit = readFileSync(join(target.home, "admin-audit.jsonl"), "utf8");
  expect(audit).toContain(`@alex/${owner.d.nodeId}`);
  const reported = caller === "person" || caller === "unverified caller" ? caller : `agent ${caller}`;
  expect(audit).toContain(`reported caller: ${reported} (reported by owner-mac)`);
  expect(audit).toContain("reported claim: agent codex (reported by owner-mac)");
  const summaries = await waitFor(async () => {
    const posts = await target.client().events({ channel: "general", kinds: "msg.post", limit: 200 });
    const matches = posts.events.filter((event) => !priorIds.has(event.id) && event.author.agent === "walkie-admin" &&
      String((event.body as { text?: string }).text).includes(`[ssh] opened from owner-mac (owner alex); reported caller: ${reported} (reported by owner-mac); reported claim: agent codex`));
    return matches.length ? matches : null;
  }, { what: "SSH summary after tunnel close" });
  expect(summaries).toHaveLength(1);
  expect((summaries[0]?.body as { mentions?: string[] }).mentions).toContain("@kira");
});

test("an old target's missing SSH info route reports target_outdated", async () => {
  const original = owner.d.client.sshInfo.bind(owner.d.client);
  owner.d.client.sshInfo = async () => { throw new PeerCallError(404, "not_found", "not found"); };
  try {
    await expect(owner.client().request("GET", "/v1/ssh/target?machine=target-mac")).rejects.toMatchObject({ code: "target_outdated" });
  } finally { owner.d.client.sshInfo = original; }
});

test("accepted SSH open is durable before bridging and audit failure refuses a new open", async () => {
  const end = await owner.d.client.tunnelTo(address(), "/peer/v1/ssh");
  const audit = join(target.home, "admin-audit.jsonl");
  const entries = readFileSync(audit, "utf8");
  expect(entries).toContain("SSH tunnel opened");
  end.close();
  await end.done;
  const saved = `${audit}.saved`;
  renameSync(audit, saved);
  mkdirSync(audit);
  try {
    await expect(owner.d.client.tunnelTo(address(), "/peer/v1/ssh"))
      .rejects.toMatchObject({ code: "audit_unavailable" });
  } finally {
    rmdirSync(audit);
    renameSync(saved, audit);
  }
});

test("remote admin off closes a live tunnel; revocation refuses new opens", async () => {
  const end = await owner.d.client.tunnelTo(address(), "/peer/v1/ssh");
  await end.write(Buffer.from("live"));
  expect(Buffer.from((await end.read()) as Uint8Array).toString()).toBe("live");
  await target.client().adminSwitches({ remote_admin: false });
  expect(await Promise.race([end.read(), Bun.sleep(2000).then(() => { throw new Error("live tunnel did not close"); })])).toBeNull();
  try { await owner.d.client.tunnelTo(address(), "/peer/v1/ssh"); throw new Error("expected refusal"); }
  catch (err) { expect((err as PeerCallError).code).toBe("remote_admin_off"); }
  await target.client().adminSwitches({ remote_admin: true });
  target.d.core.limiter.refund(`ssh:${owner.d.nodeId}`, { capacity: 10, perSecond: 1 / 6 }, 1);
  const live = await owner.d.client.tunnelTo(address(), "/peer/v1/ssh");
  const grant = readGrant(target.home);
  if (!grant?.owner_ssh) throw new Error("SSH grant missing in fixture");
  let attempts = 0;
  expect(() => revokeSshAccess(target.d.core, grant, undefined, () => {
    attempts++;
    throw new Error("injected deny write failure");
  })).toThrow("injected deny write failure");
  expect(attempts).toBe(2);
  expect(await Promise.race([live.read(), Bun.sleep(2000).then(() => { throw new Error("live tunnel did not close after deny write failure"); })])).toBeNull();
  await target.restart();
  await expect(owner.d.client.tunnelTo(address(), "/peer/v1/ssh"))
    .rejects.toMatchObject({ code: "ssh_denied" });
  let retry = 0;
  denyAndCloseSsh(target.d.core, (home, state) => {
    if (++retry === 1) throw new Error("first deny write failed");
    setSshGate(home, state);
  });
  expect(retry).toBe(2);
  expect(() => revokeSshAccess(target.d.core, grant, () => { throw new Error("injected key removal failure"); }))
    .toThrow("injected key removal failure");
  const status = await target.client().request<{ owner_key_present: boolean; reason: string }>("GET", "/v1/ssh/status");
  expect(status.owner_key_present).toBe(false);
  expect(status.reason).toBe("ssh_denied");
  await expect(owner.d.client.tunnelTo(address(), "/peer/v1/ssh"))
    .rejects.toMatchObject({ code: "ssh_denied" });
  await target.client().request("POST", "/v1/ssh/revoke", {});
  try { await owner.d.client.tunnelTo(address(), "/peer/v1/ssh"); throw new Error("expected refusal"); }
  catch (err) { expect((err as PeerCallError).code).toBe("ssh_denied"); }
  await target.client().request("POST", "/v1/provision/revoke", {});
  try { await owner.d.client.tunnelTo(address(), "/peer/v1/ssh"); throw new Error("expected refusal"); }
  catch (err) { expect((err as PeerCallError).code).toBe("grant_revoked"); }
});

test("a spent SSH packet cannot be used after grant revocation or on another node", async () => {
  await target.client().request("POST", "/v1/provision/revoke", {});
  const body = (packet: typeof signedGrant) => ({ owner_node: owner.d.nodeId, launchers: ["@alex"], seat_cap: 2,
    profiles: [profile], company_mode: true, owner_ssh: packet, consent_version: 1, consented: true,
    consent_text: consentText("alex", ["@alex"], 2, [profile], undefined, packet), confirmation: { surface: "desktop", typed_phrase: "yes" } });
  await expect(target.client().request("POST", "/v1/provision/grant", body(signedGrant)))
    .rejects.toMatchObject({ code: "owner_ssh_spent" });
  await waitFor(() => second.d.core.roster.invites?.has(targetInviteId), { what: "second roster sync" });
  await expect(second.client().request("POST", "/v1/provision/grant", body(signedGrant)))
    .rejects.toMatchObject({ code: "owner_ssh_invite" });
  const another = mintOwnerSshGrant(owner.d.core.keys, { team_id: owner.d.core.teamId as string, owner_handle: "alex", recipient: "kira",
    invite_id: secondInviteId, public_key: publicKey(), expires_at: Date.now() + 60_000 });
  await expect(target.client().request("POST", "/v1/provision/grant", body(another)))
    .rejects.toMatchObject({ code: "owner_ssh_invite" });
});

test("peer-held signed revocation denies SSH after all local revocation writes fail and the daemon restarts", async () => {
  const isolated = new Cluster();
  try {
    const home = join(isolated.root, "person-ssh");
    mkdirSync(home);
    const lead = await isolated.add({ name: "lead", login: "-", direct: true });
    const worker = await isolated.add({ name: "worker", login: "-", direct: true, sshUserHome: home, sshPort: port });
    await lead.client().init("ssh-revoke-team", "alex");
    const invite = await lead.client().inviteCode("kira");
    const decoded = decodeInvite(invite.code);
    if ("error" in decoded) throw new Error("test invite malformed");
    expect((await worker.client().join(invite.code)).admitted).toBe(true);
    await waitFor(() => worker.d.core.roster.nodes.has(lead.d.nodeId) && worker.d.core.roster.invites?.has(decoded.id),
      { what: "worker roster before SSH grant" });
    const packet = mintOwnerSshGrant(lead.d.core.keys, { team_id: lead.d.core.teamId as string, owner_handle: "alex",
      recipient: "kira", invite_id: decoded.id, public_key: publicKey(), expires_at: Date.now() + 60_000 });
    await worker.client().request("POST", "/v1/provision/grant", { owner_node: lead.d.nodeId, launchers: ["@alex"], seat_cap: 2,
      profiles: [profile], company_mode: true, owner_ssh: packet, consent_version: 1, consented: true,
      consent_text: consentText("alex", ["@alex"], 2, [profile], undefined, packet), confirmation: { surface: "desktop", typed_phrase: "yes" } });
    const grant = readGrant(worker.home);
    if (!grant?.owner_ssh) throw new Error("SSH grant missing");
    const authority = worker.d.core.roster.nodes.get(lead.d.nodeId);
    const addr = authority && worker.d.client.addrOf(authority);
    if (!addr) throw new Error("authority address missing");
    await expect(worker.d.client.sshRevoke(addr, { ...signSshRevocation(worker.d.core, grant), sig: "invalid" }))
      .rejects.toMatchObject({ code: "invalid_ssh_revocation" });
    // The authority retains the signed receipt while this target cannot persist any local revocation artifact.
    const push = lead.d.core.onLocalEvent;
    lead.d.core.onLocalEvent = null;
    try { await publishSshRevocation(worker.d.core, worker.d.client, grant); }
    finally { lead.d.core.onLocalEvent = push; }
    const fail = (): never => { throw new Error("injected disk failure"); };
    expect(() => revokeSshAccess(worker.d.core, grant, fail, fail,
      { record: fail, audit: fail, adminAudit: fail, grantState: fail })).toThrow("SSH revocation incomplete");
    expect(readGrant(worker.home)?.ssh_state).toBe("active");
    expect(teamSshRevoked(worker.d.core, grant)).toBe(false);
    expect(readFileSync(join(worker.home, "owner-ssh-gate.json"), "utf8")).toContain('"open"');
    await worker.restart();
    await waitFor(() => worker.d.sync.sshTeamConfirmed(), { what: "peer-held SSH revocation synced after restart" });
    expect(teamSshRevoked(worker.d.core, grant)).toBe(true);
    await expect(lead.d.client.tunnelTo({ ip: "", port: 7458, pubkey: worker.d.core.keys.pubkey }, "/peer/v1/ssh"))
      .rejects.toMatchObject({ code: "ssh_denied" });
  } finally { await isolated.close(); }
});


test("an unreachable authority keeps SSH closed even when a reachable peer lacks the receipt", async () => {
  const isolated = new Cluster();
  try {
    const team = await isolatedTeam(isolated, "ssh-authority-view");
    const { lead, worker, home } = team;
    const bystander = await isolated.add({ name: "bystander", login: "-", direct: true });
    expect((await bystander.client().join((await lead.client().inviteCode("other")).code)).admitted).toBe(true);
    await waitFor(() => bystander.d.core.roster.nodes.has(worker.d.nodeId) && worker.d.core.roster.nodes.has(bystander.d.nodeId),
      { what: "bystander roster sync" });
    const grant = await consentSsh(team);
    const leadNode = lead.d.nodeId;
    const bystanderNode = bystander.d.nodeId;
    await bystander.stop();
    // Only the authority holds the receipt: it does not push it, and the peer that was offline cannot pull it.
    const push = lead.d.core.onLocalEvent;
    lead.d.core.onLocalEvent = null;
    try { await publishSshRevocation(worker.d.core, worker.d.client, grant); }
    finally { lead.d.core.onLocalEvent = push; }
    expect(() => revokeSshAccess(worker.d.core, grant, failWrite, failWrite, everyWriteFails)).toThrow("SSH revocation incomplete");
    await lead.stop();
    await bystander.start();
    await worker.restart();
    await waitFor(() => {
      const state = worker.d.sync.peerState(bystanderNode);
      return !!state?.lastSync && state.lastSync >= worker.d.core.startedAt;
    }, { what: "worker synced with the peer that lacks the receipt" });
    expect(teamSshRevoked(worker.d.core, grant)).toBe(false);
    expect(worker.d.sync.sshTeamConfirmed()).toBe(false);
    expect(sshTunnelProblem(worker.d.core, leadNode, home)).toBe("ssh_team_waiting");
    expect(await worker.client().request("GET", "/v1/ssh/status"))
      .toMatchObject({ reason: "ssh_team_waiting", tunnel_allowed: false, is_authority: false });
    await lead.start();
    await waitFor(() => worker.d.sync.sshTeamConfirmed(), { what: "authority confirmation after it returns" });
    expect(teamSshRevoked(worker.d.core, grant)).toBe(true);
    expect(sshTunnelProblem(worker.d.core, leadNode, home)).toBe("ssh_denied");
    await expect(lead.d.client.tunnelTo({ ip: "", port: 7458, pubkey: worker.d.core.keys.pubkey }, "/peer/v1/ssh"))
      .rejects.toMatchObject({ code: "ssh_denied" });
  } finally { await isolated.close(); }
});

test("an authority target keeps its own revocation receipt and needs no peer to accept it", async () => {
  const isolated = new Cluster();
  try {
    const lead = await isolated.add({ name: "lead", login: "-", direct: true });
    const peer = await isolated.add({ name: "peer", login: "-", direct: true });
    await lead.client().init("ssh-authority-target", "alex");
    expect((await peer.client().join((await lead.client().inviteCode("kira")).code)).admitted).toBe(true);
    await waitFor(() => lead.d.core.roster.nodes.has(peer.d.nodeId), { what: "peer admitted" });
    const now = Date.now();
    const teamId = lead.d.core.teamId as string;
    const grant: Grant = { team_id: teamId, owner_node: lead.d.nodeId, target_node: lead.d.nodeId, recipient: "alex",
      consent_text: "consent", consent_version: 1, company_mode: true, launchers: ["@alex"], seat_cap: 1, profiles: [profile],
      created_at: now, expires_at: now + 86_400_000, ssh_state: "active",
      owner_ssh: mintOwnerSshGrant(lead.d.core.keys, { team_id: teamId, owner_handle: "alex", recipient: "alex",
        invite_id: "c".repeat(32), public_key: publicKey(), expires_at: now + 60_000 }) };
    lead.d.client.sshRevoke = async () => { throw new PeerCallError(503, "unavailable", "peer cannot store the receipt"); };
    await publishSshRevocation(lead.d.core, lead.d.client, grant);
    expect(teamSshRevoked(lead.d.core, grant)).toBe(true);
    // The authority's own log holds the receipt, so a restart needs no peer to find it.
    await peer.stop();
    await lead.restart();
    expect(teamSshRevoked(lead.d.core, grant)).toBe(true);
  } finally { await isolated.close(); }
});

test("an authority target stays closed until every reachable peer has synced since its start", async () => {
  const isolated = new Cluster();
  try {
    const lead = await isolated.add({ name: "lead", login: "-", direct: true });
    const first = await isolated.add({ name: "first", login: "-", direct: true });
    const second = await isolated.add({ name: "second", login: "-", direct: true });
    await lead.client().init("ssh-authority-peers", "alex");
    expect((await first.client().join((await lead.client().inviteCode("kira")).code)).admitted).toBe(true);
    expect((await second.client().join((await lead.client().inviteCode("other")).code)).admitted).toBe(true);
    await waitFor(() => lead.d.core.roster.nodes.has(first.d.nodeId) && lead.d.core.roster.nodes.has(second.d.nodeId), { what: "peers admitted" });
    const firstNode = first.d.nodeId;
    await second.stop();
    await lead.restart();
    await waitFor(() => {
      const state = lead.d.sync.peerState(firstNode);
      return !!state?.lastSync && state.lastSync >= lead.d.core.startedAt;
    }, { what: "authority synced with the first peer" });
    expect(lead.d.sync.sshTeamConfirmed()).toBe(false);
    expect(await lead.client().request("GET", "/v1/ssh/status")).toMatchObject({ is_authority: true });
    await second.start();
    await waitFor(() => lead.d.sync.sshTeamConfirmed(), { what: "authority synced with every reachable peer" });
  } finally { await isolated.close(); }
});

test("a revoked grant's receipt does not block a new consent that reuses the owner key", async () => {
  const isolated = new Cluster();
  try {
    const team = await isolatedTeam(isolated, "ssh-renewal");
    const { lead, worker, home } = team;
    const leadNode = lead.d.nodeId;
    const address = { ip: "", port: 7458, pubkey: worker.d.core.keys.pubkey };
    const first = await consentSsh(team);
    await worker.client().request("POST", "/v1/ssh/revoke", {});
    await waitFor(() => teamSshRevoked(worker.d.core, first), { what: "receipt for the first grant" });
    await worker.client().request("POST", "/v1/provision/revoke", {});
    const second = await consentSsh(team, Date.now() + 120_000);
    expect(second.created_at).toBeGreaterThan(first.created_at);
    expect(second.owner_ssh?.public_key).toBe(first.owner_ssh?.public_key);
    // The receipt names the first grant only: that grant stays revoked, the new one is untouched.
    expect(teamSshRevoked(worker.d.core, first)).toBe(true);
    expect(teamSshRevoked(worker.d.core, second)).toBe(false);
    expect(worker.d.sync.sshTeamConfirmed()).toBe(true);
    expect(sshTunnelProblem(worker.d.core, leadNode, home)).toBeNull();
    const end = await lead.d.client.tunnelTo(address, "/peer/v1/ssh");
    await end.write(Buffer.from("renewed"));
    expect(Buffer.from((await end.read()) as Uint8Array).toString()).toBe("renewed");
    end.close();
    await end.done;
    // After a restart SSH opens again once the authority has confirmed.
    await worker.restart();
    await waitFor(() => worker.d.sync.sshTeamConfirmed(), { what: "authority confirmation after restart" });
    expect(sshTunnelProblem(worker.d.core, leadNode, home)).toBeNull();
    // Revoking the new grant gets its own receipt, and the first receipt is still honoured.
    await worker.client().request("POST", "/v1/ssh/revoke", {});
    await waitFor(() => teamSshRevoked(worker.d.core, second), { what: "receipt for the second grant" });
    expect(teamSshRevoked(worker.d.core, first)).toBe(true);
    expect(sshTunnelProblem(worker.d.core, leadNode, home)).toBe("ssh_denied");
  } finally { await isolated.close(); }
});

test("when nothing can be saved and the authority cannot store the receipt, the CLI and status say so plainly", async () => {
  const isolated = new Cluster();
  try {
    const team = await isolatedTeam(isolated, "ssh-unsaved");
    const { lead, worker, home } = team;
    const grant = await consentSsh(team);
    const sendReceipt = worker.d.client.sshRevoke.bind(worker.d.client);
    worker.d.client.sshRevoke = async () => { throw new PeerCallError(503, "unavailable", "the authority cannot store the receipt"); };
    // Reads still work; every write that would make the revocation durable fails.
    const audit = join(worker.home, "admin-audit.jsonl");
    const keys = join(home, ".ssh", "authorized_keys");
    const keyBytes = readFileSync(keys);
    renameSync(audit, `${audit}.saved`); mkdirSync(audit);
    rmSync(keys); mkdirSync(keys);
    chmodSync(worker.home, 0o500);
    let healed = false;
    const heal = (): void => {
      if (healed) return;
      healed = true;
      chmodSync(worker.home, 0o700);
      rmdirSync(audit); renameSync(`${audit}.saved`, audit);
      rmdirSync(keys); writeFileSync(keys, keyBytes, { mode: 0o600 });
    };
    try {
      const cli = join(import.meta.dir, "../../src/cli/main.ts");
      const run = await runAsPerson([process.execPath, cli, "ssh", "revoke"],
        { PATH: process.env.PATH ?? "", WALKIE_HOME: worker.home, WALKIE_SOCKET: worker.socket });
      expect(run.code).toBe(1);
      expect(run.err).toContain(REVOCATION_UNSAVED_MESSAGE);
      const grantRun = await runAsPerson([process.execPath, cli, "provision", "revoke"],
        { PATH: process.env.PATH ?? "", WALKIE_HOME: worker.home, WALKIE_SOCKET: worker.socket });
      expect(grantRun.code).toBe(1);
      expect(grantRun.err).toContain(REVOCATION_UNSAVED_MESSAGE);
      await expect(worker.client().request("POST", "/v1/ssh/revoke", {}))
        .rejects.toMatchObject({ code: "ssh_revocation_unsaved", message: REVOCATION_UNSAVED_MESSAGE });
      await expect(worker.client().request("POST", "/v1/provision/revoke", {}))
        .rejects.toMatchObject({ code: "ssh_revocation_unsaved", message: REVOCATION_UNSAVED_MESSAGE });
      const status = await worker.client().request<{ revocation_unsaved: boolean; tunnel_allowed: boolean; reason: string }>("GET", "/v1/ssh/status");
      expect(status).toMatchObject({ revocation_unsaved: true, tunnel_allowed: false, reason: "ssh_denied" });
      // This process keeps denying the owner even though nothing could be saved.
      await expect(lead.d.client.tunnelTo({ ip: "", port: 7458, pubkey: worker.d.core.keys.pubkey }, "/peer/v1/ssh"))
        .rejects.toMatchObject({ code: "ssh_denied" });
    } finally { heal(); }
    worker.d.client.sshRevoke = sendReceipt;
    // "Run it again once the disk is writable": now it is saved, the warning clears, and a restart keeps SSH closed.
    await worker.client().request("POST", "/v1/ssh/revoke", {});
    expect((await worker.client().request<{ revocation_unsaved: boolean }>("GET", "/v1/ssh/status")).revocation_unsaved).toBe(false);
    await worker.restart();
    await waitFor(() => worker.d.sync.sshTeamConfirmed(), { what: "authority confirmation after the saved revocation" });
    expect(sshTunnelProblem(worker.d.core, lead.d.nodeId, home)).toBe("ssh_denied");
    expect(readGrant(worker.home)?.created_at).toBe(grant.created_at);
  } finally { await isolated.close(); }
});
