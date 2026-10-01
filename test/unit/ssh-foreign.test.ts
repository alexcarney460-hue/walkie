// Final review A, MEDIUM: on Linux and WSL, when an SSH server that is not Walkie's already answers on 127.0.0.1:22, Walkie
// does not use it. The consent describes Walkie's OWN loopback SSH service (the walkie-sshd unit), so a stock sshd that
// listens on every interface must never be what an owner's tunnel reaches, and SSH must never be called ready through it.
// This file is the detection itself; the flows that act on it (setup, `walkie provision grant`, the Windows bootstrap and
// `walkie ssh enable`) have their own tests. Port 22 is privileged and Remote Login owns it on a Mac, so a loopback listener
// on an ephemeral port stands in for it: the daemon's own reading of that port (sshServerStatus, the Linux probe) is what
// the CLI gets, exactly as it does from GET /v1/ssh/status.
import { afterEach, describe, expect, test } from "bun:test";
import type { SshStatus } from "../../src/cli/commands/doctor.ts";
import { FOREIGN_SSH_AFTER_CONSENT, FOREIGN_SSH_NOTE, FOREIGN_SSH_WHY, foreignSshServer, ownerSshUnlessForeign, walkieSshAnswers } from "../../src/cli/ssh-foreign.ts";
import { realSshStepDeps } from "../../src/cli/ssh-enroll.ts";
import { realServerProbe, sshServerStatus } from "../../src/daemon/ssh/server.ts";
import { encodeOwnerSshGrant, mintOwnerSshGrant } from "../../src/daemon/ssh/grant.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { publicKey } from "../helpers/ssh-team.ts";

const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => { for (const s of servers) s.stop(true); servers.length = 0; });

/** A loopback listener that sends a stock OpenSSH banner: "an SSH server on port 22" that is not Walkie's. */
function stockSshd(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { s.write("SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13\r\n"); }, data() {}, close() {}, error() {} } });
  servers.push(server);
  return server.port;
}
/** A port nothing listens on. */
function closedPort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() {}, data() {}, close() {}, error() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

/** What GET /v1/ssh/status says on Linux about that port: the daemon's own probe, not a fixture. */
const readingOf = (port: number, platform: NodeJS.Platform = "linux") => async (): Promise<SshStatus> =>
  ({ owner_key_present: false, tunnel_allowed: false, reason: "grant_absent", server: await sshServerStatus(port, { ...realServerProbe, platform }) });

describe("foreignSshServer: an SSH server answers on 127.0.0.1:22 and it is not Walkie's", () => {
  test("a stock sshd answering, with no Walkie SSH unit on the machine, is not Walkie's", async () => {
    expect(await foreignSshServer({ platform: "linux", read: readingOf(stockSshd()), walkieUnit: () => false })).toBe(true);
  });
  test("what the CLI does not know reads as not Walkie's: a missing unit hint never vouches for a server", async () => {
    expect(await foreignSshServer({ platform: "linux", read: readingOf(stockSshd()) })).toBe(true);
  });
  test("Walkie's own unit installed: the server that answers is Walkie's (running unknown, or running)", async () => {
    const port = stockSshd();
    expect(await foreignSshServer({ platform: "linux", read: readingOf(port), walkieUnit: () => true })).toBe(false);
    expect(await foreignSshServer({ platform: "linux", read: readingOf(port), walkieUnit: () => true, walkieActive: () => true })).toBe(false);
  });
  test("an installed unit that is NOT running does not vouch for whatever answers in its place", async () => {
    expect(await foreignSshServer({ platform: "linux", read: readingOf(stockSshd()), walkieUnit: () => true, walkieActive: () => false })).toBe(true);
  });
  test("nothing answering is not a foreign server: there is nothing to refuse, and the install may proceed", async () => {
    expect(await foreignSshServer({ platform: "linux", read: readingOf(closedPort()), walkieUnit: () => false })).toBe(false);
  });
  test("a status that cannot be read is not a reason to drop SSH: the install script itself refuses a port 22 that is taken", async () => {
    expect(await foreignSshServer({ platform: "linux", read: async () => { throw new Error("daemon_unreachable"); }, walkieUnit: () => false })).toBe(false);
  });
  test("only Linux and WSL (which is Linux): macOS has Walkie's own service on 22022, and Windows runs WSL", async () => {
    const port = stockSshd();
    for (const platform of ["darwin", "win32"] as const) {
      expect([platform, await foreignSshServer({ platform, read: readingOf(port, platform), walkieUnit: () => false })]).toEqual([platform, false]);
    }
  });
  test("the real step deps claim no unit and no running service off Linux, and have both answers on Linux", () => {
    const deps = realSshStepDeps({ request: async () => ({}) } as never);
    expect(typeof deps.walkieUnit).toBe("function");
    expect(typeof deps.walkieActive).toBe("function");
    if (process.platform !== "linux") {
      expect(deps.walkieUnit?.()).toBe(false);
      expect(deps.walkieActive?.()).toBe(false);
    }
  });
});

