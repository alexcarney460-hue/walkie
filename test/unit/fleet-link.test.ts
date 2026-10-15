// FLEET-LINK-1: the fleet link token (encode / decode / signature / tamper), its ids, what a person may paste, the
// commands every surface shows, and the hostname de-duplication a link's authority applies.
import { describe, expect, test } from "bun:test";
import { checkFleetLink, decodeFleetLink, encodeFleetLink, isFleetLink, linkId, linkTokenFrom, linkUseId, newLinkSecret } from "../../src/daemon/fleet-link.ts";
import { uniqueHostname } from "../../src/daemon/fleet-link-service.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { EMPTY_ROSTER, type NodeRec, type Roster } from "../../src/daemon/roster.ts";
import {
  FLEET_LINK_MAX_CHARS, fleetLinkCommand, fleetLinkUrl, fleetLinkWindowsCommand, tokenFromInput,
} from "../../src/protocol/fleet-link.ts";
import { INSTALL_URL, JOIN_URL } from "../../src/protocol/add-machine.ts";
import { isInviteCode } from "../../src/daemon/invite.ts";

const TEAM = "0123456789abcdef";
const owner = generateKeys();
const authority = generateKeys();
const EXP = Math.floor((Date.now() + 7 * 86_400_000) / 1000) * 1000;

function mint(over: Partial<{ handle: string; uses: number; approve: boolean; relay: string }> = {}) {
  const { secret, id } = newLinkSecret();
  const token = encodeFleetLink(owner, secret, {
    team: TEAM, authority: authority.pubkey, handle: over.handle ?? "ops", expires_at: EXP, uses: over.uses ?? 25,
    approve: over.approve ?? false, ...(over.relay ? { relay: over.relay } : {}),
  });
  return { token, id };
}

/** A roster where `owner`'s node belongs to an owner (enough for checkFleetLink). */
function roster(role: "owner" | "member" = "owner"): Roster {
  const node: NodeRec = { node_id: owner.nodeId, login: "direct:alex", hostname: "alex-mbp", pubkey: owner.pubkey, ip: "", port: 7458, revoked: false, transports: ["direct"] };
  return {
    ...EMPTY_ROSTER, team: { id: TEAM, name: "acme", founder: owner.nodeId, create_id: `${owner.nodeId}:1`, created_ts: 0 },
    members: new Map([["direct:alex", { login: "direct:alex", handle: "alex", role }]]), nodes: new Map([[owner.nodeId, node]]),
  };
}

