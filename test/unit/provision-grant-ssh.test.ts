// Final review A, MEDIUM, on the manual route: `walkie provision grant --owner-ssh <packet>` asks its own typed consent. When
// an SSH server that is not Walkie's already answers on 127.0.0.1:22 (Linux and WSL), Walkie does not use it: the reason is
// said before the disclosure, the disclosure and the grant leave SSH out, no administrator step installs an SSH service, and
// SSH is never reported ready. Stand-in daemon, a loopback listener standing in for port 22, stubbed terminal and sudo.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient } from "../../src/client/index.ts";
import { parseArgs } from "../../src/cli/args.ts";
import type { Ctx } from "../../src/cli/context.ts";
import type { SshStatus } from "../../src/cli/commands/doctor.ts";
import { grantFromCli } from "../../src/cli/commands/provision.ts";
import type { RootBatchDeps, RootBatchNeed, RootBatchResult } from "../../src/cli/root-batch.ts";
import type { SshStepDeps } from "../../src/cli/ssh-enroll.ts";
import { FOREIGN_SSH_AFTER_CONSENT } from "../../src/cli/ssh-foreign.ts";
import { consentText } from "../../src/daemon/provision/consent.ts";
import { PROFILES } from "../../src/daemon/provision/profiles.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { encodeOwnerSshGrant, mintOwnerSshGrant } from "../../src/daemon/ssh/grant.ts";
import { realServerProbe, sshServerStatus } from "../../src/daemon/ssh/server.ts";
import { laterSshd } from "../helpers/later-sshd.ts";
import { publicKey } from "../helpers/ssh-team.ts";

const TEAM = "0123456789abcdef";
const keys = generateKeys();
const profile = { id: "developer-worker" as const, version: PROFILES["developer-worker"].version };
const packet = mintOwnerSshGrant(keys, { team_id: TEAM, owner_handle: "alex", recipient: "arvid", invite_id: "a".repeat(32), public_key: publicKey(), expires_at: Date.now() + 3_600_000 });
const ready: SshStatus = { owner_key_present: true, tunnel_allowed: true, reason: null, server: { enabled: true, detail: "up" } };

interface Seen { path: string; body: unknown }
function daemon() {
  const dir = mkdtempSync("/tmp/walkie-pg-ssh-");
  const seen: Seen[] = [];
  const server = Bun.serve({ unix: join(dir, "walkie.sock"), async fetch(req) {
    const path = new URL(req.url).pathname;
    const text = await req.text();
    seen.push({ path, body: text ? JSON.parse(text) : undefined });
    if (path === "/v1/provision/check") return Response.json({ root_marker: false, ssh_server: false, owner_ssh: "usable" });
    if (path === "/v1/provision/grant") return Response.json({ team_id: TEAM, company_mode: true, expires_at: 1_900_000_000_000 });
    return Response.json({ error: { code: "not_found", message: path } }, { status: 404 });
  } });
  return { client: () => new WalkieClient({ socket: join(dir, "walkie.sock"), timeoutMs: 5_000 }), seen,
    posts: (path: string) => seen.filter((r) => r.path === path),
    stop: () => { server.stop(true); rmSync(dir, { recursive: true, force: true }); } };
}
let live: ReturnType<typeof daemon>[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => { for (const d of live) d.stop(); live = []; for (const x of servers) x.stop(true); servers.length = 0; });

/** A loopback listener standing in for a stock sshd on port 22, read through the daemon's own Linux probe. */
async function stockSshdStatus(): Promise<SshStatus> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(sock) { sock.write("SSH-2.0-OpenSSH_9.6p1\r\n"); }, data() {}, close() {}, error() {} } });
  servers.push(server);
  return { ...ready, server: await sshServerStatus(server.port, { ...realServerProbe, platform: "linux" }) };
}

