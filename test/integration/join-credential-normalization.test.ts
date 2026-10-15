import { afterAll, beforeAll, expect, test } from "bun:test";
import type { WalkieError } from "../../src/client/index.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";

let cluster: Cluster;
let node: TestNode;
beforeAll(async () => {
  cluster = new Cluster();
  node = await cluster.add({ name: "owner", login: "-", direct: true });
  await node.client().init("fixture", "owner");
});
afterAll(async () => { await cluster?.close(); });

for (const prefix of ["wk1", "wl1"]) {
  const wide = (prefix + "Az09_-".repeat(24)).replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
  for (const encoded of [false, true]) {
    for (const kind of ["post", "upload"]) {
      test(`${prefix} ${encoded ? "encoded " : ""}full-width text is refused by actual agent ${kind}`, async () => {
        const text = encoded ? encodeURIComponent(wide) : wide;
        const agent = node.client("helper");
        const operation = kind === "post" ? agent.post({ channel: "general", text, raw: true })
          : agent.share(new TextEncoder().encode(text), { name: "fixture.txt", mime: "text/plain" });
        const error = await operation.then(() => null, (e: WalkieError) => e);
        expect(error?.code).toBe("join_credential_private_reply_only");
      });
    }
  }
}
