// WALK-67 lane 8: the owner SSH packet on the install path. What a link's packet must prove before the one consent is
// shown, when SSH counts as READY (only from /v1/ssh/status: server on, owner key installed, tunnel open), and what
// `walkie ssh status` says. Fixtures and injected clocks only: no daemon, no sshd, no System Settings.
import { describe, expect, test } from "bun:test";
import { createInvite, decodeInvite } from "../../src/daemon/invite.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { encodeOwnerSshGrant, mintOwnerSshGrant } from "../../src/daemon/ssh/grant.ts";
import { sshStatusCommand } from "../../src/cli/commands/ssh.ts";
import type { SshStatus } from "../../src/cli/commands/doctor.ts";
import { finishOwnerSsh, type SshStepDeps } from "../../src/cli/ssh-enroll.ts";
import { checkOwnerSsh, grantRefusalLine, OWNER_SSH_DAMAGED, ownerSshRefusal, ownerSshRefusalLine, readOwnerSsh } from "../../src/cli/ssh-packet.ts";
import { sshFinal, sshReport, sshVerdict, waitForOwnerSsh } from "../../src/cli/ssh-ready.ts";
import { publicKey } from "../helpers/ssh-team.ts";
import { fakeDaemon } from "../helpers/fake-daemon.ts";
import { mkdtempSync, rmSync } from "node:fs";

const TEAM = "0123456789abcdef";
const NOW = 1_790_000_000_000;
const keys = generateKeys();

function enrollment(over: { expiresAt?: number; recipient?: string; owner?: string; team?: string } = {}) {
  const invite = createInvite(keys, { team: TEAM, authority: keys.pubkey, handle: "arvid", role: "member", now: NOW, pos: 1 });
  const packet = mintOwnerSshGrant(keys, { team_id: over.team ?? TEAM, owner_handle: over.owner ?? "alex", recipient: over.recipient ?? "arvid",
    invite_id: invite.id, public_key: publicKey(), expires_at: over.expiresAt ?? invite.expires_at });
  const decoded = decodeInvite(invite.code);
  if ("error" in decoded) throw new Error("fixture invite is malformed");
  return { invite, packet, encoded: encodeOwnerSshGrant(packet), inviteId: decoded.id };
}
const want = (inviteId: string | null) => ({ teamId: TEAM, handle: "arvid", ownerNode: keys.nodeId, ownerHandle: "alex", inviteId, now: NOW });

