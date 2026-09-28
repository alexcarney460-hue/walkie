// SEATS-FIX-2 (docs/audits/2026-09-26-*-seats-r2.md), the parts testable without daemons: a host demoted to observer
// judges no launch (Codex HIGH 1) and a demoted launcher loses the right at request time; a stop names who may
// stop (Opus LOW 4); the seats' socket re-checks a token after reading the body (Codex LOW 5); cancelling a seat
// while the seat env file is sourced ends what it started (Codex MEDIUM 2); failure summaries are redacted whole before
// they are shortened (Codex MEDIUM 4).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../src/daemon/logger.ts";
import { failureReason } from "../../src/daemon/seats/host.ts";
import { decideRun, decideStop, launcherAllowed, type SeatsPolicy } from "../../src/daemon/seats/rules.ts";
import { loginEnv } from "../../src/daemon/seats/runtime.ts";
import { SeatApi } from "../../src/daemon/seats/seat-api.ts";
import { seatsChannel, type SeatRun } from "../../src/protocol/seats.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const RUN: SeatRun = { op: "run", v: 1, runtime: "codex", prompt: "go", timeout_s: 600, max_concurrent: 9 };
const POLICY: SeatsPolicy = { allow: true, launchers: null, runtimes: ["claude", "codex"] };

/** alex (owner) + arvid (member, the host arvid-mac) + kira (owner): the seats channel [arvid, alex, kira]. */
function team() {
  const alex = tnode("alex");
  const arvid = tnode("arvid", "arvid@example.com", "arvid-mac");
  const kira = tnode("kira");
  const { team: id, create } = createTeam(alex);
  const core = makeCore(arvid, id, cleanups);
  const channel = seatsChannel(arvid.keys.nodeId);
  feed(core, [
    create, memberEv(id, alex, arvid, "member"), memberEv(id, alex, kira, "owner"), nodeEv(id, alex, arvid), nodeEv(id, alex, kira),
    ev(id, alex, "channel.upsert", { name: channel, members: ["arvid", "alex", "kira"], seats: true }),
  ]);
  const ctx = (at = now()) => ({ roster: core.roster, node: arvid.keys.nodeId, me: "arvid", policy: POLICY, now: at, maxAgeMs: 10 * 60_000 });
  return { id, core, alex, arvid, kira, channel, ctx };
}

describe("observers (Codex HIGH 1)", () => {
  test("a host demoted to observer judges no launch, fresh or queued (and answers nothing)", () => {
    const t = team();
    const req = ev(t.id, t.alex, "msg.post", { text: "go", seat: RUN } as never, { channel: t.channel });
    expect(decideRun(req, t.ctx(req.ts))?.ok).toBe(true);
    feed(t.core, [req, memberEv(t.id, t.alex, t.arvid, "observer")]); // (in alex's order: the request, then the demotion)
    expect(t.core.me()?.role).toBe("observer");
    expect(decideRun(req, t.ctx(req.ts))).toEqual({ ok: false, reason: "host_not_admitted", answer: false });
    expect(decideRun(req, { ...t.ctx(req.ts), queued: true })).toMatchObject({ ok: false, reason: "host_not_admitted" });
  });

  test("a launcher demoted to observer loses the right at request time", () => {
    const t = team();
    feed(t.core, [memberEv(t.id, t.alex, t.kira, "observer")]);
    const req = ev(t.id, t.kira, "msg.post", { text: "go", seat: RUN } as never, { channel: t.channel });
    // kira is no launcher any more, so the channel that still lists him is too wide: nothing is judged there.
    expect(decideRun(req, t.ctx(req.ts))?.ok).toBe(false);
    expect(decideRun(req, t.ctx(req.ts))).toMatchObject({ ok: false, reason: "channel_too_wide" });
    // Even named as a launcher, an observer is refused (judged at request time, from the roster of the moment).
    expect(launcherAllowed(req, t.core.roster, { ...POLICY, launchers: [{ handle: "kira" }, { handle: "alex" }] })).toBe("observer");
  });
});

