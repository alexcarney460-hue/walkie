// E21b r2 (VERDICT fbdab491 MEDIUM 2): a fleet link with no use limit still admits machines only within the plan's
// machine limit (Free: 4) and the node limits (256 per member through links, 1024 per team). The dashboard's choice,
// the minted result and the list say "no link limit", never "No limit" or "Any number of machines".
import { afterAll, beforeAll, expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FleetLinkMinted } from "../../src/protocol/fleet-link.ts";
import type { MeView, NodeView, TeamView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";

import { installWindow } from "./window-stub.ts";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  FleetLinkList: () => ReactNode; FleetLinkResult: (p: { res: FleetLinkMinted }) => ReactNode; FleetLinkSheet: (p: { onClose: () => void }) => ReactNode;
  StaticStore: (p: { state: State; children: ReactNode }) => ReactNode; initialState: State;
};
beforeAll(async () => {
  const [fl, st, rd] = await Promise.all([import("../src/views/FleetLinks.tsx"), import("../src/state/store.tsx"), import("../src/state/reducer.ts")]);
  mod = { FleetLinkList: fl.FleetLinkList, FleetLinkResult: fl.FleetLinkResult, FleetLinkSheet: fl.FleetLinkSheet, StaticStore: st.StaticStore, initialState: rd.initialState };
});

const NOW = Date.now();
const NODES: NodeView[] = [{ node_id: "n1", handle: "maren", hostname: "maren-mbp", ip: "", online: true, last_seen: NOW, rtt_ms: 3, self: true, sync: { behind: 0, last_sync: NOW } }];
const TEAM: TeamView = { id: "t", name: "harbor", authority: "n1", channels: [], nodes: NODES, plan: undefined as never, members: [{ login: "direct:maren", handle: "maren", role: "owner", display_name: "Maren Holt" }] };
const OWNER: State = { ...({} as State), phase: "ready", team: TEAM, nodes: NODES, me: { handle: "maren", role: "owner", transport: { mode: "direct" }, tailscale: { ok: false } } as unknown as MeView };
const state = (): State => ({ ...mod.initialState, ...OWNER });
const NO_PROMISE = /No limit<|Any number of|any number of|unlimited/;

test("the sheet's choice says no link limit and that plan and machine limits still apply", () => {
  const out = renderToStaticMarkup(<mod.StaticStore state={state()}><mod.FleetLinkSheet onClose={() => undefined} /></mod.StaticStore>);
  expect(out).toContain('<option value="0">No link limit (plan and machine limits apply)</option>');
  expect(out).not.toMatch(NO_PROMISE);
});

test("the minted result with no use limit", () => {
  const res = { id: "0123456789abcdef0123456789abcdef", short: "01234567", handle: "maren", role: "member", uses: 0, used: 0, pending: 0, expires_at: NOW + 86_400_000, approve: false, created_at: NOW, created_by: "maren", revoked_at: null, state: "active", token: "wl1x", link: "https://x/join#wl1x", command: "c", windows_command: "w", version: "0.2.0" } as FleetLinkMinted;
  const out = renderToStaticMarkup(<mod.FleetLinkResult res={res} />);
  expect(out).toContain('<span class="am-fact">No link limit; plan and machine limits still apply</span>');
  expect(out).not.toMatch(NO_PROMISE);
});

test("the list row of a link with no use limit", async () => {
  const { api } = await import("../src/api/client.ts");
  const orig = api.links;
  const link = { id: "0123456789abcdef0123456789abcdef", short: "01234567", handle: "maren", role: "member", uses: 0, used: 2, pending: 0, expires_at: NOW + 86_400_000, approve: false, created_at: NOW, created_by: "maren", revoked_at: null, state: "active" };
  api.links = (async () => ({ links: [link], uses: [], authority: "n1" })) as unknown as typeof api.links;
  try {
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(<mod.StaticStore state={state()}><mod.FleetLinkList /></mod.StaticStore>); });
    await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
    const json = JSON.stringify(r.toJSON());
    expect(json).toContain("2 joined · no link limit");
    expect(json).not.toMatch(NO_PROMISE);
    r.unmount();
  } finally {
    api.links = orig;
  }
});
