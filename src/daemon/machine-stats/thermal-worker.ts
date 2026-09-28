// Worker thread for the macOS IOKit temperature read (thermal-client.ts): the native calls run here, off the daemon's
// event loop. {id} → one reading {id, sensors, error}. {type:"close"} → release every CoreFoundation reference and
// close the native libraries (closeDarwinSensors), answer {closed:true} and exit this thread.
import { closeDarwinSensors, darwinSensors } from "./darwin-thermal.ts";
import { isDarwinCpuSensor } from "./parse.ts";

declare const self: Worker;

self.onmessage = (e: MessageEvent<{ id?: number; type?: string }>) => {
  if (e.data?.type === "close") {
    try { closeDarwinSensors(); } catch { /* exiting anyway */ }
    self.postMessage({ closed: true });
    process.exit(0); // in a worker: ends this thread only
  }
  const { sensors, error } = darwinSensors(isDarwinCpuSensor);
  self.postMessage({ id: e.data?.id ?? 0, sensors, error });
};
