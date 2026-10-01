// WALKIE-ADD-MACHINE-1: the site's /join page. The owner's link carries a one-time invite code (and the team's
// release) in the URL fragment. The page reads it, strips it from the address bar, shows the install command, and
// never sends the code anywhere. Tested here: fragment parsing, what the code says about itself (a real code minted
// by the daemon's invite module), the page states with a stand-in DOM, the command matching the daemon's, and
// the no-network guarantees (script source, page markup, the Vercel CSP).
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInvite } from "../../src/daemon/invite.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { encodeOwnerSshGrant, mintOwnerSshGrant } from "../../src/daemon/ssh/grant.ts";
import { addMachineCommand, addMachineLink, INSTALL_URL } from "../../src/protocol/add-machine.ts";
/** The release the site installs (scripts/install.sh DEFAULT_VERSION), which build.py links the package to. */
const INSTALLER_VERSION = readFileSync(join(import.meta.dir, "../../scripts/install.sh"), "utf8").match(/DEFAULT_VERSION="(v[^"]+)"/)![1];

interface JoinApi {
  handoff(code: string, yes: boolean, max: number, tag?: string | null, ssh?: string | null): string;
  parseFragment(hash: string): { code?: string; tag?: string | null; agents?: boolean; ssh?: string; sshDamaged?: boolean; error?: string };
  describe(code: string): { handle: string; role: string; expiresAt: number } | null;
  command(installUrl: string, code: string, tag: string | null, ssh?: string | null): string;
  run(env: { window: FakeWindow; document: FakeDocument; now: number }): string | null;
  start(win: FakeWindow, doc: FakeDocument, clock: () => number): void;
  clampSeatMax(raw: unknown): number;
  SEAT_MAX_DEFAULT: number;
  SEAT_MAX_MIN: number;
  SEAT_MAX_MAX: number;
}
const SITE = join(import.meta.dir, "..");
const page = createRequire(import.meta.url)(join(SITE, "assets", "join.js")) as JoinApi;

const NOW = 1_790_000_000_000;
const keys = generateKeys();
const mint = (handle = "arvid", now = NOW, role: "owner" | "member" | "observer" = "member") => createInvite(keys, {
  team: "0123456789abcdef", authority: keys.pubkey, handle, role, now, pos: 7, relay: "https://use1-1.relay.n0.iroh-canary.iroh.link./",
}).code;

// ---- a stand-in DOM: just what join.js touches -----------------------------------------------------------------------

class El {
  textContent = "";
  hidden = false;
  disabled = false;
  open = false;
  checked = false;
  value = "";
  readonly classes = new Set<string>();
  readonly classList = { toggle: (c: string, on: boolean) => { if (on) this.classes.add(c); else this.classes.delete(c); } };
  readonly listeners: Record<string, Array<() => void>> = {};
  clicks = 0;
  constructor(readonly attrs: Record<string, string>, readonly children: El[] = []) {
    if ("checked" in attrs) this.checked = true;
    if ("value" in attrs) this.value = attrs.value as string;
  }
  getAttribute(n: string): string | null { return this.attrs[n] ?? null; }
  addEventListener(type: string, fn: () => void): void { (this.listeners[type] ??= []).push(fn); }
  /** A stand-in for dispatching a real DOM event: runs every listener registered for `type` on this element. */
  fire(type: string): void { for (const fn of this.listeners[type] ?? []) fn(); }
  click(): void { this.clicks++; this.fire("click"); }
  querySelectorAll(sel: string): El[] {
    const m = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (!m) throw new Error(`unsupported selector ${sel}`);
    const all = (e: El): El[] => e.children.flatMap((c) => [c, ...all(c)]);
    return all(this).filter((e) => m[1] as string in e.attrs && (m[2] === undefined || e.attrs[m[1] as string] === m[2]));
  }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
}
type FakeDocument = El;
interface FakeWindow {
  location: { hash: string; pathname: string; search: string; assign(url: string): void };
  assigned: string[];
  history: { replaceState(s: unknown, t: string, url: string): void };
  replaced: string[];
  /** The address of each history entry of this document, as the browser keeps it (the current one last). */
  entries: string[];
  listeners: Record<string, Array<() => void>>;
  addEventListener(type: string, fn: () => void): void;
}

