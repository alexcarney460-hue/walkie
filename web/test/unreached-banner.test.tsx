// Mixed teams: Mission Control says when this machine can't reach part of the team and their agents are hidden here, with
// the fix. The daemon marks such a machine `unreached: { vouched }` (src/protocol/schemas.ts NodeView); `vouched` false =
// no machine that reaches it vouches for it now. The banner is shown only then, and a dismissal is remembered per machine.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MeView, NodeView, TeamView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";

import { go, installWindow } from "./window-stub.ts";
const hadWindow = "window" in globalThis;
const hadDocument = "document" in globalThis;
installWindow();
const inert: unknown = new Proxy(() => inert, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : inert), apply: () => undefined });
(globalThis as { document?: unknown }).document ??= inert;
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  if (!hadDocument) delete (globalThis as { document?: unknown }).document;
});

let mod: {
  hiddenMachines: (nodes: readonly NodeView[]) => NodeView[];
  directOnlyHere: (me: Pick<MeView, "transport"> | null) => boolean;
  readDismissed: (raw: unknown) => string[];
  isDismissed: (hidden: readonly NodeView[], dismissed: readonly string[]) => boolean;
  withDismissed: (dismissed: readonly string[], hidden: readonly NodeView[]) => string[];
  pruneDismissed: (dismissed: readonly string[], hidden: readonly NodeView[]) => string[];
  focusPageHeading: (doc?: Pick<Document, "querySelector">) => void;
  UnreachedBanner: (p: { count: number; here: boolean; onDismiss: () => void }) => ReactNode;
  UnreachedNotice: () => ReactNode;
  MissionControl: () => ReactNode;
  StaticStore: (p: { state: State; children: ReactNode }) => ReactNode; initialState: State;
};
beforeAll(async () => {
  const [ub, mc, st, rd] = await Promise.all([
    import("../src/views/mission/UnreachedBanner.tsx"), import("../src/views/mission/MissionControl.tsx"),
    import("../src/state/store.tsx"), import("../src/state/reducer.ts"),
  ]);
  mod = { ...ub, MissionControl: mc.MissionControl, StaticStore: st.StaticStore, initialState: rd.initialState };
});

const NOW = Date.now();
const node = (hostname: string, id: string, over: Partial<NodeView> = {}): NodeView => ({
  node_id: id, handle: "maren", hostname, ip: "100.64.0.1", online: true, last_seen: NOW, rtt_ms: 3, self: false, sync: { behind: 0, last_sync: NOW }, ...over,
});
const SELF = node("maren-mbp", "n0", { self: true });
/** A machine this one can't reach: online only while a machine that reaches it vouches for it. */
const unreached = (hostname: string, id: string, vouched: boolean) => node(hostname, id, { via: "relay", online: vouched, unreached: { vouched } });
const TEAM: TeamView = {
  id: "t", name: "harbor", authority: "n0", channels: [], nodes: [SELF], plan: undefined as never,
  members: [{ login: "maren@x", handle: "maren", role: "owner", display_name: "Maren Holt" }],
};
const ME = (transports: ("tailscale" | "direct")[]): MeView => ({
  handle: "maren", role: "member", transport: { mode: transports.includes("tailscale") ? "tailscale" : "direct", transports },
}) as unknown as MeView;
const state = (nodes: NodeView[], me: MeView | null = ME(["tailscale"])): State => ({ ...mod.initialState, phase: "ready", team: { ...TEAM, nodes }, nodes, me });
const render = (s: State, el: ReactNode) => renderToStaticMarkup(<mod.StaticStore state={s}>{el}</mod.StaticStore>);
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
/** The banner's sentence (its Dismiss button left out); "" when there is no banner. */
const message = (html: string) => text(/<p>(.*?)<\/p>/s.exec(html)?.[1] ?? "");

// What a browser keeps for this page (the stand-in window has none): set per test, removed after.
const win = installWindow() as unknown as { localStorage?: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } };
afterEach(() => { delete win.localStorage; });
function browserStorage(initial: Record<string, string> = {}): Map<string, string> {
  const kept = new Map(Object.entries(initial));
  win.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v) };
  return kept;
}

const ONE = "1 machine's agents are hidden on this machine because it can't reach it directly (or that machine is off). Run walkie direct enable here.";
const TWO = "2 machines' agents are hidden on this machine because it can't reach them directly (or those machines are off). Run walkie direct enable here.";

