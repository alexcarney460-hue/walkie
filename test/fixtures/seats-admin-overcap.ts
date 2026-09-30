import { writeFileSync } from "node:fs";

const pidPath = process.argv[2];
if (!pidPath) process.exit(2);
writeFileSync(pidPath, String(process.pid));
process.stdout.write("x".repeat(256 * 1024 + 1));
await Bun.sleep(10_000);
