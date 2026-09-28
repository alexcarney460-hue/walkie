// SEATS-FIX-7 end to end (docs/audits/2026-09-26-*-seats-r7.md), over the REAL helper logic on a fake system: a
// local stop whose seat user can't be verified removed says so, with the helper's reason (Codex r7 MEDIUM 6, Opus r7
// 7); after a restart, an id the helper holds for this person but seats.json lost (a power loss) is destroyed like the
// others (Codex r7 MEDIUM 3).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { createSeatUser } from "../../src/daemon/seats/admin.ts";
import { TERMINAL_STATES, type SeatView } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, type FakeSeatWorld, signInCodex } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

let c: Cluster;
let alex: TestNode;
let arvid: TestNode;
let world: FakeSeatWorld;

const person = (n: TestNode): WalkieClient => n.client("");
const seatOn = async (id: string): Promise<SeatView | undefined> => (await alex.client().seats(id)).seats[0];
const inState = (id: string, state: SeatView["state"]) =>
  waitFor(async () => ((await seatOn(id))?.state === state ? seatOn(id) : null), { timeoutMs: 20_000, what: `seat ${id} ${state}` });
const ended = (id: string) =>
  waitFor(async () => { const s = await seatOn(id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id} to end` });
const launch = async (prompt: string) => (await person(alex).seatRun({ machine: "arvid-mac", runtime: "codex", prompt })).seat;

beforeAll(async () => {
  c = new Cluster();
  const personHome = join(c.root, "arvid-home");
  mkdirSync(join(personHome, ".claude"), { recursive: true });
  chmodSync(personHome, 0o700);
  writeFileSync(join(personHome, ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"the-machines-own-login","refreshToken":"the-machines-refresh-token"}}', { mode: 0o600 });
  signInCodex(personHome);
  const walkieHome = join(c.root, "arvid");
  world = fakeSeatWorld(c.root, walkieHome);
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  mkdirSync(walkieHome, { recursive: true });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: {
      flushMs: 100, launchesPerMinute: 100, userSwitch: world.userSwitch, admin: world.admin, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: personHome },
    },
  });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  await person(arvid).seatsConfig({ allow: true, ephemeral: true });
  await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "arvid-mac takes seats" });
}, 60_000);

afterAll(async () => { await c.close(); });

describe("SEATS-FIX-7", () => {
  test("Codex r7 MEDIUM 6 / Opus r7 7: a local stop whose seat user isn't verified removed says so, with the helper's reason", async () => {
    const id = await launch("ticker 600 to stop");
    await inState(id, "running");
    world.broken.add("destroy-files");
    try {
      const r = await person(arvid).seatStop(id);
      expect(r).toMatchObject({ stopped: "local", verified: false });
      expect(r.why).toMatch(/could not verify that walkie-s\d+ was removed: .*the sweep failed \(broken\)/);
      const { local } = await person(arvid).seats();
      const u = (local.quarantined as string[])[0] as string;
      expect(local.quarantine_why?.[u]).toMatch(/files it owns remain or couldn't be checked \(the sweep failed \(broken\)\)/);
    } finally {
      world.broken.delete("destroy-files");
    }
    expect((await ended(id)).state).toBe("stopped");
  }, 60_000);

  test("Codex r7 MEDIUM 3: an id the helper holds for this person, lost from seats.json, is destroyed after a restart", async () => {
    const saved = JSON.parse(readFileSync(join(arvid.home, "seats.json"), "utf8")) as { user_high?: number };
    const lost = (saved.user_high ?? 0) + 7;
    expect((await createSeatUser(lost, world.sys)).ok).toBe(true); // made, then the daemon's record of it was lost
    expect(world.users.has(`walkie-s${lost}`)).toBe(true);
    await arvid.restart();
    await waitFor(() => (!world.users.has(`walkie-s${lost}`) ? true : null), { what: "the lost seat user destroyed" });
    expect(world.sys.ledger().pending(process.getuid?.() ?? -1)).toEqual([]);
    // and the next seat's id is above it
    const id = await launch("after the restart");
    expect((await ended(id)).state).toBe("done");
    expect(Math.max(...world.created.map((n) => Number(n.slice(8))))).toBeGreaterThan(lost);
  }, 90_000);
});
