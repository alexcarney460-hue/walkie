import { expect, test } from "bun:test";
import { approvedBrowserAnswer } from "./approval.ts";
import type { AskView } from "../../protocol/schemas.ts";

const id = "123e4567-e89b-12d3-a456-426614174000";
function answer(agent: string | undefined, node = "local", text = "YES 123e4567"): AskView {
  return { state: "answered", answers: [{ id: "a", ts: 1, author: { handle: "alex", node, ...(agent ? { agent } : {}) },
    body: { text } }], ask: {} as AskView["ask"], expires_at: 1000 } as unknown as AskView;
}

test("only the local person's exact first ask answer confirms a browser action", () => {
  expect(approvedBrowserAnswer(answer(undefined), id, "local", "alex")).toBe(true);
  expect(approvedBrowserAnswer(answer("seat-123"), id, "local", "alex")).toBe(false);
  expect(approvedBrowserAnswer(answer(undefined, "other"), id, "local", "alex")).toBe(false);
  expect(approvedBrowserAnswer(answer(undefined, "local", "YES"), id, "local", "alex")).toBe(false);
  expect(approvedBrowserAnswer({ ...answer(undefined), state: "expired" }, id, "local", "alex")).toBe(false);
});
