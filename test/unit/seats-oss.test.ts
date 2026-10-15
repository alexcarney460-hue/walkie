import { expect, test } from "bun:test";
import { SeatRun, SeatRunV2, seatOf } from "../../src/protocol/seats.ts";

export const localRun = { op: "run" as const, v: 2 as const, runtime: "codex" as const,
  local_provider: "ollama" as const, model: "qwen3:8b", brief: "a".repeat(64), timeout_s: 60, max_concurrent: 1 };

test("OSS v2 retains explicit provider through strict signed body parsing", () => {
  expect(SeatRunV2.parse(localRun)).toEqual(localRun);
  expect(seatOf({ seat: localRun })).toEqual(localRun);
});
test("OSS boundary rejects every implicit or injectable combination", () => {
  for (const change of [ { local_provider: "lmstudio" }, { runtime: "claude" }, { v: 1 },
    { model: undefined }, { model: "" }, { model: "--config" }, { model: "http://localhost:11434" },
    { model: "x/y" }, { endpoint: "http://localhost" }, { headers: {} }, { profile: "personal" },
    { extra_argv: ["--ignore-rules"] }, { account: `alex:${"a".repeat(24)}` }, { shell_user: true } ]) {
    expect(SeatRunV2.safeParse({ ...localRun, ...change }).success).toBe(false);
  }
  expect(SeatRun.safeParse({ ...localRun, v: 1, prompt: "task" }).success).toBe(false);
});
test("absent local field preserves authenticated model syntax", () => {
  const { local_provider, ...authenticated } = localRun;
  expect(SeatRunV2.parse({ ...authenticated, model: "-legacy" }).model).toBe("-legacy");
});
