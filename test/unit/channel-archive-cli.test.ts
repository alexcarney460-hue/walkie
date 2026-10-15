import { afterEach, beforeEach, expect, test } from "bun:test";
import { WalkieClient, WalkieError } from "../../src/client/index.ts";
import { channel } from "../../src/cli/commands/team.ts";
import { parseArgs, UsageError } from "../../src/cli/args.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { fakeDaemon, type FakeDaemon } from "../helpers/fake-daemon.ts";

let daemon: FakeDaemon;
let routes: Record<string, unknown>;
const archiveEvent = {
  v: 1, team: "0000000000000000", id: "0000000000000000:1", origin: "0000000000000000",
  seq: 1, ts: 1, author: { handle: "alex", node: "0000000000000000" },
  kind: "channel.upsert", body: { name: "ops", archived: true }, sig: "fixture",
};
beforeEach(() => {
  routes = {
    "GET /v1/team": { channels: [{ name: "ops", members: ["alex", "noor"], archived: false }] },
    "POST /v1/channels": { event: archiveEvent },
  };
  daemon = fakeDaemon(routes);
});
afterEach(() => daemon.stop());

function run(args: string[], json = false) {
  const lines: string[] = [];
  const errors: string[] = [];
  const client = new WalkieClient({ socket: daemon.socket, agent: "archive-fixture", underAgent: true });
  const ctx: Ctx = {
    args: parseArgs(args, CLI_BOOLEANS), json, forAgent: true, agentMarker: () => "fixture",
    client: () => client, out: (line) => lines.push(line), err: (line) => errors.push(line),
  };
  return { done: channel(ctx), lines, errors };
}

test("archive sends only the selected channel and archived flag, with caller identity and exact JSON", async () => {
  const r = run(["archive", "#ops"], true);
  expect(await r.done).toBe(0);
  expect(r.lines).toEqual([JSON.stringify(routes["POST /v1/channels"])]);
  expect(daemon.requests.map(({ method, path }) => [method, path])).toEqual([
    ["GET", "/v1/team"], ["POST", "/v1/channels"],
  ]);
  expect(daemon.requests[1]?.body).toEqual({ name: "ops", archived: true });
  for (const req of daemon.requests) {
    expect(req.headers["x-walkie-agent"]).toBe("archive-fixture");
    expect(req.headers["x-walkie-under-agent"]).toBe("1");
  }
});

test("a queued archive is not reported as already archived, and JSON keeps its request identity", async () => {
  routes["POST /v1/channels"] = { queued: true, request_id: "a".repeat(32) };
  const r = run(["archive", "ops"]);
  expect(await r.done).toBe(0);
  expect(r.lines.join("\n")).toContain("queued");
  expect(r.lines.join("\n")).not.toMatch(/^archived/);
  expect(r.lines.join("\n")).toContain("a".repeat(32));
  const json = run(["archive", "ops"], true);
  expect(await json.done).toBe(0);
  expect(JSON.parse(json.lines[0]!)).toEqual(routes["POST /v1/channels"]);
});

test("an unavailable channel never turns an archive command into a channel creation", async () => {
  await expect(run(["archive", "unavailable"]).done).rejects.toBeInstanceOf(UsageError);
  expect(daemon.requests.map((r) => r.method)).toEqual(["GET"]);
});

test("archive rejects create-only flags and extra or missing channel arguments before any request", async () => {
  for (const args of [
    ["archive"], ["archive", "ops", "extra"], ["archive", "ops", "--public"],
    ["archive", "ops", "--members", "alex"], ["archive", "ops", "--topic", "changed"],
  ]) await expect(run(args).done).rejects.toBeInstanceOf(UsageError);
  expect(daemon.requests).toEqual([]);
});

test("an API refusal is propagated without claiming an archive succeeded", async () => {
  delete routes["POST /v1/channels"];
  const r = run(["archive", "ops"]);
  await expect(r.done).rejects.toBeInstanceOf(WalkieError);
  expect(r.lines).toEqual([]);
  expect(daemon.requests.filter((r) => r.method === "POST")).toHaveLength(1);
});

test("channel create retains its existing single-write body and output", async () => {
  const r = run(["create", "#ops", "--members", "alex,noor", "--topic", "Operations"], true);
  expect(await r.done).toBe(0);
  expect(daemon.requests).toHaveLength(1);
  expect(daemon.requests[0]?.body).toEqual({ name: "ops", topic: "Operations", members: ["alex", "noor"] });
  expect(r.lines).toEqual([JSON.stringify(routes["POST /v1/channels"])]);
});

test.each([
  {}, { event: null }, { queued: false }, { error: "unconfirmed" }, { pending: true }, null,
  { event: { id: archiveEvent.id } },
  { event: { ...archiveEvent, kind: "msg.post" } },
  { event: { ...archiveEvent, body: { name: "other", archived: true } } },
  { event: { ...archiveEvent, body: { name: "ops", archived: false } } },
  { queued: true }, { queued: true, request_id: "invalid" },
  { queued: true, request_id: "a".repeat(64) }, { queued: true, request_id: "a".repeat(31) },
  { queued: true, request_id: "a".repeat(33) }, { queued: true, request_id: "A".repeat(32) },
  { queued: true, request_id: "a".repeat(32), extra: 1 },
  [[{ queued: true, request_id: "a".repeat(32) }]], // test.each spreads a row array, so wrap the array body
  { queued: "yes", request_id: "a".repeat(32) }, { queued: 1, request_id: "a".repeat(32) },
  { event: archiveEvent, extra: 1 },
  { queued: true, request_id: 12345678901234567890123456789012 },
])("an unconfirmed archive response never claims applied or retries (%#)", async (response) => {
  routes["POST /v1/channels"] = response;
  const human = run(["archive", "ops"]);
  expect(await human.done).toBe(1);
  expect(human.lines).toEqual([]);
  expect(human.errors.join("\n")).toContain("unconfirmed");
  expect(human.errors.join("\n")).toContain("before retrying");
  const json = run(["archive", "ops", "--json"], true);
  expect(await json.done).toBe(1);
  expect(json.lines).toEqual([JSON.stringify(response)]);
  expect(daemon.requests.filter((r) => r.method === "POST")).toHaveLength(2);
});

test.each(["--dry-run", "--archived=false", "--force=true", "--timeout=3", "--no-wait"])(
  "unsupported archive flag %s refuses before any I/O", async (flag) => {
    await expect(run(["archive", "ops", flag]).done).rejects.toBeInstanceOf(UsageError);
    expect(daemon.requests).toEqual([]);
  },
);

test("global output and caller identity flags retain a confirmed archive result", async () => {
  const json = run(["archive", "ops", "--json", "--for-agent", "--agent", "archive-fixture"], true);
  expect(await json.done).toBe(0);
  expect(json.errors).toEqual([]);
  expect(json.lines).toEqual([JSON.stringify({ event: archiveEvent })]);
  const human = run(["archive", "ops"]);
  expect(await human.done).toBe(0);
  expect(human.lines.join("\n")).toContain("archived");
  expect(human.errors).toEqual([]);
});
