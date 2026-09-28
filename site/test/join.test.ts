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

interface JoinApi {
  parseFragment(hash: string): { code?: string; tag?: string | null; agents?: boolean; error?: string };
  describe(code: string): { handle: string; role: string; expiresAt: number } | null;
  command(installUrl: string, code: string, tag: string | null): string;
  run(env: { window: FakeWindow; document: FakeDocument; now: number }): string | null;
  start(win: FakeWindow, doc: FakeDocument, clock: () => number): void;
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
  readonly classes = new Set<string>();
  readonly classList = { toggle: (c: string, on: boolean) => { if (on) this.classes.add(c); else this.classes.delete(c); } };
  constructor(readonly attrs: Record<string, string>, readonly children: El[] = []) {}
  getAttribute(n: string): string | null { return this.attrs[n] ?? null; }
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
  location: { hash: string; pathname: string; search: string };
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
  const consent = new El({ "data-team-agents": "" });
  consent.hidden = true;
  const states = ["loading", "ready", "expired", "invalid", "missing"].map((s) => new El({ "data-state": s }, s === "ready" ? [...fields.map(f), consent] : s === "expired" ? [f("handle"), f("expires")] : []));
  const main = new El({ "data-join": "", "data-cli": "walkie", "data-install": INSTALL_URL }, states);
  const doc = new El({}, [main]);
  const win: FakeWindow = {
    location: { hash, pathname: "/join", search: "" },
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
  return { win, doc, on, field, consent, navigate };
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

// ---- page states -------------------------------------------------------------------------------------------------------

describe("the page", () => {
  test("ready: strips the fragment first, shows the pinned command, who it's for and the expiry", () => {
    const code = mint("arvid", NOW - 3_600_000);
    const w = world(`#${code}&v=v0.2.0-pre.2`);
    expect(page.run({ window: w.win, document: w.doc, now: NOW })).toBe("ready");
    expect(w.win.replaced).toEqual(["/join"]); // no fragment in the address bar or this history entry
    expect(w.win.location.hash).toBe("");
    expect(w.on()).toEqual(["ready"]);
    expect(w.field("command")).toEqual([`curl -fsSL ${INSTALL_URL} | WALKIE_VERSION=v0.2.0-pre.2 sh -s -- --invite ${code}`]);
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
    expect(w.field("command")[0]).toBe(`curl -fsSL ${INSTALL_URL} | WALKIE_VERSION=v0.2.0-pre.2 sh -s -- --invite ${good}`);
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

describe("the consent step is described only when the team's build asks it (audit r1 MEDIUM)", () => {
  test("a=1 shows it; without it (a build with no seats, like v0.2.0-pre.2) it stays hidden", () => {
    const code = mint();
    const on = world(`#${code}&v=v0.2.0-pre.2&a=1`);
    page.run({ window: on.win, document: on.doc, now: NOW });
    expect(on.consent.hidden).toBe(false);
    const off = world(`#${code}&v=v0.2.0-pre.2`);
    page.run({ window: off.win, document: off.doc, now: NOW });
    expect(off.consent.hidden).toBe(true);
    // …and a later link without it hides it again.
    on.navigate(`#${code}`);
    page.start(on.win, on.doc, () => NOW);
    expect(on.consent.hidden).toBe(true);
  });
  test("the page's markup hides the step until the script shows it", () => {
    const html = readFileSync(join(SITE, "join.html"), "utf8");
    expect(html).toMatch(/<li data-team-agents hidden>It asks you one question/);
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
    expect(html).not.toMatch(/https?:\/\/(?!getwalkie\.vercel\.app)/);
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toContain('data-install="https://getwalkie.vercel.app/install.sh"');
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
