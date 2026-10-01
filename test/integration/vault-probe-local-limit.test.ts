import { afterAll, beforeAll, expect, test } from "bun:test";
import { WalkieError } from "../../src/client/index.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";

let cluster: Cluster;
let borrower: TestNode;
const body = { account: "a".repeat(24), node: "0123456789abcdef", provider: "claude" as const };

beforeAll(async () => {
  cluster = new Cluster();
  borrower = await cluster.add({ name: "borrower", login: "borrower@example.com" });
  await borrower.client().init("team", "borrower");
}, 30_000);
afterAll(async () => { await cluster.close(); });

test("twenty local lease attempts exhaust readiness without consuming a probe token", async () => {
  for (let i = 0; i < 20; i++) {
    const error = await borrower.client().vaultLease(body).then(() => null, (e: unknown) => e as WalkieError);
    expect(error?.code).toBe("not_found");
  }
  for (let i = 0; i < 2; i++) {
    const error = await borrower.client().vaultProbe(body).then(() => null, (e: unknown) => e as WalkieError);
    expect(error?.code).toBe("rate_limited");
  }
});
