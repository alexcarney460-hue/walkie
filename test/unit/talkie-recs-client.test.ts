import { expect, test } from "bun:test";
import { WalkieClient, WalkieError } from "../../src/client/index.ts";

// Override transport so these tests cannot connect to a daemon or send approvals.
class RecordingClient extends WalkieClient {
  readonly calls: unknown[][] = [];
  constructor() { super({ socket: "/nonexistent-fixture.sock", agent: "fixture", seatToken: "fixture" }); }
  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push([method, path, body]);
    return {} as T;
  }
}

test("recommendation requests use the route contract and encode full ids", async () => {
  const client = new RecordingClient();
  await client.talkieRecs();
  await client.talkieRecs("all");
  await client.talkieApprove("0123456789abcdef:7", "go ahead");
  await client.talkieDismiss("a1b2c3d4");
  await client.talkieApprove("a1b2c3d4");
  await client.talkieDismiss("a1b2c3d4", "later");
  const body = { kind: "create_card" as const, project: "WEB", title: "A card", reason: "r" };
  await client.talkieRecommend(body);
  expect(client.calls).toEqual([
    ["GET", "/v1/talkie/recs?status=open", undefined],
    ["GET", "/v1/talkie/recs?status=all", undefined],
    ["POST", "/v1/talkie/recs/0123456789abcdef%3A7/approve", { note: "go ahead" }],
    ["POST", "/v1/talkie/recs/a1b2c3d4/dismiss", {}],
    ["POST", "/v1/talkie/recs/a1b2c3d4/approve", {}],
    ["POST", "/v1/talkie/recs/a1b2c3d4/dismiss", { note: "later" }],
    ["POST", "/v1/talkie/recs", body],
  ]);
});

test("daemon refusals propagate without retries or identity changes", async () => {
  class RefusedClient extends RecordingClient {
    override async request<T>(): Promise<T> { throw new WalkieError("forbidden", "only WalkieTalkie records recommendations", 403); }
  }
  const client = new RefusedClient();
  await expect(client.talkieRecommend({ kind: "create_card", project: "WEB", title: "A", reason: "r" })).rejects.toThrow("only WalkieTalkie");
  expect(client.agent).toBe("fixture");
});


test("every recommendation method preserves structured refusals and sends only once", async () => {
  const error = new WalkieError("forbidden", "fixture authorization refusal", 403);
  class RefusedClient extends RecordingClient {
    override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      this.calls.push([method, path, body]);
      throw error;
    }
  }
  const client = new RefusedClient();
  const methods = [
    () => client.talkieRecs(),
    () => client.talkieApprove("a1b2c3d4"),
    () => client.talkieDismiss("a1b2c3d4"),
    () => client.talkieRecommend({ kind: "create_card", project: "WEB", title: "A", reason: "r" }),
  ];
  for (const invoke of methods) await expect(invoke()).rejects.toBe(error);
  expect(client.calls).toHaveLength(4);
  expect(client.agent).toBe("fixture");
});
