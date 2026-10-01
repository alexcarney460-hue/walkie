import { expect, test } from "bun:test";
import { GuestScope, type GuestData } from "../../src/mcp/guest-scope.ts";
import type { Guest } from "../../src/mcp/guest-registry.ts";

const guest = { id: "n/dots-ops", owner: "alex", node: "1234567890abcdef", family: "dots", name: "ops", agent: "dots-ops", address: "@alex/cloud/dots-ops", cardIds: ["aaaaaaaaaaaaaaaa:1"], tools: ["walkie_tasks", "walkie_task", "walkie_read", "walkie_task_comment", "walkie_task_done", "walkie_set_status"], subject: "local", tokenHash: "", expiresAt: 99_999, revoked: false } satisfies Guest;
const project = { channel: "p-11111111", name: "Allowed", prefix: "WEB", private: false, state: "active" as const };
const card = { id: "aaaaaaaaaaaaaaaa:1", channel: project.channel, key: "WEB-1", ref: "WEB-1-aaaaaaaa", title: "Assigned", body: "Work here", assignee: guest.address, labels: [], state: "open" as const, column: "todo", updated_at: 1 };

function setup(): { scope: GuestScope; data: GuestData; calls: string[] } {
  const calls: string[] = [];
  const data: GuestData = {
    card: (id) => id === card.id ? card : null,
    project: (channel) => channel === project.channel ? project : null,
    comments: () => [{ id: "bbbbbbbbbbbbbbbb:2", text: "Update", author: { handle: "alex" }, channel: project.channel }],
    comment: (_g, id, text) => { calls.push(`comment:${id}:${text}`); return "cccccccccccccccc:3"; },
    move: (_g, id, action) => { calls.push(`move:${id}:${action}`); return "dddddddddddddddd:4"; },
    status: (_g, id) => { calls.push(`status:${id}`); return "eeeeeeeeeeeeeeee:5"; },
  };
  return { scope: new GuestScope(data), data, calls };
}

test("only currently assigned, explicitly bound cards and their own threads are visible", () => {
  const { scope, data } = setup();
  expect(scope.call(guest, "walkie_tasks", {}).content[0]?.text).toContain("WEB-1");
  expect(scope.call(guest, "walkie_read", { thread: card.id }).content[0]?.text).toContain("Update");
  for (const args of [{ key: "WEB-2" }, { key: "aaaaaaaaaaaaaaaa:2" }]) {
    expect(scope.call(guest, "walkie_task", args).isError).toBe(true);
  }
  expect(scope.call(guest, "walkie_read", { thread: "bbbbbbbbbbbbbbbb:9" }).isError).toBe(true);
  expect(scope.call(guest, "walkie_task_comment", { key: "WEB-2", text: "hi" }).isError).toBe(true);
  data.card = () => ({ ...card, assignee: "@alex" });
  expect(scope.call(guest, "walkie_tasks", {}).content[0]?.text).not.toContain("WEB-1");
  expect(scope.call(guest, "walkie_task_done", { key: "WEB-1" }).isError).toBe(true);
});

test("private and confidential cards fail closed; assigned content is projected and redacted", () => {
  const { scope, data } = setup();
  data.project = () => ({ ...project, private: true });
  expect(scope.call(guest, "walkie_task", { key: "WEB-1" }).isError).toBe(true);
  data.project = () => project;
  data.card = () => ({ ...card, labels: ["confidential"] });
  expect(scope.call(guest, "walkie_task", { key: "WEB-1" }).isError).toBe(true);
  data.card = () => ({ ...card, title: ("api_key=sk" + "-proj-123456789012345678901234"), body: "Join at https://example.com/i/abc", due: "2026-10-01",
    reviewer: "PRIVATE REVIEWER", created_by: { handle: "PRIVATE AUTHOR" }, labels: ["public"] });
  const projected = scope.call(guest, "walkie_task", { key: "WEB-1" }).content[0]!.text;
  expect(projected).toContain("due");
  expect(projected).toContain("[REDACTED:");
  expect(projected).not.toContain("sk-proj-123456789012345678901234");
  expect(projected).not.toContain("PRIVATE REVIEWER");
  expect(projected).not.toContain("PRIVATE AUTHOR");
  expect(projected).not.toContain("p-11111111");
  data.card = () => card;
  data.comments = () => [{ id: "bbbbbbbbbbbbbbbb:2", text: ("api_key=sk" + "-proj-123456789012345678901234"), author: { handle: "alex" }, channel: project.channel }];
  const thread = scope.call(guest, "walkie_read", { thread: card.id }).content[0]!.text;
  expect(thread).toContain("[REDACTED:");
  expect(thread).not.toContain("sk-proj-123456789012345678901234");
  expect(thread).not.toContain("bbbbbbbbbbbbbbbb:2");
});

test("writes use bound identity and never accept arbitrary team tools or status cards", () => {
  const { scope, calls } = setup();
  expect(scope.call(guest, "walkie_task_comment", { key: "WEB-1", text: "Done" }).isError).toBeUndefined();
  expect(calls).toEqual([`comment:${card.id}:Done`]);
  expect(scope.call(guest, "walkie_set_status", { title: "Working", task: "WEB-2" }).isError).toBe(true);
  expect(scope.call(guest, "walkie_who", {}).isError).toBe(true);
  expect(scope.call(guest, "walkie_task_comment", { key: "WEB-1", text: "Join link https://example.com/invite/abc" }).isError).toBe(true);
});
