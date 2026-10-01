import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { runText, seatsChannel, type SeatRun } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { noKeychainSeats } from "../helpers/no-keychain.ts";

let cluster: Cluster;
let alex: TestNode;
let worker: TestNode;
setDefaultTimeout(30_000);

const MIGRATION = "walkie provision migrate-enrollment";
const UNREADABLE = "enrollment state is unreadable";
/** What a refused `walkie seat run` looks like to the launcher. */
const refusal = (run: Promise<unknown>) => run.then(() => { throw new Error("the seat request was accepted"); }, (err: { code?: string; message: string }) => err);

beforeAll(async () => {
  cluster = new Cluster();
  alex = await cluster.add({ name: "alex", login: "alex@example.com" });
  worker = await cluster.add({ name: "worker", login: "worker@example.com", seats: noKeychainSeats(join(cluster.root, "worker-home")), enrollmentBackfill: () => {
    throw new Error("enrollment migration requires local elevation: run walkie provision migrate-enrollment");
  } });
  await alex.client().init("team", "alex");
  await alex.client().invite("worker@example.com", "worker", "member");
  expect((await worker.client().join(alex.peerAddr)).admitted).toBe(true);
}, 30_000);
afterAll(async () => { await cluster.close(); });

test("migration failure advertises the host unavailable and explains why locally", async () => {
  expect((await worker.client().team()).members.length).toBe(2);
  await worker.client("").seatsConfig({ allow: true, same_user: true });
  const local = (await worker.client("").seats()).local;
  expect(local.allow).toBe(true);
  expect(local.disabled_reason).toContain("walkie provision migrate-enrollment");
  const advertised = await waitFor(async () => {
    const host = (await alex.client().seats()).hosts.find((h) => h.node === worker.d.nodeId);
    return host && !host.allows && host.activity === "Seats blocked: enrollment migration" ? host : null;
  }, { what: "migration-blocked host advertisement" });
  expect(advertised.allows).toBe(false);
  // A host blocked from its start never made a seats channel, but its advertised status already says why: the launcher
  // names that, not "its person runs `walkie seats allow` there" (which would change nothing).
  const err = await refusal(alex.client("").seatRun({ machine: worker.hostname, runtime: "codex", prompt: "should not start" }));
  expect(err.code).toBe("seats_not_allowed");
  expect(err.message).toContain(`${worker.hostname} doesn't take seats: enrollment migration requires local elevation: run ${MIGRATION}`);
  expect(err.message).not.toContain("walkie seats allow");
});

test("a pre-existing seats channel refuses submission after its host restarts enrollment-blocked", async () => {
  const older = new Cluster();
  try {
    const launcher = await older.add({ name: "launcher", login: "launcher@example.com" });
    const host = await older.add({ name: "host", login: "host@example.com", seats: noKeychainSeats(join(older.root, "host-home")) });
    await launcher.client().init("older-team", "launcher");
    await launcher.client().invite("host@example.com", "host", "member");
    expect((await host.client().join(launcher.peerAddr)).admitted).toBe(true);
    await host.client("").seatsConfig({ allow: true, same_user: true });
    await waitFor(async () => (await launcher.client().seats()).hosts.find((h) => h.node === host.d.nodeId && h.allows),
      { what: "pre-existing seats channel" });
    host.spec.enrollmentBackfill = () => { throw new Error("run walkie provision migrate-enrollment"); };
    await host.restart();
    await waitFor(async () => {
      const view = (await launcher.client().seats()).hosts.find((h) => h.node === host.d.nodeId);
      return view && !view.allows && view.activity === "Seats blocked: enrollment migration" ? view : null;
    }, { what: "blocked host advertisement" });
    await expect(launcher.client("").seatRun({ machine: host.hostname, runtime: "codex", prompt: "do not submit" }))
      .rejects.toMatchObject({ code: "seats_not_allowed", message: expect.stringContaining("walkie provision migrate-enrollment") });

    // Unreadable enrollment state is refused at submission too, with its own reason.
    host.spec.enrollmentBackfill = () => { throw new Error("EACCES: root marker unreadable"); };
    await host.restart();
    await waitFor(async () => {
      const view = (await launcher.client().seats()).hosts.find((h) => h.node === host.d.nodeId);
      return view && !view.allows && view.activity === "Seats blocked: enrollment state unreadable" ? view : null;
    }, { what: "unreadable host advertisement" });
    const err = await refusal(launcher.client("").seatRun({ machine: host.hostname, runtime: "codex", prompt: "do not submit" }));
    expect(err.code).toBe("seats_not_allowed");
    expect(err.message).toBe(`${host.hostname} doesn't take seats: ${UNREADABLE}: seats refuse to start`);
  } finally { await older.close(); }
}, 40_000);

