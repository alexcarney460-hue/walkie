// PRE5 RC LOW: the dashboard renames a board with its id percent-encoded (web/src/api/client.ts updateBoard:
// encodeURIComponent turns the id's ":" into %3A). The session allow-list (local-api.ts DASHBOARD_ROUTES) must accept
// that form as the route does, or a dashboard session gets 403 where the CLI gets 200.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dashboardRoute } from "../../src/daemon/local-api.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";

let c: Cluster;
let alex: TestNode;

const url = (n: TestNode, p: string) => `http://127.0.0.1:${n.d.localPort as number}${p}`;
async function session(n: TestNode): Promise<Record<string, string>> {
  const { nonce } = await n.client().authNonce();
  const res = await fetch(url(n, `/auth?nonce=${nonce}`), { redirect: "manual" });
  const value = /#s=([0-9a-f]{64})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
  if (!value) throw new Error("no dashboard session");
  return { "X-Walkie-Session": value, Origin: `http://127.0.0.1:${n.d.localPort as number}` };
}

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  await alex.client().init("acme", "alex");
}, 60_000);

afterAll(async () => { await c.close(); });

describe("the dashboard renames a board (its id percent-encoded)", () => {
  test("the allow-list takes both forms of the id, and nothing looser", () => {
    const id = "0123456789abcdef:12";
    expect(dashboardRoute("POST", `/v1/projects/p-0123abcd/boards/${id}`)).toBe(true);
    expect(dashboardRoute("POST", `/v1/projects/p-0123abcd/boards/${encodeURIComponent(id)}`)).toBe(true);
    expect(dashboardRoute("POST", "/v1/projects/p-0123abcd/boards/0123456789abcdef%3a12")).toBe(true);
    expect(dashboardRoute("POST", "/v1/projects/p-0123abcd/boards/0123456789abcdef%2F12")).toBe(false);
    expect(dashboardRoute("POST", "/v1/projects/p-0123abcd/boards/0123456789abcdef%3A12/x")).toBe(false);
  });

  test("a dashboard session's rename, exactly as the dashboard sends it, is served", async () => {
    const { project } = await alex.client().createProject({ name: "Launch" });
    const { board } = await alex.client().createBoard(project.channel, { name: "Second" });
    expect(board.id).toContain(":");
    const h = await session(alex);
    const res = await fetch(url(alex, `/v1/projects/${encodeURIComponent(project.channel)}/boards/${encodeURIComponent(board.id)}`), {
      method: "POST", headers: { ...h, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Renamed from the dashboard" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { board: { name: string } }).board.name).toBe("Renamed from the dashboard");
  }, 30_000);
});
