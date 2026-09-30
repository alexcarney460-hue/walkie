import { expect, test } from "bun:test";
import { liveMonitorPids, teardown } from "./orchestrator-merge7-setup.ts";

test("failed rig setup leaves teardown and process checks safe", async () => {
  await expect(teardown(undefined)).resolves.toBeUndefined();
  expect(liveMonitorPids(undefined)).toEqual([]);
});
