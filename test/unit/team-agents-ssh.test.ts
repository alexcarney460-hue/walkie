// WALK-67 lane 8, terminal path: the add-machine command's `--owner-ssh <packet>` rides in the ONE company consent that
// `walkie setup --company-machine` asks. Tested against a stand-in daemon: the packet is decoded and checked before the
// question, the text asked is consentText(..., owner_ssh), the packet goes into the single POST /v1/provision/grant, a
// damaged one is dropped with a plain message, the one root batch (sudo) runs after the typed yes and before the grant,
// and SSH is reported ready only from /v1/ssh/status. Never a real sudo, sshd, System Settings or daemon.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient } from "../../src/client/index.ts";
import { parseArgs, UsageError } from "../../src/cli/args.ts";
import type { Ctx } from "../../src/cli/context.ts";
import type { SshStatus } from "../../src/cli/commands/doctor.ts";
import { setup, sshEnrollmentExit } from "../../src/cli/commands/setup.ts";
import { companyConsentText, teamAgentsStep, type TeamAgentsDeps } from "../../src/cli/commands/team-agents.ts";
import type { RootBatchDeps, RootBatchNeed, RootBatchResult } from "../../src/cli/root-batch.ts";
import type { SshStepDeps } from "../../src/cli/ssh-enroll.ts";
import type { SshFinal } from "../../src/cli/ssh-ready.ts";
import { consentText } from "../../src/daemon/provision/consent.ts";
import { PROFILES } from "../../src/daemon/provision/profiles.ts";
import { createInvite } from "../../src/daemon/invite.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { encodeOwnerSshGrant, mintOwnerSshGrant } from "../../src/daemon/ssh/grant.ts";
import { realServerProbe, sshServerStatus } from "../../src/daemon/ssh/server.ts";
import { FOREIGN_SSH_AFTER_CONSENT } from "../../src/cli/ssh-foreign.ts";
import { laterSshd } from "../helpers/later-sshd.ts";
import { publicKey } from "../helpers/ssh-team.ts";

const BOOLEANS = new Set(["allow-team-agents", "no-team-agents", "for-agent", "seat-users", "same-user", "company-machine"]);
const TEAM = "0123456789abcdef";
const keys = generateKeys();
const profile = { id: "developer-worker" as const, version: PROFILES["developer-worker"].version };

function fixture(over: { recipient?: string } = {}) {
  const invite = createInvite(keys, { team: TEAM, authority: keys.pubkey, handle: "arvid", role: "member", now: Date.now(), pos: 1 });
  const packet = mintOwnerSshGrant(keys, { team_id: TEAM, owner_handle: "alex", recipient: over.recipient ?? "arvid",
    invite_id: invite.id, public_key: publicKey(), expires_at: invite.expires_at });
  return { invite: invite.code, packet, encoded: encodeOwnerSshGrant(packet) };
}

interface Seen { method: string; path: string; body: unknown }
/** A stand-in daemon: the roster of one owner, the seats routes, and a grant route that answers as told. */
function daemon(opts: { grant?: { status: number; body: unknown }; check?: { status: number; body: unknown }; order?: string[] } = {}) {
  const dir = mkdtempSync("/tmp/walkie-ta-ssh-");
  const seen: Seen[] = [];
  const server = Bun.serve({ unix: join(dir, "walkie.sock"), async fetch(req) {
    const path = new URL(req.url).pathname;
    const text = await req.text();
    seen.push({ method: req.method, path, body: text ? JSON.parse(text) : undefined });
    if (req.method === "POST") opts.order?.push(`POST ${path}`);
    if (path === "/v1/me") return Response.json({ team: { id: TEAM, name: "acme" }, handle: "arvid", role: "member", node: { id: "recipient-node", hostname: "arvid-box" } });
    if (path === "/v1/team") return Response.json({ members: [{ handle: "alex", role: "owner" }], nodes: [{ node_id: keys.nodeId, handle: "alex" }], authority: keys.nodeId, channels: [] });
    if (path === "/v1/seats" && req.method === "GET") return Response.json({ local: { allow: false }, hosts: [], seats: [] });
    if (path === "/v1/provision/check") return Response.json(opts.check?.body ?? { root_marker: false, ssh_server: false, owner_ssh: "usable" }, { status: opts.check?.status ?? 200 });
    if (path === "/v1/provision/grant") return Response.json(opts.grant?.body ?? { team_id: TEAM, company_mode: true }, { status: opts.grant?.status ?? 200 });
    if (path === "/v1/seats/config") return Response.json({ local: { allow: true, same_user: true, max: 4, launchers: ["@alex"] } });
    return Response.json({ error: { code: "not_found", message: path } }, { status: 404 });
  } });
  return {
    client: () => new WalkieClient({ socket: join(dir, "walkie.sock"), timeoutMs: 5_000 }), seen,
    posts: (path: string) => seen.filter((r) => r.method === "POST" && r.path === path),
    stop: () => { server.stop(true); rmSync(dir, { recursive: true, force: true }); },
  };
}

function ctxOf(argv: string[]): Ctx & { lines: string[] } {
  const lines: string[] = [];
  return { args: parseArgs(argv, BOOLEANS), json: false, forAgent: false, agentMarker: () => null, lines,
    client: () => { throw new Error("unused"); }, out: (s) => lines.push(s), err: (s) => lines.push(s) };
}

const ready: SshStatus = { owner_key_present: true, tunnel_allowed: true, reason: null, server: { enabled: true, detail: "up" } };

/**
 * The seams of the step, recorded in the order they are called. A Linux machine here has Walkie's own SSH unit unless a test
 * says otherwise (`walkieUnit: false`): a server answering on 22 is then Walkie's, and it is the stock-sshd case that needs saying.
 */