test("the banner is shown only while at least one machine's agents are hidden here", () => {
  const banner = (nodes: NodeView[]) => render(state(nodes), <mod.UnreachedNotice />);
  const one = banner([SELF, unreached("atlas", "n1", false)]);
  expect(message(one)).toBe(ONE);
  expect(one).toContain('role="status"');
  expect(one).toContain(">Dismiss</button>");
  expect(one).toContain("<code>walkie direct enable</code>");
  expect(one).toContain("local-lag-banner"); // the existing banner style
  expect(message(banner([SELF, unreached("atlas", "n1", false), unreached("hestia", "n2", false)]))).toBe(TWO);
  // Machines a reaching machine vouches for are shown, so they are not counted.
  expect(message(banner([SELF, unreached("atlas", "n1", true), unreached("hestia", "n2", false), unreached("rhea", "n3", false)]))).toBe(TWO);
  expect(banner([SELF, unreached("atlas", "n1", true)])).toBe("");
  // Machines this one reaches itself (even offline), and a daemon that sends no `unreached`, show nothing.
  expect(banner([SELF, node("alex-mac", "n4", { via: "tailscale", online: false }), node("atlas", "n1", { via: "relay", online: false })])).toBe("");
  expect(banner([SELF])).toBe("");
});

test("a Direct-only machine is told to run the command on the other machines, not here", () => {
  const nodes = [SELF, unreached("atlas", "n1", false), unreached("hestia", "n2", false)];
  expect(message(render(state(nodes, ME(["direct"])), <mod.UnreachedNotice />)))
    .toBe("2 machines' agents are hidden on this machine because it can't reach them directly (or those machines are off). Run walkie direct enable on those machines.");
  expect(message(render(state([SELF, unreached("atlas", "n1", false)], ME(["direct"])), <mod.UnreachedNotice />)))
    .toBe("1 machine's agents are hidden on this machine because it can't reach it directly (or that machine is off). Run walkie direct enable on that machine.");
  // Tailscale-only, dual (Direct just turned on, not yet on the roster), or unknown: the command is run here.
  for (const me of [ME(["tailscale"]), ME(["tailscale", "direct"]), null]) {
    expect(message(render(state(nodes, me), <mod.UnreachedNotice />))).toBe(TWO);
  }
  expect(mod.directOnlyHere(ME(["direct"]))).toBe(true);
  expect(mod.directOnlyHere(ME(["tailscale", "direct"]))).toBe(false);
  expect(mod.directOnlyHere({ transport: undefined })).toBe(false);
  expect(mod.directOnlyHere(null)).toBe(false);
});

test("hidden machines are the peers whose `unreached` says nobody vouches for them", () => {
  const nodes = [SELF, unreached("atlas", "n1", false), unreached("hestia", "n2", true), node("alex-mac", "n3")];
  expect(mod.hiddenMachines(nodes).map((n) => n.hostname)).toEqual(["atlas"]);
  expect(mod.hiddenMachines([{ ...SELF, unreached: { vouched: false } }])).toEqual([]);
});

test("dismissing is remembered per machine: the banner stays gone for them and returns for a machine not yet dismissed", () => {
  const atlas = unreached("atlas", "n1", false);
  const hestia = unreached("hestia", "n2", false);
  expect(mod.isDismissed([atlas], [])).toBe(false);
  const after = mod.withDismissed([], [atlas]);
  expect(after).toEqual(["n1"]);
  expect(mod.isDismissed([atlas], after)).toBe(true);
  expect(mod.isDismissed([atlas, hestia], after)).toBe(false); // hestia is new
  expect(mod.withDismissed(after, [atlas, hestia])).toEqual(["n1", "n2"]); // each machine once
  // A stored value that isn't a list of ids is ignored; the list is bounded, keeping the newest.
  for (const junk of [null, "n1", { n1: true }, 7]) expect(mod.readDismissed(junk)).toEqual([]);
  expect(mod.readDismissed(["n1", 2, null, "n2"])).toEqual(["n1", "n2"]);
  const long = Array.from({ length: 300 }, (_, i) => `n${i}`);
  expect(mod.readDismissed(long)).toHaveLength(256);
  expect(mod.readDismissed(long).at(-1)).toBe("n299");
});

