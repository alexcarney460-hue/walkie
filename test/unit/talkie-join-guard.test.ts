import { afterEach, expect, test } from "bun:test";
import { addMachineCommand, addMachineLink } from "../../src/protocol/add-machine.ts";
import { containsJoinCredential } from "../../src/protocol/join-credential.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const code = `wk1${"Ab_-".repeat(40)}`;

test("agent posts refuse bare invites, one-click links and install commands in every channel", () => {
  const self = tnode("alex");
  const { team, create } = createTeam(self);
  self.seq = 1;
  const core = makeCore(self, team, cleanups);
  core.ingest(create, "local");
  core.emit("channel.upsert", { name: "general" });
  core.emit("channel.upsert", { name: "private-example", members: ["alex"] });
  for (const [agent, text] of [
    ["orchestrator", `Invite: ${code}`],
    ["another-agent", addMachineLink(code, "v0.2.0-pre.2")],
    ["seat-agent", addMachineCommand(code, null)],
  ] as const) {
    for (const channel of ["general", "private-example"]) {
      expect(() => core.emit("msg.post", { text }, { channel, agent })).toThrow("agents cannot publish join credentials");
    }
  }
  expect(containsJoinCredential(`wk1${"a".repeat(37)}`)).toBe(false);
  expect(core.emit("msg.post", { text: `wk1${"a".repeat(37)}` }, { channel: "general", agent: "another-agent" }).author.agent).toBe("another-agent");
  expect(core.emit("msg.post", { text: addMachineLink(code, null) }, { channel: "general" }).author.agent).toBeUndefined();
});

test("content defense catches embedded, encoded and split-within-one-write bearer codes", () => {
  for (const value of [`X${code}`, `-${code}tail`, `%77k1${code.slice(3)}`, `join%23${code}`,
    `${code.slice(0, 7)}\n${code.slice(7)}`, `${code.slice(0, 7)}\u200b${code.slice(7)}`,
    `${code.slice(0, 7)}%E2%80%8B${code.slice(7)}`]) {
    expect(containsJoinCredential(value)).toBe(true);
  }
  expect(containsJoinCredential(`wk1${"a".repeat(37)}`)).toBe(false);
});
