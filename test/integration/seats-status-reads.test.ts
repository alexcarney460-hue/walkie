// SEATS-FIX-5 in every seats mode, through the daemon's local API (pre.11 integration review F1, HIGH): a status read
// (GET /v1/seats, which the Seats view polls every 2 s while a seat lives) serves the verdicts the last explicit check
// made and never reads the Keychain, runs `codex login status` or sources the seat env file, on a machine that never
// turned seats on as much as on one that did. Verdicts are checked again only at explicit points: daemon start with
// seats allowed, enable/configure, `walkie seats doctor` (POST /v1/seats/doctor) and, for the launched runtime, a
// launch whose verdict is older than its freshness window. Everything the host is given is injected: a counting
// Keychain reader, a `codex` that counts `login status`, a seat env file that counts being sourced.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dashboardRoute } from "../../src/daemon/local-api.ts";
import { DEFAULT_LIMITS, type RateLimits } from "../../src/daemon/ratelimit.ts";
import { TERMINAL_STATES, type SeatView } from "../../src/protocol/seats.ts";
import { seatsFor } from "../../src/daemon/seats/host.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, signInCodex } from "../helpers/fake-seat-users.ts";

setDefaultTimeout(60_000);
const FIXTURES = join(import.meta.dir, "..", "fixtures");
const BUN_DIR = dirname(process.execPath);
const MINUTE = 60_000;

const count = (file: string): number => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;

interface Machine {
  node: TestNode;
  person: string;
  token: { expiresInMs: number };
  /** Keychain reads, `codex login status` runs and seat env sourcings so far. */
  seen: () => { keychain: number; codex: number; sourced: number };
  /** The host's own state, for ageing its verdicts. */
  internals: () => { machineToken: { has: boolean; at: number } | null; cachedClaudeAccess: { readAt: number } | null; codexCheckedAt: number | null };
}

let cluster: Cluster;
let alex: TestNode;
const machines: Machine[] = [];

