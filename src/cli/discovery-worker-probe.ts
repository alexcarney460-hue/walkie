// Compile alongside src/daemon/discovery-files-worker.ts with WALKIE_EMBEDDED=true.
import { DiscoveryFiles } from "../daemon/discovery-files.ts";

const RealWorker = globalThis.Worker;
let constructed = 0;
let errors = 0;
const messages: string[] = [];
globalThis.Worker = class extends RealWorker {
  constructor(url: string | URL, opts?: WorkerOptions) {
    super(url, opts);
    constructed++;
    this.addEventListener("error", (event) => { errors++; messages.push(event.message); });
  }
};
const files = new DiscoveryFiles(false);
const context = await files.repoContext(process.cwd(), Date.now() + 5_000);
await Bun.sleep(1_000);
files.close();
console.log(JSON.stringify({ constructed, errors, messages, contextReturned: context !== null }));
if (constructed !== 1 || errors !== 0 || context === null) process.exit(1);