function seams(over: { platform?: NodeJS.Platform; markerPresent?: boolean; statuses?: SshStatus[]; batch?: Partial<RootBatchResult>; answers?: string[]; order?: string[]; walkieUnit?: boolean; walkieActive?: boolean | (() => boolean);
  /** Every status read comes from here instead of `statuses`. */ read?: () => Promise<SshStatus>;
  /** Runs when the person is asked the question (before their yes): where a test starts a server "while they read it". */ onAsk?: () => void } = {}) {
  const order = over.order ?? [];
  const calls = { asked: [] as string[], batches: [] as RootBatchNeed[], sudo: 0, ssh: [] as SshFinal[], reads: 0 };
  const answers = [...(over.answers ?? ["yes"])];
  const statuses = over.statuses ?? [ready];
  let reads = 0; let t = 0;
  const root: RootBatchDeps = {
    markerPresent: () => over.markerPresent ?? false,
    run: async (need) => { order.push("root batch"); calls.batches.push(need); return { marker: true, ssh: need.sshLinux || need.sshMacos ? "installed" : "skipped", ...over.batch }; },
  };
  const ssh: SshStepDeps = {
    platform: over.platform ?? "linux", timeoutMs: 6_000, pollMs: 2_000,
    read: async () => { calls.reads++; return over.read ? over.read() : statuses[Math.min(reads++, statuses.length - 1)]!; },
    sleep: async (ms) => { t += ms; }, now: () => t,
    walkieUnit: () => over.walkieUnit ?? true,
    ...(over.walkieActive !== undefined ? { walkieActive: typeof over.walkieActive === "function" ? over.walkieActive : () => over.walkieActive as boolean } : {}),
  };
  const d: TeamAgentsDeps = {
    interactive: true, ask: async (q) => { calls.asked.push(q); order.push("ask"); over.onAsk?.(); return answers.shift() ?? ""; },
    checkRuntime: async () => ({ installed: true, loggedIn: true }),
    installSeatUsers: async () => { calls.sudo++; return true; },
    root, ssh, onSsh: (r) => calls.ssh.push(r),
  };
  return { d, calls, order };
}

let live: ReturnType<typeof daemon>[] = [];
afterEach(() => { for (const x of live) x.stop(); live = []; });
const up = (opts: Parameters<typeof daemon>[0] = {}) => { const x = daemon(opts); live.push(x); return x; };

describe("the packet rides in the one consent", () => {
  test("asked once with consentText(..., owner_ssh), sent as owner_ssh in the single grant request, then reported from /v1/ssh/status", async () => {
    const e = fixture();
    const order: string[] = [];
    const dm = up({ order });
    const s = seams({ order });
    const ctx = ctxOf(["--company-machine", "--invite", e.invite, "--owner-ssh", e.encoded]);
    expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("allowed");
    const text = consentText("alex", ["@alex"], 4, [profile], undefined, e.packet);
    expect(text).toContain("over SSH as your user, through Walkie");
    expect(companyConsentText("alex", ["@alex"], 4, e.packet)).toBe(text);
    expect(s.calls.asked).toEqual([`${text} (type yes/N)`]); // one question, no second consent screen
    const grants = dm.posts("/v1/provision/grant");
    expect(grants).toHaveLength(1);
    expect(grants[0]!.body).toEqual({ owner_node: keys.nodeId, launchers: ["@alex"], seat_cap: 4, profiles: [profile], company_mode: true,
      consent_version: 1, consent_text: text, owner_ssh: e.packet, consented: true, confirmation: { surface: "cli", typed_phrase: "yes" } });
    expect(s.calls.sudo).toBe(0); // the seat-user sudo is never involved
    expect(s.calls.ssh).toEqual([{ state: "ready" }]);
    expect(ctx.lines.join("\n")).toContain("owner SSH is ready");
    expect(order).toEqual(["POST /v1/provision/check", "ask", "root batch", "POST /v1/provision/grant", "POST /v1/seats/config"]);
  });
  test("the packet is never printed, asked, or put in an error line", async () => {
    const e = fixture();
    const dm = up();
    const s = seams();
    const ctx = ctxOf(["--company-machine", "--invite", e.invite, "--owner-ssh", e.encoded]);
    await teamAgentsStep(ctx, dm.client(), s.d, () => undefined);
    const everything = [...ctx.lines, ...s.calls.asked].join("\n");
    for (const secret of [e.encoded, e.packet.signature, e.packet.public_key, e.packet.invite_id]) expect(everything).not.toContain(secret);
  });
  test("a link without a packet asks the same consent as before and carries no owner_ssh", async () => {
    const e = fixture();
    const dm = up();
    const s = seams();
    const ctx = ctxOf(["--company-machine", "--invite", e.invite]);
    expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("allowed");
    expect(s.calls.asked).toEqual([`${companyConsentText("alex", ["@alex"], 4)} (type yes/N)`]);
    expect(s.calls.asked[0]).not.toContain("over SSH");
    expect(dm.posts("/v1/provision/grant")[0]!.body).not.toHaveProperty("owner_ssh");
    expect(s.calls.ssh).toEqual([]);
    expect(ctx.lines.join("\n")).not.toContain("owner SSH is ready");
  });
  test("typing anything but yes carries nothing: no root batch, no grant", async () => {
    const e = fixture();
    const dm = up();
    const s = seams({ answers: ["y"] });
    const ctx = ctxOf(["--company-machine", "--invite", e.invite, "--owner-ssh", e.encoded]);
    expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("declined");
    expect([s.calls.batches, dm.posts("/v1/provision/grant")]).toEqual([[], []]);
  });
  test("the seats-only question never carries or authorizes SSH; --owner-ssh needs --company-machine", async () => {
    const e = fixture();
    const dm = up();
    await expect(teamAgentsStep(ctxOf(["--owner-ssh", e.encoded]), dm.client(), seams().d, () => undefined)).rejects.toBeInstanceOf(UsageError);
    await expect(teamAgentsStep(ctxOf(["--allow-team-agents", "--owner-ssh", e.encoded]), dm.client(), seams().d, () => undefined)).rejects.toThrow("--company-machine");
    expect(dm.seen.filter((r) => r.method === "POST")).toEqual([]);
    // The plain question for a person who ran no company flag: no packet in the text, no grant.
    const plain = seams({ answers: ["y"] });
    expect(await teamAgentsStep(ctxOf([]), dm.client(), plain.d, () => undefined)).toBe("allowed");
    expect(plain.calls.asked[0]).not.toContain("SSH");
    expect(dm.posts("/v1/provision/grant")).toEqual([]);
  });
  test("a flag or an agent cannot give the company consent, so no packet is ever sent", async () => {
    const e = fixture();
    const dm = up();
    const flagged = seams();
    expect(await teamAgentsStep(ctxOf(["--company-machine", "--allow-team-agents", "--invite", e.invite, "--owner-ssh", e.encoded]), dm.client(), flagged.d, () => undefined)).toBe("refused");
    const agent = ctxOf(["--company-machine", "--invite", e.invite, "--owner-ssh", e.encoded]);
    const asAgent = { ...agent, agentMarker: () => "CLAUDECODE is set in its environment" };
    expect(await teamAgentsStep(asAgent, dm.client(), seams().d, () => undefined)).toBe("refused");
    expect(dm.posts("/v1/provision/grant")).toEqual([]);
  });
});