describe("reading the packet before the consent is shown", () => {
  test("a packet for this invite, owner, team and person is carried", () => {
    const e = enrollment();
    const r = readOwnerSsh(e.encoded, want(e.inviteId));
    expect(r.state).toBe("carried");
    expect(r.state === "carried" && r.packet).toEqual(e.packet);
  });
  test("no packet is 'absent', not damaged (an older link, or a person who ran the plain command)", () => {
    expect(readOwnerSsh(undefined, want("x"))).toEqual({ state: "absent" });
  });
  test("damaged encodings are dropped: not base64url, truncated, not JSON, an unknown field", () => {
    const e = enrollment();
    const json = Buffer.from(JSON.stringify({ ...e.packet, extra: 1 })).toString("base64url");
    for (const bad of ["", "not a packet!", e.encoded.slice(0, 40), e.encoded.slice(0, -2), Buffer.from("{}").toString("base64url"), json, "A".repeat(1300)]) {
      expect([bad.slice(0, 12), readOwnerSsh(bad, want(e.inviteId)).state]).toEqual([bad.slice(0, 12), "damaged"]);
    }
  });
  test("a packet that is not for this enrollment is dropped: team, owner node, owner handle, person, invite, expiry", () => {
    const e = enrollment();
    const base = want(e.inviteId);
    expect(readOwnerSsh(e.encoded, { ...base, teamId: "ffffffffffffffff" }).state).toBe("damaged");
    expect(readOwnerSsh(e.encoded, { ...base, ownerNode: "ffffffffffffffff" }).state).toBe("damaged");
    expect(readOwnerSsh(e.encoded, { ...base, ownerHandle: "mallory" }).state).toBe("damaged");
    expect(readOwnerSsh(e.encoded, { ...base, handle: "kira" }).state).toBe("damaged");
    expect(readOwnerSsh(e.encoded, { ...base, inviteId: "0".repeat(32) }).state).toBe("damaged");
    expect(readOwnerSsh(e.encoded, { ...base, now: e.packet.expires_at }).state).toBe("damaged");
    expect(readOwnerSsh(e.encoded, { ...base, inviteId: null }).state).toBe("carried"); // the daemon still checks the invite
  });
  test("the plain message says what to do and that the consent leaves SSH out", () => {
    expect(OWNER_SSH_DAMAGED).toContain("can't turn on owner SSH");
    expect(OWNER_SSH_DAMAGED).toContain("Ask the owner for a new add-machine link");
    expect(OWNER_SSH_DAMAGED).toContain("leaves SSH out");
  });
  test("every SSH refusal the grant route can give has a plain reason; others are not SSH refusals", () => {
    for (const code of ["owner_ssh_invalid", "owner_ssh_mismatch", "owner_ssh_invite", "owner_ssh_spent", "owner_ssh_record", "owner_key_install_failed"]) {
      expect(ownerSshRefusal(code)).toBeTruthy();
    }
    expect(ownerSshRefusal("invalid_consent")).toBeNull();
    expect(ownerSshRefusal("grant_exists")).toBeNull();
    expect(ownerSshRefusal("owner_required")).toBeTruthy();
  });
  test("a refusal is said as a whole sentence that is TRUE: an already-joined machine is told what to do, a local failure is told to fix it and retry", () => {
    expect(ownerSshRefusalLine("owner_ssh_invite", "x")).toBe("this machine already joined with another link; the owner must remove it from the team and add it again.");
    expect(ownerSshRefusalLine("owner_ssh_spent", "x")).toBe("the daemon refused the owner's SSH authorization in this link (it was already used). Ask the owner for a new add-machine link.");
    expect(ownerSshRefusalLine("owner_ssh_invalid", "x")).toContain("Ask the owner for a new add-machine link");
    expect(ownerSshRefusalLine("owner_ssh_record", "the SSH record could not be read")).toBe("the SSH record could not be read. Fix that, then run the same command again: the same link still works.");
    expect(ownerSshRefusalLine("invalid_consent", "x")).toBeNull();
    expect(ownerSshRefusalLine("grant_exists", "x")).toBeNull();
    // The retry phrase belongs to the flow that is repeated.
    expect(ownerSshRefusalLine("owner_key_install_failed", "owner key could not be installed: EACCES", "run the Windows installer again"))
      .toBe("owner key could not be installed: EACCES. Fix that, then run the Windows installer again: the same link still works.");
  });
  test("grantRefusalLine adds the root marker's two problems, whose own message is already complete, and nothing else", () => {
    expect(grantRefusalLine("root_marker_invalid", "the marker is not what Walkie installed: fix it, then run the same command again")).toBe("the marker is not what Walkie installed: fix it, then run the same command again");
    expect(grantRefusalLine("root_marker_required", "the marker is missing")).toBe("the marker is missing");
    expect(grantRefusalLine("owner_ssh_spent", "x")).toBe(ownerSshRefusalLine("owner_ssh_spent", "x"));
    expect(grantRefusalLine("grant_exists", "x")).toBeNull();
    expect(grantRefusalLine("invalid", "x")).toBeNull();
  });
  test("checkOwnerSsh asks the daemon and returns the refusal sentence, or null; an unanswerable check is a sentence too", async () => {
    const e = enrollment();
    const asked: unknown[] = [];
    const client = (reply: () => Promise<unknown>) => ({ provisionCheck: async (b: unknown) => { asked.push(b); return reply(); } }) as never;
    expect(await checkOwnerSsh(client(async () => ({ root_marker: false, ssh_server: false, owner_ssh: "usable" })), e.packet)).toBeNull();
    expect(asked).toEqual([{ owner_ssh: e.packet }]);
    const { WalkieError } = await import("../../src/client/index.ts");
    expect(await checkOwnerSsh(client(async () => { throw new WalkieError("owner_ssh_invite", "no", 403); }), e.packet)).toContain("already joined with another link");
    expect(await checkOwnerSsh(client(async () => { throw new WalkieError("not_found", "no such route", 404); }), e.packet)).toContain("could not check the owner's SSH authorization");
    expect(await checkOwnerSsh(client(async () => { throw new Error("socket closed"); }), e.packet)).toContain("socket closed");
  });
});

