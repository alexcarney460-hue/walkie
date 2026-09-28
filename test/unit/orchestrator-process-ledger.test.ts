import { expect, test } from "bun:test";
import { selectRecordedTargets } from "../../src/daemon/orchestrator/marked-processes.ts";

test("retains an exited shell's group when its recorded background child survives", () => {
  const ledger = new Map([[101, { pgid: 101, started: "a" }], [102, { pgid: 101, started: "b" }]]);
  expect(selectRecordedTargets([{ pid: 102, ppid: 1, pgid: 101, started: "b", marked: false }], ledger, 999))
    .toEqual({ pids: [102], pgids: [101] });
});

test("does not target a reused pid or group", () => {
  const ledger = new Map([[101, { pgid: 101, started: "a" }], [102, { pgid: 101, started: "b" }]]);
  expect(selectRecordedTargets([{ pid: 102, ppid: 1, pgid: 101, started: "new", marked: false }], ledger, 999))
    .toEqual({ pids: [], pgids: [] });
});