async function machine(name: string, o: { expiresInMs: number; codexAuth?: boolean; join?: boolean; limits?: RateLimits; seatUsers?: boolean } = { expiresInMs: 8 * 60 * MINUTE }): Promise<Machine> {
  const person = join(cluster.root, `${name}-home`);
  mkdirSync(join(person, ".claude"), { recursive: true });
  chmodSync(person, 0o700); // seat users may not read it
  writeFileSync(join(person, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: `${name}-account-uuid` } })); // the cache is keyed by it
  if (o.codexAuth !== false) signInCodex(person);
  const bin = join(cluster.root, `${name}-bin`);
  mkdirSync(bin);
  symlinkSync(join(FIXTURES, "fake-claude", "claude"), join(bin, "claude"));
  const codexRuns = join(cluster.root, `${name}-codex-login-status.log`);
  const sourced = join(cluster.root, `${name}-seat-env-sourced.log`);
  // `codex login status` is counted (and says "signed in", like a keyring-backed login); anything else is the fake Codex seat.
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nif [ "$1" = login ] && [ "$2" = status ]; then echo x >> "${codexRuns}"; exit 0; fi\nexec "${join(FIXTURES, "fake-codex", "codex")}" "$@"\n`);
  chmodSync(join(bin, "codex"), 0o755);
  const home = join(cluster.root, name); // the daemon's Walkie home: the seat env file is read from it
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "seat-env"), `echo x >> "${sourced}"\n`);
  const token = { expiresInMs: o.expiresInMs };
  const world = o.seatUsers ? fakeSeatWorld(join(cluster.root, `${name}-world`), home) : null;
  let keychain = 0;
  const read = async () => {
    keychain++;
    return JSON.stringify({ claudeAiOauth: { accessToken: "keychain-access-token", refreshToken: "never-handed-over", expiresAt: Date.now() + token.expiresInMs, scopes: ["user:inference"] } });
  };
  const node = await cluster.add({
    name, login: `${name}@example.com`, hostname: `${name}-mac`, ...(o.limits ? { limits: o.limits } : {}),
    seats: {
      keychain: read, flushMs: 100, launchesPerMinute: 100, env: { HOME: person, PATH: `${bin}:${BUN_DIR}:/usr/bin:/bin` },
      ...(world ? { userSwitch: world.userSwitch, admin: world.admin, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles } : {}),
    },
  });
  await alex.client().invite(`${name}@example.com`, name, "member");
  expect((await node.client().join(alex.peerAddr)).admitted).toBe(true);
  const m: Machine = {
    node, person, token,
    seen: () => ({ keychain, codex: count(codexRuns), sourced: count(sourced) }),
    internals: () => seatsFor(node.d.core) as unknown as ReturnType<Machine["internals"]>,
  };
  machines.push(m);
  return m;
}

const status = (m: Machine) => m.node.client("").seats();
/** The shape of a seat id: `walkie seat run` and `seat show --follow` poll their seat with GET /v1/seats?seat=<id> every second. */
const SEAT_ID = "0123456789abcdef:1";
/**
 * Everything a client polls for status, `times` over: the Seats view and `walkie seats` (GET /v1/seats), the follow poll of a
 * launched seat (GET /v1/seats?seat=<id>) and the menu bar (GET /v1/seats/busy). A check of a login on any of them is a Keychain
 * prompt storm, so every window of polls below must read, spawn and source nothing.
 */
const poll = async (m: Machine, times = 5) => {
  const client = m.node.client("");
  for (let i = 0; i < times; i++) {
    await client.seats();
    await client.seats(SEAT_ID);
    await client.request("GET", "/v1/seats/busy");
  }
};
/** A daemon's start-time check (and a join's status post) run in the background: let them finish before counting. */
const settle = () => Bun.sleep(500);
const allowed = (m: Machine) => waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === m.node.d.nodeId && h.allows && h.member), { what: `${m.node.hostname} takes seats` });
const run = (m: Machine, runtime: "claude" | "codex", prompt: string) => alex.client().seatRun({ machine: m.node.hostname, runtime, prompt }).then((r) => r.seat);
const ended = (id: string) => waitFor(async () => {
  const s: SeatView | undefined = (await alex.client().seats(id)).seats[0];
  return s && TERMINAL_STATES.has(s.state) ? s : null;
}, { timeoutMs: 40_000, what: `seat ${id} to end` });
/** The verdicts as the dashboard sees them. */
const logins = async (m: Machine) => { const l = (await status(m)).local; return { claude: l.claude_login, codex: l.codex_login, reason: l.codex_login_reason }; };
const age = (m: Machine, ms: number) => {
  const h = m.internals();
  const at = Date.now() - ms;
  if (h.machineToken) h.machineToken = { ...h.machineToken, at };
  if (h.cachedClaudeAccess) h.cachedClaudeAccess = { ...h.cachedClaudeAccess, readAt: at };
  h.codexCheckedAt = at;
};

let idle: Machine; // never turned seats on, a Keychain token near expiry, a seat env file
let near: Machine; // same-user seats, a Keychain token near expiry (under the 70 minutes a default seat needs)
let inherit: Machine; // same-user seats inheriting the person's config, Codex in a "keyring" (no auth.json)
let healthy: Machine; // same-user seats, an 8 hour token: launches and verdict ages
let metered: Machine; // the production rate limits (DEFAULT_LIMITS), not the cluster's widened ones
let users: Machine; // seat users (a fake system of users), no Codex sign-in yet

beforeAll(async () => {
  cluster = new Cluster();
  alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  await alex.client().init("aka", "alex");
  idle = await machine("idle", { expiresInMs: 30 * MINUTE });
  near = await machine("near", { expiresInMs: 30 * MINUTE });
  inherit = await machine("inherit", { expiresInMs: 8 * 60 * MINUTE, codexAuth: false });
  healthy = await machine("healthy", { expiresInMs: 8 * 60 * MINUTE });
  metered = await machine("metered", { expiresInMs: 8 * 60 * MINUTE, limits: DEFAULT_LIMITS });
  users = await machine("users", { expiresInMs: 8 * 60 * MINUTE, codexAuth: false, seatUsers: true });
}, 60_000);
afterAll(async () => { await cluster.close(); });

describe("a machine that never turned seats on", () => {
  test("reads nothing at daemon start and nothing for 5 status polls, nor when it restarts", async () => {
    await settle();
    expect(idle.seen()).toEqual({ keychain: 0, codex: 0, sourced: 0 });
    await poll(idle);
    expect(idle.seen()).toEqual({ keychain: 0, codex: 0, sourced: 0 });
    await idle.node.restart();
    await settle();
    await poll(idle);
    expect(idle.seen()).toEqual({ keychain: 0, codex: 0, sourced: 0 });
  });

  test("still says what a machine nobody has checked says (never a guess of unavailable)", async () => {
    expect(await logins(idle)).toMatchObject({ claude: "machine", codex: "machine" });
  });
});

describe("same-user seats", () => {
  test("a Keychain token near expiry: enabling checks once, then 5 status polls read, spawn and source nothing", async () => {
    await near.node.client("").seatsConfig({ allow: true, same_user: true });
    await allowed(near);
    const afterEnable = near.seen();
    expect(afterEnable.keychain).toBeGreaterThanOrEqual(1); // the explicit check does read: the counters are live
    expect(afterEnable.sourced).toBeGreaterThanOrEqual(1);
    await poll(near);
    expect(near.seen()).toEqual(afterEnable);
    expect((await logins(near)).claude).toBe("unavailable"); // the answer of that check: under the 70 minutes a seat needs
  });

  test("a daemon restart checks once (seats are allowed), and the polls after it read nothing", async () => {
    const before = near.seen();
    await near.node.restart();
    await waitFor(() => near.internals().machineToken, { what: "the start-time check" });
    await settle();
    const afterStart = near.seen();
    expect(afterStart.keychain).toBe(before.keychain + 1);
    expect(afterStart.sourced).toBe(before.sourced + 1);
    await poll(near);
    expect(near.seen()).toEqual(afterStart);
  });

  test("inheriting the person's config with a keyring Codex: enabling runs `codex login status` once, the polls never do", async () => {
    await inherit.node.client("").seatsConfig({ allow: true, same_user: true, inherit_person_config: true });
    await allowed(inherit);
    const afterEnable = inherit.seen();
    expect(afterEnable.codex).toBeGreaterThanOrEqual(1);
    await poll(inherit);
    expect(inherit.seen()).toEqual(afterEnable);
    expect((await logins(inherit)).codex).toBe("machine");
  });
});

describe("seat users", () => {
  test("a status read tracks the Codex sign-in file as it is (one cheap file read that cannot prompt) and reads, spawns and sources nothing", async () => {
    await users.node.client("").seatsConfig({ allow: true, ephemeral: true });
    await allowed(users);
    const afterEnable = users.seen();
    const auth = join(users.person, ".codex", "auth.json");
    expect((await logins(users)).codex).toBe("unavailable"); // no sign-in where a seat user can use it
    signInCodex(users.person);
    const signedIn = await logins(users); // made after seats were enabled: the next status read shows it, no doctor or restart between
    expect(signedIn.codex).toBe("machine");
    expect(signedIn.reason).toBeUndefined();
    rmSync(auth);
    expect((await logins(users)).codex).toBe("unavailable");
    await poll(users);
    expect(users.seen()).toEqual(afterEnable);
  });
});

describe("doctor", () => {
  test("is the explicit full check: it reads, spawns and sources, whatever the seats' state, and shows what a launch would find", async () => {
    const auth = join(near.person, ".codex", "auth.json");
    const saved = readFileSync(auth, "utf8");
    const before = near.seen();
    rmSync(auth);
    try {
      await poll(near);
      expect(near.seen()).toEqual(before);
      expect((await logins(near)).codex).toBe("machine"); // the last check said so: a status read does not look again
      const { local } = await near.node.client("").seatsDoctor();
      expect(local.codex_login).toBe("unavailable");
      expect(local.codex_login_reason).toContain("default Codex login cannot be projected");
      const afterDoctor = near.seen();
      expect(afterDoctor.keychain).toBe(before.keychain + 1);
      expect(afterDoctor.sourced).toBe(before.sourced + 1);
      expect(await logins(near)).toMatchObject({ codex: "unavailable" }); // and the next status read serves it
      await poll(near);
      expect(near.seen()).toEqual(afterDoctor);
    } finally {
      writeFileSync(auth, saved, { mode: 0o600 });
    }
    expect((await near.node.client("").seatsDoctor()).local.codex_login).toBe("machine");
  });

  test("works on a machine that never turned seats on, and the polls after it read nothing more", async () => {
    const before = idle.seen();
    const { local } = await idle.node.client("").seatsDoctor();
    expect(local.allow).toBe(false);
    expect(local.claude_login).toBe("unavailable"); // its token has 30 minutes left
    const afterDoctor = idle.seen();
    expect(afterDoctor).toEqual({ keychain: before.keychain + 1, codex: before.codex, sourced: before.sourced + 1 });
    await poll(idle);
    expect(idle.seen()).toEqual(afterDoctor);
  });
});

describe("POST /v1/seats/doctor, the one route that reads on request", () => {
  test("is not on the dashboard's allow-list, so a page cannot drive it, and a dashboard session is refused before anything is read", async () => {
    expect(dashboardRoute("POST", "/v1/seats/doctor")).toBe(false);
    expect(dashboardRoute("GET", "/v1/seats")).toBe(true); // the poll is what a page may do
    const base = `http://127.0.0.1:${metered.node.d.localPort as number}`;
    const { nonce } = await metered.node.client().authNonce();
    const login = await fetch(`${base}/auth?nonce=${nonce}`, { redirect: "manual" });
    const session = /#s=([0-9a-f]{64})$/.exec(login.headers.get("location") ?? "")?.[1] as string;
    const before = metered.seen();
    const refused = await fetch(`${base}/v1/seats/doctor`, { method: "POST", headers: { "X-Walkie-Session": session, Origin: base, "Content-Type": "application/json" }, body: "{}" });
    expect(refused.status).toBe(403);
    expect(metered.seen()).toEqual(before);
  });

  test("is rate limited at the production limits: a burst is served, the rest is refused with 429, and a refusal reads nothing", async () => {
    const before = metered.seen().keychain;
    let served = 0;
    let limited = 0;
    for (let i = 0; i < 90; i++) {
      try { await metered.node.client("").seatsDoctor(); served++; }
      catch (err) { if ((err as { status?: number }).status === 429) limited++; else throw err; }
    }
    expect(limited).toBeGreaterThan(0);
    expect(served).toBeLessThan(90);
    expect(metered.seen().keychain - before).toBeLessThanOrEqual(served); // a call that was refused read nothing
  });
});