// ---- readiness ----------------------------------------------------------------------------------------------------------

const ready: SshStatus = { owner_key_present: true, tunnel_allowed: true, reason: null, server: { enabled: true, detail: "SSH server responds on 127.0.0.1" } };
const status = (over: Partial<SshStatus> & { server?: Partial<SshStatus["server"]> }): SshStatus => ({ ...ready, ...over, server: { ...ready.server, ...over.server } });

describe("ready means server, owner key and tunnel, nothing less", () => {
  test("all three: ready", () => {
    for (const platform of ["darwin", "linux"] as const) expect(sshVerdict(ready, platform)).toEqual({ state: "ready" });
  });
  test("each of the three missing is not ready, and names why", () => {
    const noKey = sshVerdict(status({ owner_key_present: false, tunnel_allowed: false, reason: "owner_key_absent" }), "linux");
    expect(noKey).toMatchObject({ state: "failed", code: "owner_key_absent" });
    const closed = sshVerdict(status({ tunnel_allowed: false, reason: "ssh_denied" }), "linux");
    expect(closed).toMatchObject({ state: "failed", code: "ssh_denied" });
    const silent = sshVerdict(status({ tunnel_allowed: false, reason: null }), "linux");
    expect(silent).toMatchObject({ state: "failed", code: "ssh_tunnel_closed" });
    // Each of the three is required on its own: a status that says the key is missing but the tunnel open is not ready.
    expect(sshVerdict(status({ owner_key_present: false, tunnel_allowed: true, reason: null }), "linux")).toMatchObject({ state: "failed", code: "owner_key_absent" });
    expect(sshVerdict(status({ owner_key_present: false, tunnel_allowed: true, reason: null }), "darwin").state).not.toBe("ready");
    expect(sshVerdict(status({ server: { enabled: false, detail: "off" }, owner_key_present: true, tunnel_allowed: true, reason: null }), "linux").state).not.toBe("ready");
    const off = sshVerdict(status({ server: { enabled: false, detail: "no SSH server on 127.0.0.1" } }), "linux");
    expect(off).toMatchObject({ state: "waiting", code: "ssh_server_off" });
  });
  test("macOS: Walkie's own service not answering waits like Linux's, ends as a failure with `walkie ssh enable` as the fix, and never mentions Remote Login", () => {
    const off = status({ server: { enabled: false, detail: "Walkie's SSH service is not running (nothing listens on 127.0.0.1:22022)" } });
    const v = sshVerdict(off, "darwin");
    expect(v).toMatchObject({ state: "waiting", code: "ssh_server_off" });
    expect(sshReport(v)).toMatchObject({ state: "waiting", code: "ssh_server_off" });
    expect(sshFinal(v)).toMatchObject({ state: "failed", code: "ssh_server_off" });
    expect(JSON.stringify(v)).not.toContain("Remote Login");
    expect(v.state === "waiting" && v.fix).toContain("walkie ssh enable");
  });
  test("Linux and WSL: Walkie's own unit is named only when it exists on this machine (review finding 5b)", () => {
    const off = status({ server: { enabled: false, detail: "no SSH server on 127.0.0.1" } });
    const withUnit = sshVerdict(off, "linux", { walkieUnit: true });
    expect(withUnit.state === "waiting" && withUnit.fix).toContain("sudo systemctl enable --now walkie-sshd");
    const without = sshVerdict(off, "linux", { walkieUnit: false });
    expect(without.state === "waiting" && without.fix).not.toContain("walkie-sshd");
    expect(without.state === "waiting" && without.fix).not.toContain("systemctl");
    expect(without.state === "waiting" && without.fix).toContain("walkie ssh enable");
    // Not knowing is not a reason to name a unit that may not exist.
    expect(JSON.stringify(sshVerdict(off, "linux"))).not.toContain("walkie-sshd");
    expect(sshFinal(withUnit)).toMatchObject({ state: "failed", code: "ssh_server_off" });
  });
  test("ssh_team_waiting that outlasts the wait is a failed enrollment with the reason and the fix", () => {
    const waiting = status({ tunnel_allowed: false, reason: "ssh_team_waiting" });
    expect(sshVerdict(waiting, "linux")).toMatchObject({ state: "waiting", code: "ssh_team_waiting" });
    const final = sshFinal(sshVerdict(waiting, "linux"));
    expect(final).toMatchObject({ state: "failed", code: "ssh_team_waiting" });
    expect(final.state === "failed" && final.why).toContain("roster authority");
    expect(final.state === "failed" && final.fix).toContain("Walkie Direct or Tailscale");
    const authority = sshFinal(sshVerdict({ ...waiting, is_authority: true }, "linux"));
    expect(authority.state === "failed" && authority.why).toContain("roster authority");
    expect(authority.state === "failed" && authority.fix).toContain("online");
  });
  test("an unreadable key record, an unsaved revocation and a pending install are never ready", () => {
    expect(sshVerdict(status({ owner_key_error: "authorized_keys or its managed record cannot be inspected" }), "linux")).toMatchObject({ state: "failed", code: "owner_key_error" });
    expect(sshVerdict(status({ revocation_unsaved: true }), "linux")).toMatchObject({ state: "failed", code: "ssh_revocation_unsaved" });
    expect(sshVerdict(status({ tunnel_allowed: false, reason: "ssh_pending" }), "linux")).toMatchObject({ state: "waiting", code: "ssh_pending" });
    expect(sshFinal(sshVerdict(status({ tunnel_allowed: false, reason: "ssh_pending" }), "linux")).state).toBe("failed");
  });
  test("server on and key present but the gate says the grant is gone: failed, not ready", () => {
    expect(sshVerdict(status({ tunnel_allowed: false, reason: "grant_absent", owner_key_present: false }), "linux")).toMatchObject({ state: "failed", code: "grant_absent" });
  });
});

