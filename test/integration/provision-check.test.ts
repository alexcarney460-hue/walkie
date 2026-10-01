// WALK-67 lane 8, round 2 (review findings 4 and 5a): before the question and before any root work, the installer asks the
// machine's OWN daemon whether it would accept the owner's SSH packet, and the daemon answers without spending it. A packet
// it would refuse (a bad signature, expired, another team, owner, person or invite, already used) is caught then, so no
// administrator step runs for it. Real daemons in a Cluster: a real owner link, a real fresh machine that joined with it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WalkieError } from "../../src/client/index.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { consentText } from "../../src/daemon/provision/consent.ts";
import { readGrant } from "../../src/daemon/provision/grant.ts";
import { hasOwnerKey } from "../../src/daemon/ssh/authorized-keys.ts";
import { decodeOwnerSshGrant, mintOwnerSshGrant, type OwnerSshGrant } from "../../src/daemon/ssh/grant.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { echoServer, profile, publicKey } from "../helpers/ssh-team.ts";

setDefaultTimeout(120_000);
let sshd: Awaited<ReturnType<typeof echoServer>>;
beforeAll(async () => { sshd = await echoServer(); });
afterAll(async () => { await sshd?.close(); });

interface World { cluster: Cluster; owner: TestNode; fresh: TestNode; person: string; packet: OwnerSshGrant }

async function world(): Promise<World> {
  const cluster = new Cluster();
  const person = join(cluster.root, "person-home");
  mkdirSync(person);
  const owner = await cluster.add({ name: "lead", login: "-", hostname: "lead-mac", direct: true });
  const first = await cluster.add({ name: "first", login: "-", hostname: "first-mac", direct: true });
  const fresh = await cluster.add({ name: "fresh", login: "-", hostname: "fresh-box", direct: true, sshUserHome: person, sshPort: sshd.port });
  await owner.client().init("acme", "alex");
  expect((await first.client().join((await owner.client().inviteCode("arvid", "member")).code)).admitted).toBe(true);
  const minted = await owner.client().addMachine("arvid");
  expect((await fresh.client().join(minted.code)).admitted).toBe(true);
  await waitFor(() => fresh.d.core.roster.nodes.has(owner.d.nodeId), { what: "the fresh machine's roster" });
  return { cluster, owner, fresh, person, packet: decodeOwnerSshGrant(minted.owner_ssh as string) };
}

const refusal = async (p: Promise<unknown>): Promise<WalkieError> => { try { await p; } catch (e) { return e as WalkieError; } throw new Error("expected a refusal"); };
const nothingSpent = (w: World): void => {
  expect(existsSync(join(w.fresh.home, "owner-ssh-packets-used.json"))).toBe(false);
  expect(readGrant(w.fresh.home)).toBeNull();
  expect(hasOwnerKey(w.person, w.packet.team_id, w.packet.owner_handle, w.packet.public_key)).toBe(false);
};
const grantBody = (w: World, packet: OwnerSshGrant) => ({ owner_node: w.owner.d.nodeId, launchers: ["@alex"], seat_cap: 4, profiles: [profile], company_mode: true,
  owner_ssh: packet, consent_version: 1, consented: true, consent_text: consentText("alex", ["@alex"], 4, [profile], undefined, packet),
  confirmation: { surface: "cli", typed_phrase: "yes" } });

