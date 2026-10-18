// FLEET-LINK-1: the site's /join page with a fleet link (`wl1…`, one link for many machines). A real token minted by
// the daemon's module: the page describes it (whose machines, how many, until when, approval), shows the daemon's own
// commands for macOS/Linux and for Windows through WSL2, strips the fragment, and treats an expired link as expired.
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFleetLink, newLinkSecret } from "../../src/daemon/fleet-link.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { INSTALL_URL } from "../../src/protocol/add-machine.ts";
import { fleetLinkCommand, fleetLinkUrl, fleetLinkWindowsCommand } from "../../src/protocol/fleet-link.ts";

interface JoinApi {
  parseFragment(hash: string): { code?: string; tag?: string | null; error?: string };
  describe(code: string): { handle: string; uses?: number; approve?: boolean; fleet?: boolean; expiresAt: number } | null;
  command(installUrl: string, code: string, tag: string | null): string;
  windowsCommand(installUrl: string, code: string, tag: string | null): string;
  run(env: { window: FakeWindow; document: El; now: number }): string | null;
  start(win: FakeWindow, doc: El, clock: () => number): void;
}
const SITE = join(import.meta.dir, "..");
const page = createRequire(import.meta.url)(join(SITE, "assets", "join.js")) as JoinApi;
const NOW = 1_790_000_000_000;
const keys = generateKeys();
const mint = (o: { handle?: string; uses?: number; approve?: boolean; expires?: number } = {}) => encodeFleetLink(keys, newLinkSecret().secret, {
  team: "0123456789abcdef", authority: keys.pubkey, handle: o.handle ?? "ops", uses: o.uses ?? 25, approve: o.approve ?? false,
  expires_at: o.expires ?? Math.floor((NOW + 7 * 86_400_000) / 1000) * 1000, relay: "https://use1-1.relay.n0.iroh-canary.iroh.link./",
});

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
interface FakeWindow { location: { hash: string; pathname: string; search: string }; history: { replaceState(s: unknown, t: string, url: string): void }; replaced: string[]; listeners: Record<string, Array<() => void>>; addEventListener(type: string, fn: () => void): void }

function world(hash: string) {
  const f = (name: string) => new El({ "data-field": name });
  const approve = new El({ "data-fleet-approve": "" });
  approve.hidden = true;
  const fleetFields = ["fleet-handle", "fleet-uses", "fleet-expires", "fleet-command", "fleet-command-win", "fleet-version"];
  const states = ["loading", "ready", "fleet", "expired", "invalid", "missing"].map((s) => new El({ "data-state": s },
    s === "ready" ? ["handle", "expires", "command", "version"].map(f) : s === "fleet" ? [...fleetFields.map(f), approve] : s === "expired" ? [f("handle"), f("expires")] : []));
  const main = new El({ "data-join": "", "data-cli": "walkie", "data-install": INSTALL_URL }, states);
  const win: FakeWindow = {
    location: { hash, pathname: "/join", search: "" }, replaced: [], listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    history: { replaceState: (_s, _t, url) => { win.replaced.push(url); win.location.hash = ""; } },
  };
  const on = () => states.filter((s) => s.classes.has("is-on")).map((s) => s.attrs["data-state"]);
  const field = (name: string) => main.querySelectorAll(`[data-field="${name}"]`).map((e) => e.textContent);
  return { win, doc: new El({}, [main]), on, field, approve };
}

test("skip to content keeps a displayed fleet command after the fragment is stripped", () => {
  const token = mint();
  const w = world(`#${token}`);
  page.start(w.win, w.doc, () => NOW);
  expect(w.on()).toEqual(["fleet"]);
  w.win.location.hash = "#main";
  for (const fn of w.win.listeners.popstate ?? []) fn();
  for (const fn of w.win.listeners.hashchange ?? []) fn();
  expect(w.on()).toEqual(["fleet"]);
  expect(w.field("fleet-command")).toEqual([fleetLinkCommand(token, null)]);
});

