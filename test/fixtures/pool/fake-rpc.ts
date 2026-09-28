// A stand-in for llama.cpp's rpc-server in tests that don't need a real model: listens where it is told
// (-H host -p port) and echoes every byte back. WALKIE-POOL-2.
import { createServer } from "node:net";

const argv = process.argv.slice(2);
const arg = (f: string): string | undefined => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const host = arg("-H") ?? "127.0.0.1";
const port = Number(arg("-p") ?? "50052");
createServer((s) => { s.on("data", (d) => s.write(d)); s.on("error", () => undefined); }).listen(port, host);
process.on("SIGTERM", () => process.exit(0));