describe("the token", () => {
  test("round-trips every field, and its id is the record's key (never the secret)", () => {
    const { token, id } = mint({ uses: 3, approve: true, relay: "https://use1-1.relay.n0.iroh-canary.iroh.link./" });
    expect(token.startsWith("wl1")).toBe(true);
    expect(token.length).toBeLessThanOrEqual(FLEET_LINK_MAX_CHARS);
    expect(isFleetLink(token)).toBe(true);
    expect(isInviteCode(token)).toBe(false); // never mistaken for a single-use invite
    const d = decodeFleetLink(token);
    if ("error" in d) throw new Error(d.error);
    expect([d.team, d.authority, d.issuer, d.handle, d.uses, d.approve, d.expires_at, d.id]).toEqual([TEAM, authority.pubkey, owner.nodeId, "ops", 3, true, EXP, id]);
    expect(d.relay).toBe("https://use1-1.relay.n0.iroh-canary.iroh.link./");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  test("unlimited (0) and the longest handle fit in 300 characters", () => {
    const { token } = mint({ uses: 0, handle: "a".repeat(24), relay: `https://${"r".repeat(40)}.example/` });
    expect(token.length).toBeLessThanOrEqual(FLEET_LINK_MAX_CHARS);
    const d = decodeFleetLink(token);
    expect("error" in d ? d.error : d.uses).toBe(0);
  });

  test("checkFleetLink: this team, signed by a node that is an owner's now", () => {
    const { token } = mint();
    expect(checkFleetLink(token, roster(), TEAM).ok).toBe(true);
    expect(checkFleetLink(token, roster(), "fedcba9876543210")).toEqual({ ok: false, reason: "link_wrong_team" });
    expect(checkFleetLink(token, roster("member"), TEAM)).toEqual({ ok: false, reason: "link_issuer_not_owner" });
    expect(checkFleetLink(token, EMPTY_ROSTER, TEAM)).toEqual({ ok: false, reason: "link_issuer_not_owner" });
  });

  test("any change to a signed byte fails the signature; any change to the shape is malformed", () => {
    const { token } = mint({ uses: 3 });
    const raw = Buffer.from(token.slice(3), "base64url");
    const at = 1 + 8 + 32 + 8 + 16 + 4 + 1; // the low byte of `uses`
    const more = Buffer.from(raw);
    more[at] = 200; // 3 → 200 uses
    expect(checkFleetLink(`wl1${more.toString("base64url")}`, roster(), TEAM)).toEqual({ ok: false, reason: "link_bad_signature" });
    const flags = Buffer.from(raw);
    flags[at + 1] = 0; // approve 0 is valid shape; flip approve on a no-approve link
    flags[at + 1] = 1;
    expect(checkFleetLink(`wl1${flags.toString("base64url")}`, roster(), TEAM)).toEqual({ ok: false, reason: "link_bad_signature" });
    expect(decodeFleetLink(token.slice(0, -4))).toEqual({ error: "link_malformed" });
    expect(decodeFleetLink(`${token}A`)).toEqual({ error: "link_malformed" });
    expect(decodeFleetLink(`wl2${token.slice(3)}`)).toEqual({ error: "link_malformed" });
    const badFlags = Buffer.from(raw);
    badFlags[at + 1] = 2;
    expect(decodeFleetLink(`wl1${badFlags.toString("base64url")}`)).toEqual({ error: "link_malformed" });
  });

  test("use ids are distinct per link and per machine, and shaped like invite ids (the chain's used set)", () => {
    const a = linkId(new Uint8Array(16).fill(1));
    const b = linkId(new Uint8Array(16).fill(2));
    expect(linkUseId(a, "0000000000000001")).not.toBe(linkUseId(a, "0000000000000002"));
    expect(linkUseId(a, "0000000000000001")).not.toBe(linkUseId(b, "0000000000000001"));
    expect(linkUseId(a, "0000000000000001")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("what a person pastes", () => {
  const { token } = mint();
  test("the token, the /join link, the command, wrapped lines", () => {
    expect(tokenFromInput(token)).toBe(token);
    expect(tokenFromInput(fleetLinkUrl(token, "v0.2.0-pre.5"))).toBe(token);
    expect(tokenFromInput(fleetLinkCommand(token, "v0.2.0-pre.5"))).toBe(token);
    expect(tokenFromInput(fleetLinkWindowsCommand(token, null))).toBe(token);
    // A mail client wrapped the token: joined again (the daemon's decoder confirms it), the rest of a line left out.
    expect(linkTokenFrom(`  ${token.slice(0, 60)}\n${token.slice(60)}  `)).toBe(token);
    expect(linkTokenFrom(`sh -s -- --join-link ${token.slice(0, 100)}\n  ${token.slice(100)}`)).toBe(token);
    expect(linkTokenFrom(`${token}\nthanks!`)).toBe(token); // joined with the next word doesn't decode: the word alone does
    expect(tokenFromInput(`${token}\n`)).toBe(token);
    expect(tokenFromInput("wk1AAAA")).toBe(null);
    expect(tokenFromInput("100.101.102.103")).toBe(null);
  });

  test("the commands and the link every surface shows", () => {
    expect(fleetLinkCommand(token, "v0.2.0-pre.5")).toBe(`curl -fsSL ${INSTALL_URL} | WALKIE_VERSION=v0.2.0-pre.5 sh -s -- --join-link ${token}`);
    expect(fleetLinkCommand(token, null)).toBe(`curl -fsSL ${INSTALL_URL} | sh -s -- --join-link ${token}`);
    expect(fleetLinkWindowsCommand(token, null)).toBe(`wsl -- sh -c "curl -fsSL ${INSTALL_URL} | sh -s -- --join-link ${token}"`);
    const url = fleetLinkUrl(token, "v0.2.0-pre.5");
    expect(url).toBe(`${JOIN_URL}#${token}&v=v0.2.0-pre.5`);
    expect(new URL(url).search).toBe(""); // nothing a server sees
  });
});

describe("hostname de-duplication", () => {
  const nodes = (names: string[]): Roster => {
    const r = roster();
    const m = new Map(r.nodes);
    names.forEach((h, i) => m.set(`00000000000000${String(i).padStart(2, "0")}`, {
      node_id: `00000000000000${String(i).padStart(2, "0")}`, login: "direct:alex", hostname: h, pubkey: owner.pubkey, ip: "", port: 7458, revoked: false,
    }));
    return { ...r, nodes: m };
  };

  test("a free name is kept; a taken one gets -2, -3, …; the machine's own record doesn't count", () => {
    expect(uniqueHostname(nodes(["build-01"]), "ubuntu", "ffffffffffffffff")).toBe("ubuntu");
    expect(uniqueHostname(nodes(["ubuntu"]), "ubuntu", "ffffffffffffffff")).toBe("ubuntu-2");
    expect(uniqueHostname(nodes(["ubuntu", "ubuntu-2"]), "Ubuntu.local", "ffffffffffffffff")).toBe("ubuntu-3");
    expect(uniqueHostname(nodes(["ubuntu"]), "ubuntu", "0000000000000000")).toBe("ubuntu");
    const long = "x".repeat(63);
    expect(uniqueHostname(nodes([long]), long, "ffffffffffffffff")).toBe(`${"x".repeat(61)}-2`);
  });
});
