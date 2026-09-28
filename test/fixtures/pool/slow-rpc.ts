// A stand-in rpc-server that takes 3 s before it listens (a slow start), then echoes. WALKIE-POOL-3 tests.
import { createServer } from "node:net";
const argv = process.argv.slice(2);
const arg = (f: string): string | undefined => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
process.on("SIGTERM", () => process.exit(0));
await Bun.sleep(3_000);
createServer((s) => { s.on("data", (d) => s.write(d)); s.on("error", () => undefined); }).listen(Number(arg("-p")), arg("-H") ?? "127.0.0.1");
