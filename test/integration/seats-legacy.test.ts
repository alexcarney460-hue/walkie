// Codex r3 HIGH 2 on its own (runs unchanged on older code, for the before/after): a host whose config.json allowed
// seats before seat users existed (`seats: {allow: true}`, no pool, no same_user) is upgraded and restarted. It must
// run nothing until the person sets seat users up or says --same-user.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TERMINAL_STATES, seatsChannel } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

let c: Cluster;
let alex: TestNode;
let arvid: TestNode;
let log: string;

beforeAll(async () => {
  c = new Cluster();
  const home = join(c.root, "arvid-home");
  mkdirSync(home, { recursive: true });
  log = join(c.root, "codex.jsonl");
  const seats = { flushMs: 100, env: { PATH: `${join(import.meta.dir, "..", "fixtures", "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, FAKE_CODEX_LOG: log } };
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  arvid = await c.add({ name: "arvid", login: "arvid@example.com", hostname: "arvid-mac", seats });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  // The seats channel as an older version made it, then an old-style config.json (allow, nothing else).
  const cfgPath = join(arvid.home, "config.json");
  // (Marked, as the seats host marks it since PRE4: this test is about the legacy config, and an unmarked channel runs
  // no seat anyway, seats-unmarked.test.ts.)
  await arvid.client("").request("POST", "/v1/channels", { name: seatsChannel(arvid.d.nodeId), members: ["arvid", "alex"], seats: true }).catch(() => undefined);
  await waitFor(async () => (await alex.client().team()).channels.some((x) => x.name === seatsChannel(arvid.d.nodeId)), { what: "the seats channel" });
  await arvid.stop();
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, seats: { allow: true, env: ["FAKE_CODEX_LOG"] } }, null, 2));
  await arvid.start();
}, 60_000);
afterAll(async () => { await c.close(); });

test("a legacy enabled config runs no seat after the upgrade", async () => {
  const res = await alex.client("").seatRun({ machine: "arvid-mac", runtime: "codex", prompt: "legacy seat" });
  const s = await waitFor(async () => { const x = (await alex.client().seats(res.seat)).seats[0]; return x && TERMINAL_STATES.has(x.state) ? x : null; }, { timeoutMs: 20_000, what: "an answer" });
  const ran = existsSync(log) && readFileSync(log, "utf8").includes('"prompt":"legacy seat"');
  console.error("LEGACY", JSON.stringify({ state: s.state, reason: s.reason, ran }));
  expect(ran).toBe(false);
  expect(s.state).toBe("refused");
}, 60_000);