describe("waiting for readiness", () => {
  /** A clock that only moves when the wait sleeps, and a scripted run of status readings (the last one repeats). */
  function run(readings: Array<SshStatus | Error>, platform: NodeJS.Platform, timeoutMs = 10_000) {
    let t = 0; let i = 0; const reads: number[] = []; const noted: string[] = [];
    const final = waitForOwnerSsh({
      read: async () => { reads.push(t); const r = readings[Math.min(i++, readings.length - 1)]!; if (r instanceof Error) throw r; return r; },
      sleep: async (ms) => { t += ms; }, now: () => t, platform, timeoutMs, pollMs: 2_000, onWaiting: (w) => noted.push(w.code),
    });
    return { final, reads, noted };
  }
  test("macOS waits until the server AND the key AND the tunnel all hold, then reads ready", async () => {
    const off = status({ server: { enabled: false, detail: "Walkie's SSH service is not running" }, tunnel_allowed: false, reason: "ssh_team_waiting" });
    const serverOnly = status({ tunnel_allowed: false, reason: "ssh_team_waiting" });
    const keyMissing = status({ owner_key_present: false, tunnel_allowed: false, reason: "ssh_team_waiting" });
    const r = run([off, off, serverOnly, ready], "darwin");
    expect(await r.final).toEqual({ state: "ready" });
    expect(r.reads).toEqual([0, 2000, 4000, 6000]);
    expect(r.noted).toEqual(["ssh_server_off", "ssh_team_waiting"]);
    // The service never coming up is a failed enrollment when the wait is over: there is no click left for a person to make.
    const never = run([off], "darwin");
    expect(await never.final).toMatchObject({ state: "failed", code: "ssh_server_off" });
    expect(never.reads.at(-1)).toBe(10_000);
    // The server and the gate alone are not enough without the owner's key (failed at once: it will not install itself).
    const noKey = run([{ ...keyMissing, reason: "owner_key_absent" }], "darwin");
    expect(await noKey.final).toMatchObject({ state: "failed", code: "owner_key_absent" });
  });
  test("a gate that never opens is failed at the end of the wait, not pending", async () => {
    const waiting = status({ tunnel_allowed: false, reason: "ssh_team_waiting" });
    const r = run([waiting], "linux", 60_000);
    expect(await r.final).toMatchObject({ state: "failed", code: "ssh_team_waiting" });
    expect(r.reads.length).toBe(31);
  });
  test("a gate that opens within the wait is ready", async () => {
    const waiting = status({ tunnel_allowed: false, reason: "ssh_team_waiting" });
    expect(await run([waiting, waiting, ready], "linux").final).toEqual({ state: "ready" });
  });
  test("a status the daemon cannot answer is waited on, then failed; it never reads as ready", async () => {
    const r = run([new Error("daemon_unreachable")], "linux", 6_000);
    expect(await r.final).toMatchObject({ state: "failed", code: "status_unavailable" });
    expect(await run([new Error("x"), ready], "linux").final).toEqual({ state: "ready" });
  });
  test("a refusal that will not fix itself ends the wait at once", async () => {
    const r = run([status({ tunnel_allowed: false, reason: "ssh_denied" }), ready], "linux");
    expect(await r.final).toMatchObject({ state: "failed", code: "ssh_denied" });
    expect(r.reads).toEqual([0]);
  });
});

