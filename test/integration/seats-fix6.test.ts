// SEATS-FIX-6 end to end (docs/audits/2026-09-26-*-seats-r6.md): the root helper's REAL logic over a fake system
// (test/helpers/fake-seat-users.ts), with the seat user's files removed by the REAL runner's sweep, as that (fake)
// user: tricky names and a symlink a seat plants can't turn into deletions outside its own files (Codex r6 CRITICAL 1,
// HIGH 2); a create whose answer is lost is still destroyed, and an id the helper says it made nothing for is not
// (Codex r6 MEDIUM 4); busy says paused and resumed only once verified, and deny's error names quarantined users
// (Codex r6 MEDIUM 8); a seat env file that only mentions a token isn't a usable login (Codex r6 LOW 9).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import type { AdminResult, AdminVerb } from "../../src/daemon/seats/admin.ts";
import { seatsFor } from "../../src/daemon/seats/host.ts";
import { TERMINAL_STATES, type SeatView } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, type FakeSeatWorld, signInCodex } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const CREDS = '{"claudeAiOauth":{"accessToken":"the-machines-own-login","refreshToken":"the-machines-refresh-token"}}';

let c: Cluster;
let alex: TestNode;
let arvid: TestNode;
let world: FakeSeatWorld;
let log: string;
let personHome: string;
let victim: string;
/** The helper as the daemon calls it: the fake world's, unless a test puts something in front. */
let adminImpl: ((verb: AdminVerb, n: number) => Promise<AdminResult>) | null = null;

const person = (n: TestNode): WalkieClient => n.client("");
const seatOn = async (id: string): Promise<SeatView | undefined> => (await alex.client().seats(id)).seats[0];
const inState = (id: string, state: SeatView["state"]) =>
  waitFor(async () => ((await seatOn(id))?.state === state ? seatOn(id) : null), { timeoutMs: 20_000, what: `seat ${id} ${state}` });
const ended = (id: string) =>
  waitFor(async () => { const s = await seatOn(id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id} to end` });
const launch = async (prompt: string, runtime: "codex" | "claude" = "codex") => (await person(alex).seatRun({ machine: "arvid-mac", runtime, prompt })).seat;
const saved = () => JSON.parse(readFileSync(join(arvid.home, "seats.json"), "utf8")) as { users?: number[]; user_high?: number };

beforeAll(async () => {
  c = new Cluster();
  personHome = join(c.root, "arvid-home");
  mkdirSync(join(personHome, ".claude"), { recursive: true });
  chmodSync(personHome, 0o700);
  writeFileSync(join(personHome, ".claude", ".credentials.json"), CREDS, { mode: 0o600 });
  signInCodex(personHome);
  victim = join(c.root, "victim");
  mkdirSync(victim);
  writeFileSync(join(victim, "keep"), "the person's file");
  log = join(c.root, "codex.jsonl");
  const walkieHome = join(c.root, "arvid");
  world = fakeSeatWorld(c.root, walkieHome);
  const seats = {
    flushMs: 100, launchesPerMinute: 100, busyReapplyMs: 300,
    userSwitch: world.userSwitch, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
    admin: (verb: AdminVerb, n: number) => (adminImpl ?? world.admin)(verb, n),
    env: {
      PATH: `${join(FIXTURES, "fake-codex")}:${join(FIXTURES, "fake-claude")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: personHome,
      FAKE_CODEX_LOG: log, FAKE_OUTSIDE_DIR: world.outside,
    },
  };
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  mkdirSync(walkieHome, { recursive: true });
  arvid = await c.add({ name: "arvid", login: "arvid@example.com", hostname: "arvid-mac", seats });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  const { local } = await person(arvid).seatsConfig({ allow: true, ephemeral: true, env: ["FAKE_CODEX_LOG", "FAKE_OUTSIDE_DIR"] });
  expect(local).toMatchObject({ allow: true, ephemeral: true, claude_login: "machine" });
  await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "arvid-mac takes seats" });
}, 60_000);

afterAll(async () => {
  await c.close();
});

