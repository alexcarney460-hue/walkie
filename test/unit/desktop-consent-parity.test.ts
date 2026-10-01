// WALK-67 lane 8: the macOS app builds its consent text and validates the owner SSH packet in Rust
// (desktop/src-tauri/src/join.rs); the daemon's grant route accepts only `consentText()` byte for byte, and its packet
// schema and bounds live in TypeScript. This test reads the Rust constants and renders them, so the two cannot drift
// apart unnoticed. (The Rust behaviour itself is covered by `cargo test`.)
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inviteId } from "../../src/daemon/invite.ts";
import { consentText } from "../../src/daemon/provision/consent.ts";
import { PROFILES } from "../../src/daemon/provision/profiles.ts";
import { decodeOwnerSshGrant, OwnerSshGrant } from "../../src/daemon/ssh/grant.ts";
import { ownerSshRefusal, ownerSshRefusalLine } from "../../src/cli/ssh-packet.ts";
import { describeRootBatch } from "../../src/cli/root-batch.ts";

const rust = readFileSync(join(import.meta.dir, "../../desktop/src-tauri/src/join.rs"), "utf8");

function constant(name: string): string {
  const match = new RegExp(`const ${name}: &str = "((?:[^"\\\\]|\\\\.)*)";`).exec(rust);
  if (!match) throw new Error(`join.rs has no const ${name}`);
  const text = match[1] as string;
  expect(text).not.toContain("\\"); // plain text only: no escapes to misread
  return text;
}

/** What join.rs's consent_text() renders: its three constants and the same placeholder fills. */
function rustConsent(owner: string, max: number, ssh: boolean): string {
  return `${constant("CONSENT_HEAD")}${ssh ? constant("CONSENT_SSH") : ""}${constant("CONSENT_TAIL")}`
    .replaceAll("{owner}", owner).replaceAll("{launchers}", `@${owner}`).replaceAll("{max}", String(max))
    .replaceAll("{profile}", /const DEVELOPER_PROFILE_VERSION: u32 = (\d+);/.exec(rust)?.[1] ?? "?");
}

const profile = { id: "developer-worker" as const, version: PROFILES["developer-worker"].version };
const packet = { team_id: "0123456789abcdef", owner_node: "fedcba9876543210", owner_handle: "boss", recipient: "alex", invite_id: "a".repeat(32),
  public_key: "ssh-ed25519 AAAA", expires_at: 1, signature: "sig" } as const;

describe("the macOS app's consent text is the daemon's, byte for byte", () => {
  test("without owner SSH", () => {
    for (const [owner, max] of [["alex", 4], ["boss", 1], ["kira-2", 64]] as const) {
      expect(rustConsent(owner, max, false)).toBe(consentText(owner, [`@${owner}`], max, [profile]));
    }
  });
  test("with owner SSH the sentence sits in the same place with the same words", () => {
    for (const [owner, max] of [["alex", 4], ["boss", 7]] as const) {
      expect(rustConsent(owner, max, true)).toBe(consentText(owner, [`@${owner}`], max, [profile], undefined, packet as never));
    }
    expect(rustConsent("boss", 4, true)).toContain("may sign in to this machine over SSH as your user, through Walkie");
  });
  test("item 8: the SSH sentence says what is true on all three platforms, and mentions Remote Login nowhere", () => {
    const text = consentText("boss", ["@boss"], 4, [profile], undefined, packet as never);
    expect(text).toContain("through Walkie, using a Walkie SSH service that listens only on this machine and accepts only key logins.");
    expect(text).not.toMatch(/Remote Login/i);
    expect(rustConsent("boss", 4, true)).toBe(text);
    expect(consentText("boss", ["@boss"], 4, [profile])).not.toContain("SSH");
  });
});