// ---- the terminal's last step ----------------------------------------------------------------------------------------------

function stepDeps(platform: NodeJS.Platform, readings: SshStatus[]) {
  const calls = { reads: 0 };
  let t = 0;
  const deps: SshStepDeps = {
    platform, timeoutMs: 8_000, pollMs: 2_000,
    read: async () => { calls.reads++; return readings[Math.min(calls.reads - 1, readings.length - 1)]!; },
    sleep: async (ms) => { t += ms; }, now: () => t,
  };
  return { deps, calls };
}

describe("finishOwnerSsh", () => {
  const off = status({ server: { enabled: false, detail: "Walkie's SSH service is not running (nothing listens on 127.0.0.1:22022)" } });
  test("macOS: ready only when the readings say so, and nothing is opened or asked of the person on the way", async () => {
    const { deps } = stepDeps("darwin", [ready]);
    const lines: string[] = [];
    expect(await finishOwnerSsh((l) => lines.push(l), deps)).toEqual({ state: "ready" });
    expect(lines.join("\n")).toContain("owner SSH is ready");
    expect(Object.keys(deps).sort()).toEqual(["now", "platform", "pollMs", "read", "sleep", "timeoutMs"]);
    const turning = stepDeps("darwin", [off, off, ready]);
    expect(await finishOwnerSsh(() => undefined, turning.deps)).toEqual({ state: "ready" });
  });
  test("macOS: a service that never answers is a failed enrollment with the fix, and the text never sends anyone to Remote Login", async () => {
    const { deps } = stepDeps("darwin", [off]);
    const lines: string[] = [];
    const final = await finishOwnerSsh((l) => lines.push(l), deps);
    expect(final).toMatchObject({ state: "failed", code: "ssh_server_off" });
    const text = lines.join("\n");
    expect(text).toContain("NOT ready");
    expect(text).toContain("walkie ssh enable");
    expect(text).not.toContain("Remote Login");
    expect(text).not.toContain("System Settings");
    expect(text).not.toContain("is ready");
  });
  test("a daemon that cannot answer is waited on, then failed, never ready", async () => {
    const unreadable = stepDeps("darwin", [off]);
    const never = { ...unreadable.deps, read: async (): Promise<SshStatus> => { throw new Error("daemon_unreachable"); } };
    expect(await finishOwnerSsh(() => undefined, never)).toMatchObject({ state: "failed", code: "status_unavailable" });
  });
  test("Linux and WSL: a gate that stays shut is a failed enrollment", async () => {
    const waiting = status({ tunnel_allowed: false, reason: "ssh_team_waiting" });
    const { deps } = stepDeps("linux", [waiting]);
    const lines: string[] = [];
    const final = await finishOwnerSsh((l) => lines.push(l), deps);
    expect(final).toMatchObject({ state: "failed", code: "ssh_team_waiting" });
    expect(lines.join("\n")).toContain("NOT ready");
    expect(lines.join("\n")).toContain("what fixes it");
  });
  test("a unit that was never created is not named: Linux's hint reaches the verdict only when the unit exists", async () => {
    const down = status({ server: { enabled: false, detail: "no SSH server on 127.0.0.1" } });
    for (const [unit, named] of [[true, true], [false, false]] as const) {
      const { deps } = stepDeps("linux", [down]);
      const lines: string[] = [];
      await finishOwnerSsh((l) => lines.push(l), { ...deps, walkieUnit: () => unit });
      expect([unit, lines.join("\n").includes("walkie-sshd")]).toEqual([unit, named]);
    }
  });
});

