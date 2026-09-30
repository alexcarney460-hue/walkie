import { expect, test } from "bun:test";
import { Cluster } from "../helpers/cluster.ts";
import { COMMANDS } from "../../src/cli/main.ts";
import { RENTAL_COMPUTE_AVAILABLE_IN_THIS_VERSION } from "../../src/protocol/compute-release.ts";
import { EXIT, type Ctx } from "../../src/cli/context.ts";

test("pre.10 daemon and CLI refuse rental compute before any site call", async () => {
  expect(RENTAL_COMPUTE_AVAILABLE_IN_THIS_VERSION).toBe(false);
  const cluster = new Cluster();
  try {
    const node = await cluster.add({ name: "alex", login: "alex@example.com", compute: false });
    await node.client().init("acme", "alex");
    await expect(node.client().computeQuotes()).rejects.toThrow("rental compute is not available in this version");
    const errors: string[] = [];
    const code = await COMMANDS.compute!({ err: (message: string) => { errors.push(message); } } as unknown as Ctx);
    expect(code).toBe(EXIT.error);
    expect(errors).toEqual(["rental compute is not available in this version"]);
  } finally { await cluster.close(); }
});

test("locked agent compute writes do not claim an action in general", async () => {
  const cluster = new Cluster();
  try {
    const node = await cluster.add({ name: "alex", login: "alex@example.com", compute: false });
    await node.client().init("acme", "alex");
    const before = (await node.client().events({ channel: "general", limit: 100 })).events.length;
    for (const [path, body] of [
      ["/v1/compute/rent", { machines: [{ tier: "agent", count: 1 }] }],
      ["/v1/compute/stop", { all: true }],
      ["/v1/compute/credit", { block: 1000 }],
      ["/v1/compute/handover/object", {}],
    ] as const) {
      const response = await fetch(`http://walkie${path}`, { unix: node.socket, method: "POST",
        headers: { "Content-Type": "application/json", "X-Walkie-Agent": "cc-probe" },
        body: JSON.stringify(body) } as RequestInit);
      expect(response.status).toBe(503);
      expect((await response.text())).toContain("compute_unavailable");
    }
    const after = (await node.client().events({ channel: "general", limit: 100 })).events.length;
    expect(after).toBe(before);
  } finally { await cluster.close(); }
});
