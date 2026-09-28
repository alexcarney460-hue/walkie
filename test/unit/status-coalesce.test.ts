import { expect, test } from "bun:test";
import { StatusCoalescer } from "../../src/daemon/status-coalesce.ts";
import type { Event } from "../../src/protocol/schemas.ts";

test("bursts over the limit coalesce to the latest status, emitted once the bucket refills", async () => {
  let tokens = 1;
  const emitted: string[] = [];
  const c = new StatusCoalescer({
    tryEmit: (_a, body) => {
      if (tokens <= 0) return null;
      tokens--;
      emitted.push(body.activity ?? "");
      return { id: "x" } as unknown as Event;
    },
  }, 20);
  expect(c.submit("a", { agent: "a", state: "working", runtime: "cli", activity: "1" })).not.toBeNull();
  expect(c.submit("a", { agent: "a", state: "working", runtime: "cli", activity: "2" })).toBeNull();
  expect(c.submit("a", { agent: "a", state: "working", runtime: "cli", activity: "3" })).toBeNull();
  await Bun.sleep(50);
  expect(emitted).toEqual(["1"]); // still limited: held, not dropped
  tokens = 5;
  await Bun.sleep(50);
  expect(emitted).toEqual(["1", "3"]); // only the latest survives
  c.stop();
});
