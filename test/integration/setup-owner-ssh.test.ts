// WALK-67 lane 8, end to end on the terminal path with REAL daemons: the owner mints an add-machine link (a real
// invite and a real signed owner SSH packet), a fresh machine joins with the invite, and the company step that
// `walkie setup --company-machine --invite <code> --owner-ssh <packet>` runs asks its one question, posts the one
// grant to the machine's own daemon (which verifies the owner's signature, the invite that admitted the machine, the
// exact consent text and the built-in profile version), installs the owner's key, and reports SSH ready only from the
// daemon's status. The sshd is a loopback echo server and the person's SSH home a scratch directory; the one system
// seam stubbed is the "server answers on 127.0.0.1:22" probe (nothing listens on 22 here).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../../src/cli/args.ts";
import type { Ctx } from "../../src/cli/context.ts";
import type { SshStatus } from "../../src/cli/commands/doctor.ts";
import { companyConsentText, teamAgentsStep, type TeamAgentsDeps } from "../../src/cli/commands/team-agents.ts";
import type { SshFinal } from "../../src/cli/ssh-ready.ts";
import { readGrant } from "../../src/daemon/provision/grant.ts";
import { hasOwnerKey } from "../../src/daemon/ssh/authorized-keys.ts";
import { decodeOwnerSshGrant, encodeOwnerSshGrant } from "../../src/daemon/ssh/grant.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { echoServer } from "../helpers/ssh-team.ts";
import { noKeychainSeats } from "../helpers/no-keychain.ts";

setDefaultTimeout(120_000);
const BOOLEANS = new Set(["allow-team-agents", "no-team-agents", "for-agent", "seat-users", "same-user", "company-machine"]);
let sshd: Awaited<ReturnType<typeof echoServer>>;
beforeAll(async () => { sshd = await echoServer(); });
afterAll(async () => { await sshd?.close(); });

interface World { cluster: Cluster; owner: TestNode; fresh: TestNode; person: string; code: string; encoded: string; handle: string }

/** An owner, an existing member machine, and a FRESH machine that joined with the add-machine invite. */
async function world(): Promise<World> {
  const cluster = new Cluster();
  const person = join(cluster.root, "person-home");
  mkdirSync(person);
  const owner = await cluster.add({ name: "lead", login: "-", hostname: "lead-mac", direct: true });
  const first = await cluster.add({ name: "first", login: "-", hostname: "first-mac", direct: true });
  const fresh = await cluster.add({ name: "fresh", login: "-", hostname: "fresh-box", direct: true, sshUserHome: person, sshPort: sshd.port, seats: noKeychainSeats(join(cluster.root, "fresh-home")) });
  await owner.client().init("acme", "alex");
  expect((await first.client().join((await owner.client().inviteCode("arvid", "member")).code)).admitted).toBe(true);
  const minted = await owner.client().addMachine("arvid");
  expect((await fresh.client().join(minted.code)).admitted).toBe(true);
  await waitFor(() => fresh.d.core.roster.nodes.has(owner.d.nodeId), { what: "the fresh machine's roster" });
  return { cluster, owner, fresh, person, code: minted.code, encoded: minted.owner_ssh as string, handle: "arvid" };
}

const statusOf = (w: World) => async (): Promise<SshStatus> => {
  const real = await w.fresh.client().request<SshStatus>("GET", "/v1/ssh/status");
  // Nothing listens on 127.0.0.1:22 on this machine: that one fact is stood in for; the key and the gate are the daemon's own.
  return { ...real, server: { enabled: true, detail: "SSH server responds on 127.0.0.1" } };
};

function run(w: World, argv: string[], over: Partial<TeamAgentsDeps> = {}) {
  const lines: string[] = [];
  const asked: string[] = [];
  const results: SshFinal[] = [];
  const ctx: Ctx & { lines: string[] } = { args: parseArgs(argv, BOOLEANS), json: false, forAgent: false, agentMarker: () => null, lines,
    client: () => { throw new Error("unused"); }, out: (s) => lines.push(s), err: (s) => lines.push(s) };
  const deps: TeamAgentsDeps = {
    interactive: true, ask: async (q) => { asked.push(q); return "yes"; }, checkRuntime: async () => ({ installed: true, loggedIn: true }),
    installSeatUsers: async () => true, readGrant: async () => readGrant(w.fresh.home),
    // Walkie's own unit is what answers on the stood-in 22: a server that is not Walkie's is never used (src/cli/ssh-foreign.ts).
    ssh: { platform: "linux", read: statusOf(w), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now, timeoutMs: 30_000, pollMs: 500, walkieUnit: () => true },
    onSsh: (r) => results.push(r), ...over,
  };
  return { ctx, asked, results, step: () => teamAgentsStep(ctx, w.fresh.client(), deps, () => undefined) };
}

