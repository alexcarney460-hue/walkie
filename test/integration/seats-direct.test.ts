// Seats on a Walkie Direct team (no Tailscale anywhere: iroh QUIC on loopback, no relays), the case of a machine that
// joined with an invite link (Arvid's Mac is Direct-only): the host opts in in one step, a teammate's machine starts
// agents there, their requests and output travel as signed events over Direct, the repo bundle is fetched over
// Direct, and the commits come back. On Free (after the trial) the seats channel is still allowed (it is the seats
// protocol's own channel, PROTOCOL §11); with the roster authority offline, enabling waits for it and then works.
// Seat users: the REAL helper logic over a fake system (test/helpers/fake-seat-users.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ctx } from "../../src/cli/context.ts";
import { enableSeats } from "../../src/cli/commands/seats-enable.ts";
import { TERMINAL_STATES, type SeatView } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, signInCodex, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const DAY = 86_400_000;
let c: Cluster;
let alex: TestNode;
let arvid: TestNode;
let world: FakeSeatWorld;
/** Both machines' clocks: moved past the trial to test the Free plan. */
let offset = 0;
const clock = () => Date.now() + offset;

const seatOn = async (id: string): Promise<SeatView | undefined> => (await alex.client().seats(id)).seats[0];
const ended = (id: string) =>
  waitFor(async () => { const s = await seatOn(id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id} to end` });
const ctxOf = (n: TestNode, out: string[]): Ctx => ({
  args: { pos: [], flags: new Map() }, json: false, forAgent: false, client: () => n.client(""), out: (x: string) => out.push(x), err: (x: string) => out.push(x),
}) as unknown as Ctx;

beforeAll(async () => {
  c = new Cluster();
  const personHome = join(c.root, "arvid-home");
  mkdirSync(join(personHome, ".claude"), { recursive: true });
  chmodSync(personHome, 0o700);
  writeFileSync(join(personHome, ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"the-machines-own-login","refreshToken":"the-machines-refresh-token"}}', { mode: 0o600 });
  signInCodex(personHome);
  const walkieHome = join(c.root, "arvid");
  world = fakeSeatWorld(c.root, walkieHome);
  alex = await c.add({ name: "alex", login: "-", hostname: "alex-mbp", direct: true, clock });
  mkdirSync(walkieHome, { recursive: true });
  arvid = await c.add({
    name: "arvid", login: "-", hostname: "arvid-mac", direct: true, clock,
    seats: {
      flushMs: 100, launchesPerMinute: 100, userSwitch: world.userSwitch, admin: world.admin, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: personHome },
    },
  });
  await alex.client().init("aka", "alex");
  const inv = await alex.client().inviteCode("arvid", "member");
  expect((await arvid.client().join(inv.code)).admitted).toBe(true);
  expect(arvid.d.core.roster.nodes.get(arvid.d.nodeId)?.transports).toEqual(["direct"]);
  offset = 61 * DAY; // past the trial: the Free plan (restricted channels need the Team plan)
}, 60_000);

afterAll(async () => { await c.close(); });

describe("seats on a Direct-only machine", () => {
  test("with the roster authority offline, enabling waits for the seats channel, and completes once it is back", async () => {
    await arvid.client("").seatsConfig({ allow: false, ephemeral: true }); // seat users set up (setup-user --apply)
    await alex.stop();
    const out: string[] = [];
    const local = await enableSeats(ctxOf(arvid, out), {});
    expect(local?.allow).toBe(true);
    expect(local?.channel_ok).toBe(false);
    expect(out.join("\n")).toContain("the seats channel waits for the team's roster authority");
    await alex.start();
    await waitFor(async () => ((await arvid.client("").seats()).local.channel_ok ? true : null), { timeoutMs: 30_000, what: "the seats channel made once the authority is back" });
  }, 60_000);

  test("on Free (after the trial) the seats channel is allowed, and a teammate starts agents there over Direct", async () => {
    expect(alex.d.core.roster.channels.get(`seats-${arvid.d.nodeId}`)?.members).toContain("arvid");
    await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.hostname === "arvid-mac" && h.allows && h.member && h.online), { timeoutMs: 30_000, what: "alex sees arvid-mac take seats over Direct" });
    // A repo bundle too: fetched by the host from alex over Direct (the peer client picks the transport).
    const repo = join(c.root, "direct-repo");
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd: repo, stderr: "pipe" });
    git("init", "-q");
    writeFileSync(join(repo, "README.md"), "hello\n");
    git("add", ".");
    git("commit", "-qm", "first");
    const bundle = join(c.root, "direct.bundle");
    git("bundle", "create", bundle, "HEAD");
    const { hash } = await alex.client().seatsBundle(new Uint8Array(readFileSync(bundle)));
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) ids.push((await alex.client().seatRun({ machine: arvid.d.nodeId, runtime: "codex", prompt: "commit something", bundle: hash })).seat);
    for (const id of ids) {
      const s = await ended(id);
      expect(s.state).toBe("done");
      expect(s.commits).toBeGreaterThan(0);
      expect(s.result_bundle).toBeTruthy();
    }
    expect(world.users.size).toBe(0); // their seat users are gone
  }, 90_000);
});
