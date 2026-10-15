import { expect, test } from "bun:test";
import { SeatRunV2, seatOf } from "../../src/protocol/seats.ts";

const run = { op: "run", v: 2, runtime: "codex", brief: "a".repeat(64), timeout_s: 600, max_concurrent: 1 } as const;

test("opted-in Codex v2 launch is a strict parsed seat request while ordinary bytes stay unchanged", () => {
  const controlled = { ...run, control: { v: 1, adapter: "codex-app-server" } } as const;
  expect(SeatRunV2.safeParse(controlled).success).toBe(true);
  expect(seatOf({ seat: controlled })).toEqual(controlled);
  expect(SeatRunV2.safeParse({ ...run, runtime: "claude", control: controlled.control }).success).toBe(false);
  expect(SeatRunV2.safeParse({ ...run, local_provider: "ollama", control: controlled.control }).success).toBe(false);
  expect(SeatRunV2.safeParse({ ...controlled, control: { ...controlled.control, extra: true } }).success).toBe(false);
  expect(JSON.stringify(SeatRunV2.parse(run))).toBe(JSON.stringify(run));
});