function run(over: { platform?: NodeJS.Platform; status?: SshStatus; read?: () => Promise<SshStatus>; walkieUnit?: boolean; walkieActive?: () => boolean; flags?: string[];
  /** Runs when the person is asked the question (before their yes): where a test starts a server "while they read it". */
  onAsk?: () => void; /** The administrator step refuses the SSH half, as the install script does when port 22 is taken. */ refuseSsh?: boolean } = {}) {
  const d = daemon();
  live.push(d);
  const out: string[] = []; const err: string[] = [];
  const needs: RootBatchNeed[] = []; const asked: string[] = [];
  const ctx: Ctx = { args: parseArgs(["grant", "--owner-node", keys.nodeId, "--owner-handle", "alex", "--launchers", "@alex", "--seat-cap", "4", "--profile", "developer-worker", ...(over.flags ?? ["--owner-ssh", encodeOwnerSshGrant(packet)])], new Set()),
    json: false, forAgent: false, agentMarker: () => null, client: () => d.client(), out: (l) => out.push(l), err: (l) => err.push(l) };
  const refused: RootBatchResult = { marker: true, ssh: "failed", why: "the SSH service install stopped; its messages are above", rerun: "sudo walkie provision root-marker install /home/arvid/.walkie ssh-linux" };
  const root: RootBatchDeps = { markerPresent: () => false, run: async (need) => { needs.push(need); return over.refuseSsh && need.sshLinux ? refused : { marker: true, ssh: "skipped" }; } };
  let reads = 0; let t = 0;
  const ssh: SshStepDeps = { platform: over.platform ?? "linux", timeoutMs: 6_000, pollMs: 2_000, read: async () => { reads++; return over.read ? over.read() : over.status ?? ready; },
    sleep: async (ms) => { t += ms; }, now: () => t, walkieUnit: () => over.walkieUnit ?? true, ...(over.walkieActive ? { walkieActive: over.walkieActive } : {}) };
  const go = () => grantFromCli(ctx, { tty: true, type: async (question) => { asked.push(question); over.onAsk?.(); return "yes"; }, root, ssh });
  return { d, out, err, needs, asked, go, reads: () => reads };
}

describe("walkie provision grant --owner-ssh on Linux or WSL", () => {
  test("a stock sshd answering on 22: the reason first, a disclosure and grant without SSH, the marker only, and SSH never reported ready", async () => {
    const r = run({ status: await stockSshdStatus(), walkieUnit: false });
    expect(await r.go()).toBe(0);
    expect(r.err.join("\n")).toContain("This machine already runs its own SSH server; Walkie's owner SSH needs its own service, which a later release adds alongside it; owner SSH stays off.");
    const disclosure = r.out[0] as string; // the first thing printed is the disclosure
    expect(disclosure).toBe(consentText("alex", ["@alex"], 4, [profile])); // what a link without SSH shows
    expect(disclosure).not.toContain("SSH");
    expect(r.needs).toEqual([{ marker: true, sshLinux: false, sshMacos: false }]); // no SSH service for it
    expect(r.d.posts("/v1/provision/check")).toEqual([]);
    const grants = r.d.posts("/v1/provision/grant");
    expect(grants).toHaveLength(1);
    expect(grants[0]!.body).not.toHaveProperty("owner_ssh");
    expect((grants[0]!.body as { consent_text: string }).consent_text).toBe(disclosure);
    expect(JSON.stringify(r.d.seen)).not.toContain(packet.signature); // the packet is not sent to the daemon at all
    expect(r.reads()).toBe(1); // only the look before the question: it dropped the packet, so there is nothing to look at again or to watch, and nothing is called ready
    expect(`${r.out.join("\n")}${r.err.join("\n")}`).not.toContain("owner SSH is ready");
  });
  test("Walkie's own service answering (its unit installed): the check, the SSH disclosure, the packet in the grant, and ready from the status", async () => {
    const r = run({ walkieUnit: true });
    expect(await r.go()).toBe(0);
    expect(r.err.join("\n")).not.toContain("already runs its own SSH server");
    expect(r.out[0]).toBe(consentText("alex", ["@alex"], 4, [profile], undefined, packet));
    expect(r.d.posts("/v1/provision/check")).toHaveLength(1);
    expect(r.d.posts("/v1/provision/grant")[0]!.body).toHaveProperty("owner_ssh", packet);
    expect(r.err.join("\n")).toContain("owner SSH is ready");
  });
  test("macOS: never foreign, whatever the unit hint says", async () => {
    const r = run({ platform: "darwin", walkieUnit: false });
    expect(await r.go()).toBe(0);
    expect(r.err.join("\n")).not.toContain("already runs its own SSH server");
    expect(r.d.posts("/v1/provision/grant")[0]!.body).toHaveProperty("owner_ssh", packet);
  });
  test("a grant without --owner-ssh never looks at the SSH server", async () => {
    const r = run({ walkieUnit: false, flags: [] });
    expect(await r.go()).toBe(0);
    expect(r.reads()).toBe(0);
    expect(r.d.posts("/v1/provision/grant")[0]!.body).not.toHaveProperty("owner_ssh");
  });
});