test("a dismissal lasts only while its machine stays hidden: one that recovers and is hidden again is told again", () => {
  const atlas = unreached("atlas", "n1", false);
  const hestia = unreached("hestia", "n2", false);
  // Only dismissals of machines hidden now are kept.
  expect(mod.pruneDismissed(["n1", "n2", "n3"], [atlas, hestia])).toEqual(["n1", "n2"]);
  expect(mod.pruneDismissed(["n1", "n2"], [hestia])).toEqual(["n2"]);
  expect(mod.pruneDismissed(["n1"], [])).toEqual([]);
  expect(mod.pruneDismissed([], [atlas])).toEqual([]);
  // The recurrence the banner exists to catch: dismissed while hidden, vouched for again (nothing hidden), hidden once more.
  let dismissed = mod.withDismissed([], [atlas]);
  expect(mod.isDismissed([atlas], dismissed)).toBe(true);
  dismissed = mod.pruneDismissed(dismissed, []);
  expect(dismissed).toEqual([]);
  expect(mod.isDismissed([atlas], dismissed)).toBe(false);
  // One of two recovers while the other stays hidden: the other stays dismissed, the recovered one is told again if it returns.
  dismissed = mod.withDismissed([], [atlas, hestia]);
  dismissed = mod.pruneDismissed(dismissed, [hestia]);
  expect(dismissed).toEqual(["n2"]);
  expect(mod.isDismissed([hestia], dismissed)).toBe(true);
  expect(mod.isDismissed([atlas, hestia], dismissed)).toBe(false);
});

test("the Dismiss button calls the handler", () => {
  let dismissed = 0;
  const banner = mod.UnreachedBanner({ count: 2, here: true, onDismiss: () => { dismissed++; } }) as ReactElement<{ children: ReactElement[] }>;
  const button = banner.props.children.find((c) => c.type === "button") as ReactElement<{ onClick: () => void; children: string }>;
  expect(button.props.children).toBe("Dismiss");
  button.props.onClick();
  expect(dismissed).toBe(1);
});

test("Dismiss moves focus to the Mission Control heading instead of dropping it to the page body", () => {
  const focused: unknown[] = [];
  const asked: string[] = [];
  const heading = { tabIndex: 0, focus: (options?: unknown) => { focused.push(options); } };
  const g = globalThis as { document?: unknown };
  const saved = g.document;
  g.document = { querySelector: (selector: string) => { asked.push(selector); return heading; } };
  try {
    let dismissed = 0;
    const banner = mod.UnreachedBanner({ count: 2, here: true, onDismiss: () => { dismissed++; } }) as ReactElement<{ children: ReactElement[] }>;
    const button = banner.props.children.find((c) => c.type === "button") as ReactElement<{ onClick: () => void }>;
    button.props.onClick();
    expect(dismissed).toBe(1);
    expect(asked).toEqual([".mission-main h1"]);
    expect(heading.tabIndex).toBe(-1); // focusable by script, never by Tab
    expect(focused).toEqual([{ preventScroll: true }]); // the heading is where the banner was: no scroll jump
  } finally {
    g.document = saved;
  }
});

test("focusPageHeading does nothing, and does not throw, without a heading or without a document", () => {
  expect(() => mod.focusPageHeading({ querySelector: () => null })).not.toThrow();
  const g = globalThis as { document?: unknown };
  const saved = g.document;
  delete g.document;
  try {
    expect(() => mod.focusPageHeading()).not.toThrow();
  } finally {
    g.document = saved;
  }
});

test("a dismissal kept in this browser hides the banner; a machine hidden since then brings it back", () => {
  const nodes = [SELF, unreached("atlas", "n1", false)];
  expect(render(state(nodes), <mod.UnreachedNotice />)).not.toBe(""); // nothing stored: shown
  browserStorage({ "walkie.unreachedDismissed": JSON.stringify(["n1"]) });
  expect(render(state(nodes), <mod.UnreachedNotice />)).toBe("");
  expect(message(render(state([...nodes, unreached("hestia", "n2", false)]), <mod.UnreachedNotice />))).toBe(TWO);
  browserStorage({ "walkie.unreachedDismissed": "not json" }); // damaged storage: treated as none, shown
  expect(message(render(state(nodes), <mod.UnreachedNotice />))).toBe(ONE);
});

test("Mission Control shows the banner under its title while a machine's agents are hidden, and not otherwise", () => {
  go("#/mission");
  const hidden = render(state([SELF, unreached("atlas", "n1", false)]), <mod.MissionControl />);
  expect(hidden).toContain('data-testid="unreached-banner"');
  expect(text(hidden)).toContain(ONE);
  const fine = render(state([SELF, unreached("atlas", "n1", true)]), <mod.MissionControl />);
  expect(fine).not.toContain("unreached-banner");
  expect(render(state([SELF]), <mod.MissionControl />)).not.toContain("unreached-banner");
});
