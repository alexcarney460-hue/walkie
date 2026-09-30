// P2 child: ROLE=seat runs the real createSeatUser(77); ROLE=talkie runs the real createTalkieUser. Both use the real Ledger
// and the real lock code over the fake OS world of the repo's own test helper; denySchedulers is the real read-modify-write
// shape with a 300 ms gap between its read and its write so an overlap of two helpers is visible.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const tree = process.env.TREE as string;
const root = process.env.ROOT as string;
const role = process.env.ROLE as string;
const { fakeSeatWorld } = await import(`${tree}/test/helpers/fake-seat-users.ts`);
const { createSeatUser } = await import(`${tree}/src/daemon/seats/admin.ts`);
const { createTalkieUser } = await import(`${tree}/src/daemon/seats/talkie-user.ts`);
const world = fakeSeatWorld(root, join(root, "walkie-home"));
world.sys.acl = () => "";
const log = (s: string) => appendFileSync(join(root, "overlap.log"), `${Date.now()} ${role} ${s}\n`);
const sys = {
  ...world.sys,
  denySchedulers: (name: string) => {
    log("deny-enter");
    for (const f of [world.schedulerFiles.cron[1], world.schedulerFiles.at[1]]) {
      const text = existsSync(f) ? readFileSync(f, "utf8") : "";
      if (text.split("\n").includes(name)) continue;
      Bun.sleepSync(300); // the gap a concurrent helper can land in
      writeFileSync(f, `${text}${name}\n`);
    }
    log("deny-exit");
  },
};
const res = role === "seat" ? await createSeatUser(77, sys) : role === "seat2" ? await createSeatUser(78, sys) : await createTalkieUser(sys, "33333333-3333-4333-8333-333333333333");
log(`done ok=${res.ok} why=${res.why ?? ""}`);
process.exit(0);