// Final review A: the service's AuthorizedKeysFile is the person's own ~/.ssh/authorized_keys, so any key already authorized for
// their account works on loopback, not only the owner's. The door is therefore described as accepting only KEY LOGINS, in the
// same words wherever a person is asked: the daemon's recorded text, the Rust constant, the join page, the Windows bootstrap.
describe("the SSH door is described in the same words in every copy of the consent", () => {
  const PHRASE = "accepts only key logins";
  const STALE = /accepts only (?:the owner(?:'|''|&rsquo;)s key|that key)/;
  const read = (path: string): string => readFileSync(join(import.meta.dir, "../..", path), "utf8");
  test("the daemon's text, the Rust constant, the join page (source and rendered) and the Windows bootstrap each say it", () => {
    const copies: Record<string, string> = {
      "src/daemon/provision/consent.ts (consentText)": consentText("boss", ["@boss"], 4, [profile], undefined, packet as never),
      "desktop/src-tauri/src/join.rs (CONSENT_SSH)": constant("CONSENT_SSH"),
      "site/src/join.html": read("site/src/join.html"),
      "site/join.html": read("site/join.html"),
      "scripts/windows/bootstrap.ps1": read("scripts/windows/bootstrap.ps1"),
    };
    for (const [where, text] of Object.entries(copies)) {
      expect([where, text.includes(PHRASE)]).toEqual([where, true]);
      expect([where, STALE.test(text)]).toEqual([where, false]);
    }
  });
  test("the daemon's text and the Rust constant are the same sentence, to the byte", () => {
    const sentence = (text: string): string => /using a Walkie SSH service[^.]*\./.exec(text)?.[0] ?? "";
    expect(sentence(constant("CONSENT_SSH"))).toBe(sentence(consentText("boss", ["@boss"], 4, [profile], undefined, packet as never)));
    expect(sentence(constant("CONSENT_SSH"))).toBe("using a Walkie SSH service that listens only on this machine and accepts only key logins.");
  });
  test("what is said before the administrator prompt, and in the app's own window, says it too (no copy still promises the owner's key alone)", () => {
    for (const need of [{ marker: true, sshLinux: true, sshMacos: false }, { marker: false, sshLinux: false, sshMacos: true }]) {
      const line = describeRootBatch(need);
      expect(line).toContain(PHRASE);
      expect(STALE.test(line)).toBe(false);
    }
    const ui = read("desktop/ui/app.js");
    expect(ui).toContain(PHRASE);
    expect(STALE.test(ui)).toBe(false);
  });
});

describe("the macOS app selects the profile version the daemon has built in", () => {
  test("DEVELOPER_PROFILE_VERSION is src/daemon/provision/profiles.ts's: the grant route refuses any other version", () => {
    expect(/const DEVELOPER_PROFILE_VERSION: u32 = (\d+);/.exec(rust)?.[1]).toBe(String(PROFILES["developer-worker"].version));
    expect(rust).toContain('"version": DEVELOPER_PROFILE_VERSION');
  });
});

describe("the macOS app validates the packet the way the daemon's schema and bounds say", () => {
  test("the eight fields the app requires are exactly the daemon's OwnerSshGrant fields", () => {
    const match = /const SSH_FIELDS: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(rust);
    expect(match).not.toBeNull();
    const fields = (match![2] as string).split(",").map((f) => f.trim().replaceAll('"', "")).filter(Boolean).sort();
    expect(Number(match![1])).toBe(fields.length);
    expect(fields).toEqual(Object.keys(OwnerSshGrant.shape).sort());
  });
  test("the length bound is the daemon's decoder bound: 1200 passes the shape check, 1201 is refused as an encoding", () => {
    expect(rust).toContain("const SSH_MAX_CHARS: usize = 1200;");
    expect(() => decodeOwnerSshGrant("A".repeat(1201))).toThrow("invalid owner SSH grant encoding");
    expect(() => decodeOwnerSshGrant("A".repeat(1200))).not.toThrow("invalid owner SSH grant encoding"); // fails later, as JSON
    expect(() => decodeOwnerSshGrant("")).toThrow("invalid owner SSH grant encoding");
  });
  test("the invite id the app derives is the daemon's: sha256 of the one-use secret, first 16 bytes in hex", () => {
    const pinned = /const ZERO_SECRET_ID: &str = "([0-9a-f]{32})";/.exec(rust)?.[1];
    expect(pinned).toBe(inviteId(new Uint8Array(16)));
    expect(rust).toContain("Sha256::digest(&invite[49..65])"); // bytes 49..65 are the secret in the invite layout (src/daemon/invite.ts)
  });
});

describe("the macOS app says every refusal of the owner's SSH packet the way the terminal does", () => {
  const armCodes = (fn: string): string[] => {
    const body = new RegExp(`pub fn ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(rust)?.[1] ?? "";
    return [...body.matchAll(/^\s*"([a-z_]+)"\s*=>/gm)].map((m) => m[1] as string).sort();
  };
  test("the codes the app has a reason for are the codes the terminal has a reason for", () => {
    const rustCodes = armCodes("ssh_refusal");
    const tsCodes = ["owner_ssh_invalid", "owner_ssh_mismatch", "owner_ssh_invite", "owner_ssh_spent", "owner_ssh_record", "owner_key_install_failed", "owner_required"].sort();
    expect(rustCodes).toEqual(tsCodes);
    for (const code of tsCodes) expect(ownerSshRefusal(code), code).toBeTruthy();
  });
  test("the app's sentences make the same distinctions: a new link, 'remove it and add it again', or 'fix it and open the same link again'", () => {
    // The terminal's wording, for the three kinds the app also separates.
    expect(ownerSshRefusalLine("owner_ssh_spent", "x")).toContain("Ask the owner for a new add-machine link");
    expect(ownerSshRefusalLine("owner_ssh_invite", "x")).toContain("the owner must remove it from the team and add it again");
    expect(ownerSshRefusalLine("owner_key_install_failed", "x")).toContain("the same link still works");
    expect(rust).toContain('"owner_ssh_invite" => Some("This Mac already joined with another link; the owner must remove it from the team and add it again.".into())');
    expect(rust).toContain("Ask the owner for a new add-machine link.");
    expect(rust).toContain("Fix that, then open the same link again: the same link still works.");
  });
});

describe("the macOS app's one administrator prompt carries no packet", () => {
  const elevate = readFileSync(join(import.meta.dir, "../../desktop/src-tauri/src/elevate.rs"), "utf8");
  test("the elevation module never names the packet, and builds exactly the root helper's argv this repo's CLI accepts", () => {
    const code = elevate.split("#[cfg(test)]")[0] as string;
    for (const word of ["owner_ssh", "OwnerSsh", "packet"]) expect(code.replace(/\/\/.*$/gm, ""), word).not.toContain(word);
    // `provision root-marker install <home> [ssh-macos]` is what src/cli/main.ts's arity gate permits.
    expect(code).toContain("provision root-marker install");
    expect(code).toContain('" ssh-macos"');
  });
});
