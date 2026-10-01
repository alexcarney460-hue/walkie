// WALK-67 lane 8, WSL: `walkie provision grant-bootstrap` is how the Windows enrollment records the person's one
// consent (typed as ALLOW in the PowerShell bootstrap) after its root batch installed the marker. It posts the same
// grant request as the terminal, with the packet in it. Stand-in daemon only.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient } from "../../src/client/index.ts";
import { parseArgs, UsageError } from "../../src/cli/args.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { grantFromBootstrap, type BootstrapGrantDeps } from "../../src/cli/commands/provision-bootstrap.ts";
import { consentText } from "../../src/daemon/provision/consent.ts";
import { PROFILES } from "../../src/daemon/provision/profiles.ts";
import { createInvite, decodeInvite } from "../../src/daemon/invite.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { encodeOwnerSshGrant, mintOwnerSshGrant } from "../../src/daemon/ssh/grant.ts";
import type { SshStatus } from "../../src/cli/commands/doctor.ts";
import type { SshStepDeps } from "../../src/cli/ssh-enroll.ts";
import { realServerProbe, sshServerStatus } from "../../src/daemon/ssh/server.ts";
import { walkieUnitHints } from "../../src/cli/ssh-unit.ts";
import { SERVICES, systemctlSays } from "../helpers/systemctl-show.ts";
import { publicKey } from "../helpers/ssh-team.ts";

const TEAM = "0123456789abcdef";
const keys = generateKeys();
const profile = { id: "developer-worker" as const, version: PROFILES["developer-worker"].version };

function enrollment() {
  const invite = createInvite(keys, { team: TEAM, authority: keys.pubkey, handle: "arvid", role: "member", now: Date.now(), pos: 1 });
  const decoded = decodeInvite(invite.code);
  if ("error" in decoded) throw new Error("fixture invite is malformed");
  const packet = mintOwnerSshGrant(keys, { team_id: TEAM, owner_handle: "alex", recipient: "arvid", invite_id: decoded.id, public_key: publicKey(), expires_at: invite.expires_at });
  return { inviteId: decoded.id, packet, encoded: encodeOwnerSshGrant(packet) };
}

function daemon(opts: { grant?: { status: number; body: unknown } } = {}) {
  const dir = mkdtempSync("/tmp/walkie-pb-");
  const posts: unknown[] = [];
  const server = Bun.serve({ unix: join(dir, "walkie.sock"), async fetch(req) {
    const path = new URL(req.url).pathname;
    const text = await req.text();
    if (req.method === "POST") posts.push({ path, body: text ? JSON.parse(text) : undefined });
    if (path === "/v1/me") return Response.json({ team: { id: TEAM, name: "acme" }, handle: "arvid", role: "member", node: { id: "worker-node", hostname: "arvid-wsl" } });
    if (path === "/v1/team") return Response.json({ members: [{ handle: "alex", role: "owner" }], nodes: [{ node_id: keys.nodeId, handle: "alex" }], authority: keys.nodeId, channels: [] });
    if (path === "/v1/provision/grant") return Response.json(opts.grant?.body ?? { expires_at: 1_900_000_000_000 }, { status: opts.grant?.status ?? 200 });
    return Response.json({ error: { code: "not_found", message: path } }, { status: 404 });
  } });
  return { client: () => new WalkieClient({ socket: join(dir, "walkie.sock"), timeoutMs: 5_000 }), posts,
    stop: () => { server.stop(true); rmSync(dir, { recursive: true, force: true }); } };
}
let live: ReturnType<typeof daemon>[] = [];
const listeners: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => { for (const d of live) d.stop(); live = []; for (const l of listeners) l.stop(true); listeners.length = 0; });
const up = (opts: Parameters<typeof daemon>[0] = {}) => { const d = daemon(opts); live.push(d); return d; };

function ctxFor(d: ReturnType<typeof daemon>): Ctx & { lines: string[] } {
  const lines: string[] = [];
  return { args: parseArgs([], new Set()), json: false, forAgent: false, agentMarker: () => null, lines, client: () => d.client(),
    out: (s) => lines.push(s), err: (s) => lines.push(s) };
}
const deps = (over: Partial<BootstrapGrantDeps> = {}): BootstrapGrantDeps => ({ stdinIsTty: false, isWsl: async () => true, markerPresent: () => true, now: Date.now, ...over });
const input = (e: ReturnType<typeof enrollment>, over: Record<string, unknown> = {}) => JSON.stringify({ owner_node: keys.nodeId, owner_handle: "alex", launchers: ["@alex"],
  seat_cap: 4, profile: "developer-worker", invite_id: e.inviteId, owner_ssh: e.encoded, ...over });

