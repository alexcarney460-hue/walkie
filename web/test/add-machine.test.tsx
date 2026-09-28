// WALKIE-ADD-MACHINE-1: the Team page offers "Add a machine" on each member row to owners only (a member sees how to
// ask an owner instead), and the sheet shows the link, the pinned command, who it's for, the expiry and the warning.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AddMachine } from "../../src/protocol/add-machine.ts";
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
  Team: () => ReactNode; AddMachineResult: (p: { res: AddMachine }) => ReactNode;
  StaticStore: (p: { state: State; children: ReactNode }) => ReactNode; initialState: State;
};
beforeAll(async () => {
  const [tm, am, st, rd] = await Promise.all([
    import("../src/views/Team.tsx"), import("../src/views/AddMachineSheet.tsx"), import("../src/state/store.tsx"), import("../src/state/reducer.ts"),
  ]);
  mod = { Team: tm.Team, AddMachineResult: am.AddMachineResult, StaticStore: st.StaticStore, initialState: rd.initialState };
});

const NOW = Date.now();
const node = (hostname: string, handle: string, id: string): NodeView => ({
  node_id: id, handle, hostname, ip: "", online: true, last_seen: NOW, rtt_ms: 3, self: handle === "maren", sync: { behind: 0, last_sync: NOW },
});
const NODES = [node("maren-mbp", "maren", "n1"), node("arvid-mbp", "arvid", "n2")];
const TEAM: TeamView = {
  id: "t", name: "harbor", authority: "n1", channels: [], nodes: NODES, plan: undefined as never,
  members: [
    { login: "direct:maren", handle: "maren", role: "owner", display_name: "Maren Holt" },
    { login: "direct:arvid", handle: "arvid", role: "member", display_name: "Arvid" },
  ],
};
const state = (role: "owner" | "member", handle: string): State => ({
  ...mod.initialState, phase: "ready", team: TEAM, nodes: NODES,
  me: { handle, role, transport: { mode: "direct" }, tailscale: { ok: false } } as unknown as MeView,
});
const render = (s: State, el: ReactNode) => renderToStaticMarkup(<mod.StaticStore state={s}>{el}</mod.StaticStore>);

test("owner: every member row has Add a machine (their own row is labelled 'Add another of my machines')", () => {
  go("#/team");
  const out = render(state("owner", "maren"), <mod.Team />);
  expect(out).toContain('aria-label="Add a machine for @arvid"');
  expect(out).toContain('aria-label="Add another of my machines"'); // the owner's own row
  expect(out.match(/class="btn btn-ghost btn-icon btn-sm add-machine-btn"/g)).toHaveLength(2); // one per member row (maren, arvid)
});

test("member: no minting action anywhere; told to ask an owner for an Add a machine link", () => {
  go("#/team");
  const out = render(state("member", "arvid"), <mod.Team />);
  expect(out).not.toContain("Add a machine for @");
  expect(out).not.toContain("Add another of my machines");
  expect(out).toContain("to put Walkie on another of your machines, ask Maren Holt for an “Add a machine” link");
});

test("the sheet: link, pinned command, copy buttons, once-only for @handle, expiry and the warning", () => {
  const code = `wk1${"A".repeat(180)}`;
  const res: AddMachine = {
    code, handle: "arvid", role: "member", expires_at: NOW + 7 * 86_400_000, existing_member: true, version: "0.2.0-pre.2", team_agents: false,
    link: `https://getwalkie.vercel.app/join#${code}&v=v0.2.0-pre.2`,
    command: `curl -fsSL https://getwalkie.vercel.app/install.sh | WALKIE_VERSION=v0.2.0-pre.2 sh -s -- --invite ${code}`,
  };
  const out = renderToStaticMarkup(<mod.AddMachineResult res={res} />);
  expect(out).toContain(res.link.replace(/&/g, "&amp;"));
  expect(out).toContain(res.command);
  expect(out).toContain('aria-label="Copy Link"');
  expect(out).toContain(`aria-label="Copy command: ${res.command}"`);
  expect(out).toContain("Works once, only for <b class=\"mono\">@arvid</b>");
  expect(out).toMatch(/Expires <b>[^<]+<\/b>/);
  expect(out).toContain("Anyone with this link joins as one of @arvid’s machines.");
  expect(out).toContain("it stays in the browser history (and synced history)");
  // v0.2.0-pre.2 hosts no seats: its setup never asks, so the sheet doesn't promise the question…
  expect(out).not.toContain("The installer asks them one question");
  // …a build that does says so.
  const withSeats = renderToStaticMarkup(<mod.AddMachineResult res={{ ...res, team_agents: true }} />);
  expect(withSeats).toContain("The installer asks them one question: may the team start agents on that machine?");
});
