// PRE4 delta (Opus 4): behind a roster authority that drops the `seats` mark (a pre.3 build parses channel.upsert
// without it), seats fail closed: no seat runs in the unmarked channel, the host says why, and it asks the authority
// again only once per backoff window, however many roster changes come in meanwhile.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { seatsChannel } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

let c: Cluster;
let alex: TestNode, arvid: TestNode;
let upserts = 0;
function person(n: TestNode): WalkieClient { return n.client(""); }

beforeAll(async () => {
  c = new Cluster();
  const home = join(c.root, "arvid-home");
  mkdirSync(home, { recursive: true });
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  arvid = await c.add({ name: "arvid", login: "arvid@example.com", hostname: "arvid-mac", seats: { env: { PATH: "/usr/bin:/bin", HOME: home } } });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  // The authority behaves like an older build: it signs the seats channel's upserts without the mark.
  const core = alex.d.core;
  const emit = core.emit.bind(core);
  const name = seatsChannel(arvid.d.nodeId);
  (core as unknown as { emit: typeof core.emit }).emit = ((kind: string, body: Record<string, unknown>, opts?: unknown) => {
    if (kind === "channel.upsert" && body.name === name) {
      upserts++;
      const { seats: _drop, ...rest } = body;
      return emit(kind as never, rest as never, opts as never);
    }
    return emit(kind as never, body as never, opts as never);
  }) as typeof core.emit;
}, 60_000);
afterAll(async () => { await c.close(); });

test("the channel is shaped but unmarked: no seat runs, the host says why, and it doesn't hammer the authority", async () => {
  const name = seatsChannel(arvid.d.nodeId);
  await person(arvid).seatsConfig({ allow: true, same_user: true });
  await waitFor(() => arvid.d.core.roster.channels.get(name)?.members?.includes("arvid"), { timeoutMs: 10_000, what: "the seats channel" });
  expect(arvid.d.core.roster.channels.get(name)?.seats).toBeUndefined();
  await waitFor(async () => (await person(arvid).seats()).local?.channel_error?.includes("didn't record"), { timeoutMs: 10_000, what: "the host says why" });
  // A launch is refused by the host (the channel isn't fit) — nothing runs.
  await alex.client().seatRun({ machine: "arvid-mac", runtime: "claude", prompt: "hi" }).catch(() => undefined);
  await Bun.sleep(500);
  expect((await person(arvid).seats()).seats.filter((s) => s.state === "running")).toEqual([]);
  // Roster changes keep coming (each schedules a reconcile): still at most one more request in this window.
  const before = upserts;
  for (let i = 0; i < 5; i++) { await alex.client().channel({ name: "general", topic: `t${i}` }); await Bun.sleep(700); }
  expect(upserts - before).toBeLessThanOrEqual(1);
}, 60_000);
