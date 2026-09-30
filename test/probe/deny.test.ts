// PROBE (reviewer): `walkie seats deny` (the emergency control) while a restart backlog is queued: when does it return, and when is
// allow=false written to config.json (deny() persists it only AFTER every stopped seat's user destroy resolves)?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdminVerb } from "../../src/daemon/seats/admin.ts";
import type { SeatView } from "../../src/protocol/seats.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, signInCodex, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const N = Number(process.env.BACKLOG ?? 8);
const D = Number(process.env.DESTROY_MS ?? 500);
const TREE = process.env.TREE_LABEL ?? "?";
let c: Cluster; let alex: TestNode; let arvid: TestNode; let world: FakeSeatWorld;
const t00 = Date.now(); const now = () => Date.now() - t00;
beforeAll(async () => {
  c = new Cluster();
  const personHome = join(c.root, "arvid-home");
  mkdirSync(join(personHome, ".claude"), { recursive: true }); chmodSync(personHome, 0o700);
  writeFileSync(join(personHome, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "access-token", refreshToken: "rt", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference"] } }), { mode: 0o600 });
  signInCodex(personHome);
  const walkieHome = join(c.root, "arvid");
  world = fakeSeatWorld(c.root, walkieHome); world.sys.acl = () => "";
  for (let n = 1; n <= N; n++) { const r = await world.admin("create", n); if (!r.ok) throw new Error(`backlog create ${n}: ${r.why}`); }
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  mkdirSync(walkieHome, { recursive: true });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: { flushMs: 100, launchesPerMinute: 100, userSwitch: world.userSwitch, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
      admin: async (verb: AdminVerb, n: number) => { if (verb === "destroy") await Bun.sleep(D); return world.admin(verb, n); },
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: personHome } },
  });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
}, 120_000);
afterAll(async () => { try { await c.close(); } catch { /* */ } });

const allowOnDisk = (): boolean | null => {
  const p = arvid.d.paths.config;
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8"))?.seats?.allow ?? null; } catch { return null; }
};
test(`deny behind a backlog ${TREE}`, async () => {
  await arvid.client("").seatsConfig({ allow: true, ephemeral: true, max: Number(process.env.HOSTMAX ?? 20) });
  const id = (await alex.client().seatRun({ machine: "arvid-mac", runtime: "codex", prompt: "ticker 600 deny probe" })).seat;
  for (let i = 0; i < 400; i++) { const s = (await alex.client().seats(id)).seats[0] as SeatView | undefined; if (s?.state === "running") break; await Bun.sleep(50); }
  const onDiskBefore = allowOnDisk();
  const denyStart = now();
  const deny = arvid.client("").seatsConfig({ allow: false }).then(() => now(), (e: Error) => `ERR ${e.message}`);
  let persistedAt: number | null = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 60_000) { if (allowOnDisk() === false) { persistedAt = now(); break; } if ((await Promise.race([deny, Bun.sleep(100).then(() => "pending")])) !== "pending") break; }
  const denyDone = await deny;
  if (persistedAt === null && allowOnDisk() === false) persistedAt = now();
  console.log("DENY_RESULT " + JSON.stringify({ tree: TREE, backlog: N, destroyMs: D, onDiskBefore, denyStartedAt: denyStart, denyReturnedAt: denyDone, denyCallMs: typeof denyDone === "number" ? denyDone - denyStart : denyDone, allowFalsePersistedAt: persistedAt, persistedAfterMs: persistedAt === null ? null : persistedAt - denyStart }));
  expect(persistedAt).not.toBeNull();
  if (typeof denyDone === "number") expect(persistedAt as number).toBeLessThan(denyDone);
}, 180_000);