// Final review C, F3 (MEDIUM): the look before the question is not the last word. A stock sshd that starts while the person reads and
// types used to be taken for "a service that already answers": no SSH install, the packet kept, the owner key put into the person's
// authorized_keys, and "owner SSH is ready" said through a server the consent never described. The same look is made again after the
// typed yes, right before the administrator step and the grant.
describe("a stock sshd that starts answering after the first look (final review C, F3)", () => {
  test("started while the person reads and types: the second look drops the packet, says why, records the consent without SSH and reports nothing ready", async () => {
    const later = laterSshd(ready);
    servers.push({ stop: () => later.stop() });
    const r = run({ read: later.read, walkieUnit: false, onAsk: later.start });
    expect(await r.go()).toBe(0);
    // The question was asked with SSH in it (nothing answered yet) and the person typed yes to that: the sentence follows, and what
    // is recorded is the grant without SSH, in the text the daemon expects for a grant without it.
    expect(r.out[0]).toBe(consentText("alex", ["@alex"], 4, [profile], undefined, packet));
    expect(r.err.join("\n")).toContain("This machine already runs its own SSH server; Walkie's owner SSH needs its own service, which a later release adds alongside it; owner SSH stays off. The consent recorded leaves SSH out, though the one shown above included it.");
    expect(r.err.join("\n")).toContain(FOREIGN_SSH_AFTER_CONSENT);
    expect(r.needs).toEqual([{ marker: true, sshLinux: false, sshMacos: false }]); // the marker only: no SSH service is installed for it
    const grants = r.d.posts("/v1/provision/grant");
    expect(grants).toHaveLength(1);
    expect(grants[0]!.body).not.toHaveProperty("owner_ssh");
    expect((grants[0]!.body as { consent_text: string }).consent_text).toBe(consentText("alex", ["@alex"], 4, [profile]));
    expect(JSON.stringify(grants[0]!.body)).not.toContain(packet.signature);
    expect(r.reads()).toBe(2); // the look before the question and the look after the yes: nothing is watched afterwards
    expect(`${r.out.join("\n")}${r.err.join("\n")}`).not.toContain("owner SSH is ready");
  });
  test("nothing starts: the two looks change nothing, and the packet is carried as before", async () => {
    const later = laterSshd(ready);
    servers.push({ stop: () => later.stop() });
    const r = run({ read: later.read, walkieUnit: false, refuseSsh: true });
    await expect(r.go()).rejects.toThrow("the SSH service was not installed"); // nothing answered, so the install ran (and this stand-in refused it)
    expect(r.needs).toEqual([{ marker: true, sshLinux: true, sshMacos: false }]);
    expect(r.err.join("\n")).not.toContain("already runs its own SSH server");
    expect(r.d.posts("/v1/provision/grant")).toEqual([]);
  });
  test("Walkie's own service answering at both looks keeps the packet", async () => {
    const r = run({ walkieUnit: true });
    expect(await r.go()).toBe(0);
    expect(r.err.join("\n")).not.toContain("already runs its own SSH server");
    expect(r.d.posts("/v1/provision/grant")[0]!.body).toHaveProperty("owner_ssh", packet);
    expect(r.err.join("\n")).toContain("owner SSH is ready");
  });
  test("the administrator step skips the install only for WALKIE's service: a server that answers but is not Walkie's at that moment never counts", async () => {
    // Walkie's service is running at both looks and is not when the step reads again (while something else still answers on 22).
    let asked = 0;
    const r = run({ status: ready, walkieUnit: true, walkieActive: () => ++asked <= 2, refuseSsh: true });
    await expect(r.go()).rejects.toThrow("the SSH service was not installed");
    expect(r.needs).toEqual([{ marker: true, sshLinux: true, sshMacos: false }]); // the install is planned, not skipped
    expect(r.d.posts("/v1/provision/grant")).toEqual([]); // and what it refuses stops everything: nothing recorded, the packet not spent
    expect(`${r.out.join("\n")}${r.err.join("\n")}`).not.toContain("owner SSH is ready");
  });
});
