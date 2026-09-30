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
import { addMachineCommand, addMachineLink, INSTALL_URL } from "../../src/protocol/add-machine.ts";
/** The release the site installs (scripts/install.sh DEFAULT_VERSION), which build.py links the package to. */
const INSTALLER_VERSION = readFileSync(join(import.meta.dir, "../../scripts/install.sh"), "utf8").match(/DEFAULT_VERSION="(v[^"]+)"/)![1];

interface JoinApi {
  handoff(code: string, yes: boolean, max: number, tag?: string | null): string;
  parseFragment(hash: string): { code?: string; tag?: string | null; agents?: boolean; error?: string };
  describe(code: string): { handle: string; role: string; expiresAt: number } | null;
  command(installUrl: string, code: string, tag: string | null): string;
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
  const fields = ["handle", "expires", "command", "version"];
  const choiceNo = new El({ type: "radio", "data-consent-choice": "no" });
  const choiceYes = new El({ type: "radio", "data-consent-choice": "yes", checked: "true" });
  const maxInput = new El({ type: "number", "data-consent-max-input": "", value: "4" });
  const maxBlock = new El({ "data-consent-max": "" }, [maxInput]);
  maxBlock.hidden = false;
  const consent = new El({ "data-team-agents": "" }, [choiceNo, choiceYes, maxBlock]);
  const button = new El({ "data-join-package": "" });
  const open = new El({ "data-join-open": "" });
  const packageLink = new El({ "data-package-url": "" });
  const fallback = new El({ "data-terminal-fallback": "" });
  consent.hidden = true;
  const states = ["loading", "ready", "expired", "invalid", "missing"].map((s) => new El({ "data-state": s }, s === "ready" ? [...fields.map(f), consent, button, open, packageLink, fallback] : s === "expired" ? [f("handle"), f("expires")] : []));
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
  return { win, doc, on, field, consent, choiceNo, choiceYes, maxBlock, maxInput, button, open, packageLink, fallback, navigate };
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
    expect(w.field("command")).toEqual([`curl -fsSL ${INSTALL_URL} | WALKIE_MIN_VERSION=v0.2.0-pre.2 sh -s -- --invite ${code}`]);
    expect(w.field("handle")).toEqual(["@arvid", "@arvid"]); // the ready and expired sections both name them
    expect(w.field("version")[0]).toContain("v0.2.0-pre.2");
    expect(w.field("expires")[0]).not.toBe("");
  });
  test("no release in the link: the command installs the latest", () => {
    const code = mint();
    const w = world(`#${code}`);
    expect(page.run({ window: w.win, document: w.doc, now: NOW })).toBe("ready");
    expect(w.field("command")[0]).toBe(`curl -fsSL ${INSTALL_URL} | sh -s -- --invite ${code}`);
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
    expect(w.field("command")[0]).toBe(`curl -fsSL ${INSTALL_URL} | WALKIE_MIN_VERSION=v0.2.0-pre.2 sh -s -- --invite ${good}`);
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
  test("the markup has a real No/Yes consent control, Yes checked by default, and the seat maximum shown", () => {
    const html = readFileSync(join(SITE, "join.html"), "utf8");
    expect(html).toMatch(/<legend>Let your team run agents on this computer\?<\/legend>/);
    expect(html).toMatch(/<input type="radio" name="agents-consent" data-consent-choice="no">/);
    expect(html).toMatch(/<input type="radio" name="agents-consent" data-consent-choice="yes" checked>/);
    expect(html).toMatch(/<div class="consent-max" data-consent-max>/);
    expect(html).toMatch(/<label for="j-seat-max">Seat maximum<\/label>/);
    expect(html).toMatch(/<input type="number" id="j-seat-max" data-consent-max-input[^>]* value="4">/);
  });
  test("the markup explains what a seat is and names all three stop switches in plain text", () => {
    const html = readFileSync(join(SITE, "join.html"), "utf8");
    expect(html).toContain("Each seat runs as a separate OS user");
    expect(html).toContain("You can stop seats from Walkie on this Mac");
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

  test("a fresh 'ready' link starts at Yes (the default), with the seat maximum shown and reset to 4", () => {
    const code = mint();
    const w = world(`#${code}&a=1`);
    page.run({ window: w.win, document: w.doc, now: NOW });
    expect(w.choiceYes.checked).toBe(true);
    expect(w.choiceNo.checked).toBe(false);
    expect(w.maxBlock.hidden).toBe(false);
    expect(w.maxInput.value).toBe("4");
  });

  test("an observer invite pre-fills No and cannot pre-fill seats", () => {
    const w = world(`#${mint("kira", NOW, "observer")}`);
    page.run({ window: w.win, document: w.doc, now: NOW });
    expect(w.choiceYes.checked).toBe(false);
    expect(w.choiceYes.disabled).toBe(true);
    expect(w.choiceNo.checked).toBe(true);
    expect(w.maxBlock.hidden).toBe(true);
  });

  test("choosing No hides the seat maximum; back to Yes reveals it again (start() wires the change listeners)", () => {
    const code = mint();
    const w = world(`#${code}&a=1`);
    page.start(w.win, w.doc, () => NOW);
    expect(w.maxBlock.hidden).toBe(false);
    w.choiceNo.checked = true;
    w.choiceYes.checked = false;
    w.choiceNo.fire("change");
    expect(w.maxBlock.hidden).toBe(true);
    w.choiceYes.checked = true;
    w.choiceNo.checked = false;
    w.choiceYes.fire("change");
    expect(w.maxBlock.hidden).toBe(false);
    w.choiceNo.checked = true;
    w.choiceYes.checked = false;
    w.choiceNo.fire("change");
    expect(w.maxBlock.hidden).toBe(true);
  });

  test("an out-of-range or non-numeric seat maximum is clamped back once the field changes (not on every keystroke)", () => {
    const code = mint();
    const w = world(`#${code}&a=1`);
    page.start(w.win, w.doc, () => NOW);
    w.maxInput.value = "999";
    w.maxInput.fire("change");
    expect(w.maxInput.value).toBe("64");
    w.maxInput.value = "abc";
    w.maxInput.fire("change");
    expect(w.maxInput.value).toBe("4");
  });

  test("a No answer and a custom maximum don't survive a new link (reset to the Yes default with the rest of the fields)", () => {
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
    expect(w.choiceYes.checked).toBe(true);
    expect(w.choiceNo.checked).toBe(false);
    expect(w.maxBlock.hidden).toBe(false);
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
    expect(html).toContain('Install Walkie and join');
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
