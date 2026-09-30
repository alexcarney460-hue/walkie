// Serial 120 ms message handling without adding CPU load.
import "../../../src/daemon/discovery-files-worker.ts";

const handle = globalThis.onmessage;
let queue = Promise.resolve();
const firstOpen = new Set<string>();
globalThis.onmessage = (event) => {
  queue = queue.then(async () => {
    if (event.data.op !== "policy") await Bun.sleep(120);
    if (event.data.op === "openFile" && !firstOpen.has(event.data.args[0])) {
      firstOpen.add(event.data.args[0]);
      postMessage({ id: event.data.id, started: true });
      postMessage({ id: event.data.id, value: null });
      return;
    }
    await handle?.call(globalThis as unknown as Window, event);
  });
};