describe("a packet that can't be used is dropped, plainly, before the consent", () => {
  test("damaged: the message comes first, the consent leaves SSH out, nothing is sent, SSH is never reported ready", async () => {
    const e = fixture();
    const order: string[] = [];
    for (const bad of [e.encoded.slice(0, -3), "garbage!", "", fixture({ recipient: "kira" }).encoded]) {
      const dm = up({ order });
      const s = seams({ order });
      const ctx = ctxOf(["--company-machine", "--invite", e.invite, "--owner-ssh", bad]);
      expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("allowed");
      const out = ctx.lines.join("\n");
      expect(out).toContain("This link can't turn on owner SSH");
      expect(out).toContain("Ask the owner for a new add-machine link");
      expect(s.calls.asked).toEqual([`${companyConsentText("alex", ["@alex"], 4)} (type yes/N)`]);
      expect(s.calls.asked[0]).not.toContain("SSH");
      expect(dm.posts("/v1/provision/grant")[0]!.body).not.toHaveProperty("owner_ssh");
      expect(s.calls.ssh).toEqual([]); // nothing was carried, so nothing is watched or reported
      expect(out).not.toContain("owner SSH is ready");
      expect(s.calls.batches.every((b) => !b.sshLinux)).toBe(true); // and no SSH service is installed for it
      live.pop()!.stop();
    }
  });
  test("an expired packet is damaged too", async () => {
    const e = fixture();
    const old = mintOwnerSshGrant(keys, { team_id: TEAM, owner_handle: "alex", recipient: "arvid", invite_id: e.packet.invite_id, public_key: publicKey(), expires_at: Date.now() - 1000 });
    const dm = up();
    const s = seams();
    const ctx = ctxOf(["--company-machine", "--invite", e.invite, "--owner-ssh", encodeOwnerSshGrant(old)]);
    await teamAgentsStep(ctx, dm.client(), s.d, () => undefined);
    expect(ctx.lines.join("\n")).toContain("This link can't turn on owner SSH");
    expect(dm.posts("/v1/provision/grant")[0]!.body).not.toHaveProperty("owner_ssh");
  });
});

