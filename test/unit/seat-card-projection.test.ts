import { expect, test } from "bun:test";
import { Bodies } from "../../src/protocol/schemas.ts";
import { projectStatus } from "../../src/protocol/status-projection.ts";

test("seat parent and launcher survive validation and projection without widening other parents", () => {
  const body = Bodies["agent.status"].parse({
    agent: "seat-abc123-1", parent: "seats", launcher: "alex", state: "working", runtime: "codex",
    title: "Private brief", activity: "Edit private.ts", started_at: 123, model: "test-model",
  });
  expect(Bodies["agent.status"].omit({ launcher: true }).safeParse(body).success).toBe(true);
  const hidden = projectStatus(body, { title: "prompt", activity: "tool" }, { prompts: false, activity: false });
  expect(hidden).toMatchObject({ parent: "seats", launcher: "alex", model: "test-model", started_at: 123 });
  expect(hidden.title).toBeUndefined();
  expect(hidden.activity).not.toBe("Edit private.ts");
  const activity = projectStatus(body, { title: "prompt", activity: "tool" }, { prompts: false, activity: true });
  expect(activity.title).toBeUndefined();
  expect(activity.activity).toBe("Edit private.ts");
  const full = projectStatus(body, { title: "prompt", activity: "tool" }, { prompts: true, activity: true });
  expect(full.title).toBe("Private brief");
  expect(projectStatus({ ...body, agent: "codex-abc123" }, undefined, { prompts: true, activity: true }).parent).toBeUndefined();
});
