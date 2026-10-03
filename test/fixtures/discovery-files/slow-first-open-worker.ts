// The real discovery worker, except that the first openFile of a run (a marker file in WALKIE_TEST_SLOW_OPEN_MARK, so a
// replacement worker does not repeat it) takes 2 s: longer than one read's 500 ms, so the daemon gets no answer for it.
import { existsSync, writeFileSync } from "node:fs";
import "../../../src/daemon/discovery-files-worker.ts";

const handle = globalThis.onmessage;
globalThis.onmessage = async (event) => {
  const mark = process.env.WALKIE_TEST_SLOW_OPEN_MARK;
  if (event.data.op === "openFile" && mark && !existsSync(mark)) {
    writeFileSync(mark, "slow");
    await Bun.sleep(2_000);
  }
  await handle?.call(globalThis as unknown as Window, event);
};
