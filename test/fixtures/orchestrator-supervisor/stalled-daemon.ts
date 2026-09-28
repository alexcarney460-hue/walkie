import { ClaudeChild } from "../../../src/daemon/orchestrator/process.ts";
const directory = process.argv[2]!;
const mode = process.argv[3];
const expires = Date.now() + (mode === "expiry" || mode === "path" ? 2_000 : 30_000);
const child = new ClaudeChild("/bin/sh", ["-c", (mode === "orphan" || mode === "detached-orphan")
  ? mode === "detached-orphan"
    ? `echo ready; perl -MPOSIX -e 'setsid(); exec "/bin/sh", "-c", $ARGV[0]' '/bin/sleep 60 & echo $! > "${directory}/orphan"; /bin/sleep 0.5'; /bin/sleep 60`
    : `echo ready; /bin/sh -c '/bin/sleep 60 & echo $! > "${directory}/orphan"; /bin/sleep 0.3'; /bin/sleep 60`
  : "echo ready; /bin/sleep 60"], directory, { PATH: mode === "path" ? "/nonexistent" : "/usr/bin:/bin" }, {
  onSignal: () => {
    process.stdout.write(JSON.stringify({ group: child.pid }) + "\n");
    if (mode === "stall" || mode === "orphan" || mode === "detached-orphan") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
  onExit: () => process.exit(0),
}, (line) => line, { directory, expires: () => expires });
