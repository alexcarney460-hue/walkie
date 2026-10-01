import { expect, test } from "bun:test";
import { TOOLS } from "../../src/mcp/tools.ts";

test("every MCP tool declares its effects", () => {
  expect(TOOLS.length).toBeGreaterThan(20);
  for (const tool of TOOLS) {
    expect(tool.annotations).toEqual({
      readOnlyHint: expect.any(Boolean),
      destructiveHint: expect.any(Boolean),
      openWorldHint: expect.any(Boolean),
    });
  }
  expect(TOOLS.find((tool) => tool.name === "walkie_cli")?.annotations)
    .toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  for (const name of ["walkie_tasks", "walkie_task", "walkie_read"]) {
    expect(TOOLS.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
  }
  for (const name of ["walkie_set_status", "walkie_task_comment", "walkie_task_done"]) {
    expect(TOOLS.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(false);
  }
  expect(TOOLS.find((tool) => tool.name === "walkie_linear_create")?.annotations.openWorldHint).toBe(true);
  for (const name of ["walkie_fetch", "walkie_room_read"]) {
    expect(TOOLS.find((tool) => tool.name === name)?.annotations)
      .toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  }
});
