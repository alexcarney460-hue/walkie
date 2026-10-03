// WALK-75 Simple mode: #/simple is a dashboard view. These tests import only modules that already exist on
// grok-base, so a missing "simple" view fails the assertions (the hash falls through to Mission Control).
import { act } from "react";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { MeView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import { installDom, type DomEnv } from "./mini-dom.ts";
import { go } from "./window-stub.ts";

let env: DomEnv;
let parseHash: typeof import("../src/lib/route.ts").parseHash;
let hrefFor: typeof import("../src/lib/route.ts").hrefFor;
let Sidebar: typeof import("../src/components/Shell.tsx").Sidebar;
let TabBar: typeof import("../src/components/Shell.tsx").TabBar;
let MobileBar: typeof import("../src/components/Shell.tsx").MobileBar;
let SHORTCUTS: typeof import("../src/lib/hotkeys.ts").SHORTCUTS;
let CommandPalette: typeof import("../src/components/CommandPalette.tsx").CommandPalette;
let StaticStore: typeof import("../src/state/store.tsx").StaticStore;
let initialState: State;

const me: MeView = {
  version: "0", protocol: 1, handle: "alex", role: "owner",
  team: { id: "0123456789abcdef", name: "Northwind" },
  node: { id: "aaaaaaaaaaaaaaaa", hostname: "host", ip: "127.0.0.1", port: 1 },
  tailscale: { ok: false, login: null }, plan: null,
};

const PROTO_KEYS = ["focus", "querySelector", "scrollIntoView"] as const;
let protoSaved: Array<{ key: (typeof PROTO_KEYS)[number]; desc: PropertyDescriptor | undefined }> = [];

beforeAll(async () => {
  env = await installDom();
  const proto = HTMLElement.prototype;
  protoSaved = PROTO_KEYS.map((key) => ({ key, desc: Object.getOwnPropertyDescriptor(proto, key) }));
  Object.assign(proto, { focus() {}, querySelector: () => null, scrollIntoView() {} });
  go("#/simple");
  const [route, shell, hotkeys, palette, store, reducer] = await Promise.all([
    import("../src/lib/route.ts"),
    import("../src/components/Shell.tsx"),
    import("../src/lib/hotkeys.ts"),
    import("../src/components/CommandPalette.tsx"),
    import("../src/state/store.tsx"),
    import("../src/state/reducer.ts"),
  ]);
  parseHash = route.parseHash;
  hrefFor = route.hrefFor;
  Sidebar = shell.Sidebar;
  TabBar = shell.TabBar;
  MobileBar = shell.MobileBar;
  SHORTCUTS = hotkeys.SHORTCUTS;
  CommandPalette = palette.CommandPalette;
  StaticStore = store.StaticStore;
  initialState = reducer.initialState;
});

afterAll(async () => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  for (const { key, desc } of protoSaved) {
    if (desc) Object.defineProperty(proto, key, desc);
    else delete proto[key];
  }
  await env.restore();
  go("#/mission");
});

beforeEach(() => { go("#/simple"); });

function ready(): State {
  return { ...initialState, phase: "ready", me };
}

test("parseHash reads #/simple, and card wins over ask", () => {
  expect(parseHash("#/simple").view).toBe("simple");
  expect(parseHash("#/simple?card=a%3A1")).toEqual({ view: "simple", card: "a:1" });
  const ask = "aaaaaaaaaaaaaaaa:2";
  expect(parseHash(hrefFor({ view: "simple", ask }))).toEqual({ view: "simple", ask });
  expect(hrefFor({ view: "simple", card: "a:1" })).toBe("#/simple?card=a%3A1");
  expect(parseHash(`#/simple?ask=${encodeURIComponent(ask)}&card=c1`)).toEqual({ view: "simple", card: "c1" });
  expect(parseHash("#/projects").view).toBe("projects");
  expect(parseHash("#/projects?card=keep").card).toBe("keep");
  expect(parseHash("#/not-a-view").view).toBe("mission");
});

test("sidebar and phone header link to Simple; the six phone tabs do not", async () => {
  const side = await env.mount(<StaticStore state={ready()}><Sidebar onSearch={() => {}} /></StaticStore>);
  const link = side.all("a").find((a) => a.getAttribute("href") === "#/simple");
  expect(link?.textContent).toContain("Simple");
  expect(link?.getAttribute("aria-current")).toBe("page");
  await side.unmount();

  const tabs = await env.mount(<StaticStore state={ready()}><TabBar /></StaticStore>);
  expect(tabs.all("a").some((a) => a.getAttribute("href") === "#/simple")).toBe(false);
  expect(tabs.all("a").length).toBe(6);
  await tabs.unmount();

  const phone = await env.mount(<StaticStore state={ready()}><MobileBar onSearch={() => {}} /></StaticStore>);
  const mobile = phone.all("a").find((a) => a.getAttribute("href") === "#/simple");
  expect(mobile?.className).toContain("mobile-simple");
  expect(mobile?.textContent).toContain("Simple");
  expect(mobile?.getAttribute("aria-current")).toBe("page");
  await phone.unmount();
});

test("g then n is listed, and the command palette offers Simple", async () => {
  expect(SHORTCUTS.some((s) => s.keys.join(" ") === "g n" && s.label === "Simple")).toBe(true);
  expect(SHORTCUTS.some((s) => s.keys.includes("h") || s.keys.includes("j") || s.keys.includes("k") || s.keys.includes("l"))).toBe(false);
  const page = await env.mount(<StaticStore state={ready()}><CommandPalette onClose={() => {}} /></StaticStore>);
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(page.text()).toContain("Simple");
  await page.unmount();
});