test("a request that reaches an enrollment-blocked host through a stale status is refused with the enrollment reason", async () => {
  const older = new Cluster();
  try {
    const launcher = await older.add({ name: "launcher", login: "launcher@example.com" });
    const host = await older.add({ name: "host", login: "host@example.com", seats: noKeychainSeats(join(older.root, "host-home")) });
    await launcher.client().init("older-team", "launcher");
    await launcher.client().invite("host@example.com", "host", "member");
    expect((await host.client().join(launcher.peerAddr)).admitted).toBe(true);
    await host.client("").seatsConfig({ allow: true, same_user: true });
    await waitFor(async () => (await launcher.client().seats()).hosts.find((h) => h.node === host.d.nodeId && h.allows),
      { what: "pre-existing seats channel" });
    host.spec.enrollmentBackfill = () => { throw new Error("run walkie provision migrate-enrollment"); };
    await host.restart();
    // What an older launcher, or one whose copy of the host's status is stale, does: the request is posted without the
    // submission check (the host's own gate is the real control).
    const run: SeatRun = { op: "run", v: 1, runtime: "codex", prompt: "must be refused by the host", timeout_s: 3_600, max_concurrent: 3 };
    const event = launcher.d.core.emit("msg.post", { text: runText(run, host.hostname), seat: run } as never, { channel: seatsChannel(host.d.nodeId) });
    const ended = await waitFor(async () => {
      const s = (await launcher.client().seats(event.id)).seats[0];
      return s && s.state === "refused" ? s : null;
    }, { timeoutMs: 20_000, what: "the host's refusal" });
    expect(ended.reason).toContain(`seats are blocked on ${host.hostname}: enrollment migration requires local elevation: run ${MIGRATION}`);
    expect(ended.reason).not.toContain("walkie seats allow");
  } finally { await older.close(); }
}, 40_000);

test("a local host that is enrollment-blocked with seats denied names the enrollment reason, never undefined", async () => {
  const solo = new Cluster();
  try {
    const self = await solo.add({ name: "self", login: "self@example.com", hostname: "self-mbp", seats: noKeychainSeats(join(solo.root, "self-home")) });
    await self.client().init("solo", "self");
    await self.client("").seatsConfig({ allow: true, same_user: true });
    await waitFor(async () => (await self.client().seats()).hosts.find((h) => h.node === self.d.nodeId && h.allows), { what: "seats allowed" });
    await self.client("").seatsConfig({ allow: false });
    self.spec.enrollmentBackfill = () => { throw new Error("run walkie provision migrate-enrollment"); };
    await self.restart();
    expect((await self.client("").seats()).local.disabled_reason).toBeUndefined(); // denied: the view has no reason of its own
    await waitFor(async () => {
      const view = (await self.client().seats()).hosts.find((h) => h.node === self.d.nodeId);
      return view && !view.allows && view.activity === "Seats blocked: enrollment migration" ? view : null;
    }, { what: "the local blocked advertisement" });
    const err = await refusal(self.client("").seatRun({ machine: self.hostname, runtime: "codex", prompt: "x" }));
    expect(err.code).toBe("seats_not_allowed");
    expect(err.message).toBe(`${self.hostname} doesn't take seats: enrollment migration requires local elevation: run ${MIGRATION}`);
  } finally { await solo.close(); }
}, 40_000);
