// WALKIE-ADD-MACHINE-1: the link/command builders shared by the daemon, CLI, dashboard and site, and the agent
// boundary on the MCP side (no tool mints a code; an unknown tool name is refused without a daemon call).
import { describe, expect, test } from "bun:test";
import { callTool, TOOLS } from "../../src/mcp/tools.ts";
import type { WalkieClient } from "../../src/client/index.ts";
import { addMachineCommand, addMachineLink, INSTALL_URL, JOIN_URL, releaseTag } from "../../src/protocol/add-machine.ts";

const CODE = `wk1${"Ab_-".repeat(40)}`;

describe("add-machine link and command", () => {
  test("releaseTag: the running version as an installer tag; dev builds get none", () => {
    expect(releaseTag("0.2.0-pre.2")).toBe("v0.2.0-pre.2");
    expect(releaseTag("v1.4.0")).toBe("v1.4.0");
    expect(releaseTag("0.2.0-dev+abc")).toBeNull();
    expect(releaseTag("latest")).toBeNull();
    expect(releaseTag("1.2.3; rm -rf ~")).toBeNull();
  });
  test("the command pins the release and passes the code to setup; the link keeps both in the fragment", () => {
    expect(addMachineCommand(CODE, "v0.2.0-pre.2")).toBe(`curl -fsSL ${INSTALL_URL} | WALKIE_MIN_VERSION=v0.2.0-pre.2 sh -s -- --invite ${CODE} --company-machine`);
    expect(addMachineCommand(CODE, null)).toBe(`curl -fsSL ${INSTALL_URL} | sh -s -- --invite ${CODE} --company-machine`);
    const link = new URL(addMachineLink(CODE, "v0.2.0-pre.2"));
    expect(`${link.origin}${link.pathname}`).toBe(JOIN_URL);
    expect(link.search).toBe("");
    expect(link.hash).toBe(`#${CODE}&v=v0.2.0-pre.2`);
    expect(addMachineLink(CODE, null)).toBe(`${JOIN_URL}#${CODE}`);
    expect(addMachineLink(CODE, "v0.3.0", true)).toBe(`${JOIN_URL}#${CODE}&v=v0.3.0&a=1`);
  });
});

describe("agents can't mint over MCP", () => {
  test("no MCP tool mints invite codes or add-machine links", () => {
    for (const t of TOOLS) expect(`${t.name} ${t.description}`).not.toMatch(/invite|add[-_ ]machine|join code/i);
  });
  test("a made-up tool name is refused without calling the daemon", async () => {
    const calls: string[] = [];
    const spy = new Proxy({}, { get: (_t, k) => { calls.push(String(k)); return () => Promise.reject(new Error("no daemon")); } }) as WalkieClient;
    for (const name of ["walkie_add_machine", "walkie_invite", "walkie_team_add_machine"]) {
      const r = await callTool(spy, name, { handle: "kira" });
      expect(r.isError).toBe(true);
      expect(r.content[0]?.text).toContain(`unknown tool ${name}`);
    }
    expect(calls.filter((c) => /invite|addMachine|request/.test(c))).toEqual([]);
  });
});