describe("the Windows enrollment's consent, recorded from inside WSL", () => {
  test("one grant request with the packet in it, consentText(..., owner_ssh) and the windows surface; the packet is never printed", async () => {
    const e = enrollment();
    const d = up();
    const ctx = ctxFor(d);
    expect(await grantFromBootstrap(ctx, input(e), deps())).toBe(0);
    expect(d.posts).toHaveLength(1);
    expect(d.posts[0]).toEqual({ path: "/v1/provision/grant", body: { owner_node: keys.nodeId, launchers: ["@alex"], seat_cap: 4, profiles: [profile], company_mode: true,
      consent_version: 1, consent_text: consentText("alex", ["@alex"], 4, [profile], undefined, e.packet), owner_ssh: e.packet, consented: true,
      confirmation: { surface: "windows", typed_phrase: "yes" } } });
    const printed = ctx.lines.join("\n");
    for (const secret of [e.encoded, e.packet.signature, e.packet.public_key]) expect(printed).not.toContain(secret);
    expect(printed).toContain("enrollment grant for @alex recorded");
  });
  test("a link without a packet records the same consent without SSH", async () => {
    const e = enrollment();
    const d = up();
    expect(await grantFromBootstrap(ctxFor(d), input(e, { owner_ssh: undefined }), deps())).toBe(0);
    const body = (d.posts[0] as { body: Record<string, unknown> }).body;
    expect(body).not.toHaveProperty("owner_ssh");
    expect(body.consent_text).toBe(consentText("alex", ["@alex"], 4, [profile]));
  });
  test("a packet that is not for this invite is dropped, said plainly, and the consent leaves SSH out", async () => {
    const e = enrollment();
    const d = up();
    const ctx = ctxFor(d);
    expect(await grantFromBootstrap(ctx, input(e, { invite_id: "0".repeat(32) }), deps())).toBe(0);
    const body = (d.posts[0] as { body: Record<string, unknown> }).body;
    expect(body).not.toHaveProperty("owner_ssh");
    expect(String(body.consent_text)).not.toContain("SSH");
    expect(ctx.lines.join("\n")).toContain("This link can't turn on owner SSH");
    expect(ctx.lines.join("\n")).toContain("Ask the owner for a new add-machine link");
  });
  test("the daemon refusing the packet is said plainly and exits non-zero", async () => {
    const e = enrollment();
    const d = up({ grant: { status: 403, body: { error: { code: "owner_ssh_spent", message: "already used" } } } });
    await expect(grantFromBootstrap(ctxFor(d), input(e), deps())).rejects.toThrow("already used");
    await expect(grantFromBootstrap(ctxFor(d), input(e), deps())).rejects.toThrow("Ask the owner for a new add-machine link");
    await expect(grantFromBootstrap(ctxFor(d), input(e), deps())).rejects.toThrow("nothing was recorded");
  });
  test("a failure on this machine says to fix it and run the Windows installer again, in under 300 characters (what PowerShell prints)", async () => {
    const e = enrollment();
    const d = up({ grant: { status: 409, body: { error: { code: "owner_key_install_failed", message: "owner key could not be installed: authorized_keys must be a regular file, not a link" } } } });
    const error = await grantFromBootstrap(ctxFor(d), input(e), deps()).catch((x: Error) => x);
    expect(error).toBeInstanceOf(UsageError);
    const text = (error as Error).message;
    expect(text).toContain("authorized_keys must be a regular file");
    expect(text).toContain("Fix that, then run the Windows installer again: the same link still works.");
    expect(text).not.toContain("Ask the owner for a new add-machine link");
    expect(text.length).toBeLessThan(300);
  });
});

describe("it is only the Windows enrollment's step", () => {
  test("never from a terminal, never outside WSL, never before the root batch installed the marker", async () => {
    const e = enrollment();
    const d = up();
    await expect(grantFromBootstrap(ctxFor(d), input(e), deps({ stdinIsTty: true }))).rejects.toThrow("walkie provision grant");
    await expect(grantFromBootstrap(ctxFor(d), input(e), deps({ isWsl: async () => false }))).rejects.toThrow("inside WSL");
    await expect(grantFromBootstrap(ctxFor(d), input(e), deps({ markerPresent: () => false }))).rejects.toThrow("marker is missing");
    expect(d.posts).toEqual([]);
  });
  test("only the expected fields, and only a current owner of the joined team", async () => {
    const e = enrollment();
    const d = up();
    for (const bad of ["not json", "{}", input(e, { extra: 1 }), input(e, { seat_cap: 0 }), input(e, { seat_cap: 65 }), input(e, { launchers: [] }),
      input(e, { profile: "root" }), input(e, { owner_node: "xyz" }), input(e, { invite_id: "short" }), input(e, { owner_ssh: "bad packet!" }), input(e, { owner_ssh: "A".repeat(1201) })]) {
      await expect(grantFromBootstrap(ctxFor(d), bad, deps())).rejects.toBeInstanceOf(UsageError);
    }
    await expect(grantFromBootstrap(ctxFor(d), input(e, { owner_node: "ffffffffffffffff" }), deps())).rejects.toThrow("not a current owner");
    await expect(grantFromBootstrap(ctxFor(d), input(e, { owner_handle: "mallory" }), deps())).rejects.toThrow("not a current owner");
    expect(d.posts).toEqual([]);
  });
});

