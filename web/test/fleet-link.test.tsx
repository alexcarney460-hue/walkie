// FLEET-LINK-1: the Team page gives owners "Add machines" (one link for many machines) and the Fleet links list;
// members get neither. The sheet's result shows the link, the macOS/Linux and Windows (WSL) commands with copy
// buttons, how many machines, whose, until when, approval, and the warning with the link's id to revoke it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FleetLinkMinted } from "../../src/protocol/fleet-link.ts";
import type { MeView, NodeView, TeamView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";

import { go, installWindow } from "./window-stub.ts";
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
  FleetLinkList: () => ReactNode; Team: () => ReactNode; FleetLinkResult: (p: { res: FleetLinkMinted }) => ReactNode; FleetLinkSheet: (p: { onClose: () => void }) => ReactNode;
  StaticStore: (p: { state: State; children: ReactNode }) => ReactNode; initialState: State;
};
beforeAll(async () => {
  const [tm, fl, st, rd] = await Promise.all([
    import("../src/views/Team.tsx"), import("../src/views/FleetLinks.tsx"), import("../src/state/store.tsx"), import("../src/state/reducer.ts"),
  ]);
  mod = { FleetLinkList: fl.FleetLinkList, Team: tm.Team, FleetLinkResult: fl.FleetLinkResult, FleetLinkSheet: fl.FleetLinkSheet, StaticStore: st.StaticStore, initialState: rd.initialState };
});

const NOW = Date.now();
const node = (hostname: string, handle: string, id: string): NodeView => ({
  node_id: id, handle, hostname, ip: "", online: true, last_seen: NOW, rtt_ms: 3, self: handle === "maren", sync: { behind: 0, last_sync: NOW },
});
const NODES = [node("maren-mbp", "maren", "n1"), node("devon-mbp", "devon", "n2")];
const TEAM: TeamView = {
  id: "t", name: "harbor", authority: "n1", channels: [], nodes: NODES, plan: undefined as never,
  members: [
    { login: "direct:maren", handle: "maren", role: "owner", display_name: "Maren Holt" },
    { login: "direct:devon", handle: "devon", role: "member", display_name: "Devon" },
  ],
};
const state = (role: "owner" | "member", handle: string): State => ({
  ...mod.initialState, phase: "ready", team: TEAM, nodes: NODES,
  me: { handle, role, transport: { mode: "direct" }, tailscale: { ok: false } } as unknown as MeView,
});
const render = (s: State, el: ReactNode) => renderToStaticMarkup(<mod.StaticStore state={s}>{el}</mod.StaticStore>);

test("owner: an Add machines button on Machines and a Fleet links section", () => {
  go("#/team");
  const out = render(state("owner", "maren"), <mod.Team />);
  expect(out).toContain(">Add machines</button>");
  expect(out).toContain('title="One link that adds many machines"');
  expect(out).toContain('id="fleet-h">Fleet links</h2>');
});

test("member: neither; told to ask an owner (a fleet link for many machines)", () => {
  go("#/team");
  const out = render(state("member", "devon"), <mod.Team />);
  expect(out).not.toContain(">Add machines</button>");
  expect(out).not.toContain("Fleet links</h2>");
  expect(out).toContain("(or a fleet link, for many machines)");
});

test("the default owner target has an unchecked owner-level confirmation and cannot be submitted", () => {
  const out = render(state("owner", "maren"), <mod.FleetLinkSheet onClose={() => undefined} />);
  expect(out).toContain("Yes, grant owner-level access");
  expect(out).toContain("mint links, remove members, move authority and read restricted channels");
  expect(out).toContain('disabled="">Create link</button>');
  expect(out).not.toContain('checked=""');
});

test("the result: link, both commands with copy buttons, the facts and the warning", () => {
  const token = `wl1${"A".repeat(200)}`;
  const command = `curl -fsSL https://sqwakie.si/install.sh | WALKIE_VERSION=v0.2.0-pre.5 sh -s -- --join-link ${token}`;
  const res: FleetLinkMinted = {
    id: "0123456789abcdef0123456789abcdef", short: "01234567", handle: "maren", role: "owner", uses: 25, used: 0, pending: 0,
    expires_at: NOW + 7 * 86_400_000, approve: true, created_at: NOW, created_by: "maren", revoked_at: null, state: "active",
    token, link: `https://sqwakie.si/join#${token}&v=v0.2.0-pre.5`, command, windows_command: `wsl -- sh -c "${command}"`, version: "0.2.0-pre.5",
  };
  const out = renderToStaticMarkup(<mod.FleetLinkResult res={res} />);
  expect(out).toContain(res.link.replace(/&/g, "&amp;"));
  expect(out).toContain(`aria-label="Copy command: ${command}"`);
  expect(out).toContain(`aria-label="Copy command: ${res.windows_command.replace(/"/g, "&quot;")}"`);
  expect(out).toContain("Up to <b>25</b> machines");
  expect(out).toContain('They join as <b class="mono">@maren</b>’s (owner)');
  expect(out).toMatch(/Works until <b>[^<]+<\/b>/);
  expect(out).toContain("Each waits for <b>your approval</b>");
  expect(out).toContain("Anyone with this link can add machines as @maren’s");
  expect(out).toContain('<span class="mono">01234567</span>');
  expect(out).toContain("Windows (PowerShell, with WSL2)");
  expect(out).toContain("Owner-level access");
});

