import { afterAll, beforeAll, expect, test } from "bun:test";
import { Cluster, type TestNode } from "../helpers/cluster.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { ORCHESTRATOR_TOKEN_HEADER } from "../../src/protocol/orchestrator.ts";
import { TalkieOsUser } from "../../src/daemon/orchestrator/os-user.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

let cluster: Cluster;
let node: TestNode;

beforeAll(async () => {
  cluster = new Cluster();
  node = await cluster.add({ name: "alex", login: "-", hostname: "alex-mbp", direct: true });
  await node.client().init("acme", "alex");
  registerHost(node.d.core, { acceptsToken: (token: string) => token === "test-child-token" } as unknown as OrchestratorHost);
});
afterAll(async () => { await cluster.close(); });

test("proxy marker, forced agent and child token privately deliver every minted credential", async () => {
  const cases = [
    { "X-Walkie-Talkie-Shell": "1" },
    { [ORCHESTRATOR_TOKEN_HEADER]: "test-child-token" },
    { "X-Walkie-Agent": "orchestrator", [ORCHESTRATOR_TOKEN_HEADER]: "test-child-token" },
  ];
  for (const path of ["/v1/team/invite-code", "/v1/team/add-machine"]) {
    for (const marked of cases) {
      const before = (await node.client().orchestratorMessages({ limit: 100 })).messages.length;
      const headers = new Headers({ "Content-Type": "application/json" });
      for (const [key, value] of Object.entries(marked)) if (value !== undefined) headers.set(key, value);
      const res = await fetch(`http://walkie${path}`, { unix: node.socket, method: "POST",
        headers, body: JSON.stringify({ handle: "alex" }) } as RequestInit);
      expect(res.status).toBe(200);
      const receipt = await res.json() as Record<string, unknown>;
      expect(receipt.delivered).toBe(true);
      expect(JSON.stringify(receipt)).not.toContain("wk1");
      const messages = (await node.client().orchestratorMessages({ limit: 100 })).messages;
      expect(messages.length).toBe(before + 1);
      expect(messages.some((m) => m.via === "private" && m.text.includes("wk1"))).toBe(true);
    }
  }
});

test("an unmarked owner-socket request still returns the credential to the person", async () => {
  for (const path of ["/v1/team/invite-code", "/v1/team/add-machine"]) {
    const res = await fetch(`http://walkie${path}`, { unix: node.socket, method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: "alex" }) } as RequestInit);
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain("wk1");
  }
});

test("the dedicated shell proxy mints only checked private joins", async () => {
  const home = join(cluster.root, "walkie-talkie"); mkdirSync(home, { recursive: true });
  const user = new TalkieOsUser(node.socket, (token) => token === "test-child-token", {
    ready: () => true, privateHome: () => null, socketRoot: cluster.root,
    admin: async () => ({ ok: true, name: "walkie-talkie", uid: 550_000, home }),
  });
  try {
    await user.prepare();
    for (const path of ["/v1/team/invite-code", "/v1/team/add-machine"]) {
      const headers = { [ORCHESTRATOR_TOKEN_HEADER]: "test-child-token", "Content-Type": "application/json" };
      const before = (await node.client().orchestratorMessages({ limit: 100 })).messages.length;
      const accepted = await fetch(`http://walkie${path}`, { unix: user.socket, method: "POST", headers,
        body: JSON.stringify({ handle: "alex" }) } as RequestInit);
      expect(accepted.status).toBe(200);
      expect((await accepted.json() as { delivered: boolean }).delivered).toBe(true);
      expect((await node.client().orchestratorMessages({ limit: 100 })).messages.length).toBe(before + 1);
      for (const body of [{ handle: "alex", extra: true }, { handle: "alex", role: "owner" }]) {
        const denied = await fetch(`http://walkie${path}`, { unix: user.socket, method: "POST", headers,
          body: JSON.stringify(body) } as RequestInit);
        expect(denied.status).toBe(403);
      }
    }
  } finally { await user.destroy(); }
});

test("auth routes treat a child token as orchestrator and reject a different agent name", async () => {
  for (const [headers, code] of [
    [{ [ORCHESTRATOR_TOKEN_HEADER]: "test-child-token" }, "person_only"],
    [{ [ORCHESTRATOR_TOKEN_HEADER]: "test-child-token", "X-Walkie-Agent": "helper" }, "forbidden"],
  ] as const) {
    const res = await fetch("http://walkie/v1/auth/nonce", { unix: node.socket, method: "POST", headers } as RequestInit);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
  }
});
