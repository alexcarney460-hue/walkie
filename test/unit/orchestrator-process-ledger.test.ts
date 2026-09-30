import { expect, test } from "bun:test";
import { selectRecordedTargets, signalMarkedProcess } from "../../src/daemon/orchestrator/marked-processes.ts";

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

test("EPERM is reported while an exited PID is ignored", () => {
  const lines: string[] = [];
  const deny = () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); };
  signalMarkedProcess(123, "SIGKILL", deny, (line) => lines.push(line));
  expect(lines).toEqual(["SIGKILL denied for PID 123 (EPERM); privileged uid cleanup is required"]);
  signalMarkedProcess(123, "SIGKILL", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }, (line) => lines.push(line));
  expect(lines).toHaveLength(1);
});