function world(hash: string) {
  const f = (name: string) => new El({ "data-field": name });
  const fields = ["handle", "expires", "command", "version", "seat-cap"];
  const choiceNo = new El({ type: "radio", "data-consent-choice": "no" });
  const choiceYes = new El({ type: "radio", "data-consent-choice": "yes" });
  const maxInput = new El({ type: "number", "data-consent-max-input": "", value: "4" });
  const maxBlock = new El({ "data-consent-max": "" }, [maxInput]);
  maxBlock.hidden = false;
  const sshConsent = new El({ "data-ssh-consent": "" });
  const sshNote = new El({ "data-ssh-command-note": "" });
  const sshDamaged = new El({ "data-ssh-damaged": "" });
  for (const e of [sshConsent, sshNote, sshDamaged]) e.hidden = true;
  const consent = new El({ "data-team-agents": "" }, [choiceNo, choiceYes, maxBlock, sshConsent, sshDamaged]);
  const button = new El({ "data-join-package": "" });
  const open = new El({ "data-join-open": "" });
  const packageLink = new El({ "data-package-url": "" });
  const fallback = new El({ "data-terminal-fallback": "" });
  consent.hidden = true;
  const states = ["loading", "ready", "expired", "invalid", "missing"].map((s) => new El({ "data-state": s }, s === "ready" ? [...fields.map(f), consent, button, open, packageLink, fallback, sshNote] : s === "expired" ? [f("handle"), f("expires")] : []));
  const main = new El({ "data-join": "", "data-cli": "walkie", "data-install": INSTALL_URL, "data-package-available": "true" }, states);
  const doc = new El({}, [main]);
  const win: FakeWindow = {
    location: { hash, pathname: "/join", search: "", assign: (url) => { win.assigned.push(url); } },
    assigned: [],
    replaced: [],
    entries: [`/join${hash}`],
    listeners: {},
    addEventListener: (type, fn) => { (win.listeners[type] ??= []).push(fn); },
    history: { replaceState: (_s, _t, url) => { win.replaced.push(url); win.location.hash = ""; win.entries[win.entries.length - 1] = url; } },
  };
  const on = () => states.filter((s) => s.classes.has("is-on")).map((s) => s.attrs["data-state"]);
  const field = (name: string) => main.querySelectorAll(`[data-field="${name}"]`).map((e) => e.textContent);
  /** A link opened in the same tab (a new history entry with its fragment), then the browser's hashchange. */
  const navigate = (next: string) => {
    win.location.hash = next;
    win.entries.push(`/join${next}`);
    for (const fn of win.listeners.hashchange ?? []) fn();
  };
  return { win, doc, on, field, consent, choiceNo, choiceYes, maxBlock, maxInput, button, open, packageLink, fallback, navigate, sshConsent, sshNote, sshDamaged, main };
}

// ---- fragment + code --------------------------------------------------------------------------------------------------

describe("fragment parsing", () => {
  const code = mint();
  test("#<code> and #<code>&v=<tag>; the tag must be a release tag the installer accepts", () => {
    expect(page.parseFragment(`#${code}`)).toEqual({ code, tag: null, agents: false });
    expect(page.parseFragment(`#${code}&v=v0.2.0-pre.2`)).toEqual({ code, tag: "v0.2.0-pre.2", agents: false });
    expect(page.parseFragment(`#${code}&v=v0.2.0-pre.2&a=1`)).toEqual({ code, tag: "v0.2.0-pre.2", agents: true });
    expect(page.parseFragment(`#${code}&a=yes`)).toEqual({ code, tag: null, agents: false });
    expect(page.parseFragment(`#${code}&v=latest;rm -rf`)).toEqual({ code, tag: null, agents: false });
    expect(page.parseFragment(`#${code}&v=v1.2.3%20%7C%20sh`)).toEqual({ code, tag: null, agents: false });
    expect(page.parseFragment(`#${code}&x=1&v=v1.2.3`)).toEqual({ code, tag: "v1.2.3", agents: false });
  });
  test("whitespace from a wrapped link is dropped; missing and damaged codes are told apart", () => {
    expect(page.parseFragment(`#${code.slice(0, 50)}%0A${code.slice(50)}`).code).toBe(code);
    expect(page.parseFragment("")).toEqual({ error: "missing" });
    expect(page.parseFragment("#")).toEqual({ error: "missing" });
    expect(page.parseFragment("#wk1short")).toEqual({ error: "invalid" });
    expect(page.parseFragment(`#${code.slice(0, -1)}!`)).toEqual({ error: "invalid" });
    expect(page.parseFragment(`#<script>${code}`)).toEqual({ error: "invalid" });
    expect(page.parseFragment("#%E0%A4%A")).toEqual({ error: "invalid" });
    expect(page.parseFragment(`#wk1${"A".repeat(400)}`)).toEqual({ error: "invalid" });
  });
  test("a real code describes its handle, role and expiry; damaged bytes don't", () => {
    expect(page.describe(code)).toEqual({ handle: "arvid", role: "member", expiresAt: Math.floor((NOW + 7 * 86_400_000) / 1000) * 1000 });
    expect(page.describe(mint("kira-2", NOW, "observer"))?.handle).toBe("kira-2");
    expect(page.describe(mint("kira-2", NOW, "observer"))?.role).toBe("observer");
    expect(page.describe(`wk1${"A".repeat(120)}`)).toBeNull(); // version byte 0
  });
  test("the page's command is the daemon's command, byte for byte (CLI, dashboard and page agree)", () => {
    for (const tag of ["v0.2.0-pre.2", null]) {
      expect(page.command(INSTALL_URL, code, tag)).toBe(addMachineCommand(code, tag));
      for (const agents of [false, true]) {
        const link = new URL(addMachineLink(code, tag, agents));
        expect(page.parseFragment(link.hash)).toEqual({ code, tag, agents });
      }
    }
  });
});