describe("an SSH server that is not Walkie's already answers on 127.0.0.1:22 inside WSL (final review A, MEDIUM)", () => {
  const ready: SshStatus = { owner_key_present: true, tunnel_allowed: true, reason: null, server: { enabled: true, detail: "up" } };
  /** A loopback listener standing in for a stock sshd on port 22, read through the daemon's own Linux probe. */
  async function stockSshd(): Promise<SshStatus> {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(sock) { sock.write("SSH-2.0-OpenSSH_9.6p1\r\n"); }, data() {}, close() {}, error() {} } });
    listeners.push(server);
    return { ...ready, server: await sshServerStatus(server.port, { ...realServerProbe, platform: "linux" }) };
  }
  const step = (status: SshStatus, walkieUnit: boolean): SshStepDeps => ({ platform: "linux", read: async () => status, sleep: async () => undefined, now: Date.now, walkieUnit: () => walkieUnit });

  test("the packet is dropped, the reason is said, and the consent recorded is the one without SSH: nothing is called ready", async () => {
    const e = enrollment();
    const d = up();
    const ctx = ctxFor(d);
    expect(await grantFromBootstrap(ctx, input(e), deps({ ssh: step(await stockSshd(), false) }))).toBe(0);
    const body = (d.posts[0] as { body: Record<string, unknown> }).body;
    expect(body).not.toHaveProperty("owner_ssh");
    expect(body.consent_text).toBe(consentText("alex", ["@alex"], 4, [profile]));
    expect(String(body.consent_text)).not.toContain("SSH");
    expect(JSON.stringify(d.posts)).not.toContain(e.packet.signature);
    const printed = ctx.lines.join("\n");
    expect(printed).toContain("This machine already runs its own SSH server; Walkie's owner SSH needs its own service, which a later release adds alongside it; owner SSH stays off. The enrollment continues without SSH.");
    expect(printed).not.toContain("owner SSH is ready");
    for (const secret of [e.encoded, e.packet.signature, e.packet.public_key]) expect(printed).not.toContain(secret);
  });
  test("Walkie's own SSH service answering keeps the packet in the one grant, as before", async () => {
    const e = enrollment();
    const d = up();
    const ctx = ctxFor(d);
    expect(await grantFromBootstrap(ctx, input(e), deps({ ssh: step(ready, true) }))).toBe(0);
    expect((d.posts[0] as { body: Record<string, unknown> }).body).toHaveProperty("owner_ssh", e.packet);
    expect(ctx.lines.join("\n")).not.toContain("already runs its own SSH server");
  });
  test("Walkie's own running service, as systemd tells the unprivileged person, keeps the packet; the same server under any other systemd answer does not (final review C, F1)", async () => {
    // The install script once left /etc/systemd/system root-only, so the unit FILE could not be seen by the person and Walkie's own
    // service read as someone else's: the WSL step dropped owner SSH on a healthy enrollment. systemd's answer is what counts now.
    const answering = await stockSshd();
    for (const [name, text, kept] of [["Walkie's own, running", SERVICES.walkies, true], ["Walkie's own, stopped", SERVICES.stopped, false],
      ["another unit of that name", SERVICES.foreign, false], ["no such unit", SERVICES.missing, false], ["systemctl unavailable", null, false]] as const) {
      const e = enrollment();
      const d = up();
      const ctx = ctxFor(d);
      const ssh: SshStepDeps = { ...step(answering, false), ...walkieUnitHints("linux", systemctlSays(text)) };
      expect(await grantFromBootstrap(ctx, input(e), deps({ ssh }))).toBe(0);
      const body = (d.posts[0] as { body: Record<string, unknown> }).body;
      expect([name, "owner_ssh" in body, ctx.lines.join("\n").includes("already runs its own SSH server")]).toEqual([name, kept, !kept]);
    }
  });
  test("nothing answering, or a link without a packet, changes nothing", async () => {
    const e = enrollment();
    const noServer: SshStatus = { ...ready, server: { enabled: false, detail: "no SSH server on 127.0.0.1" } };
    const d = up();
    expect(await grantFromBootstrap(ctxFor(d), input(e), deps({ ssh: step(noServer, false) }))).toBe(0);
    expect((d.posts[0] as { body: Record<string, unknown> }).body).toHaveProperty("owner_ssh", e.packet);
    let reads = 0;
    const counting: SshStepDeps = { ...step(ready, false), read: async () => { reads++; return ready; } };
    const plain = up();
    expect(await grantFromBootstrap(ctxFor(plain), input(e, { owner_ssh: undefined }), deps({ ssh: counting }))).toBe(0);
    expect(reads).toBe(0);
  });
});
