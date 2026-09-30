import { acquireInstanceLock } from "../../src/daemon/instance-lock.ts";

const socket = process.argv[2];
if (!socket) throw new Error("socket path required");
const lock = acquireInstanceLock(socket);
const server = Bun.serve({ unix: socket, fetch: () => new Response("ok") });
process.stdout.write("ready\n");
await new Promise<void>(() => undefined);
server.stop(true);
lock.release();