describe("the daemon checks the packet before the question and before any root work (review findings 4 and 5a)", () => {
  const argv = (e: ReturnType<typeof fixture>) => ["--company-machine", "--invite", e.invite, "--owner-ssh", e.encoded];
  test("a packet the daemon accepts: the check comes first (carrying only the packet), then the one question, the one batch, the one grant", async () => {
    const e = fixture();
    const order: string[] = [];
    const dm = up({ order });
    const s = seams({ order });
    expect(await teamAgentsStep(ctxOf(argv(e)), dm.client(), s.d, () => undefined)).toBe("allowed");
    expect(order.slice(0, 2)).toEqual(["POST /v1/provision/check", "ask"]);
    expect(dm.posts("/v1/provision/check")).toHaveLength(1);
    expect(dm.posts("/v1/provision/check")[0]!.body).toEqual({ owner_ssh: e.packet });
  });
  test("each refusal the check can give stops the step before the question: refused, no question, no root batch, no grant, SSH never reported", async () => {
    const cases: Array<[string, number, string[], string[]]> = [
      ["owner_ssh_invalid", 403, ["its signature or expiry did not verify", "Ask the owner for a new add-machine link"], []],
      ["owner_ssh_mismatch", 403, ["it is for another enrollment", "Ask the owner for a new add-machine link"], []],
      ["owner_ssh_spent", 403, ["it was already used", "Ask the owner for a new add-machine link"], []],
      ["owner_required", 403, ["no longer an owner of the team", "Ask the owner for a new add-machine link"], []],
      ["owner_ssh_invite", 403, ["this machine already joined with another link; the owner must remove it from the team and add it again"], ["Ask the owner for a new add-machine link"]],
      ["owner_ssh_record", 409, ["the private SSH packet consumption record could not be read", "run the same command again", "the same link still works"], ["Ask the owner for a new add-machine link"]],
    ];
    for (const [code, status, includes, excludes] of cases) {
      for (const platform of ["linux", "darwin"] as const) {
        const e = fixture();
        const dm = up({ check: { status, body: { error: { code, message: code === "owner_ssh_record" ? "the private SSH packet consumption record could not be read" : "refused" } } } });
        const s = seams({ platform });
        const ctx = ctxOf(argv(e));
        expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("refused");
        const out = ctx.lines.join("\n");
        for (const text of includes) expect([code, out]).toEqual([code, expect.stringContaining(text)]);
        for (const text of excludes) expect(out).not.toContain(text);
        expect(out).toContain("company seats stay off");
        expect([code, s.calls.asked, s.calls.batches, dm.posts("/v1/provision/grant"), dm.posts("/v1/seats/config"), s.calls.ssh]).toEqual([code, [], [], [], [], []]);
        for (const secret of [e.encoded, e.packet.signature, e.packet.public_key]) expect(out).not.toContain(secret);
        live.pop()!.stop();
      }
    }
  });
  test("a check that cannot be answered is a refusal too: nothing runs for a packet nobody vetted", async () => {
    for (const status of [404, 500]) {
      const e = fixture();
      const dm = up({ check: { status, body: { error: { code: status === 404 ? "not_found" : "internal", message: "no such route" } } } });
      const s = seams();
      const ctx = ctxOf(argv(e));
      expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("refused");
      expect(ctx.lines.join("\n")).toContain("could not check the owner's SSH authorization");
      expect([s.calls.asked, s.calls.batches, dm.posts("/v1/provision/grant")]).toEqual([[], [], []]);
      live.pop()!.stop();
    }
  });
  test("a link without a packet, or with one the installer already dropped, asks the daemon to check nothing", async () => {
    const e = fixture();
    const none = up();
    await teamAgentsStep(ctxOf(["--company-machine", "--invite", e.invite]), none.client(), seams().d, () => undefined);
    expect(none.posts("/v1/provision/check")).toEqual([]);
    const damaged = up();
    await teamAgentsStep(ctxOf(["--company-machine", "--invite", e.invite, "--owner-ssh", "garbage!"]), damaged.client(), seams().d, () => undefined);
    expect(damaged.posts("/v1/provision/check")).toEqual([]);
  });
});