describe("the terminal company step against a real daemon", () => {
  test("a real link's packet rides in the one consent: granted, key installed, SSH ready from the daemon's own status", async () => {
    const w = await world();
    try {
      const argv = ["--company-machine", "--invite", w.code, "--owner-ssh", w.encoded];
      const r = run(w, argv);
      expect(await r.step()).toBe("allowed");
      const text = companyConsentText("alex", ["@alex"], 4, decodeOwnerSshGrant(w.encoded));
      expect(r.asked).toEqual([`${text} (type yes/N)`]); // one question, the packet's own consent text
      const grant = readGrant(w.fresh.home);
      expect(grant?.owner_ssh).toEqual(decodeOwnerSshGrant(w.encoded));
      expect([grant?.ssh_state, grant?.consent_text === text]).toEqual(["active", true]);
      const packet = decodeOwnerSshGrant(w.encoded);
      expect(hasOwnerKey(w.person, packet.team_id, packet.owner_handle, packet.public_key)).toBe(true);
      expect(r.results).toEqual([{ state: "ready" }]);
      const out = r.ctx.lines.join("\n");
      expect(out).toContain("owner SSH is ready");
      expect(out).not.toContain(w.encoded);
      expect(out).not.toContain(packet.signature);
    } finally { await w.cluster.close(); }
  });

  test("a retry of the same command after the grant stands resumes onto the same packet and reads ready again", async () => {
    const w = await world();
    try {
      const argv = ["--company-machine", "--invite", w.code, "--owner-ssh", w.encoded];
      expect(await run(w, argv).step()).toBe("allowed");
      const again = run(w, argv);
      expect(await again.step()).toBe("allowed");
      expect(again.results).toEqual([{ state: "ready" }]);
    } finally { await w.cluster.close(); }
  });

  test("a packet whose signature the daemon refuses: said plainly, nothing is recorded or installed, SSH is never ready", async () => {
    const w = await world();
    try {
      const real = decodeOwnerSshGrant(w.encoded);
      const forged = encodeOwnerSshGrant({ ...real, signature: Buffer.alloc(64, 9).toString("base64") });
      const r = run(w, ["--company-machine", "--invite", w.code, "--owner-ssh", forged]);
      expect(await r.step()).toBe("refused");
      const out = r.ctx.lines.join("\n");
      expect(out).toContain("signature or expiry did not verify");
      expect(out).toContain("Ask the owner for a new add-machine link");
      expect(readGrant(w.fresh.home)).toBeNull();
      expect(hasOwnerKey(w.person, real.team_id, real.owner_handle, real.public_key)).toBe(false);
      expect(r.results).toEqual([]);
    } finally { await w.cluster.close(); }
  });

  test("review finding 4: a machine that already joined, given a later link's packet, is told what to do BEFORE the question and before any root work", async () => {
    const w = await world();
    try {
      const later = await w.owner.client().addMachine("arvid"); // another add-machine link for the same person
      const batches: unknown[] = [];
      const root = { markerPresent: () => false, run: async (need: unknown) => { batches.push(need); return { marker: true, ssh: "installed" as const }; } };
      const r = run(w, ["--company-machine", "--invite", later.code, "--owner-ssh", later.owner_ssh as string], { root });
      expect(await r.step()).toBe("refused");
      const out = r.ctx.lines.join("\n");
      expect(out).toContain("this machine already joined with another link; the owner must remove it from the team and add it again");
      expect(out).not.toContain("Ask the owner for a new add-machine link"); // a new link can never work on this machine
      expect([r.asked, batches, readGrant(w.fresh.home), r.results]).toEqual([[], [], null, []]);
      // The first link's own packet is still good: the check spent nothing.
      const again = run(w, ["--company-machine", "--invite", w.code, "--owner-ssh", w.encoded], { root });
      expect(await again.step()).toBe("allowed");
      expect(batches).toHaveLength(1);
    } finally { await w.cluster.close(); }
  });

  test("a packet whose signature the daemon refuses never reaches a root batch", async () => {
    const w = await world();
    try {
      const real = decodeOwnerSshGrant(w.encoded);
      const forged = encodeOwnerSshGrant({ ...real, signature: Buffer.alloc(64, 5).toString("base64") });
      const batches: unknown[] = [];
      const root = { markerPresent: () => false, run: async (need: unknown) => { batches.push(need); return { marker: true, ssh: "installed" as const }; } };
      const r = run(w, ["--company-machine", "--invite", w.code, "--owner-ssh", forged], { root });
      expect(await r.step()).toBe("refused");
      expect([r.asked, batches]).toEqual([[], []]);
    } finally { await w.cluster.close(); }
  });

  test("a damaged packet is dropped before the question: the consent leaves SSH out and the grant carries none", async () => {
    const w = await world();
    try {
      const r = run(w, ["--company-machine", "--invite", w.code, "--owner-ssh", w.encoded.slice(0, -4)]);
      expect(await r.step()).toBe("allowed");
      expect(r.asked).toEqual([`${companyConsentText("alex", ["@alex"], 4)} (type yes/N)`]);
      expect(r.ctx.lines.join("\n")).toContain("This link can't turn on owner SSH");
      const grant = readGrant(w.fresh.home);
      expect(grant?.owner_ssh).toBeUndefined();
      expect(r.results).toEqual([]);
    } finally { await w.cluster.close(); }
  });
});
