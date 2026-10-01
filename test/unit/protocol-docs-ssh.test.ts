// Final review B (docs, MUST): docs/PROTOCOL.md describes exactly what ships. The owner SSH tunnel dials 127.0.0.1:22022 on macOS
// (Walkie's own launchd service) and 127.0.0.1:22 on Linux and WSL, and POST /v1/provision/check is in the local route table.
// Each statement is checked against the code it describes, so a change to either one fails here until the other follows.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FOREIGN_SSH_AFTER_CONSENT, FOREIGN_SSH_NOTE, FOREIGN_SSH_WHY } from "../../src/cli/ssh-foreign.ts";
import { WALKIE_SSH_UNIT_PATH } from "../../src/daemon/ssh/enroll-linux.ts";
import { MACOS_SSH_PORT, sshServicePort } from "../../src/daemon/ssh/server.ts";

const ROOT = join(import.meta.dir, "../..");
const protocol = readFileSync(join(ROOT, "docs/PROTOCOL.md"), "utf8");
const rows = protocol.split("\n").filter((line) => line.startsWith("|"));
const rowFor = (method: string, path: string): string => {
  const found = rows.filter((row) => row.startsWith(`| ${method} | \`${path}\` |`));
  expect([method, path, found.length]).toEqual([method, path, 1]);
  return found[0] as string;
};

describe("the SSH tunnel's target port", () => {
  test("the code: Walkie's own service on 22022 on macOS, the machine's loopback sshd on 22 on Linux and WSL", () => {
    expect(MACOS_SSH_PORT).toBe(22022);
    expect(sshServicePort("darwin")).toBe(22022);
    expect(sshServicePort("linux")).toBe(22);
  });
  test("docs/PROTOCOL.md says exactly that for CONNECT /peer/v1/ssh, and no longer says 22 for every platform", () => {
    const row = rowFor("CONNECT", "/peer/v1/ssh");
    expect(row).toContain("127.0.0.1:22022 on macOS");
    expect(row).toContain("127.0.0.1:22 on Linux and WSL");
    expect(row).toContain("never Remote Login's port 22");
    expect(row).not.toContain("loopback SSH server, 127.0.0.1:22 (");
    expect(protocol).toContain("127.0.0.1:22022\n  on macOS, 127.0.0.1:22 on Linux and WSL"); // the framing paragraph says the same
    expect(protocol).not.toContain("raw bytes to the machine's loopback SSH server.");
  });
});

describe("POST /v1/provision/check in the local route table", () => {
  const routes = readFileSync(join(ROOT, "src/daemon/provision/routes.ts"), "utf8");
  test("the route exists in the daemon, and is the one the docs describe", () => {
    expect(routes).toContain('route("POST", "/v1/provision/check"');
    const row = rowFor("POST", "/v1/provision/check");
    for (const field of ["root_marker", "ssh_server", "owner_ssh", "owner_ssh?: OwnerSshGrant"]) expect([field, row.includes(field)]).toEqual([field, true]);
    for (const state of ["none", "usable", "recorded"]) expect(row).toContain(`"${state}"`);
    expect(row).toContain("person_only");
    expect(row).toContain("Spends, writes and installs nothing");
  });
  test("every error code the row names is one the route (or the grant rules it shares) can answer", () => {
    const checked = `${routes}\n${readFileSync(join(ROOT, "src/daemon/local-routes.ts"), "utf8")}`;
    for (const code of ["person_only", "root_forbidden", "no_team", "forbidden", "owner_required", "owner_ssh_invalid", "owner_ssh_mismatch", "owner_ssh_invite", "owner_ssh_spent", "owner_ssh_record"]) {
      expect([code, checked.includes(`"${code}"`)]).toEqual([code, true]);
    }
  });
  test("the row names every status the route can answer before it looks at the packet, requireTeam's `403 forbidden` (not an admitted member) included (final review C, F6)", () => {
    const row = rowFor("POST", "/v1/provision/check");
    const team = readFileSync(join(ROOT, "src/daemon/local-routes.ts"), "utf8");
    expect(team).toContain('throw new HttpError(409, "no_team"');
    expect(team).toContain('throw new HttpError(403, "forbidden", "this node is not an admitted member")');
    for (const answer of ["`403 person_only`", "`403 root_forbidden`", "`409 no_team`", "`403 forbidden` (this node is not an admitted member)"]) expect([answer, row.includes(answer)]).toEqual([answer, true]);
  });
  test("it sits in the local API's table (section 5), not among the peer routes", () => {
    const at = protocol.indexOf("| POST | `/v1/provision/check` |");
    expect(at).toBeGreaterThan(protocol.indexOf("## 5. Local API"));
    expect(at).toBeLessThan(protocol.indexOf("## 6. Agent safety contract"));
  });
});