describe("an SSH server that is not Walkie's already answers on 127.0.0.1:22 (Linux and WSL; final review A, MEDIUM)", () => {
  const argv = (e: ReturnType<typeof fixture>) => ["--company-machine", "--invite", e.invite, "--owner-ssh", e.encoded];
  const WHY = "This machine already runs its own SSH server; Walkie's owner SSH needs its own service, which a later release adds alongside it; owner SSH stays off";
  const servers: Array<{ stop(force?: boolean): void }> = [];
  afterEach(() => { for (const x of servers) x.stop(true); servers.length = 0; });
  /** A loopback listener standing in for a stock sshd on port 22 (22 is privileged here); the daemon's own Linux probe reads it. */
  async function stockSshdStatus(): Promise<SshStatus> {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(sock) { sock.write("SSH-2.0-OpenSSH_9.6p1\r\n"); }, data() {}, close() {}, error() {} } });
    servers.push(server);
    return { ...ready, server: await sshServerStatus(server.port, { ...realServerProbe, platform: "linux" }) };
  }

  test("the reason is said first, the consent leaves SSH out, the grant carries no owner_ssh, nothing is installed for SSH, and SSH is never reported ready", async () => {
    const e = fixture();
    const order: string[] = [];
    const dm = up({ order });
    const s = seams({ order, walkieUnit: false, statuses: [await stockSshdStatus()] });
    const ctx = ctxOf(argv(e));
    const out = ctx.out;
    ctx.out = (line) => { if (line.includes("already runs its own SSH server")) order.push("reason"); out(line); };
    expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("allowed");
    const text = ctx.lines.join("\n");
    expect(text).toContain(`${WHY}. The consent below leaves SSH out.`);
    expect(s.calls.asked).toEqual([`${companyConsentText("alex", ["@alex"], 4)} (type yes/N)`]); // the consent a link without SSH shows
    expect(s.calls.asked[0]).not.toContain("SSH");
    expect(order.slice(0, 2)).toEqual(["reason", "ask"]); // before the question
    expect(s.calls.batches).toEqual([{ marker: true, sshLinux: false, sshMacos: false }]); // the marker only: no SSH service is installed for it
    const grants = dm.posts("/v1/provision/grant");
    expect(grants).toHaveLength(1);
    expect(grants[0]!.body).not.toHaveProperty("owner_ssh");
    expect((grants[0]!.body as { consent_text: string }).consent_text).toBe(companyConsentText("alex", ["@alex"], 4));
    expect(JSON.stringify(dm.seen)).not.toContain(e.packet.signature); // the packet is not sent to the daemon at all
    expect(s.calls.ssh).toEqual([]); // not watched, so never reported
    expect(text).not.toContain("owner SSH is ready");
    for (const secret of [e.encoded, e.packet.signature, e.packet.public_key]) expect(text).not.toContain(secret);
  });
  test("an installed Walkie unit that is not running does not vouch for what answers: the same refusal", async () => {
    const e = fixture();
    const dm = up();
    const s = seams({ walkieUnit: true, walkieActive: false, statuses: [ready] });
    const ctx = ctxOf(argv(e));
    expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("allowed");
    expect(ctx.lines.join("\n")).toContain(WHY);
    expect(dm.posts("/v1/provision/grant")[0]!.body).not.toHaveProperty("owner_ssh");
    expect(s.calls.ssh).toEqual([]);
  });
  test("Walkie's own service answering (its unit installed and running) is used as before: the packet rides in the consent and SSH is reported from the status", async () => {
    const e = fixture();
    const dm = up();
    const s = seams({ walkieUnit: true, walkieActive: true, statuses: [ready] });
    const ctx = ctxOf(argv(e));
    expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("allowed");
    expect(ctx.lines.join("\n")).not.toContain("already runs its own SSH server");
    expect(dm.posts("/v1/provision/grant")[0]!.body).toHaveProperty("owner_ssh", e.packet);
    expect(s.calls.ssh).toEqual([{ state: "ready" }]);
  });
  test("nothing answering on 22: the install proceeds as before (the batch installs Walkie's service)", async () => {
    const e = fixture();
    const noServer: SshStatus = { ...ready, server: { enabled: false, detail: "no SSH server on 127.0.0.1" } };
    const s = seams({ walkieUnit: false, statuses: [noServer, noServer, noServer, ready] }); // looked at before the question, again after the yes, again by the batch, then the wait
    const ctx = ctxOf(argv(e));
    expect(await teamAgentsStep(ctx, up().client(), s.d, () => undefined)).toBe("allowed");
    expect(ctx.lines.join("\n")).not.toContain("already runs its own SSH server");
    expect(s.calls.batches).toEqual([{ marker: true, sshLinux: true, sshMacos: false }]);
  });
  test("a status that cannot be read says nothing about a foreign server: SSH is not dropped for want of a reading", async () => {
    const e = fixture();
    const s = seams({ walkieUnit: false, statuses: [ready] });
    const failing = { ...s.d, ssh: { ...s.d.ssh!, read: async (): Promise<SshStatus> => { throw new Error("daemon_unreachable"); } } };
    const dm = up();
    const ctx = ctxOf(argv(e));
    await teamAgentsStep(ctx, dm.client(), failing, () => undefined);
    expect(ctx.lines.join("\n")).not.toContain("already runs its own SSH server");
    expect(dm.posts("/v1/provision/grant")[0]!.body).toHaveProperty("owner_ssh", e.packet);
  });
  test("macOS never reads this as foreign: Walkie's own service is on 22022, and no Walkie unit exists there", async () => {
    const e = fixture();
    const dm = up();
    const s = seams({ platform: "darwin", walkieUnit: false, statuses: [ready] });
    const ctx = ctxOf(argv(e));
    expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("allowed");
    expect(ctx.lines.join("\n")).not.toContain("already runs its own SSH server");
    expect(dm.posts("/v1/provision/grant")[0]!.body).toHaveProperty("owner_ssh", e.packet);
  });
  test("a link without a packet never looks: the status is not read before the question", async () => {
    const e = fixture();
    const s = seams({ walkieUnit: false, statuses: [ready] });
    await teamAgentsStep(ctxOf(["--company-machine", "--invite", e.invite]), up().client(), s.d, () => undefined);
    expect(s.calls.reads).toBe(0);
  });
});

// Final review C, F3 (MEDIUM): the look before the question is not the last word. A stock sshd that starts while the person reads and
// types used to be taken for "a service that already answers": no SSH install, the packet kept, the owner key put into the person's
// authorized_keys, and "owner SSH is ready" said through a server the consent never described. The same look is made again after the
// typed yes, right before the administrator step and the grant.
describe("a stock sshd that starts answering after the first look (final review C, F3)", () => {
  const argv = (e: ReturnType<typeof fixture>) => ["--company-machine", "--invite", e.invite, "--owner-ssh", e.encoded];
  const servers: Array<{ stop(): void }> = [];
  afterEach(() => { for (const x of servers) x.stop(); servers.length = 0; });

  test("started while the person reads and types: the second look drops the packet, says why, records the consent without SSH and reports nothing ready", async () => {
    const e = fixture();
    const dm = up();
    const later = laterSshd(ready);
    servers.push(later);
    const s = seams({ walkieUnit: false, read: later.read, onAsk: later.start });
    const ctx = ctxOf(argv(e));
    expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("allowed");
    // The question was asked with SSH in it (nothing answered yet) and the person typed yes to that.
    expect(s.calls.asked).toEqual([`${companyConsentText("alex", ["@alex"], 4, e.packet)} (type yes/N)`]);
    const text = ctx.lines.join("\n");
    expect(text).toContain("This machine already runs its own SSH server; Walkie's owner SSH needs its own service, which a later release adds alongside it; owner SSH stays off. The consent recorded leaves SSH out, though the one shown above included it.");
    expect(text).toContain(FOREIGN_SSH_AFTER_CONSENT);
    expect(s.calls.batches).toEqual([{ marker: true, sshLinux: false, sshMacos: false }]); // the marker only: no SSH service is installed for it
    const grants = dm.posts("/v1/provision/grant");
    expect(grants).toHaveLength(1);
    expect(grants[0]!.body).not.toHaveProperty("owner_ssh");
    expect((grants[0]!.body as { consent_text: string }).consent_text).toBe(companyConsentText("alex", ["@alex"], 4)); // what the daemon expects for a grant without SSH
    expect(JSON.stringify(grants[0]!.body)).not.toContain(e.packet.signature);
    expect(s.calls.reads).toBe(2); // the look before the question and the look after the yes: nothing is watched afterwards
    expect(s.calls.ssh).toEqual([]);
    expect(text).not.toContain("owner SSH is ready");
  });
  test("nothing starts: the two looks change nothing, and the packet is carried as before", async () => {
    const e = fixture();
    const dm = up();
    const later = laterSshd(ready);
    servers.push(later);
    const s = seams({ walkieUnit: false, read: later.read, batch: { ssh: "failed", why: "the SSH service install stopped; its messages are above" } });
    const ctx = ctxOf(argv(e));
    expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("incomplete"); // nothing answered, so the install ran (and this stand-in refused it)
    expect(s.calls.batches).toEqual([{ marker: true, sshLinux: true, sshMacos: false }]);
    expect(ctx.lines.join("\n")).not.toContain("already runs its own SSH server");
    expect(dm.posts("/v1/provision/grant")).toEqual([]);
  });
  test("Walkie's own service answering at both looks keeps the packet", async () => {
    const e = fixture();
    const dm = up();
    const s = seams({ walkieUnit: true, statuses: [ready] });
    const ctx = ctxOf(argv(e));
    expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("allowed");
    expect(ctx.lines.join("\n")).not.toContain("already runs its own SSH server");
    expect(dm.posts("/v1/provision/grant")[0]!.body).toHaveProperty("owner_ssh", e.packet);
    expect(s.calls.ssh).toEqual([{ state: "ready" }]);
  });
  test("the administrator step skips the install only for WALKIE's service: a server that answers but is not Walkie's at that moment never counts", async () => {
    // Walkie's service is running at both looks and is not when the step reads again (while something else still answers on 22).
    const e = fixture();
    const dm = up();
    let asked = 0;
    const s = seams({ walkieUnit: true, walkieActive: () => ++asked <= 2, statuses: [ready], batch: { ssh: "failed", why: "the SSH service install stopped; its messages are above" } });
    const ctx = ctxOf(argv(e));
    expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("incomplete");
    expect(s.calls.batches).toEqual([{ marker: true, sshLinux: true, sshMacos: false }]); // the install is planned, not skipped
    expect(dm.posts("/v1/provision/grant")).toEqual([]); // and what it refuses stops everything: nothing recorded, the packet not spent
    expect(s.calls.ssh).toEqual([]);
    expect(ctx.lines.join("\n")).not.toContain("owner SSH is ready");
  });
});