test("local handoff carries only the invite and selected consent", () => {
  const code = mint();
  expect(page.handoff(code, true, 7)).toBe(`walkie-join://join#${code}&seats=yes&max=7`);
  expect(page.handoff(code, false, 7)).toBe(`walkie-join://join#${code}&seats=no&max=0`);
  expect(page.handoff(code, true, 7, "v0.2.0-pre.8")).toBe(`walkie-join://join#${code}&seats=yes&max=7&v=v0.2.0-pre.8`);
});

test("the package download has no invite; opening the app uses only the local scheme", () => {
  const code = mint();
  const w = world(`#${code}`);
  page.start(w.win, w.doc, () => NOW);
  w.button.click();
  expect(w.packageLink.clicks).toBe(0);
  w.choiceYes.checked = true;
  w.button.click();
  expect(w.packageLink.clicks).toBe(1);
  expect(w.win.assigned).toEqual([]);
  w.choiceYes.checked = false;
  w.choiceNo.checked = true;
  w.open.click();
  expect(w.win.assigned).toEqual([`walkie-join://join#${code}&seats=no&max=0`]);
});

test("an unavailable signed package opens the command path and never downloads", () => {
  const w = world(`#${mint()}`);
  w.doc.querySelector("[data-join]")!.attrs["data-package-available"] = "false";
  page.start(w.win, w.doc, () => NOW);
  expect(w.button.hidden).toBe(true);
  expect(w.fallback.open).toBe(true);
  w.button.click();
  expect(w.packageLink.clicks).toBe(0);
});

// ---- page states -------------------------------------------------------------------------------------------------------

describe("the page", () => {
  test("ready: strips the fragment first, shows the pinned command, who it's for and the expiry", () => {
    const code = mint("arvid", NOW - 3_600_000);
    const w = world(`#${code}&v=v0.2.0-pre.2`);
    expect(page.run({ window: w.win, document: w.doc, now: NOW })).toBe("ready");
    expect(w.win.replaced).toEqual(["/join"]); // no fragment in the address bar or this history entry
    expect(w.win.location.hash).toBe("");
    expect(w.on()).toEqual(["ready"]);
    expect(w.field("command")).toEqual([`curl -fsSL ${INSTALL_URL} | WALKIE_MIN_VERSION=v0.2.0-pre.2 sh -s -- --invite ${code} --company-machine`]);
    expect(w.field("handle")).toEqual(["@arvid", "@arvid"]); // the ready and expired sections both name them
    expect(w.field("version")[0]).toContain("v0.2.0-pre.2");
    expect(w.field("expires")[0]).not.toBe("");
  });
  test("no release in the link: the command installs the latest", () => {
    const code = mint();
    const w = world(`#${code}`);
    expect(page.run({ window: w.win, document: w.doc, now: NOW })).toBe("ready");
    expect(w.field("command")[0]).toBe(`curl -fsSL ${INSTALL_URL} | sh -s -- --invite ${code} --company-machine`);
  });
  test("expired: says who it was for and when it stopped; the code is never shown", () => {
    const code = mint("arvid", NOW - 8 * 86_400_000);
    const w = world(`#${code}`);
    expect(page.run({ window: w.win, document: w.doc, now: NOW })).toBe("expired");
    expect(w.on()).toEqual(["expired"]);
    expect(w.field("handle")).toEqual(["@arvid", "@arvid"]); // the ready and expired sections both name them
    expect(w.field("command")).toEqual([""]);
    expect(w.win.replaced).toEqual(["/join"]);
  });
  test("invalid and missing codes get their own states (a reload after reading is 'missing')", () => {
    const bad = world("#wk1not-a-real-code-at-all");
    expect(page.run({ window: bad.win, document: bad.doc, now: NOW })).toBe("invalid");
    expect(bad.win.replaced).toEqual(["/join"]);
    expect(bad.field("command")).toEqual([""]);
    const none = world("");
    expect(page.run({ window: none.win, document: none.doc, now: NOW })).toBe("missing");
    expect(none.win.replaced).toEqual([]);
    expect(none.on()).toEqual(["missing"]);
  });
});

