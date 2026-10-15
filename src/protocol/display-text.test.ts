import { expect, test } from "bun:test";
import { displayStoredText } from "./display-text.ts";

test("stored peer phrases are translated only for display", () => {
  expect(displayStoredText("Connected to Walkie")).toBe("Connected to Sqwakie");
  expect(displayStoredText("Walkie access revoked")).toBe("Sqwakie access revoked");
  expect(displayStoredText("Connected to Walkie now")).toBe("Connected to Walkie now");
});

test("malformed retained values are returned unchanged", () => {
  const object = { text: "Connected to Walkie" };
  for (const value of [undefined, null, false, 42, object, ["Connected to Walkie"]]) {
    expect(displayStoredText(value)).toBe(value);
  }
});

test("the recommendation marker is translated without changing the rest of the message", () => {
  const raw = "[WalkieTalkie recommendation abc123]\nSend this in my name";
  expect(displayStoredText(raw)).toBe("[Talkie recommendation abc123]\nSend this in my name");
  expect(raw).toStartWith("[WalkieTalkie recommendation");
  expect(displayStoredText("A quoted [WalkieTalkie recommendation abc123]")).toBe("A quoted [WalkieTalkie recommendation abc123]");
});

test("historical recommendation body and footer phrases change only at display time", () => {
  const created = "WalkieTalkie recommends: ask Fay to review";
  const resolved = "@fay approved WalkieTalkie's recommendation: ask Fay to review";
  const asked = "[WalkieTalkie recommendation abc123]\nPlease review.\n(Sent by @kira on WalkieTalkie's recommendation: old reason)";
  expect(displayStoredText(created)).toBe("Talkie recommends: ask Fay to review");
  expect(displayStoredText(resolved)).toBe("@fay approved Talkie's recommendation: ask Fay to review");
  expect(displayStoredText(asked)).toBe("[Talkie recommendation abc123]\nPlease review.\n(Sent by @kira on Talkie's recommendation: old reason)");
  expect(asked).toContain("WalkieTalkie's recommendation");
  expect(displayStoredText("A quote: WalkieTalkie recommends: ask Fay to review")).toBe("A quote: WalkieTalkie recommends: ask Fay to review");
});