describe("the one root batch", () => {
  const argv = (e: ReturnType<typeof fixture>) => ["--company-machine", "--invite", e.invite, "--owner-ssh", e.encoded];
  const noServer: SshStatus = { ...ready, server: { enabled: false, detail: "no SSH server on 127.0.0.1" } };
  const RERUN = "sudo /usr/local/bin/walkie provision root-marker install /Users/arvid/.walkie";
  test("Linux: one batch after the typed yes and before the grant installs the marker AND the SSH service; no second sudo", async () => {
    const e = fixture();
    const order: string[] = [];
    const dm = up({ order });
    const s = seams({ order, statuses: [noServer, noServer, noServer, ready] }); // Linux reads the status before the question and again after the yes (a server that is not Walkie's?), again for the batch, then for the wait
    const ctx = ctxOf(argv(e));
    expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("allowed");
    expect(s.calls.batches).toEqual([{ marker: true, sshLinux: true, sshMacos: false }]);
    expect(order.slice(0, 4)).toEqual(["POST /v1/provision/check", "ask", "root batch", "POST /v1/provision/grant"]);
    expect(order.filter((x) => x === "root batch")).toHaveLength(1);
    expect(s.calls.sudo).toBe(0);
    expect(ctx.lines.join("\n")).toContain("one administrator step (sudo asks for your password once): the root-owned company-machine marker, then Walkie's SSH service for the owner's key (it listens only on this machine and accepts only key logins)");
  });
  test("Linux with Walkie's own SSH service already answering, or the marker already there: the batch asks for only what is missing", async () => {
    const e = fixture();
    const answering = seams({ statuses: [ready] });
    await teamAgentsStep(ctxOf(argv(e)), up().client(), answering.d, () => undefined);
    expect(answering.calls.batches).toEqual([{ marker: true, sshLinux: false, sshMacos: false }]);
    const markerThere = seams({ markerPresent: true, statuses: [noServer, noServer, noServer, ready] });
    await teamAgentsStep(ctxOf(argv(e)), up().client(), markerThere.d, () => undefined);
    expect(markerThere.calls.batches).toEqual([{ marker: false, sshLinux: true, sshMacos: false }]);
    const nothing = seams({ markerPresent: true, statuses: [ready] });
    await teamAgentsStep(ctxOf(argv(e)), up().client(), nothing.d, () => undefined);
    expect(nothing.calls.batches).toEqual([]); // no sudo at all
  });
  test("macOS: the SAME one batch installs the marker and Walkie's own SSH service (never Remote Login), before the grant; nothing is opened afterwards", async () => {
    const e = fixture();
    const order: string[] = [];
    const dm = up({ order });
    const off: SshStatus = { ...ready, server: { enabled: false, detail: "Walkie's SSH service is not running (nothing listens on 127.0.0.1:22022)" } };
    const s = seams({ platform: "darwin", order, statuses: [off, ready] });
    const ctx = ctxOf(argv(e));
    expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("allowed");
    expect(s.calls.batches).toEqual([{ marker: true, sshLinux: false, sshMacos: true }]);
    expect(order).toEqual(["POST /v1/provision/check", "ask", "root batch", "POST /v1/provision/grant", "POST /v1/seats/config"]);
    expect(s.calls.ssh).toEqual([{ state: "ready" }]);
    const out = ctx.lines.join("\n");
    expect(out).toContain("Walkie's SSH service for the owner's key (it listens only on this Mac and accepts only key logins; Remote Login is not used)");
    expect(out).not.toContain("System Settings");
    expect(out.split("\n").filter((l) => l.includes("Remote Login")).every((l) => l.includes("Remote Login is not used"))).toBe(true);
  });
  test("macOS with Walkie's service already answering needs only the marker", async () => {
    const e = fixture();
    const s = seams({ platform: "darwin", statuses: [ready] });
    await teamAgentsStep(ctxOf(argv(e)), up().client(), s.d, () => undefined);
    expect(s.calls.batches).toEqual([{ marker: true, sshLinux: false, sshMacos: false }]);
  });
  test("macOS: a service that never answers is a failed enrollment with the reason and the fix, never ready and never 'pending'", async () => {
    const e = fixture();
    const off: SshStatus = { ...ready, server: { enabled: false, detail: "Walkie's SSH service is not running (nothing listens on 127.0.0.1:22022)" } };
    const s = seams({ platform: "darwin", statuses: [off] });
    const ctx = ctxOf(argv(e));
    expect(await teamAgentsStep(ctx, up().client(), s.d, () => undefined)).toBe("allowed");
    expect(s.calls.ssh).toEqual([expect.objectContaining({ state: "failed", code: "ssh_server_off" })]);
    const out = ctx.lines.join("\n");
    expect(out).not.toContain("owner SSH is ready");
    expect(out).toContain("walkie ssh enable");
    expect(out).not.toContain("owner SSH is pending");
  });
  test("an administrator step that did not finish stops before the grant: nothing is recorded, seats stay off", async () => {
    const e = fixture();
    const dm = up();
    const s = seams({ batch: { marker: false, why: "the administrator step was not completed" } });
    const ctx = ctxOf(argv(e));
    expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("incomplete");
    expect(dm.posts("/v1/provision/grant")).toEqual([]);
    expect(dm.posts("/v1/seats/config")).toEqual([]);
    expect(ctx.lines.join("\n")).toContain("company seats stay off");
  });
  test("review finding 5b: an SSH service that did not install stops BEFORE the grant (the link stays usable), with the exact rerun command and no unit that was never created", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const e = fixture();
      const dm = up();
      const kind = platform === "linux" ? "ssh-linux" : "ssh-macos";
      const s = seams({ platform, statuses: [noServer], batch: { ssh: "failed", why: "the SSH service install stopped; its messages are above", rerun: `${RERUN} ${kind}` } });
      const ctx = ctxOf(argv(e));
      expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("incomplete");
      expect(dm.posts("/v1/provision/grant")).toEqual([]); // nothing recorded, so the packet is not spent
      expect(dm.posts("/v1/seats/config")).toEqual([]);
      expect(s.calls.ssh).toEqual([]); // and SSH is never reported ready, or watched
      const out = ctx.lines.join("\n");
      expect(out).toContain("company seats stay off");
      expect(out).toContain("the SSH service was not installed");
      expect(out).toContain("the SSH service install stopped; its messages are above");
      expect(out).toContain(`${RERUN} ${kind}`);
      expect(out).toContain("run the same command again");
      expect(out).toContain("the same link still works");
      expect(out).not.toContain("systemctl");
      expect(out).not.toContain("walkie-sshd");
      live.pop()!.stop();
    }
  });
});

