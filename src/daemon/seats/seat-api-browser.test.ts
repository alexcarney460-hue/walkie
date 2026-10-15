import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeatApi } from "./seat-api.ts";
import type { Logger } from "../logger.ts";

test("the seat socket routes browser actions only with that live seat's token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-seat-browser-"));
  const calls: string[] = [];
  const api = new SeatApi(join(dir, "seat.sock"), {
    postAsSeat: () => { throw new Error("unexpected progress post"); },
    browserAsSeat: async (seat, body) => { calls.push(`${seat}:${body.op}`); return { text: "opened" }; },
  }, { warn: () => {} } as unknown as Logger);
  api.start();
  const token = api.issue("seat-1");
  const send = (presented?: string) => fetch("http://walkie/v1/browser/action", { unix: api.socket, method: "POST",
    headers: { "Content-Type": "application/json", ...(presented ? { Authorization: `Bearer ${presented}` } : {}) },
    body: JSON.stringify({ op: "open", url: "https://example.org" }) } as RequestInit);
  try {
    expect((await send()).status).toBe(401);
    expect((await send(token)).status).toBe(200);
    expect(calls).toEqual(["seat-1:open"]);
    api.revoke("seat-1");
    expect((await send(token)).status).toBe(401);
  } finally { api.stop(); }
});