describe("more than one link in the same tab (audit r1 MEDIUM)", () => {
  test("valid, then expired: the second is stripped from its own history entry and the first member's command is gone", () => {
    const good = mint("arvid", NOW - 3_600_000);
    const old = mint("kira", NOW - 8 * 86_400_000);
    const w = world(`#${good}&v=v0.2.0-pre.2`);
    page.start(w.win, w.doc, () => NOW);
    expect(w.on()).toEqual(["ready"]);
    expect(w.field("command")[0]).toContain(good);
    w.navigate(`#${old}`);
    expect(w.on()).toEqual(["expired"]);
    expect(w.win.entries).toEqual(["/join", "/join"]); // no entry keeps a code
    expect(w.win.location.hash).toBe("");
    expect(w.field("command")).toEqual([""]);
    expect(w.field("version")).toEqual([""]);
    expect(w.field("handle")).toEqual(["@kira", "@kira"]);
    expect(JSON.stringify(w.field("handle").concat(w.field("expires")))).not.toContain("arvid");
  });
  test("expired, then valid: the new command shows; back to a stripped entry clears it (popstate)", () => {
    const old = mint("kira", NOW - 8 * 86_400_000);
    const good = mint("arvid", NOW - 3_600_000);
    const w = world(`#${old}`);
    page.start(w.win, w.doc, () => NOW);
    expect(w.on()).toEqual(["expired"]);
    w.navigate(`#${good}&v=v0.2.0-pre.2`);
    expect(w.on()).toEqual(["ready"]);
    expect(w.field("command")[0]).toBe(`curl -fsSL ${INSTALL_URL} | WALKIE_MIN_VERSION=v0.2.0-pre.2 sh -s -- --invite ${good} --company-machine`);
    expect(w.win.entries).toEqual(["/join", "/join"]);
    for (const fn of w.win.listeners.popstate ?? []) fn(); // back: the entry has no fragment any more
    expect(w.on()).toEqual(["missing"]);
    expect(w.field("command")).toEqual([""]);
  });
  test("as Chrome does it (popstate, then hashchange, for one fragment navigation): the second link shows", () => {
    const first = mint("kira", NOW - 3_600_000);
    const second = mint("arvid", NOW - 3_600_000);
    const w = world(`#${first}`);
    page.start(w.win, w.doc, () => NOW);
    w.win.location.hash = `#${second}`;
    w.win.entries.push(`/join#${second}`);
    for (const fn of w.win.listeners.popstate ?? []) fn();
    for (const fn of w.win.listeners.hashchange ?? []) fn(); // the fragment is already gone: ignored
    expect(w.on()).toEqual(["ready"]);
    expect(w.field("command")[0]).toContain(second);
    expect(w.field("handle")).toEqual(["@arvid", "@arvid"]);
    expect(w.win.entries).toEqual(["/join", "/join"]);
  });
  test("a damaged second link clears the first link's command", () => {
    const w = world(`#${mint()}`);
    page.start(w.win, w.doc, () => NOW);
    w.navigate("#wk1damaged");
    expect([w.on(), w.field("command"), w.win.entries]).toEqual([["invalid"], [""], ["/join", "/join"]]);
  });
});

