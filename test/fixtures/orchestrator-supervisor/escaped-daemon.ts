import { ClaudeChild } from "../../../src/daemon/orchestrator/process.ts";
const directory = process.argv[2]!;
const child = new ClaudeChild("/bin/sh", ["-c", `perl -MPOSIX -e 'setsid(); open F,">",$ARGV[0]; print F $$; close F; sleep 120' "$1" & echo ready; sleep 120`, "fixture", `${directory}/escaped`], directory,
  { PATH: "/usr/bin:/bin" }, { onSignal: () => process.stdout.write(`${child.pid}\n`), onExit: () => {} },
  (line) => line, { directory, expires: () => Date.now() + 30_000 });
setInterval(() => {}, 1000);
