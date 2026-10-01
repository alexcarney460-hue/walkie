import { describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_CHALLENGE_TTL_MS, DesktopProof } from "../../src/daemon/desktop-proof.ts";
import { LocalApi, type LocalApiDeps } from "../../src/daemon/local-api.ts";

const log = { info() {}, warn() {}, error() {}, debug() {} };
const TOKEN = "0".repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;

interface Daemon { readonly api: LocalApi; readonly socket: string; readonly port: number; readonly clock: { now: number }; stop(): void }

/** One real LocalApi on a unix socket and an ephemeral loopback port, with a clock the test moves by hand. */
async function boot(nodeId = "0123456789abcdef"): Promise<Daemon> {
  const dir = mkdtempSync(join(tmpdir(), "walkie-desktop-proof-"));
  const socket = join(dir, "walkie.sock");
  const clock = { now: 1_000_000 };
  const api = new LocalApi({ core: { nodeId, log }, token: TOKEN, webDir: dir, desktop: { now: () => clock.now } } as unknown as LocalApiDeps);
  await api.startUnix(socket);
  api.startTcp(0);
  return { api, socket, port: api.tcpPort!, clock, stop() { api.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

const fresh = (): string => randomBytes(32).toString("hex");

/** The trusted path: the owner-only unix socket (what the WSL bridge uses). */
function register(d: Daemon, challenge: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch("http://walkie/v1/desktop/challenge", {
    method: "POST", unix: d.socket, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ challenge }),
  } as RequestInit);
}

/** The untrusted path: whatever listens on the loopback port, reached the way the Windows app reaches it. */
function prove(d: Daemon, challenge: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${d.port}/v1/desktop/prove`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ challenge }),
  });
}

async function answerOf(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  const body = await res.json() as { ok: boolean; answer: string };
  expect(body.ok).toBe(true);
  expect(body.answer).toMatch(HEX64);
  return body.answer;
}

/** The request the Windows app writes (desktop/src-tauri/src/proof.rs pins the same bytes), over a raw socket, and everything the daemon sends back until it closes. */
function raw(port: number, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    sock.on("data", (c) => chunks.push(Buffer.from(c)));
    sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    sock.on("error", reject);
    sock.write(`POST /v1/desktop/prove HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nAccept: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  });
}