describe("the local consent step", () => {
  test("the link's a flag does not choose or hide consent", () => {
    const code = mint();
    const on = world(`#${code}&v=v0.2.0-pre.2&a=1`);
    page.run({ window: on.win, document: on.doc, now: NOW });
    expect(on.consent.hidden).toBe(false);
    const off = world(`#${code}&v=v0.2.0-pre.2`);
    page.run({ window: off.win, document: off.doc, now: NOW });
    expect(off.consent.hidden).toBe(false);
    on.navigate(`#${code}`);
    page.start(on.win, on.doc, () => NOW);
    expect(on.consent.hidden).toBe(false);
  });
  test("the page's markup hides the step until the script shows it", () => {
    const html = readFileSync(join(SITE, "join.html"), "utf8");
    expect(html).toMatch(/<div data-team-agents>/);
  });
  test("the markup has an unchecked No/Yes consent control and the seat maximum", () => {
    const html = readFileSync(join(SITE, "join.html"), "utf8");
    expect(html).toMatch(/<legend>Let your team run agents on this computer\?<\/legend>/);
    expect(html).toMatch(/<input type="radio" name="agents-consent" data-consent-choice="no">/);
    expect(html).toMatch(/<input type="radio" name="agents-consent" data-consent-choice="yes">/);
    expect(html).not.toMatch(/data-consent-choice="yes" checked/);
    expect(html).toMatch(/<div class="consent-max" data-consent-max hidden>/);
    expect(html).toMatch(/<label for="j-seat-max">Seat maximum<\/label>/);
    expect(html).toMatch(/<input type="number" id="j-seat-max" data-consent-max-input[^>]* value="4">/);
  });
  test("the markup explains what a seat is and names all three stop switches in plain text", () => {
    const html = readFileSync(join(SITE, "join.html"), "utf8");
    expect(html).toContain("run agents as your macOS/Windows-WSL/Linux user");
    expect(html).toContain("walkie admin remote off");
    expect(html).toContain("walkie agents admin off");
    expect(html).toContain("walkie seats deny");
  });
  test("Windows bootstrap and Mac package stay hidden until their release gates exist", () => {
    const html = readFileSync(join(SITE, "join.html"), "utf8");
    expect(html).toContain('data-package-available="false"');
    expect(html).toContain('data-join-package hidden');
    expect(html).toContain('data-windows-section hidden');
    expect(html).toContain('data-windows-copy hidden');
    expect(html).toContain("PowerShell bootstrap pending signed release verification");
  });
});

describe("the consent control itself (OCJ-A)", () => {
  test("clampSeatMax: keeps a valid integer in range, and falls back to the default 4 otherwise", () => {
    expect(page.SEAT_MAX_DEFAULT).toBe(4);
    expect(page.SEAT_MAX_MIN).toBe(1);
    expect(page.SEAT_MAX_MAX).toBe(64);
    expect(page.clampSeatMax("4")).toBe(4);
    expect(page.clampSeatMax("12")).toBe(12);
    expect(page.clampSeatMax("1")).toBe(1);
    expect(page.clampSeatMax("64")).toBe(64);
    expect(page.clampSeatMax("0")).toBe(1); // clamped up to the minimum
    expect(page.clampSeatMax("-3")).toBe(1);
    expect(page.clampSeatMax("999")).toBe(64); // clamped down to the maximum
    expect(page.clampSeatMax("4.7")).toBe(4); // truncated, not rounded
    expect(page.clampSeatMax("")).toBe(4);
    expect(page.clampSeatMax("  ")).toBe(4);
    expect(page.clampSeatMax("abc")).toBe(4);
    expect(page.clampSeatMax("4;rm -rf")).toBe(4);
    expect(page.clampSeatMax(null)).toBe(4);
    expect(page.clampSeatMax(undefined)).toBe(4);
  });

  test("a fresh 'ready' link starts with no choice and a hidden seat maximum", () => {
    const code = mint();
    const w = world(`#${code}&a=1`);
    page.run({ window: w.win, document: w.doc, now: NOW });
    expect(w.choiceYes.checked).toBe(false);
    expect(w.choiceNo.checked).toBe(false);
    expect(w.maxBlock.hidden).toBe(true);
    expect(w.maxInput.value).toBe("4");
    expect(w.field("seat-cap")).toEqual(["0"]);
  });

  test("an observer invite cannot select seats and still requires an explicit choice", () => {
    const w = world(`#${mint("kira", NOW, "observer")}`);
    page.run({ window: w.win, document: w.doc, now: NOW });
    expect(w.choiceYes.checked).toBe(false);
    expect(w.choiceYes.disabled).toBe(true);
    expect(w.choiceNo.checked).toBe(false);
    expect(w.maxBlock.hidden).toBe(true);
  });

  test("choosing No hides the seat maximum; back to Yes reveals it again (start() wires the change listeners)", () => {
    const code = mint();
    const w = world(`#${code}&a=1`);
    page.start(w.win, w.doc, () => NOW);
    expect(w.maxBlock.hidden).toBe(true);
    w.choiceNo.checked = true;
    w.choiceYes.checked = false;
    w.choiceNo.fire("change");
    expect(w.maxBlock.hidden).toBe(true);
    w.choiceYes.checked = true;
    w.choiceNo.checked = false;
    w.choiceYes.fire("change");
    expect(w.maxBlock.hidden).toBe(false);
    expect(w.field("seat-cap")).toEqual(["4"]);
    w.choiceNo.checked = true;
    w.choiceYes.checked = false;
    w.choiceNo.fire("change");
    expect(w.maxBlock.hidden).toBe(true);
  });

  test("an out-of-range or non-numeric seat maximum is clamped back once the field changes (not on every keystroke)", () => {
    const code = mint();
    const w = world(`#${code}&a=1`);
    page.start(w.win, w.doc, () => NOW);
    w.choiceYes.checked = true;
    w.choiceYes.fire("change");
    w.maxInput.value = "999";
    w.maxInput.fire("change");
    expect(w.maxInput.value).toBe("64");
    expect(w.field("seat-cap")).toEqual(["64"]);
    w.maxInput.value = "abc";
    w.maxInput.fire("change");
    expect(w.maxInput.value).toBe("4");
  });

  test("a No answer and a custom maximum don't survive a new link", () => {
    const code1 = mint("arvid");
    const code2 = mint("kira");
    const w = world(`#${code1}&a=1`);
    page.start(w.win, w.doc, () => NOW);
    w.maxInput.value = "9";
    w.maxInput.fire("change");
    expect(w.maxInput.value).toBe("9");
    w.choiceNo.checked = true;
    w.choiceYes.checked = false;
    w.choiceNo.fire("change");
    expect(w.maxBlock.hidden).toBe(true);
    w.navigate(`#${code2}&a=1`);
    expect(w.choiceYes.checked).toBe(false);
    expect(w.choiceNo.checked).toBe(false);
    expect(w.maxBlock.hidden).toBe(true);
    expect(w.maxInput.value).toBe("4");
  });

  test("choosing Yes never changes the pinned install command (it stays the daemon's, byte for byte)", () => {
    const code = mint();
    const w = world(`#${code}&v=v0.2.0-pre.2&a=1`);
    page.start(w.win, w.doc, () => NOW);
    const before = w.field("command");
    w.choiceYes.checked = true;
    w.choiceYes.fire("change");
    w.maxInput.value = "9";
    w.maxInput.fire("change");
    expect(w.field("command")).toEqual(before);
    expect(w.field("command")[0]).toBe(addMachineCommand(code, "v0.2.0-pre.2"));
  });
});