describe("a fleet link on /join", () => {
  test("the daemon's link parses; the page describes the token (whose, how many, approval, until when)", () => {
    const token = mint({ uses: 25, approve: true });
    const url = new URL(fleetLinkUrl(token, "v0.2.0-pre.5"));
    expect(page.parseFragment(url.hash)).toMatchObject({ code: token, tag: "v0.2.0-pre.5" });
    expect(page.describe(token)).toEqual({ fleet: true, handle: "ops", uses: 25, approve: true, expiresAt: Math.floor((NOW + 7 * 86_400_000) / 1000) * 1000 });
    expect(page.describe(mint({ uses: 0 }))?.uses).toBe(0);
    expect(page.describe(`wl1${"A".repeat(200)}`)).toBeNull();
  });

  test("the commands are the daemon's, byte for byte (macOS/Linux and Windows via WSL2)", () => {
    const token = mint();
    for (const tag of ["v0.2.0-pre.5", null]) {
      expect(page.command(INSTALL_URL, token, tag)).toBe(fleetLinkCommand(token, tag));
      expect(page.windowsCommand(INSTALL_URL, token, tag)).toBe(fleetLinkWindowsCommand(token, tag));
    }
  });

  test("the fleet state: fragment stripped, fields filled, approval shown only for an approve-each-machine link", () => {
    const token = mint({ uses: 25, approve: true });
    const w = world(`#${token}&v=v0.2.0-pre.5`);
    expect(page.run({ window: w.win, document: w.doc, now: NOW })).toBe("fleet");
    expect(w.win.replaced).toEqual(["/join"]);
    expect(w.on()).toEqual(["fleet"]);
    expect(w.field("fleet-handle")).toEqual(["@ops"]);
    expect(w.field("fleet-uses")).toEqual(["up to 25 machines"]);
    expect(w.field("fleet-command")).toEqual([fleetLinkCommand(token, "v0.2.0-pre.5")]);
    expect(w.field("fleet-command-win")).toEqual([fleetLinkWindowsCommand(token, "v0.2.0-pre.5")]);
    expect(w.field("fleet-version")[0]).toContain("v0.2.0-pre.5");
    expect(w.field("command")).toEqual([""]); // the single-use section says nothing
    expect(w.approve.hidden).toBe(false);
    const plain = world(`#${mint({ uses: 0 })}`);
    expect(page.run({ window: plain.win, document: plain.doc, now: NOW })).toBe("fleet");
    expect(plain.field("fleet-uses")).toEqual(["any number of machines"]);
    expect(plain.approve.hidden).toBe(true);
  });

  test("one use reads 'up to 1 machine'", () => {
    const w = world(`#${mint({ uses: 1 })}`);
    expect(page.run({ window: w.win, document: w.doc, now: NOW })).toBe("fleet");
    expect(w.field("fleet-uses")).toEqual(["up to 1 machine"]);
  });

  test("expired: the expired state, no command", () => {
    const w = world(`#${mint({ expires: Math.floor((NOW - 1000) / 1000) * 1000 })}`);
    expect(page.run({ window: w.win, document: w.doc, now: NOW })).toBe("expired");
    expect(w.field("fleet-command")).toEqual([""]);
    expect(w.field("handle")).toEqual(["@ops", "@ops"]); // the ready and expired sections both name them
  });

  test("the page's markup: a fleet section with both copy buttons, the approval fact hidden until the script shows it", () => {
    const html = readFileSync(join(SITE, "join.html"), "utf8");
    expect(html).toContain('data-state="fleet"');
    expect(html).toContain('aria-label="Copy the install command for macOS or Linux"');
    // The Windows wording says a fresh Windows/WSL run is not verified (site: qualify the join page Windows sentences).
    expect(html).toContain('aria-label="Copy the Windows command. A fresh Windows/WSL run is not verified."');
    expect(html).toMatch(/<span class="fact" data-fleet-approve hidden>/);
    expect(html).not.toContain("Links last 7 days"); // fleet links last up to 30
  });
});
