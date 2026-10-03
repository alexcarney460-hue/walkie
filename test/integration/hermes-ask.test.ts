// Hermes is view only: it has no inbox, so an ask addressed directly to a Hermes agent would sit unanswered until it expired. The daemon
// refuses one (403) on this machine and on any other, and says why. Asks to a person, to a machine and to any other agent are unchanged,
// and the MCP tool reaches the same route.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { WalkieError } from "../../src/client/index.ts";
import { handleToolCall } from "../../src/mcp/server.ts";
import { Cluster, standardTeam, waitFor, type TestNode } from "../helpers/cluster.ts";

const REFUSAL = "Hermes agents are view only: they cannot answer asks";
const hex = (name: string) => createHash("sha256").update(name).digest("hex");

let c: Cluster;
let alex: TestNode, kira: TestNode;
beforeAll(async () => {
  c = new Cluster();
  ({ alex, kira } = await standardTeam(c)); // alex-mbp, kiras-mbp, and kira's second machine kiras-studio
  const hermes = (node: TestNode, profile: string) => node.client(`hermes-${profile}`).hermesStatus({ profile, session: hex(profile), at: Date.now(),
    sequence: 1, state: "idle", fallback: "idle" });
  await hermes(kira, "research"); // kira's machine shows a Hermes profile, an ordinary Claude agent, and a Claude agent that merely has a Hermes-like name
  await kira.client("cc-0ff0ff").status({ agent: "cc-0ff0ff", state: "idle", runtime: "claude-code" });
  await kira.client("hermes-fan").status({ agent: "hermes-fan", state: "idle", runtime: "claude-code" });
  await hermes(alex, "writer"); // and alex's own machine shows one too
  for (const agent of ["hermes-research", "cc-0ff0ff", "hermes-fan"]) {
    await waitFor(async () => (await alex.client().agents()).agents.find((a) => a.agent === agent && a.hostname === "kiras-mbp"), { what: `${agent} on alex` });
  }
}, 60_000);
afterAll(async () => { await c.close(); });

/** That an ask was refused as an ask to a Hermes agent: a 403 forbidden saying why. */
function expectRefused(error: WalkieError | null): void {
  expect(error).not.toBeNull();
  expect([error?.status, error?.code, error?.message]).toEqual([403, "forbidden", REFUSAL]);
}
/** The error an ask to `to` is refused with, or null when it was accepted. */
async function refusal(node: TestNode, to: string): Promise<WalkieError | null> {
  try { await node.client().ask({ to, text: "are you there?", timeout_s: 60 }); return null; }
  catch (error) { if (error instanceof WalkieError) return error; throw error; }
}
/** The asks this node holds that are addressed to `to` exactly (an ask refused at creation is not among them). */
const asksTo = async (node: TestNode, to: string) => (await node.client().asks({})).asks.filter((a) => a.ask.body.to === to);

describe("an ask addressed directly to a Hermes agent", () => {
  test("is refused when the agent is on another person's machine, with a clear 403, and no ask is created", async () => {
    expectRefused(await refusal(alex, "@kira/kiras-mbp/hermes-research"));
    expect(await asksTo(alex, "@kira/kiras-mbp/hermes-research")).toEqual([]);
  });

  test("is refused when the agent is on the asker's own machine", async () => {
    expectRefused(await refusal(alex, "@alex/alex-mbp/hermes-writer"));
    expect(await asksTo(alex, "@alex/alex-mbp/hermes-writer")).toEqual([]);
  });

  test("is refused for an agent's ask as for a person's, while the same agent can still ask an ordinary agent", async () => {
    await expect(alex.client("planner").ask({ to: "@kira/kiras-mbp/hermes-research", text: "an agent asks a Hermes agent", timeout_s: 60 })).rejects.toThrow(REFUSAL);
    const { event } = await alex.client("planner").ask({ to: "@kira/kiras-mbp/cc-0ff0ff", text: "an agent asks an ordinary agent", timeout_s: 60 });
    expect(event.kind).toBe("ask");
  });

  test("reaches a model through the MCP tool as the same error", async () => {
    const result = await handleToolCall(alex.client("planner"), "walkie_ask", { to: "@kira/kiras-mbp/hermes-research", text: "are you there?", wait_s: 5 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(`forbidden: ${REFUSAL}`);
    expect(await asksTo(alex, "@kira/kiras-mbp/hermes-research")).toEqual([]);
  });
});

describe("every other ask is unchanged", () => {
  test("a person, a machine and an ordinary agent are asked as before, and a name nobody holds too", async () => {
    for (const to of ["@kira", "@kira/kiras-mbp", "@kira/kiras-mbp/cc-0ff0ff", "@kira/kiras-mbp/nobody"]) {
      expect([to, await refusal(alex, to)]).toEqual([to, null]);
      expect((await asksTo(alex, to)).length).toBeGreaterThan(0);
    }
  });

  test("an agent that is called hermes-something but is not a Hermes session is asked: the card decides, not the name", async () => {
    expect(await refusal(alex, "@kira/kiras-mbp/hermes-fan")).toBeNull();
  });

  test("the address must name the machine the Hermes card is on: the same agent name on another machine has no card there", async () => {
    expect(await refusal(alex, "@kira/kiras-studio/hermes-research")).toBeNull();
    expect(await refusal(alex, "@alex/alex-mbp/hermes-research")).toBeNull();
  });

  test("a Hermes agent is still shown to everyone, and its person can still be asked", async () => {
    const seen = (await alex.client().agents()).agents.find((a) => a.agent === "hermes-research");
    expect(seen?.status).toMatchObject({ runtime: "other", runtime_name: "hermes" });
    const { event } = await alex.client().ask({ to: "@kira", text: "the person of a Hermes agent can be asked", timeout_s: 60 });
    await waitFor(async () => (await kira.client().asks({ state: "open", to: "me" })).asks.some((a) => a.ask.id === event.id), { what: "the ask on kira" });
  });
});