// ---- the owner's SSH authorization ---------------------------------------------------------------------------------------

describe("the owner's SSH authorization (WALK-67 lane 8)", () => {
  const sshKey = (() => {
    const name = Buffer.from("ssh-ed25519");
    const a = Buffer.alloc(4); a.writeUInt32BE(name.length);
    const b = Buffer.alloc(4); b.writeUInt32BE(32);
    return `ssh-ed25519 ${Buffer.concat([a, name, b, Buffer.alloc(32, 7)]).toString("base64")}`;
  })();
  const invite = createInvite(keys, { team: "0123456789abcdef", authority: keys.pubkey, handle: "arvid", role: "member", now: NOW - 3_600_000, pos: 7 });
  const code = invite.code;
  const packet = encodeOwnerSshGrant(mintOwnerSshGrant(keys, { team_id: "0123456789abcdef", owner_handle: "alex", recipient: "arvid", invite_id: invite.id, public_key: sshKey, expires_at: invite.expires_at }));
  /** Everything visible on the page except the install command, which is where the packet is allowed to appear. */
  const visibleText = (w: ReturnType<typeof world>) => JSON.stringify(["handle", "expires", "version", "seat-cap"].map((n) => w.field(n)));

  test("the daemon's own add-machine link parses, with the packet, byte for byte", () => {
    const link = new URL(`${addMachineLink(code, "v0.2.0-pre.11", true)}&ssh=${packet}`);
    expect(page.parseFragment(link.hash)).toEqual({ code, tag: "v0.2.0-pre.11", agents: true, ssh: packet });
    expect(page.parseFragment(`#${code}&ssh=${packet}`)).toEqual({ code, tag: null, agents: false, ssh: packet });
    expect(page.parseFragment(`#${code}`)).toEqual({ code, tag: null, agents: false }); // nothing added when there is none
  });
  test("a malformed, oversized, empty or repeated packet is dropped and flagged, never carried", () => {
    for (const bad of ["ssh=", "ssh=not%20base64!", `ssh=${"A".repeat(1201)}`, "ssh=a=b", `ssh=${packet}&ssh=${packet}`, `ssh=${packet}&ssh=x!`, `ssh=a%2Bb`]) {
      const parsed = page.parseFragment(`#${code}&${bad}`);
      expect([bad.slice(0, 14), parsed.ssh, parsed.sshDamaged]).toEqual([bad.slice(0, 14), undefined, true]);
      expect(parsed.code).toBe(code); // the invite itself is still good
    }
    expect(page.parseFragment(`#${code}&ssh=${"A".repeat(1200)}`).ssh).toBe("A".repeat(1200)); // the bound is 1200
  });
  test("the command is the daemon's command with --owner-ssh, byte for byte; a bad packet adds nothing", () => {
    for (const tag of ["v0.2.0-pre.11", null]) {
      expect(page.command(INSTALL_URL, code, tag, packet)).toBe(`${addMachineCommand(code, tag)} --owner-ssh ${packet}`);
      expect(page.command(INSTALL_URL, code, tag)).toBe(addMachineCommand(code, tag));
    }
    expect(page.command(INSTALL_URL, code, null, "bad packet; rm -rf /")).toBe(addMachineCommand(code, null));
  });
  test("the local handoff carries the packet only when seats are allowed, only as a fragment field, never a query", () => {
    const yes = page.handoff(code, true, 7, "v0.2.0-pre.11", packet);
    expect(yes).toBe(`walkie-join://join#${code}&seats=yes&max=7&v=v0.2.0-pre.11&ssh=${packet}`);
    expect(page.handoff(code, true, 7, null, packet)).toBe(`walkie-join://join#${code}&seats=yes&max=7&ssh=${packet}`);
    expect(page.handoff(code, false, 7, "v0.2.0-pre.11", packet)).toBe(`walkie-join://join#${code}&seats=no&max=0&v=v0.2.0-pre.11`);
    expect(page.handoff(code, true, 7, "v0.2.0-pre.11", "bad!")).toBe(`walkie-join://join#${code}&seats=yes&max=7&v=v0.2.0-pre.11`);
    const url = new URL(yes);
    expect(url.search).toBe("");
    expect(url.pathname).toBe("");
    expect(url.hash).toContain(packet);
  });
  test("the page strips the fragment first, describes the SSH request in the consent, and shows the packet only in the command", () => {
    const w = world(`#${code}&v=v0.2.0-pre.11&a=1&ssh=${packet}`);
    expect(page.run({ window: w.win, document: w.doc, now: NOW })).toBe("ready");
    expect(w.win.replaced).toEqual(["/join"]); // path and search only: the packet is in no URL
    expect(w.win.location.hash).toBe("");
    expect(w.win.entries).toEqual(["/join"]); // no history entry keeps it
    expect(w.field("command")).toEqual([`${addMachineCommand(code, "v0.2.0-pre.11")} --owner-ssh ${packet}`]);
    expect([w.sshConsent.hidden, w.sshNote.hidden, w.sshDamaged.hidden]).toEqual([false, false, true]);
    expect(visibleText(w)).not.toContain(packet);
    expect(w.win.assigned).toEqual([]); // nothing is opened until the person chooses
  });
  test("opening the app after Yes hands the packet to the local app only; No does not", () => {
    const w = world(`#${code}&ssh=${packet}`);
    page.start(w.win, w.doc, () => NOW);
    w.choiceYes.checked = true;
    w.button.click();
    w.open.click();
    expect(w.win.assigned).toEqual([`walkie-join://join#${code}&seats=yes&max=4&ssh=${packet}`]);
    const no = world(`#${code}&ssh=${packet}`);
    page.start(no.win, no.doc, () => NOW);
    no.choiceNo.checked = true;
    no.open.click();
    expect(no.win.assigned).toEqual([`walkie-join://join#${code}&seats=no&max=0`]);
    expect(new URL(w.win.assigned[0]!).search).toBe("");
  });
  test("a damaged packet: said plainly, left out of the command and the handoff, the invite still works", () => {
    const w = world(`#${code}&ssh=damaged!`);
    page.start(w.win, w.doc, () => NOW); // start() reads the link once; a second run would find the fragment already stripped
    expect(w.on()).toEqual(["ready"]);
    expect([w.sshConsent.hidden, w.sshNote.hidden, w.sshDamaged.hidden]).toEqual([true, true, false]);
    expect(w.field("command")).toEqual([addMachineCommand(code, null)]);
    expect(w.field("command")[0]).not.toContain("--owner-ssh");
    w.choiceYes.checked = true;
    w.open.click();
    expect(w.win.assigned).toEqual([`walkie-join://join#${code}&seats=yes&max=4`]);
  });
  test("a link without a packet shows no SSH text at all", () => {
    const w = world(`#${code}&v=v0.2.0-pre.11`);
    page.run({ window: w.win, document: w.doc, now: NOW });
    expect([w.sshConsent.hidden, w.sshNote.hidden, w.sshDamaged.hidden]).toEqual([true, true, true]);
    expect(w.field("command")).toEqual([addMachineCommand(code, "v0.2.0-pre.11")]);
  });
  test("the next link in the same tab never inherits the last link's packet (memory only, reset every run)", () => {
    const other = mint("kira", NOW - 3_600_000);
    const w = world(`#${code}&ssh=${packet}`);
    page.start(w.win, w.doc, () => NOW);
    expect(w.field("command")[0]).toContain("--owner-ssh");
    w.navigate(`#${other}`);
    expect(w.field("command")).toEqual([addMachineCommand(other, null)]);
    expect([w.sshConsent.hidden, w.sshNote.hidden, w.sshDamaged.hidden]).toEqual([true, true, true]);
    w.choiceYes.checked = true;
    w.open.click();
    expect(w.win.assigned).toEqual([`walkie-join://join#${other}&seats=yes&max=4`]);
    expect(w.win.entries).toEqual(["/join", "/join"]); // neither entry keeps a fragment
    // And an expired link shows no command and keeps nothing.
    const old = mint("kira", NOW - 8 * 86_400_000);
    w.navigate(`#${old}&ssh=${packet}`);
    expect(w.on()).toEqual(["expired"]);
    expect(w.field("command")).toEqual([""]);
    w.open.click();
    expect(w.win.assigned).toHaveLength(1); // nothing new was opened for the expired link
  });
  test("the markup describes it, hides it until the script shows it, and names the revoke command in plain text", () => {
    const html = readFileSync(join(SITE, "join.html"), "utf8");
    expect(html).toMatch(/<p class="welcome-note" data-ssh-consent hidden>/);
    expect(html).toMatch(/<p class="welcome-note" data-ssh-damaged hidden>/);
    expect(html).toMatch(/<p class="welcome-note" data-ssh-command-note hidden>/);
    expect(html).toContain("may sign in to this computer over SSH as your user, through Walkie");
    // What is true on all three platforms: Walkie's own service, this machine only, key logins only (any key authorized for the person's account works on loopback); Remote Login never asked for.
    expect(html).toContain("using a Walkie SSH service that listens only on this computer and accepts only key logins");
    expect(html).not.toMatch(/Remote Login/i);
    expect(html).toContain("<code>walkie ssh revoke</code>");
    expect(html).toContain("--owner-ssh");
    expect(html).toContain("Ask the owner for a new add-machine link");
  });
  test("join.js keeps the packet in no storage, URL query, log or timer", () => {
    const js = readFileSync(join(SITE, "assets", "join.js"), "utf8");
    for (const api of ["console.", "localStorage", "sessionStorage", "document.cookie", "setTimeout", "location.href", "?ssh", "search ="]) expect(js.includes(api)).toBe(false);
    expect(js).toContain("var pendingSsh = null; // memory only");
  });
});