describe("desktop daemon identity", () => {
  test("is served on the owner socket only, with the effective port and no value a listener could replay", async () => {
    const d = await boot();
    try {
      const unix = await fetch("http://walkie/v1/desktop/identity", { unix: d.socket } as RequestInit);
      expect(unix.status).toBe(200);
      expect(await unix.json()).toEqual({ ok: true, version: expect.any(String), node_id: "0123456789abcdef", port: d.port });
      // Public over localhost it counted as proof, and a saved copy replayed. It is no longer served there at all.
      expect((await fetch(`http://127.0.0.1:${d.port}/v1/desktop/identity`)).status).toBe(401);
      const bearer = await fetch(`http://127.0.0.1:${d.port}/v1/desktop/identity`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(bearer.status).toBe(403);
      expect((await fetch(`http://127.0.0.1:${d.port}/v1/me`)).status).toBe(401);
    } finally { d.stop(); }
  });
});

describe("desktop listener proof", () => {
  test("a real daemon answers a challenge registered over its socket, with the same answer on both paths", async () => {
    const d = await boot();
    try {
      const c = fresh();
      const reg = await register(d, c);
      expect(reg.status).toBe(200);
      const trusted = await reg.clone().json() as { expires_at: number };
      expect(trusted.expires_at).toBe(d.clock.now + DESKTOP_CHALLENGE_TTL_MS);
      const expected = await answerOf(reg);
      expect(await answerOf(await prove(d, c))).toBe(expected);
    } finally { d.stop(); }
  });

  test("the answer depends on the challenge and on this daemon boot's secret", async () => {
    const a = await boot();
    const b = await boot();
    try {
      const c1 = fresh();
      const c2 = fresh();
      const a1 = await answerOf(await register(a, c1));
      const a2 = await answerOf(await register(a, c2));
      expect(a2).not.toBe(a1);
      // Another daemon (another boot) given the very same challenge cannot produce the first one's answer.
      expect(await answerOf(await register(b, c1))).not.toBe(a1);
    } finally { a.stop(); b.stop(); }
  });

  test("replaying an earlier response fails: the old challenge is spent and a new one needs a new answer", async () => {
    const d = await boot();
    try {
      const earlier = fresh();
      const saved = await answerOf(await register(d, earlier));
      expect(await answerOf(await prove(d, earlier))).toBe(saved);
      const later = fresh();
      const expected = await answerOf(await register(d, later));
      expect(saved).not.toBe(expected);
      // A listener that kept the earlier answer can only offer it again, or ask the daemon for it again: both fail.
      const again = await prove(d, earlier);
      expect(again.status).toBe(404);
      expect(JSON.stringify(await again.json())).not.toContain(saved);
    } finally { d.stop(); }
  });

  test("a challenge nobody registered gets no answer: the listener is not an oracle", async () => {
    const owner = await boot();
    const other = await boot();
    try {
      const unregistered = await prove(owner, fresh());
      expect(unregistered.status).toBe(404);
      expect(JSON.stringify(await unregistered.json())).not.toMatch(/answer|[0-9a-f]{64}/);
      // Registered with one daemon, asked of another: refused (a port owner that is not the registering daemon).
      const c = fresh();
      await answerOf(await register(owner, c));
      expect((await prove(other, c)).status).toBe(404);
    } finally { owner.stop(); other.stop(); }
  });

  test("a challenge is single use", async () => {
    const d = await boot();
    try {
      const c = fresh();
      await answerOf(await register(d, c));
      await answerOf(await prove(d, c));
      expect((await prove(d, c)).status).toBe(404);
      // Registering it again is refused too, so an answered challenge can never be re-armed.
      expect((await register(d, c)).status).toBe(409);
      expect((await prove(d, c)).status).toBe(404);
    } finally { d.stop(); }
  });

  test("an unanswered challenge cannot be registered twice either", async () => {
    const d = await boot();
    try {
      const c = fresh();
      await answerOf(await register(d, c));
      expect((await register(d, c)).status).toBe(409);
    } finally { d.stop(); }
  });

  test("an expired challenge gets no answer", async () => {
    const d = await boot();
    try {
      const justInTime = fresh();
      const tooLate = fresh();
      await answerOf(await register(d, justInTime));
      await answerOf(await register(d, tooLate));
      d.clock.now += DESKTOP_CHALLENGE_TTL_MS - 1;
      await answerOf(await prove(d, justInTime));
      d.clock.now += 1;
      const late = await prove(d, tooLate);
      expect(late.status).toBe(404);
      expect(JSON.stringify(await late.json())).not.toMatch(/[0-9a-f]{64}/);
    } finally { d.stop(); }
  });

  test("registering is the trusted socket's, and a person's: never loopback, never an agent", async () => {
    const d = await boot();
    try {
      const c = fresh();
      const body = JSON.stringify({ challenge: c });
      const url = `http://127.0.0.1:${d.port}/v1/desktop/challenge`;
      expect((await fetch(url, { method: "POST", body })).status).toBe(401);
      expect((await fetch(url, { method: "POST", body, headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(403);
      expect((await register(d, c, { "X-Walkie-Agent": "scout" })).status).toBe(403);
      expect((await register(d, c, { "X-Walkie-Under-Agent": "1" })).status).toBe(403);
      // None of those registered it.
      expect((await prove(d, c)).status).toBe(404);
      await answerOf(await register(d, c));
    } finally { d.stop(); }
  });

  test("the socket never answers the loopback-only route and loopback refuses a cross-origin page", async () => {
    const d = await boot();
    try {
      const c = fresh();
      await answerOf(await register(d, c));
      const viaSocket = await fetch("http://walkie/v1/desktop/prove", {
        method: "POST", unix: d.socket, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge: c }),
      } as RequestInit);
      expect(viaSocket.status).toBe(404);
      expect((await prove(d, c, { Origin: "http://evil.example" })).status).toBe(403);
      expect((await fetch(`http://127.0.0.1:${d.port}/v1/desktop/prove`)).status).toBe(405);
      // The refused attempts spent nothing.
      await answerOf(await prove(d, c));
    } finally { d.stop(); }
  });

  test("malformed challenges are refused on both paths", async () => {
    const d = await boot();
    try {
      for (const bad of ["", "abc", fresh().toUpperCase(), fresh().slice(1), `${fresh()}0`, "g".repeat(64), 7, null, {}]) {
        expect((await register(d, bad)).status).toBe(400);
        expect((await prove(d, bad)).status).toBe(400);
      }
    } finally { d.stop(); }
  });

  test("the exact request the Windows app writes is answered with a Content-Length-framed JSON body", async () => {
    const d = await boot();
    try {
      const c = fresh();
      const expected = await answerOf(await register(d, c));
      const text = await raw(d.port, JSON.stringify({ challenge: c }));
      expect(text.startsWith("HTTP/1.1 200 ")).toBe(true);
      const [head, body] = text.split("\r\n\r\n") as [string, string];
      const length = /^content-length: *(\d+)$/im.exec(head);
      expect(length).not.toBeNull();
      expect(Number(length![1])).toBe(Buffer.byteLength(body));
      expect(/^transfer-encoding:/im.test(head)).toBe(false);
      expect(JSON.parse(body)).toEqual({ ok: true, answer: expected });
    } finally { d.stop(); }
  });
});

describe("DesktopProof", () => {
  const at = (now: { v: number }) => new DesktopProof({ now: () => now.v });

  test("answers are 64 hex characters and never contain the secret or the challenge", () => {
    const proof = at({ v: 0 });
    const c = fresh();
    const r = proof.register(c);
    expect(r).not.toBeNull();
    expect(r!.answer).toMatch(HEX64);
    expect(r!.answer).not.toContain(c);
  });

  test("keeps at most 32 live challenges and drops the oldest first", () => {
    const clock = { v: 0 };
    const proof = at(clock);
    const first = fresh();
    proof.register(first);
    const rest = Array.from({ length: 32 }, () => fresh());
    for (const c of rest) proof.register(c);
    expect(proof.answer(first)).toBeNull();
    expect(proof.answer(rest[0]!)).not.toBeNull();
    expect(proof.answer(rest[31]!)).not.toBeNull();
  });

  test("an expired challenge may be registered afresh but is never answered", () => {
    const clock = { v: 0 };
    const proof = at(clock);
    const c = fresh();
    proof.register(c);
    clock.v = DESKTOP_CHALLENGE_TTL_MS;
    expect(proof.answer(c)).toBeNull();
    expect(proof.register(c)).not.toBeNull();
  });

  test("two instances never share a secret", () => {
    const c = fresh();
    expect(at({ v: 0 }).register(c)!.answer).not.toBe(at({ v: 0 }).register(c)!.answer);
  });

  // The two tests below write the documented values out in full instead of importing them (the other expiry tests are
  // written in terms of the exported constant, so they would pass for any lifetime): docs/PROTOCOL.md and
  // docs/SECURITY.md say 10 s and this HMAC, and desktop/README.md says 10 s.
  test("a challenge lives 10 seconds", () => {
    expect(DESKTOP_CHALLENGE_TTL_MS).toBe(10_000);
    const clock = { v: 5_000 };
    const proof = at(clock);
    const justInTime = fresh();
    const tooLate = fresh();
    expect(proof.register(justInTime)!.expiresAt).toBe(15_000);
    proof.register(tooLate);
    clock.v = 14_999;
    expect(proof.answer(justInTime)).not.toBeNull();
    clock.v = 15_000;
    expect(proof.answer(tooLate)).toBeNull();
  });

  test("the answer is HMAC-SHA256, keyed by a 32-byte per-boot secret, of the domain prefix and the challenge", () => {
    const proof = at({ v: 0 });
    // The one place a test reads the secret: the construction cannot be recomputed without it.
    const secret = (proof as unknown as { secret: Buffer }).secret;
    expect(secret.length).toBe(32);
    const c = fresh();
    const expected = createHmac("sha256", secret).update(`walkie-desktop-listener-proof/v1\n${c}`).digest("hex");
    expect(proof.register(c)!.answer).toBe(expected);
    // The loopback path gives the very same value.
    expect(proof.answer(c)).toBe(expected);
    // Without the prefix it would be another value: the domain separation really is in the MAC.
    expect(expected).not.toBe(createHmac("sha256", secret).update(c).digest("hex"));
  });
});
