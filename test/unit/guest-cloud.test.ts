import { expect, test } from "bun:test";
import { cloudAddress, isCloudAgent } from "../../src/protocol/guest-cloud.ts";

test("cloud guests group by signed owner and keep the cloud alias", () => {
  const dots = { agent: "dots-ops", handle: "alex", status: { runtime: "other", runtime_name: "dots" } };
  expect(isCloudAgent(dots)).toBe(true);
  expect(cloudAddress(dots)).toBe("@alex/cloud/dots-ops");
  expect(isCloudAgent({ ...dots, agent: "dots-ops", status: { runtime: "other", runtime_name: "grok" } })).toBe(false);
  expect(isCloudAgent({ ...dots, agent: "cc-ops" })).toBe(false);
});