// ---- no network, no leaks ----------------------------------------------------------------------------------------------

describe("the code never leaves the page", () => {
  const js = readFileSync(join(SITE, "assets", "join.js"), "utf8");
  const html = readFileSync(join(SITE, "join.html"), "utf8");
  const vercel = JSON.parse(readFileSync(join(SITE, "vercel.json"), "utf8")) as { headers: { source: string; headers: { key: string; value: string }[] }[] };

  test("join.js has no network or storage API at all", () => {
    for (const api of ["fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "EventSource", "new Image", "import(", "localStorage", "sessionStorage", "indexedDB", "document.cookie", ".src =", "location.href =", "window.open"]) {
      expect(js.includes(api)).toBe(false);
    }
  });
  test("the page loads only its own scripts, none inline, and no third-party resource", () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc="\/assets\/[a-z]+\.js")[^>]*>/);
    expect(html.match(/https?:\/\/[^" ]+/g)?.sort()).toEqual([
      "https://getwalkie.vercel.app/install.sh",
      `https://github.com/alexcarney460-hue/walkie-releases/releases/download/${INSTALLER_VERSION}/Walkie.pkg`,
    ]);
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toContain('data-install="https://getwalkie.vercel.app/install.sh"');
    expect(html).toContain('Download and run Walkie');
    expect(html).toContain('data-join-package');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("puts the private invite code on your command line");
  });
  test("site.js (loaded too) makes no request either", () => {
    const site = readFileSync(join(SITE, "assets", "site.js"), "utf8");
    for (const api of ["fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket"]) expect(site.includes(api)).toBe(false);
  });
  test("Vercel serves /join with connect-src 'none', no inline script, no referrer, no framing", () => {
    for (const source of ["/join", "/join.html"]) {
      const rule = vercel.headers.find((h) => h.source === source);
      const get = (k: string) => rule?.headers.find((h) => h.key === k)?.value ?? "";
      const csp = get("Content-Security-Policy");
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(get("Referrer-Policy")).toBe("no-referrer");
    }
  });
});