describe("walkie ssh status", () => {
  const deps = (platform: NodeJS.Platform, readings: SshStatus[]) => stepDeps(platform, readings).deps;
  test("ready: one line, exit 0; with --json the verdict is one JSON line", async () => {
    const lines: string[] = [];
    expect(await sshStatusCommand([], deps("linux", [ready]), (l) => lines.push(l))).toBe(0);
    expect(lines.join("\n")).toContain("owner SSH is ready");
    const json: string[] = [];
    expect(await sshStatusCommand(["--json"], deps("linux", [ready]), (l) => json.push(l))).toBe(0);
    expect(JSON.parse(json.join(""))).toEqual({ state: "ready" });
  });
  test("not ready: exit 1 for a person, but --json always exits 0 and carries the state, code, why and fix", async () => {
    const off = status({ server: { enabled: false, detail: "Walkie's SSH service is not running (nothing listens on 127.0.0.1:22022)" } });
    const human: string[] = [];
    expect(await sshStatusCommand([], deps("darwin", [off]), (l) => human.push(l))).toBe(1);
    expect(human.join("\n")).toContain("owner SSH is not ready yet");
    expect(human.join("\n")).toContain("walkie ssh enable");
    const json: string[] = [];
    expect(await sshStatusCommand(["--json"], deps("darwin", [off]), (l) => json.push(l))).toBe(0);
    expect(JSON.parse(json.join(""))).toMatchObject({ state: "waiting", code: "ssh_server_off" });
    const waiting = status({ tunnel_allowed: false, reason: "ssh_team_waiting" });
    const once: string[] = [];
    await sshStatusCommand(["--json"], deps("linux", [waiting]), (l) => once.push(l));
    expect(JSON.parse(once.join(""))).toMatchObject({ state: "waiting", code: "ssh_team_waiting" }); // one reading: not yet a failure
    const waited: string[] = [];
    await sshStatusCommand(["--wait", "--json"], deps("linux", [waiting]), (l) => waited.push(l));
    expect(JSON.parse(waited.join(""))).toMatchObject({ state: "failed", code: "ssh_team_waiting" }); // the wait ran out
    expect(waited).toHaveLength(1); // json mode prints nothing but the verdict
  });
  test("unknown arguments are refused", async () => {
    await expect(sshStatusCommand(["--now"], deps("linux", [ready]), () => undefined)).rejects.toThrow("usage: walkie ssh status");
  });
});

describe("the real CLI entry", () => {
  async function cli(args: string[], routes: Record<string, unknown>) {
    const daemon = fakeDaemon(routes);
    const home = mkdtempSync("/tmp/walkie-ssh-cli-");
    try {
      const child = Bun.spawn([process.execPath, "src/cli/main.ts", ...args], { cwd: process.cwd(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_SOCKET: daemon.socket, WALKIE_HOME: home } });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { out, err, code, requests: daemon.requests };
    } finally { daemon.stop(); rmSync(home, { recursive: true, force: true }); }
  }
  test("walkie ssh status --json reads GET /v1/ssh/status and says ready only for all three", async () => {
    const r = await cli(["ssh", "status", "--json"], { "GET /v1/ssh/status": ready });
    expect([r.code, JSON.parse(r.out)]).toEqual([0, { state: "ready" }]);
    expect(r.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /v1/ssh/status"]);
    const missingKey = await cli(["ssh", "status", "--json"], { "GET /v1/ssh/status": { ...ready, owner_key_present: false, tunnel_allowed: false, reason: "owner_key_absent" } });
    expect(JSON.parse(missingKey.out)).toMatchObject({ state: "failed", code: "owner_key_absent" });
    const off = await cli(["ssh", "status"], { "GET /v1/ssh/status": { ...ready, server: { enabled: false, detail: "no SSH server answers" } } });
    expect(off.code).toBe(1);
    expect(off.out).toContain("owner SSH is not ready yet");
    expect(off.out).not.toContain("Remote Login");
  });
  test("without a daemon the status is an error, never ready", async () => {
    const r = await cli(["ssh", "status", "--json"], {});
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("ready");
  });
});
