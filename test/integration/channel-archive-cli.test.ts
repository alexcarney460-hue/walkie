// The real CLI entry and API run only against a task-owned synthetic cluster.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Cluster, standardTeam, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

let cluster: Cluster;
let alex: TestNode;
let kira: TestNode;
beforeAll(async () => {
  cluster = new Cluster();
  ({ alex, kira } = await standardTeam(cluster));
});
afterAll(async () => { await cluster.close(); });

function archive(node: TestNode, name: string) {
  return runAsPerson([process.execPath, join(import.meta.dir, "../../src/cli/main.ts"), "channel", "archive", name, "--json"], {
    PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: node.home, WALKIE_SOCKET: node.socket,
  });
}

test("owner CLI archives an existing private channel without changing its membership or topic", async () => {
  await alex.client().channel({ name: "archive-private", members: ["alex", "kira"], topic: "Keep this topic" });
  const result = await archive(alex, "#archive-private");
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(JSON.parse(result.out).event.body).toMatchObject({ name: "archive-private", archived: true });
  const view = (await alex.client().team()).channels.find((c) => c.name === "archive-private");
  expect(view).toMatchObject({ archived: true, members: ["alex", "kira"], topic: "Keep this topic" });
  await expect(alex.client().post({ channel: "archive-private", text: "refused after archive" })).rejects.toThrow(/archived/);
});

test("member CLI retains the server owner-only refusal and leaves the channel active", async () => {
  await alex.client().channel({ name: "archive-member" });
  await waitFor(async () => (await kira.client().team()).channels.some((c) => c.name === "archive-member"));
  const result = await archive(kira, "archive-member");
  expect(result.code).toBe(1);
  expect(result.err).toContain("not_channel_owner");
  expect((await alex.client().team()).channels.find((c) => c.name === "archive-member")?.archived).not.toBe(true);
});

test("unknown channel exits unsuccessfully without creating an archived placeholder", async () => {
  const result = await archive(alex, "archive-missing");
  expect(result.code).toBe(1);
  expect(result.out).toBe("");
  expect((await alex.client().team()).channels.some((c) => c.name === "archive-missing")).toBe(false);
});

test("unsupported dry-run refuses through the actual CLI without archiving a live fixture channel", async () => {
  await alex.client().channel({ name: "archive-dryrun" });
  const result = await runAsPerson([
    process.execPath, join(import.meta.dir, "../../src/cli/main.ts"),
    "channel", "archive", "archive-dryrun", "--dry-run",
  ], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: alex.home, WALKIE_SOCKET: alex.socket });
  expect(result.code).toBe(1);
  expect(result.out).toBe("");
  expect(result.err).toContain("dry-run");
  expect((await alex.client().team()).channels.find((c) => c.name === "archive-dryrun")?.archived).not.toBe(true);
});

test.each([false, true])("offline authority leaves an actual CLI archive queued until it can apply (JSON=%s)", async (json) => {
  const fixture = new Cluster();
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  try {
    const { alex: authority, kira: owner } = await standardTeam(fixture);
    await authority.client().setRole("kira", "owner");
    const name = "archive-queued";
    await authority.client().channel({ name, topic: "retained" });
    await waitFor(() => owner.d.core.roster.members.get(owner.spec.login)?.role === "owner"
      && owner.d.core.roster.channels.has(name));
    await authority.stop();
    const responses: { status: number; body: { queued: boolean; request_id: string } }[] = [];
    const methods: string[] = [];
    const socket = join(fixture.root, "archive-observer.sock");
    proxy = Bun.serve({ unix: socket, async fetch(req) {
      const body = await req.text();
      methods.push(req.method);
      const upstream = await fetch(`http://localhost${new URL(req.url).pathname}`, {
        unix: owner.socket, method: req.method, headers: req.headers, ...(body ? { body } : {}),
      });
      const text = await upstream.text();
      if (req.method === "POST") responses.push({ status: upstream.status, body: JSON.parse(text) });
      return new Response(text, { status: upstream.status, headers: upstream.headers });
    } });
    const result = await runAsPerson([
      process.execPath, join(import.meta.dir, "../../src/cli/main.ts"),
      "channel", "archive", name, ...(json ? ["--json"] : []),
    ], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: owner.home, WALKIE_SOCKET: socket });
    expect(methods).toEqual(["GET", "POST"]);
    expect(responses).toHaveLength(1);
    const response = responses[0]!;
    expect(response.status).toBe(202);
    expect(response.body.queued).toBe(true);
    expect(response.body.request_id).toMatch(/^[0-9a-f]{32}$/);
    expect(owner.d.core.store.queuedRequests().some((r) => r.id === response.body.request_id)).toBe(true);
    expect(owner.d.core.roster.channels.get(name)?.archived).not.toBe(true);
    if (json) expect(result.out).toBe(`${JSON.stringify(response.body)}\n`);
    await authority.start();
    await waitFor(() => authority.d.core.roster.channels.get(name)?.archived === true, { timeoutMs: 15_000 });
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    if (!json) expect(result.out).toContain("queued");
    expect(authority.d.core.roster.channels.get(name)?.topic).toBe("retained");
  } finally {
    proxy?.stop(true);
    await fixture.close();
  }
});