describe("SEATS-FIX-6", () => {
  test("Codex r6 CRITICAL 1 / HIGH 2: a name with a newline and a symlink of the seat's delete only the seat's own entries", async () => {
    const id = await launch(`plant-tricky ${victim}`);
    expect((await ended(id)).state).toBe("done");
    // Its own sweep, as itself, verified; nothing of the person's (named inside the tricky name, or behind the link).
    const sweep = world.sweeps.at(-1);
    expect(sweep).toMatchObject({ verified: true, left: [] });
    expect(readdirSync(world.outside)).toEqual([]);
    expect(readFileSync(join(victim, "keep"), "utf8")).toBe("the person's file");
    expect(world.users.size).toBe(0);
    expect((await person(arvid).seats()).local.quarantined).toBeUndefined();
  }, 60_000);

  test("Codex r6 MEDIUM 4: the id is saved before the helper is asked; a lost answer still destroys what was made", async () => {
    const before = world.destroyed.length;
    let savedAtCall: number[] | undefined;
    let asked = 0;
    adminImpl = async (verb, n) => {
      if (verb !== "create") return world.admin(verb, n);
      asked = n;
      savedAtCall = saved().users;
      await world.admin(verb, n); // the user is made…
      throw new Error("sudo was killed"); // …and the answer is lost
    };
    let s: SeatView;
    try {
      s = await ended(await launch("never runs"));
    } finally {
      adminImpl = null;
    }
    expect(savedAtCall).toContain(asked);
    expect(s.state).toBe("failed");
    expect(s.reason).toMatch(/no seat user could be made: the user helper didn't answer/);
    await waitFor(() => (world.destroyed.length > before ? true : null), { what: "the made user destroyed" });
    expect(world.users.has(`walkie-s${asked}`)).toBe(false);
    await waitFor(async () => ((await person(arvid).seats()).local.quarantined === undefined ? true : null), { what: "quarantine cleared" });
    expect(saved().users).not.toContain(asked);
  }, 60_000);

  test("Codex r6 MEDIUM 4: an id the helper made nothing for (used elsewhere) is dropped, and the next one above it is used", async () => {
    let refused = 0;
    adminImpl = async (verb, n) => {
      if (verb === "create" && !refused) { refused = n; return { ok: false, code: "used", high: n + 5, why: "used" }; }
      return world.admin(verb, n);
    };
    try {
      const id = await launch("after a used id");
      expect((await ended(id)).state).toBe("done");
    } finally {
      adminImpl = null;
    }
    expect(world.created).toContain(`walkie-s${refused + 6}`);
    expect(world.created).not.toContain(`walkie-s${refused}`);
    expect(saved().users ?? []).toEqual([]);
    expect(saved().user_high).toBeGreaterThanOrEqual(refused + 6);
  }, 60_000);

  test("Codex r6 MEDIUM 8: a re-applied pause that gets no answer is no longer said paused; resume is said only once verified", async () => {
    const id = await launch("ticker 600 busy");
    await inState(id, "running");
    try {
      await person(arvid).seatsBusy({ max: 0 });
      await inState(id, "paused");
      world.failing.add("stop"); // the runner can't be reached: no answer at all
      try {
        const s = await waitFor(async () => { const x = await seatOn(id); return x?.state === "running" ? x : null; }, { what: "no longer paused" });
        expect(s.reason).toMatch(/could not be paused/);
        expect((await person(arvid).seats()).local.availability).toMatchObject({ paused: 0 });
      } finally {
        world.failing.delete("stop");
      }
      await person(arvid).seatsBusy({ max: 0 }); // paused again, verified
      await inState(id, "paused");
      world.failing.add("cont");
      try {
        await person(arvid).seatsResume();
        const s = await waitFor(async () => { const x = await seatOn(id); return x?.reason?.includes("could not verify that it resumed") ? x : null; }, { what: "unverified resume said" });
        expect(s.state).toBe("running");
      } finally {
        world.failing.delete("cont");
      }
      await person(arvid).seatsBusy({ max: 0 });
      await inState(id, "paused");
      await person(arvid).seatsResume();
      expect((await waitFor(async () => { const x = await seatOn(id); return x?.reason === "resumed" ? x : null; }, { what: "resumed" })).state).toBe("running");
    } finally {
      await person(arvid).seatsResume().catch(() => undefined);
      await person(alex).seatStop(id).catch(() => undefined);
      await ended(id);
    }
  }, 90_000);

  test("Codex r6 MEDIUM 8: deny's error, when config.json can't be written, names the seat users not verified removed", async () => {
    const id = await launch("ticker 600 before a full disk");
    await inState(id, "running");
    world.broken.add("destroy-files");
    const blocker = join(arvid.home, "config.json.tmp");
    mkdirSync(blocker);
    try {
      await expect(person(arvid).seatsConfig({ allow: false })).rejects.toThrow(/seats are off and every seat was told to stop, but these seat users could not be verified removed .*walkie-s\d+\. And config\.json could not be written/);
      const { local } = await person(arvid).seats();
      expect(local.allow).toBe(false);
      expect(local.quarantined?.length).toBe(1);
    } finally {
      rmSync(blocker, { recursive: true, force: true });
      world.broken.delete("destroy-files");
    }
    const n = Number(((await person(arvid).seats()).local.quarantined as string[])[0]?.slice(8));
    expect((await (seatsFor(arvid.d.core) as unknown as { destroyUser(n: number): Promise<{ ok: boolean }> }).destroyUser(n)).ok).toBe(true); // the retry
    expect((await person(arvid).seats()).local.quarantined).toBeUndefined();
    await person(arvid).seatsConfig({ allow: true, ephemeral: true, env: ["FAKE_CODEX_LOG", "FAKE_OUTSIDE_DIR"] });
  }, 90_000);

  test("Codex r6 LOW 9: a seat env file that only mentions the token (a comment, an empty value) is not a usable login", async () => {
    const creds = join(personHome, ".claude", ".credentials.json");
    const envFile = join(arvid.d.core.paths.home, "seat-env");
    rmSync(creds);
    writeFileSync(envFile, "# CLAUDE_CODE_OAUTH_TOKEN=paste-it-here\nCLAUDE_CODE_OAUTH_TOKEN=\n");
    try {
      // configure re-sources it (a launch and the view do too)
      const { local } = await person(arvid).seatsConfig({ allow: true, ephemeral: true, env: ["FAKE_CODEX_LOG", "FAKE_OUTSIDE_DIR"] });
      expect(local.claude_login).toBe("unavailable");
      const s = await ended(await launch("needs a login", "claude"));
      expect(s.reason).toMatch(/Keychain, which a seat user can't use/);
      writeFileSync(envFile, `CLAUDE_CODE_OAUTH_TOKEN=sk${""}-ant-oat01-${"u".repeat(40)}\n`);
      expect((await person(arvid).seatsConfig({ allow: true, ephemeral: true, env: ["FAKE_CODEX_LOG", "FAKE_OUTSIDE_DIR"] })).local.claude_login).toBe("machine");
    } finally {
      rmSync(envFile, { force: true });
      writeFileSync(creds, CREDS, { mode: 0o600 });
    }
    expect(existsSync(creds)).toBe(true);
  }, 60_000);
});