describe("the daemon checks a packet without spending it", () => {
  test("a good packet is usable, any number of times, and nothing is recorded, spent or installed", async () => {
    const w = await world();
    try {
      for (let i = 0; i < 2; i++) {
        const r = await w.fresh.client().provisionCheck({ owner_ssh: w.packet });
        expect(r.owner_ssh).toBe("usable");
        expect(typeof r.root_marker).toBe("boolean");
        expect(typeof r.ssh_server).toBe("boolean");
      }
      nothingSpent(w);
      // The checked packet is still good: the real grant spends it, once.
      await w.fresh.client().request("POST", "/v1/provision/grant", grantBody(w, w.packet));
      expect(readGrant(w.fresh.home)?.ssh_state).toBe("active");
      // A retry of the same command after the grant stands is still fine (it is THIS machine's own grant), ...
      expect((await w.fresh.client().provisionCheck({ owner_ssh: w.packet })).owner_ssh).toBe("recorded");
      // ... but once the grant is revoked the packet is used up for good.
      await w.fresh.client().provisionRevoke();
      expect((await refusal(w.fresh.client().provisionCheck({ owner_ssh: w.packet }))).code).toBe("owner_ssh_spent");
    } finally { await w.cluster.close(); }
  });

  test("with no packet it only reports what the administrator step has to do", async () => {
    const w = await world();
    try {
      const r = await w.fresh.client().provisionCheck({});
      expect(r.owner_ssh).toBe("none");
      expect(r.root_marker).toBe(false); // nothing installed the marker yet
      nothingSpent(w);
    } finally { await w.cluster.close(); }
  });

  test("every bad-packet case is refused with its own code, and none of them spends, records or installs anything", async () => {
    const w = await world();
    try {
      const p = w.packet;
      const stranger = generateKeys();
      const second = decodeOwnerSshGrant((await w.owner.client().addMachine("arvid")).owner_ssh as string); // a different link for the same person
      const cases: Array<[string, OwnerSshGrant, string]> = [
        ["a forged signature", { ...p, signature: Buffer.alloc(64, 9).toString("base64") }, "owner_ssh_invalid"],
        ["an expired packet", mintOwnerSshGrant(w.owner.d.core.keys, { team_id: p.team_id, owner_handle: p.owner_handle, recipient: p.recipient, invite_id: p.invite_id, public_key: p.public_key, expires_at: Date.now() - 1000 }), "owner_ssh_invalid"],
        ["another team", mintOwnerSshGrant(w.owner.d.core.keys, { team_id: "ffffffffffffffff", owner_handle: p.owner_handle, recipient: p.recipient, invite_id: p.invite_id, public_key: p.public_key, expires_at: p.expires_at }), "owner_ssh_mismatch"],
        ["another person", mintOwnerSshGrant(w.owner.d.core.keys, { team_id: p.team_id, owner_handle: p.owner_handle, recipient: "kira", invite_id: p.invite_id, public_key: p.public_key, expires_at: p.expires_at }), "owner_ssh_mismatch"],
        ["another owner handle", mintOwnerSshGrant(w.owner.d.core.keys, { team_id: p.team_id, owner_handle: "mallory", recipient: p.recipient, invite_id: p.invite_id, public_key: p.public_key, expires_at: p.expires_at }), "owner_ssh_mismatch"],
        ["an invite that did not admit this machine (it already joined with another link)", second, "owner_ssh_invite"],
        ["an owner node that is not in the roster", mintOwnerSshGrant(stranger, { team_id: p.team_id, owner_handle: p.owner_handle, recipient: p.recipient, invite_id: p.invite_id, public_key: publicKey(), expires_at: p.expires_at }), "owner_required"],
      ];
      for (const [name, packet, code] of cases) {
        const e = await refusal(w.fresh.client().provisionCheck({ owner_ssh: packet }));
        expect([name, e.code]).toEqual([name, code]);
        nothingSpent(w);
      }
      // After all of those the real packet still works: nothing was consumed.
      expect((await w.fresh.client().provisionCheck({ owner_ssh: p })).owner_ssh).toBe("usable");
      await w.fresh.client().request("POST", "/v1/provision/grant", grantBody(w, p));
      expect(readGrant(w.fresh.home)?.ssh_state).toBe("active");
    } finally { await w.cluster.close(); }
  });

  test("the grant route and the check agree on every refusal (they share one set of rules)", async () => {
    const w = await world();
    try {
      const p = w.packet;
      const forged = { ...p, signature: Buffer.alloc(64, 7).toString("base64") };
      const checkCode = (await refusal(w.fresh.client().provisionCheck({ owner_ssh: forged }))).code;
      const grantCode = (await refusal(w.fresh.client().request("POST", "/v1/provision/grant", grantBody(w, forged)))).code;
      expect(grantCode).toBe(checkCode);
      const second = decodeOwnerSshGrant((await w.owner.client().addMachine("arvid")).owner_ssh as string);
      expect((await refusal(w.fresh.client().request("POST", "/v1/provision/grant", grantBody(w, second)))).code)
        .toBe((await refusal(w.fresh.client().provisionCheck({ owner_ssh: second }))).code);
    } finally { await w.cluster.close(); }
  });

  test("it is local and a person's alone: an agent is refused, and a body with anything else in it is invalid", async () => {
    const w = await world();
    try {
      expect((await refusal(w.fresh.client("agent").provisionCheck({ owner_ssh: w.packet }))).code).toBe("person_only");
      expect((await refusal(w.fresh.client().request("POST", "/v1/provision/check", { owner_ssh: w.packet, extra: true }))).code).toBe("invalid");
      expect((await refusal(w.fresh.client().request("POST", "/v1/provision/check", { owner_ssh: { ...w.packet, signature: "" } }))).code).toBe("invalid");
      nothingSpent(w);
    } finally { await w.cluster.close(); }
  });
});

