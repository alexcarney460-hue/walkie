// WALK-67 lane 8, round 2 (review finding 3): a refusal that is THIS machine's to fix says so, with the real problem named,
// and the same link still works afterwards. Only a real key-install failure is `owner_key_install_failed`; a root marker
// that is not what Walkie installed is `root_marker_invalid` with its own message (it used to be mislabelled as a key
// failure), and an unreadable packet-use record names its file. Real daemons in a Cluster, scratch homes only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WalkieError } from "../../src/client/index.ts";
import { consentText } from "../../src/daemon/provision/consent.ts";
import { readGrant } from "../../src/daemon/provision/grant.ts";
import { enrollmentPath, requireEnrollmentRoot, RootMarkerInvalid, RootMarkerRequired, setTestEnrollmentRoot, writeRootMarker } from "../../src/daemon/provision/root-marker.ts";
import { hasOwnerKey } from "../../src/daemon/ssh/authorized-keys.ts";
import { decodeOwnerSshGrant, type OwnerSshGrant } from "../../src/daemon/ssh/grant.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { echoServer, profile } from "../helpers/ssh-team.ts";

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
const body = (w: World, packet?: OwnerSshGrant) => ({ owner_node: w.owner.d.nodeId, launchers: ["@alex"], seat_cap: 4, profiles: [profile], company_mode: true,
  ...(packet ? { owner_ssh: packet } : {}), consent_version: 1, consented: true,
  consent_text: consentText("alex", ["@alex"], 4, [profile], undefined, packet), confirmation: { surface: "cli", typed_phrase: "yes" } });
const used = (w: World): string => join(w.fresh.home, "owner-ssh-packets-used.json");
/** Nothing is recorded as spent: no record, or one with no entries (a packet given back leaves an empty record). */
const nothingSpent = (w: World): boolean => !existsSync(used(w)) || (JSON.parse(readFileSync(used(w), "utf8")) as string[]).length === 0;

describe("a root marker that is not what Walkie installed", () => {
  test("is root_marker_invalid with its own message (never a key failure), spends nothing, and the same packet works once it is fixed", async () => {
    const w = await world();
    try {
      writeRootMarker(w.fresh.home);
      const marker = enrollmentPath(w.fresh.home);
      chmodSync(marker, 0o666); // tampered: not mode 0644 any more
      const e = await refusal(w.fresh.client().request("POST", "/v1/provision/grant", body(w, w.packet)));
      expect(e.code).toBe("root_marker_invalid");
      expect(e.status).toBe(409);
      expect(e.message).toContain(marker);
      expect(e.message).toContain("have an administrator fix or remove it");
      expect(e.message).toContain("run the same command again");
      expect(e.message).not.toContain("owner key");
      expect([nothingSpent(w), readGrant(w.fresh.home), hasOwnerKey(w.person, w.packet.team_id, w.packet.owner_handle, w.packet.public_key)]).toEqual([true, null, false]);
      // Seats-only consent meets the same marker and says the same thing.
      expect((await refusal(w.fresh.client().request("POST", "/v1/provision/grant", body(w)))).code).toBe("root_marker_invalid");
      // The person fixes it (here: the mode; in life: removes the file and the administrator step installs a fresh one) and runs the same command again.
      chmodSync(marker, 0o644);
      await w.fresh.client().request("POST", "/v1/provision/grant", body(w, w.packet));
      expect(readGrant(w.fresh.home)?.ssh_state).toBe("active");
    } finally { await w.cluster.close(); }
  });

  test("the marker's typed errors tell 'missing' from 'not what Walkie installed'", () => {
    const root = mkdtempSync(join(tmpdir(), "walkie-marker-root-"));
    const home = join(root, "home");
    try {
      mkdirSync(home);
      // A real (non-test) home with no marker: the system root is only looked at, never written.
      expect(() => requireEnrollmentRoot(join(root, "no-such-home-for-the-test"))).toThrow(RootMarkerRequired);
      setTestEnrollmentRoot(home, join(root, "enrollment"));
      writeRootMarker(home);
      writeFileSync(enrollmentPath(home), "{\"company_mode\":false}\n", { mode: 0o644 });
      expect(() => requireEnrollmentRoot(home)).toThrow(RootMarkerInvalid);
      expect(() => requireEnrollmentRoot(home)).not.toThrow(RootMarkerRequired);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("only a real key-install failure is owner_key_install_failed", () => {
  test("authorized_keys that cannot be touched is one, with the real reason in the message, and the same packet works after the fix", async () => {
    const w = await world();
    try {
      const keys = join(w.person, ".ssh", "authorized_keys");
      mkdirSync(keys, { recursive: true }); // authorized_keys is a directory
      const e = await refusal(w.fresh.client().request("POST", "/v1/provision/grant", body(w, w.packet)));
      expect(e.code).toBe("owner_key_install_failed");
      expect(e.message).toContain("owner key could not be installed");
      expect(nothingSpent(w)).toBe(true);
      rmSync(keys, { recursive: true, force: true });
      await w.fresh.client().request("POST", "/v1/provision/grant", body(w, w.packet));
      expect(readGrant(w.fresh.home)?.ssh_state).toBe("active");
    } finally { await w.cluster.close(); }
  });
});

describe("a packet-use record that cannot be read or written", () => {
  test("is owner_ssh_record naming the file and the reason, for the grant and for the check, and nothing is installed", async () => {
    const w = await world();
    try {
      writeFileSync(used(w), "this is not json\n", { mode: 0o600 });
      const g = await refusal(w.fresh.client().request("POST", "/v1/provision/grant", body(w, w.packet)));
      expect(g.code).toBe("owner_ssh_record");
      expect(g.status).toBe(409);
      expect(g.message).toContain("owner-ssh-packets-used.json");
      expect(hasOwnerKey(w.person, w.packet.team_id, w.packet.owner_handle, w.packet.public_key)).toBe(false);
      const c = await refusal(w.fresh.client().provisionCheck({ owner_ssh: w.packet }));
      expect(c.code).toBe("owner_ssh_record");
      expect(c.message).toContain("owner-ssh-packets-used.json");
      rmSync(used(w));
      await w.fresh.client().request("POST", "/v1/provision/grant", body(w, w.packet));
      expect(readGrant(w.fresh.home)?.ssh_state).toBe("active");
    } finally { await w.cluster.close(); }
  });
});