describe("who may stop (Opus LOW 4)", () => {
  test("a stop says whether it came from the host's person in person", () => {
    const t = team();
    const stop = { op: "stop", v: 1, seat: "0123456789abcdef:7" };
    const byKira = ev(t.id, t.kira, "msg.post", { text: "stop", seat: stop } as never, { channel: t.channel });
    const d = decideStop(byKira, t.ctx(byKira.ts));
    expect(d).toMatchObject({ ok: true, launcher: "kira", hostPerson: false });
    const byArvid = ev(t.id, t.arvid, "msg.post", { text: "stop", seat: stop } as never, { channel: t.channel });
    expect(decideStop(byArvid, t.ctx(byArvid.ts))).toMatchObject({ ok: true, launcher: "arvid", hostPerson: true });
  });
});

describe("the seats' socket (Codex LOW 5)", () => {
  test("a token revoked while its request's body is still arriving posts nothing", async () => {
    const dir = mkdtempSync("/tmp/walkie-seatapi-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const posted: string[] = [];
    const api = new SeatApi(join(dir, "s.sock"), { postAsSeat: (id, b) => { posted.push(`${id}:${b.text}`); return {} as never; } }, createLogger({}));
    api.start();
    cleanups.push(() => api.stop());
    const token = api.issue("0123456789abcdef:1");
    let push: (s: string) => void = () => undefined;
    let end: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        push = (s) => ctrl.enqueue(new TextEncoder().encode(s));
        end = () => ctrl.close();
      },
    });
    const res = fetch("http://walkie/v1/post", {
      method: "POST", unix: join(dir, "s.sock"), body, duplex: "half",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    } as RequestInit);
    push('{"channel":"seats-0123456789abcdef",');
    await Bun.sleep(150); // authenticated on the headers; the body is still arriving
    api.revoke("0123456789abcdef:1"); // the seat ends meanwhile
    push('"text":"late"}');
    end();
    const r = await res;
    expect(r.status).toBe(401);
    expect(posted).toEqual([]);
  });
});

describe("cancelling a seat while it prepares (Codex MEDIUM 2)", () => {
  test("aborting while the seat env file is sourced ends what the file started, not only the shell", async () => {
    const home = mkdtempSync("/tmp/walkie-seatenv-");
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const pidFile = join(home, "child.pid");
    writeFileSync(join(home, "seat-env"), `sleep 300 &\necho $! > "${pidFile}"\nwait\n`);
    const ac = new AbortController();
    const pending = loginEnv({ PATH: "/usr/bin:/bin" }, home, join(home, "seat-env"), [], ac.signal);
    const t0 = Date.now();
    while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()) {
      if (Date.now() - t0 > 5_000) throw new Error("the seat env file's child never started");
      await Bun.sleep(20);
    }
    const child = Number(readFileSync(pidFile, "utf8").trim());
    ac.abort();
    const out = await pending;
    expect(out.sourced).toBeNull();
    const t1 = Date.now();
    let alive = true;
    while (alive && Date.now() - t1 < 3_000) {
      try { process.kill(child, 0); await Bun.sleep(20); } catch { alive = false; }
    }
    if (alive) process.kill(child, "SIGKILL");
    expect(alive).toBe(false);
  });
});

describe("failure summaries (Codex MEDIUM 4)", () => {
  test("a secret that crosses the cut is redacted whole, never left half-shown", () => {
    const secret = `ghp_${"A1b2C3d4E5".repeat(4)}`.slice(0, 40);
    const text = `${"x".repeat(248)} token ${secret} rejected`; // the token runs across character 280
    const reason = failureReason(text);
    expect(reason.length).toBeLessThanOrEqual(280);
    expect(reason).not.toContain("ghp_");
    expect(reason).not.toContain(secret.slice(4, 20));
  });
});

