import { expect, test } from "bun:test";
import { connect, createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessStartTime, readProcessTable, type ProcRow } from "../../src/cli/agent-detect.ts";
import { classifySshCaller, socketPeerPid } from "../../src/daemon/ssh/caller.ts";

const table = (rows: [number, number, string][]): Map<number, ProcRow> =>
  new Map(rows.map(([pid, ppid, command]) => [pid, { ppid, command, startTime: `start-${pid}` }]));

test("an unsupported ancestry and claimed agent remain unverified", () => {
  expect(classifySshCaller(21, table([[21, 20, "bun walkie"], [20, 1, "zsh"]]), "codex"))
    .toEqual({ caller: "unverified caller", claim: "codex" });
});

test("an agent with a verified executable is found from its ancestry", () => {
  const rows = table([[21, 20, "bun walkie"], [20, 19, "zsh"], [19, 1, "kimi-code"]]);
  rows.set(19, { ...rows.get(19)!, executable: "/usr/bin/kimi-code" });
  expect(classifySshCaller(21, rows, undefined, "start-21"))
    .toEqual({ caller: "kimi-code" });
});

test("a direct bridge caller cannot replace a verified agent with a claim", () => {
  const rows = table([[21, 20, "bun caller"], [20, 1, "codex"]]);
  rows.set(20, { ...rows.get(20)!, executable: "/usr/bin/codex" });
  expect(classifySshCaller(21, rows, "claude-code", "start-21"))
    .toEqual({ caller: "codex", claim: "claude-code" });
});

test("PID reuse between socket accept and process lookup is unverified", () => {
  const rows = table([[21, 20, "bun caller"], [20, 1, "codex"]]);
  rows.set(20, { ...rows.get(20)!, executable: "/usr/bin/codex" });
  expect(classifySshCaller(21, rows, undefined, "old-start")).toEqual({ caller: "unverified caller" });
});

test("a process reparented to init is unverified", () => {
  expect(classifySshCaller(21, table([[21, 1, "bun caller"]]), undefined, "start-21"))
    .toEqual({ caller: "unverified caller" });
});

test("spoofed argv zero alone does not identify an agent", () => {
  const rows = table([[21, 20, "codex --fake"], [20, 1, "zsh"]]);
  rows.set(21, { ...rows.get(21)!, argv: ["codex", "--fake"], executable: "/bin/sleep" });
  expect(classifySshCaller(21, rows, undefined, "start-21")).toEqual({ caller: "unverified caller" });
});

test("the current process table carries the socket peer start identity", () => {
  const startTime = readProcessStartTime(process.pid);
  if (!startTime) throw new Error("process start time unavailable");
  expect(readProcessTable()?.get(process.pid)?.startTime).toBe(startTime);
});

test("missing peer process information is called unverified", () => {
  expect(classifySshCaller(null, null, "codex")).toEqual({ caller: "unverified caller", claim: "codex" });
  expect(classifySshCaller(21, table([[21, 999, "bun walkie"]]))).toEqual({ caller: "unverified caller" });
});

test("the accepted Unix socket exposes its OS peer PID", async () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-peerpid-"));
  const path = join(dir, "peer.sock");
  const server = createServer((socket) => { socket.write(String(socketPeerPid(socket))); socket.end(); });
  try {
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const peer = connect(path);
    const received = await new Promise<string>((resolve, reject) => {
      let data = "";
      peer.on("data", (part) => { data += part.toString(); });
      peer.once("end", () => resolve(data));
      peer.once("error", reject);
    });
    expect(received).toBe(String(process.pid));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
