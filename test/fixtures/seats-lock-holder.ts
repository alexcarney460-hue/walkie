import { withSeatAdminLock } from "../../src/daemon/seats/talkie-lock.ts";

const path = process.argv[2];
if (!path) throw new Error("lock path required");
await withSeatAdminLock(path, false, async () => {
  process.stdout.write("held\n");
  await new Promise<void>(() => undefined);
});