// Final review C, F6 + F4: the docs said a server that is not Walkie's "is never used" as if the daemon enforced it, and that the Windows
// step "says why in plain words" where the person never saw it. They now say what happens: the ENROLLMENT checks (before the consent and
// again before the grant), the daemon's routes do not judge, and on Windows the closing summary carries the WSL step's sentence.
describe("a server that is not Walkie's: the docs say exactly what happens", () => {
  const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");
  const security = read("docs/SECURITY.md");
  const install = read("docs/INSTALL.md");
  const changelog = read("CHANGELOG.md");
  const section = (text: string, from: string, to: string): string => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

  test("PROTOCOL.md: the tunnel reaches whatever answers on 22; the guard is the enrollment's", () => {
    const row = rowFor("CONNECT", "/peer/v1/ssh");
    expect(row).not.toContain("is never used");
    expect(row).toContain("it does not look at what answers there");
    expect(row).toContain("whatever listens on that port is what the stream reaches");
    expect(row).toContain("`walkie setup --company-machine` and `walkie provision grant` check for one before the consent question and again after the typed yes");
    expect(row).toContain("the Windows/WSL step checks right before it records the consent");
    expect(row).toContain("each leaves owner SSH off on that machine");
  });
  test("SECURITY.md: the enrollment flows look twice, systemd decides what is Walkie's, and the daemon's routes do not judge", () => {
    const owner = section(security, "Optional owner SSH consent", "The packet reaches the machine");
    expect(owner).not.toContain("is never used, below");
    expect(owner).toContain("the enrollment flows never use a server that is not Walkie's");
    expect(owner).toContain("look before the question and again after the typed yes");
    expect(owner).toContain("systemctl show walkie-sshd.service");
    expect(owner).toContain(WALKIE_SSH_UNIT_PATH);
    expect(owner).toContain("These checks are in the enrollment flows, not in the daemon");
    expect(owner).toContain("the grant route, `GET /v1/ssh/status`");
    expect(owner).toContain("The administrator step skips an SSH install only for a server that is Walkie's");
    expect(owner).toContain(FOREIGN_SSH_WHY.replace(/^T/, "t").replace(/\.$/, ""));
  });
  test("INSTALL.md: the same, and the WSL case as it is (the script refuses, the grant leaves SSH out, the summary carries the WSL step's sentence)", () => {
    const terminal = section(install, "- **Terminal, Linux and macOS**", "- **Browser join page**");
    expect(terminal).not.toContain("is never used: owner SSH stays off");
    expect(terminal).toContain("the enrollment does not use an SSH server that is not Walkie's");
    expect(terminal).toContain("owner SSH stays off on that machine in this release");
    expect(install).toContain(FOREIGN_SSH_NOTE);
    expect(install).toContain(FOREIGN_SSH_AFTER_CONSENT.slice(FOREIGN_SSH_WHY.length + 1));
    expect(install).toContain("systemd, asked as you");
    const windows = section(install, "- **Windows with WSL**", "- **`walkie provision grant --owner-ssh <packet>`**");
    expect(windows).toContain("the install script refuses the taken port (the WSL root step exits 5");
    expect(windows).toContain("although PowerShell's consent, shown before the WSL half can look inside the Ubuntu, named it");
    expect(windows).toContain("on its own standard error");
    expect(windows).toContain("Owner SSH was left out of the consent recorded");
    expect(windows).toContain("PowerShell is untested");
    expect(windows).not.toContain("the enrollment continues without SSH (PowerShell's own consent text cannot know this beforehand)");
  });
  test("CHANGELOG.md says the same in one place, and does not say the daemon enforces it", () => {
    const entry = section(changelog, "## v0.2.0-pre.11", "## v0.2.0-pre.10.1");
    expect(entry).toContain("enrollment never uses an SSH server that is not Walkie's already answering on port 22");
    expect(entry).toContain("look before the consent question and again after the typed yes");
    expect(entry).toContain("The daemon's own routes (the grant, `GET /v1/ssh/status`, the tunnel) do not judge what answers on port 22");
    expect(entry).toContain("with the WSL step's own reason, not a request for a new add-machine link");
    expect(entry).not.toContain("an SSH server that is not Walkie's already answering on port 22 is never used");
  });
});