describe("after the grant", () => {
  const argv = (e: ReturnType<typeof fixture>) => ["--company-machine", "--invite", e.invite, "--owner-ssh", e.encoded];
  test("ssh_team_waiting that outlasts the wait is a failed enrollment with the reason and the fix, while seats stay on", async () => {
    const e = fixture();
    const waiting: SshStatus = { ...ready, tunnel_allowed: false, reason: "ssh_team_waiting" };
    const s = seams({ statuses: [waiting] });
    const ctx = ctxOf(argv(e));
    expect(await teamAgentsStep(ctx, up().client(), s.d, () => undefined)).toBe("allowed");
    expect(s.calls.ssh).toEqual([expect.objectContaining({ state: "failed", code: "ssh_team_waiting" })]);
    const out = ctx.lines.join("\n");
    expect(out).toContain("NOT ready");
    expect(out).toContain("roster authority");
    expect(out).toContain("what fixes it");
  });
  test("SSH is not ready when the server and gate are fine but the owner key is missing", async () => {
    const e = fixture();
    const s = seams({ statuses: [{ ...ready, owner_key_present: false, tunnel_allowed: false, reason: "owner_key_absent" }] });
    await teamAgentsStep(ctxOf(argv(e)), up().client(), s.d, () => undefined);
    expect(s.calls.ssh).toEqual([expect.objectContaining({ state: "failed", code: "owner_key_absent" })]);
  });
  test("the daemon refusing the packet at the grant (a race after the check) is said plainly and nothing is turned on", async () => {
    const e = fixture();
    for (const [code, reason] of [["owner_ssh_spent", "already used"], ["owner_ssh_invalid", "signature or expiry"]] as const) {
      const dm = up({ grant: { status: 403, body: { error: { code, message: "refused" } } } });
      const s = seams();
      const ctx = ctxOf(argv(e));
      expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("refused");
      const out = ctx.lines.join("\n");
      expect(out).toContain(reason);
      expect(out).toContain("Ask the owner for a new add-machine link");
      expect(dm.posts("/v1/seats/config")).toEqual([]);
      expect(s.calls.ssh).toEqual([]);
      live.pop()!.stop();
    }
    // A machine that already joined with another link is told the truth, not to ask for a link that can never work there.
    const dm = up({ grant: { status: 403, body: { error: { code: "owner_ssh_invite", message: "refused" } } } });
    const ctx = ctxOf(argv(e));
    expect(await teamAgentsStep(ctx, dm.client(), seams().d, () => undefined)).toBe("refused");
    expect(ctx.lines.join("\n")).toContain("this machine already joined with another link; the owner must remove it from the team and add it again");
    expect(ctx.lines.join("\n")).not.toContain("Ask the owner for a new add-machine link");
  });
  test("review finding 3: a failure on THIS machine names the problem and says to fix it and run the same command again (the same link still works)", async () => {
    const e = fixture();
    for (const [code, message] of [
      ["owner_key_install_failed", "owner key could not be installed: authorized_keys must be a regular file, not a link"],
      ["owner_ssh_record", "the one-use record of SSH authorizations (/home/arvid/.walkie/owner-ssh-packets-used.json) could not be written: EACCES"],
    ] as const) {
      const dm = up({ grant: { status: 409, body: { error: { code, message } } } });
      const s = seams();
      const ctx = ctxOf(argv(e));
      expect(await teamAgentsStep(ctx, dm.client(), s.d, () => undefined)).toBe("incomplete");
      const out = ctx.lines.join("\n");
      expect(out).toContain(message);
      expect(out).toContain("Fix that, then run the same command again: the same link still works.");
      expect(out).not.toContain("new add-machine link");
      expect(out).not.toContain("grant is pending");
      expect([dm.posts("/v1/seats/config"), s.calls.ssh]).toEqual([[], []]);
      live.pop()!.stop();
    }
  });
  test("a root marker problem shows the daemon's own message, for a seats-only link too, never the stale 'grant is pending' line", async () => {
    const e = fixture();
    for (const [code, message] of [
      ["root_marker_invalid", "the root-owned enrollment marker /var/lib/walkie/enrolled-x.json is not what Walkie installed (mode): have an administrator fix or remove it, then run the same command again"],
      ["root_marker_required", "this machine's root-owned enrollment marker is missing: run the enrollment's administrator step, then run the same command again"],
    ] as const) {
      for (const argvFor of [argv(e), ["--company-machine", "--invite", e.invite]]) {
        const dm = up({ grant: { status: 409, body: { error: { code, message } } } });
        const ctx = ctxOf(argvFor);
        expect(await teamAgentsStep(ctx, dm.client(), seams().d, () => undefined)).toBe("incomplete");
        const out = ctx.lines.join("\n");
        expect(out).toContain(message);
        expect(out).not.toContain("grant is pending");
        expect(out).not.toContain("owner key");
        expect(dm.posts("/v1/seats/config")).toEqual([]);
        live.pop()!.stop();
      }
    }
  });
  test("a retry after grant_exists resumes only onto a saved grant that carries this very packet", async () => {
    const e = fixture();
    const grantBody = { error: { code: "grant_exists", message: "active grant" } };
    const saved = (over: Record<string, unknown>) => async () => ({ team_id: TEAM, target_node: "recipient-node", recipient: "arvid", owner_node: keys.nodeId,
      launchers: ["@alex"], seat_cap: 4, profiles: [profile], company_mode: true, consent_version: 1,
      consent_text: companyConsentText("alex", ["@alex"], 4, e.packet), owner_ssh: e.packet, created_at: Date.now() - 1000, expires_at: Date.now() + 60_000, ...over });
    const same = up({ grant: { status: 409, body: grantBody } });
    const s1 = seams();
    expect(await teamAgentsStep(ctxOf(argv(e)), same.client(), { ...s1.d, readGrant: saved({}) }, () => undefined)).toBe("allowed");
    expect(s1.calls.ssh).toEqual([{ state: "ready" }]);
    const other = fixture();
    for (const changed of [{ owner_ssh: other.packet }, { owner_ssh: undefined, consent_text: companyConsentText("alex", ["@alex"], 4) }]) {
      const dm = up({ grant: { status: 409, body: grantBody } });
      const s2 = seams();
      const ctx = ctxOf(argv(e));
      expect(await teamAgentsStep(ctx, dm.client(), { ...s2.d, readGrant: saved(changed) }, () => undefined)).toBe("refused");
      expect(ctx.lines.join("\n")).toContain("different or expired provisioning grant");
      expect(dm.posts("/v1/seats/config")).toEqual([]);
      expect(s2.calls.ssh).toEqual([]);
    }
  });
});

describe("setup and its exit status", () => {
  test("--owner-ssh without --company-machine is refused before anything is done", async () => {
    const e = fixture();
    await expect(setup(ctxOf(["--owner-ssh", e.encoded]))).rejects.toThrow("--company-machine");
    await expect(setup(ctxOf(["--invite", e.invite, "--owner-ssh", e.encoded]))).rejects.toBeInstanceOf(UsageError);
  });
  test("owner SSH that did not become ready after the rest was set up is an incomplete enrollment (exit 4); ready or none is not", () => {
    const say = () => { const lines: string[] = []; return { ctx: { ...ctxOf([]), err: (s: string) => lines.push(s) } as Ctx, lines }; };
    const failed = say();
    expect(sshEnrollmentExit(failed.ctx, { state: "failed", code: "ssh_team_waiting", why: "w", fix: "f" })).toBe(4);
    expect(failed.lines.join("\n")).toContain("owner SSH is not ready");
    expect(failed.lines.join("\n")).toContain("walkie ssh status");
    for (const ok of [{ state: "ready" } as const, null]) {
      const quiet = say();
      expect(sshEnrollmentExit(quiet.ctx, ok)).toBeNull();
      expect(quiet.lines).toEqual([]);
    }
  });
});