describe("what is said, and what is carried", () => {
  const keys = generateKeys();
  const packet = mintOwnerSshGrant(keys, { team_id: "0123456789abcdef", owner_handle: "alex", recipient: "arvid", invite_id: "a".repeat(32), public_key: publicKey(), expires_at: Date.now() + 60_000 });

  test("the reason is plain, names what stays off, and says what a later release does", () => {
    expect(FOREIGN_SSH_WHY).toBe("This machine already runs its own SSH server; Walkie's owner SSH needs its own service, which a later release adds alongside it; owner SSH stays off.");
    expect(FOREIGN_SSH_NOTE).toBe(`${FOREIGN_SSH_WHY} The consent below leaves SSH out.`);
  });
  test("a server found AFTER the consent was shown says the consent recorded leaves SSH out, though the one shown included it", () => {
    expect(FOREIGN_SSH_AFTER_CONSENT).toBe(`${FOREIGN_SSH_WHY} The consent recorded leaves SSH out, though the one shown above included it.`);
  });
  test("a foreign server drops the packet and says why; nothing else is carried", async () => {
    const said: string[] = [];
    const kept = await ownerSshUnlessForeign(packet, { platform: "linux", read: readingOf(stockSshd()), walkieUnit: () => false }, (line) => said.push(line), FOREIGN_SSH_NOTE);
    expect(kept).toBeUndefined();
    expect(said).toEqual([FOREIGN_SSH_NOTE]);
    expect(said.join("")).not.toContain(encodeOwnerSshGrant(packet));
  });
  test("Walkie's own service keeps the packet and says nothing", async () => {
    const said: string[] = [];
    const kept = await ownerSshUnlessForeign(packet, { platform: "linux", read: readingOf(stockSshd()), walkieUnit: () => true }, (line) => said.push(line), FOREIGN_SSH_NOTE);
    expect(kept).toEqual(packet);
    expect(said).toEqual([]);
  });
  test("no packet, or no way to look: nothing is read and the answer is unchanged", async () => {
    let reads = 0;
    const step = { platform: "linux" as const, read: async (): Promise<SshStatus> => { reads++; throw new Error("must not be asked"); } };
    expect(await ownerSshUnlessForeign(undefined, step, () => undefined, FOREIGN_SSH_NOTE)).toBeUndefined();
    expect(await ownerSshUnlessForeign(packet, undefined, () => undefined, FOREIGN_SSH_NOTE)).toEqual(packet);
    expect(reads).toBe(0);
  });
});

// Final review C, F3: what the administrator step reads to decide whether the install can be skipped. A server that answers on 22 and
// is not Walkie's must never read as "Walkie's service already answers", or the install is skipped and the packet rides on that server.
describe("walkieSshAnswers: the install is skipped only for WALKIE's own service", () => {
  test("Linux: an answering server counts only when it is Walkie's (its unit installed and not known to be stopped)", async () => {
    const read = readingOf(stockSshd());
    expect(await walkieSshAnswers({ platform: "linux", read, walkieUnit: () => true })).toBe(true);
    expect(await walkieSshAnswers({ platform: "linux", read, walkieUnit: () => true, walkieActive: () => true })).toBe(true);
    expect(await walkieSshAnswers({ platform: "linux", read, walkieUnit: () => true, walkieActive: () => false })).toBe(false);
    expect(await walkieSshAnswers({ platform: "linux", read, walkieUnit: () => false })).toBe(false);
    expect(await walkieSshAnswers({ platform: "linux", read })).toBe(false);
  });
  test("nothing answering is not Walkie's service answering, whatever the unit hints say", async () => {
    expect(await walkieSshAnswers({ platform: "linux", read: readingOf(closedPort()), walkieUnit: () => true, walkieActive: () => true })).toBe(false);
  });
  test("macOS: the status is Walkie's own service on its own port, so an answer is Walkie's, with no unit to ask about", async () => {
    expect(await walkieSshAnswers({ platform: "darwin", read: readingOf(stockSshd(), "darwin"), walkieUnit: () => false })).toBe(true);
    expect(await walkieSshAnswers({ platform: "darwin", read: readingOf(closedPort(), "darwin") })).toBe(false);
  });
  test("a status that cannot be read is the caller's to handle: it throws, and the step then runs the install, whose script refuses a taken port", async () => {
    await expect(walkieSshAnswers({ platform: "linux", read: async () => { throw new Error("daemon_unreachable"); }, walkieUnit: () => true })).rejects.toThrow("daemon_unreachable");
  });
});