describe("a verdict's age", () => {
  test("past its freshness window it is still what a status read says, and still costs no read", async () => {
    await healthy.node.client("").seatsConfig({ allow: true, same_user: true });
    await allowed(healthy);
    expect(await logins(healthy)).toMatchObject({ claude: "machine", codex: "machine" });
    const before = healthy.seen();
    age(healthy, 20 * MINUTE);
    await poll(healthy);
    expect(await logins(healthy)).toMatchObject({ claude: "machine", codex: "machine" });
    expect(healthy.seen()).toEqual(before);
  });
});

describe("a launch", () => {
  test("whose Codex verdict is stale checks it first: a Codex sign-in that went away is found, refused with its reason, and shown; the Keychain is never read for it", async () => {
    const auth = join(healthy.person, ".codex", "auth.json");
    const saved = readFileSync(auth, "utf8");
    rmSync(auth);
    try {
      age(healthy, 20 * MINUTE);
      expect((await logins(healthy)).codex).toBe("machine"); // cached
      const before = healthy.seen().keychain;
      const s = await ended(await run(healthy, "codex", "needs a Codex login"));
      expect(s.state).toBe("failed");
      expect(s.reason).toContain("default Codex login cannot be projected");
      expect(await logins(healthy)).toMatchObject({ codex: "unavailable", reason: expect.stringContaining("default Codex login cannot be projected") });
      expect(healthy.seen().keychain).toBe(before);
    } finally {
      writeFileSync(auth, saved, { mode: 0o600 });
    }
    await healthy.node.client("").seatsDoctor();
    expect((await logins(healthy)).codex).toBe("machine");
  });

  test("whose Claude verdict is stale checks it first: a token that expired since is found, the launch is refused with a clear reason, and the view shows it", async () => {
    expect((await logins(healthy)).claude).toBe("machine");
    healthy.token.expiresInMs = 30 * MINUTE; // the Keychain token has run down since the last check
    age(healthy, 20 * MINUTE);
    expect((await logins(healthy)).claude).toBe("machine"); // cached: a status read does not look again
    const before = healthy.seen().keychain;
    const s = await ended(await run(healthy, "claude", "needs a Claude login"));
    expect(s.state).toBe("failed");
    expect(s.reason).toContain("cannot be projected for the full seat timeout");
    expect(s.reason).toContain("refresh Claude Code");
    expect(healthy.seen().keychain).toBeGreaterThan(before); // the launch is an explicit point: it may read
    expect((await logins(healthy)).claude).toBe("unavailable");
  });

  test("whose verdicts are fresh does not check them again", async () => {
    const auth = join(healthy.person, ".codex", "auth.json");
    const saved = readFileSync(auth, "utf8");
    await healthy.node.client("").seatsDoctor(); // fresh verdicts (Claude unavailable: the token is still run down)
    rmSync(auth);
    try {
      const s = await ended(await run(healthy, "codex", "needs a Codex login, verdict fresh"));
      expect(s.state).toBe("failed"); // the launch's own projection still refuses it
      expect((await logins(healthy)).codex).toBe("machine"); // the verdict is made again at the next explicit point, not by every launch
    } finally {
      writeFileSync(auth, saved, { mode: 0o600 });
    }
  });
});