test("the result says 1 machine, not 1 machines", () => {
  const res = { id: "0123456789abcdef0123456789abcdef", short: "01234567", handle: "maren", role: "member", uses: 1, used: 0, pending: 0, expires_at: NOW + 86_400_000, approve: false, created_at: NOW, created_by: "maren", revoked_at: null, state: "active", token: "wl1x", link: "https://x/join#wl1x", command: "c", windows_command: "w", version: "0.2.0" } as FleetLinkMinted;
  const out = renderToStaticMarkup(<mod.FleetLinkResult res={res} />);
  expect(out).toContain("Up to <b>1</b> machine</span>");
});

const LINK = { id: "0123456789abcdef0123456789abcdef", short: "01234567", handle: "devon", role: "member", uses: 5, used: 0, pending: 1, expires_at: NOW + 86_400_000, approve: true, created_at: NOW, created_by: "maren", revoked_at: null, state: "active" };
const USE = { link: LINK.id, node_id: "nodeaaaabbbb", hostname: "devon-mbp", state: "pending", at: NOW, generation: "g1" };
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

test("the list: Approve, Deny and Revoke name their machine or link; a refused decision refetches the list", async () => {
  const { api } = await import("../src/api/client.ts");
  const orig = { links: api.links, admit: api.admit };
  let loads = 0;
  api.links = (async () => { loads++; return { links: [LINK], uses: [USE], authority: "n1" }; }) as unknown as typeof api.links;
  api.admit = (async () => { throw new Error("stale_join_request"); }) as unknown as typeof api.admit;
  try {
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(<mod.StaticStore state={state("owner", "maren")}><mod.FleetLinkList /></mod.StaticStore>); });
    await settle();
    expect(loads).toBe(1);
    const labels = r.root.findAllByType("button").map((b) => b.props["aria-label"]);
    expect(labels).toContain("Approve devon-mbp node nodeaaaa");
    expect(labels).toContain("Deny devon-mbp node nodeaaaa");
    expect(labels).toContain("Revoke fleet link 01234567");
    const approve = r.root.findAllByType("button").find((b) => b.props["aria-label"] === "Approve devon-mbp node nodeaaaa")!;
    await act(async () => { approve.props.onClick(); });
    await settle();
    expect(loads).toBe(2);
    expect(JSON.stringify(r.toJSON())).toContain("Something went wrong");
    r.unmount();
  } finally { Object.assign(api, orig); }
});

test("a failed reload hides stale decisions and offers retry, including when the list was empty", async () => {
  const { api } = await import("../src/api/client.ts");
  const original = { links: api.links, admit: api.admit };
  for (const links of [[LINK], []]) {
    let loads = 0;
    api.links = (async () => {
      loads++;
      if (loads > 1) throw new Error("reload failed");
      return { links, uses: links.length ? [USE] : [], authority: "n1" };
    }) as unknown as typeof api.links;
    api.admit = (async () => { throw new Error("stale_join_request"); }) as unknown as typeof api.admit;
    try {
      let r!: ReturnType<typeof create>;
      await act(async () => { r = create(<mod.StaticStore state={state("owner", "maren")}><mod.FleetLinkList /></mod.StaticStore>); });
      await settle();
      if (links.length) {
        const approve = r.root.findAllByType("button").find((b) => b.props["aria-label"] === "Approve devon-mbp node nodeaaaa")!;
        await act(async () => { approve.props.onClick(); });
      } else {
        await act(async () => { r.update(<mod.StaticStore state={state("owner", "maren")}><mod.FleetLinkList refresh="again" /></mod.StaticStore>); });
      }
      await settle();
      expect(JSON.stringify(r.toJSON())).toContain("Something went wrong. Try again.");
      expect(r.root.findAllByType("button").map((b) => b.props["aria-label"])).not.toContain("Approve devon-mbp node nodeaaaa");
      expect(r.root.findAllByType("button").some((b) => b.children.includes("Retry"))).toBe(true);
      r.unmount();
    } finally { Object.assign(api, original); }
  }
});

test("pending actions with the same hostname identify their nodes", async () => {
  const { api } = await import("../src/api/client.ts");
  const original = api.links;
  api.links = (async () => ({ links: [LINK], uses: [USE, { ...USE, node_id: "nodeccccdddd" }], authority: "n1" })) as unknown as typeof api.links;
  try {
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(<mod.StaticStore state={state("owner", "maren")}><mod.FleetLinkList /></mod.StaticStore>); });
    await settle();
    const names = r.root.findAllByType("button").map((b) => b.props["aria-label"]);
    expect(names).toContain("Approve devon-mbp node nodeaaaa");
    expect(names).toContain("Approve devon-mbp node nodecccc");
    r.unmount();
  } finally { api.links = original; }
});

test("the revoke confirmation names its link", async () => {
  const { api } = await import("../src/api/client.ts");
  const orig = api.links;
  api.links = (async () => ({ links: [LINK], uses: [], authority: "n1" })) as unknown as typeof api.links;
  try {
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(<mod.StaticStore state={state("owner", "maren")}><mod.FleetLinkList /></mod.StaticStore>); });
    await settle();
    await act(async () => { r.root.findAllByType("button").find((b) => b.props["aria-label"] === "Revoke fleet link 01234567")!.props.onClick(); });
    expect(r.root.findAllByType("button").map((b) => b.props["aria-label"])).toContain("Confirm revoke fleet link 01234567");
    r.unmount();
  } finally { api.links = orig; }
});
