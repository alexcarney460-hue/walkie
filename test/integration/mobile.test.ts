// WALKIE-PWA-1 end to end: a daemon, a local relay and a headless phone (src/mobile/client.ts, the same code the
// phone app runs). Pairing, the phone's allow-list, the live stream, revocation, restart and removal, and that the
// relay only ever carries ciphertext.
import { WalkieClient } from "../../src/client/index.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { b64u, hkdfKey, pairingKeys, roomOf, unb64u } from "../../src/mobile/crypto.ts";
import { MobileLink, type Registered } from "../../src/mobile/client.ts";
import { startRelay, type RelayHandle } from "../../src/relay/server.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

let c: Cluster;
let alex: TestNode;
let kira: TestNode;
let relay: RelayHandle;
let relayUrl: string;
const APP = "http://127.0.0.1:1/m";

beforeAll(async () => {
  relay = startRelay({ port: 0, hostname: "127.0.0.1", connectRate: { capacity: 1_000, perSecond: 1_000 }, perIpConnections: 1_000 });
  relayUrl = `ws://127.0.0.1:${relay.port}`;
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", mobile: { relayUrl, appUrl: APP } });
  kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp", mobile: { relayUrl, appUrl: APP } });
  await alex.client().init("acme", "alex");
  await alex.client().invite("kira@example.com", "kira", "member");
  const j = await kira.client().join(alex.peerAddr);
  if (!j.admitted) throw new Error(`kira join failed: ${j.reason}`);
});
afterAll(async () => {
  await c.close();
  relay.stop();
});

function secretOf(url: string): string {
  const m = /#pair=([A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22})/.exec(url);
  if (!m) throw new Error(`no pairing code in ${url}`);
  return m[1] as string;
}

async function pairPhone(node: TestNode, name = "Test phone"): Promise<{ reg: Registered; secret: string }> {
  const p = await node.client().mobilePair();
  const secret = secretOf(p.url);
  const k = await pairingKeys(secret);
  const link = await MobileLink.open({ relay: relayUrl, room: k.room, kid: "pair", psk: k.psk });
  const reg = await link.register(name);
  link.close();
  return { reg, secret };
}

async function deviceLink(reg: Registered): Promise<MobileLink> {
  return MobileLink.open({ relay: relayUrl, room: reg.room, kid: `d:${reg.device.id}`, psk: await hkdfKey(unb64u(reg.key)) });
}

describe("pairing", () => {
  test("nothing links to the relay until a person pairs; pair() gives a link, a code and a QR", async () => {
    const before = await alex.client().mobile();
    expect(before.linked).toBe(false);
    expect(before.devices).toEqual([]);
    const p = await alex.client().mobilePair();
    expect(p.url.startsWith(`${APP}#pair=`)).toBe(true);
    expect(p.url).toContain(`&relay=${encodeURIComponent(relayUrl)}`); // a development relay rides along
    expect(p.code).toBe(secretOf(p.url));
    expect(p.expires_at - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(p.qr.length).toBeGreaterThan(20);
    expect(p.qr.every((r) => r.length === p.qr.length && /^[01]+$/.test(r))).toBe(true);
    await waitFor(async () => (await alex.client().mobile()).linked, { what: "relay link" });
  });

  test("a phone pairs, gets a device key, and the pairing secret works once", async () => {
    const { reg, secret } = await pairPhone(alex, "Alex's iPhone");
    expect(reg.device.name).toBe("Alex's iPhone");
    expect(reg.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const devices = (await alex.client().mobile()).devices;
    expect(devices.map((d) => d.id)).toContain(reg.device.id);
    expect(JSON.stringify(devices)).not.toContain(reg.key); // the API never shows a key
    // the same secret again: the room is gone
    const k = await pairingKeys(secret);
    await expect(MobileLink.open({ relay: relayUrl, room: k.room, kid: "pair", psk: k.psk, timeoutMs: 3_000 })).rejects.toThrow();
    // the key is stored 0600 in a 0700 directory
    const dir = join(alex.home, "mobile");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "devices.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "devices.json"), "utf8")).toContain(reg.device.id);
  });

  test("a wrong secret for a real pairing room fails the handshake, and five failures void the pairing", async () => {
    const p = await alex.client().mobilePair();
    const k = await pairingKeys(secretOf(p.url));
    const wrong = await pairingKeys(`${k.room}.${"A".repeat(22)}`);
    for (let i = 0; i < 5; i++) {
      await expect(MobileLink.open({ relay: relayUrl, room: k.room, kid: "pair", psk: wrong.psk, timeoutMs: 3_000 })).rejects.toThrow();
    }
    await expect(MobileLink.open({ relay: relayUrl, room: k.room, kid: "pair", psk: k.psk, timeoutMs: 3_000 })).rejects.toThrow();
  });

  test("holding a pairing code doesn't let anyone claim its relay room (the claim key never leaves the daemon)", async () => {
    const p = await alex.client().mobilePair();
    const code = secretOf(p.url);
    const [room, secret] = code.split(".") as [string, string];
    // Try the obvious keys an attacker could build from the code: none of them names the room.
    for (const candidate of [unb64u(secret), new TextEncoder().encode(code).slice(0, 32)]) {
      const key = new Uint8Array(32);
      key.set(candidate.slice(0, 32));
      expect(await roomOf(key)).not.toBe(room);
    }
    // And a daemon connection that claims *some* key can't displace the holder: the phone still pairs.
    const attacker = new WebSocket(`${relayUrl}/v1/daemon?v=2`);
    await new Promise((resolve) => { attacker.onopen = resolve; });
    attacker.send(JSON.stringify({ t: "open", key: b64u(unb64u(secret.padEnd(43, "A").slice(0, 43))) }));
    const k = await pairingKeys(code);
    const link = await MobileLink.open({ relay: relayUrl, room: k.room, kid: "pair", psk: k.psk });
    expect((await link.info()).handle).toBe("alex");
    link.close();
    attacker.close();
  });

  test("an agent can't pair a phone", async () => {
    await expect(alex.client("claude").mobilePair()).rejects.toMatchObject({ status: 403 });
  });

  test("nor can a CLI running under an agent pair (the code is a credential); status and signing phones out are admin (AGENT-ADMIN-1)", async () => {
    const under = new WalkieClient({ socket: alex.socket, underAgent: true, timeoutMs: 15_000 });
    await expect(under.mobilePair()).rejects.toMatchObject({ status: 403, code: "person_only" });
    expect((await under.mobile()).devices).toBeDefined();
    await expect(under.mobileRevoke("0123456789ab")).rejects.toMatchObject({ status: 404 }); // passed the gate: no such device
    await alex.client().adminSwitches({ agent_admin: false });
    try {
      await expect(under.mobile()).rejects.toMatchObject({ status: 403, code: "agent_admin_off" });
      await expect(under.mobileRevokeAll()).rejects.toMatchObject({ status: 403, code: "agent_admin_off" });
    } finally {
      await alex.client().adminSwitches({ agent_admin: true });
    }
    expect((await alex.client().mobile()).devices).toBeDefined(); // the person still can
  });
});

describe("the phone's allow-list", () => {
  let reg: Registered;
  let link: MobileLink;
  beforeAll(async () => {
    reg = (await pairPhone(alex)).reg;
    link = await deviceLink(reg);
  });
  afterAll(() => link.close());

  test("Mission Control reads answer", async () => {
    for (const path of ["/v1/me", "/v1/team", "/v1/agents", "/v1/peers", "/v1/asks?state=open&to=me", "/v1/events?channel=general&limit=5"]) {
      const r = await link.request("GET", path);
      expect({ path, status: r.status }).toEqual({ path, status: 200 });
    }
    const me = await link.request<{ handle: string }>("GET", "/v1/me");
    expect(me.body.handle).toBe("alex");
  });

  test("posting works, as the person (never an agent)", async () => {
    const r = await link.request<{ event: { author: { handle: string; agent?: string }; body: { text: string } } }>("POST", "/v1/post", { channel: "general", text: "from my phone" });
    expect(r.status).toBe(200);
    expect(r.body.event.author.handle).toBe("alex");
    expect(r.body.event.author.agent).toBeUndefined();
  });

  test("posting never creates a channel from the phone", async () => {
    const r = await link.request<{ error: { code: string } }>("POST", "/v1/post", { channel: "brand-new-channel", text: "hi" });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("unknown_channel");
    expect((await alex.client().team()).channels.map((c) => c.name)).not.toContain("brand-new-channel");
  });

  test("answering an ask works", async () => {
    const ask = await kira.client().ask({ to: "@alex", text: "ship it?", channel: "general", timeout_s: 300 });
    const asked = ask.event.id;
    const open = await waitFor(async () => {
      const r = await link.request<{ asks: { ask: { id: string } }[] }>("GET", "/v1/asks?state=open&to=me");
      return r.body.asks.find((a) => a.ask.id === asked) ?? null;
    }, { what: "ask on alex's machine" });
    const r = await link.request("POST", "/v1/answer", { ask: open.ask.id, text: "yes" });
    expect(r.status).toBe(200);
  });

  test("everything else is refused: tokens, accounts, admin, roster, license, integrations, artifacts", async () => {
    const refused: [("GET" | "POST"), string, unknown?][] = [
      ["GET", "/v1/accounts"], ["GET", "/v1/license"], ["GET", "/v1/integrations"], ["GET", "/v1/diag"],
      ["GET", "/v1/team/pending"], ["GET", "/v1/mobile"], ["GET", "/v1/linear/issues?keys=A-1"], ["GET", `/v1/artifacts/${"a".repeat(64)}`],
      ["POST", "/v1/team/invite", { login: "m@example.com", handle: "mallory", role: "owner" }],
      ["POST", "/v1/team/member", { handle: "kira", role: "removed" }], ["POST", "/v1/team/authority", { node: "x" }],
      ["POST", "/v1/mobile/pair"], ["POST", "/v1/license", { key: "x" }], ["POST", "/v1/channels", { name: "x" }],
      ["POST", "/v1/status", { agent: "a", state: "working" }], ["POST", "/v1/ask", { to: "@kira", text: "x" }],
      ["POST", "/v1/auth/nonce"], ["POST", "/v1/auth/rotate"], ["GET", "/v1/healthz"],
      ["GET", "//evil.example/v1/me"], ["GET", "/v1/../v1/accounts"], ["GET", "/auth?nonce=x"], ["GET", "/"],
    ];
    for (const [method, path, body] of refused) {
      const r = await link.request(method, path, body);
      expect({ method, path, status: r.status }).toEqual({ method, path, status: 403 });
    }
    // and nothing happened: mallory is not a member
    const team = await alex.client().team();
    expect(team.members.map((m) => m.handle)).not.toContain("mallory");
  });

  test("the live stream delivers events and agents, never accounts", async () => {
    const got: { type: string; data: unknown }[] = [];
    const cancel = link.stream("/v1/stream", (type, data) => got.push({ type, data }), () => undefined);
    await waitFor(() => got.some((m) => m.type === "hello"), { what: "stream hello" });
    await alex.client().post({ channel: "general", text: "live to the phone" });
    await waitFor(() => got.some((m) => m.type === "event" && JSON.stringify(m.data).includes("live to the phone")), { what: "event on the stream" });
    cancel();
    expect(got.every((m) => ["hello", "event", "agents", "nodes", "hidden"].includes(m.type))).toBe(true);
  });
});

describe("revocation, restart, removal", () => {
  test("revoking a device ends its open link and its key stops working", async () => {
    const { reg } = await pairPhone(alex);
    const link = await deviceLink(reg);
    const closed = new Promise<{ revoked: boolean }>((resolve) => { link.onClose = (e) => resolve(e); });
    expect((await link.request("GET", "/v1/me")).status).toBe(200);
    await alex.client().mobileRevoke(reg.device.id);
    expect((await closed).revoked).toBe(true);
    await expect(deviceLink(reg)).rejects.toThrow();
    expect((await alex.client().mobile()).devices.map((d) => d.id)).not.toContain(reg.device.id);
  });

  test("each device has its own room: another device's key is refused there, and a signed-out device's room is gone", async () => {
    const a = (await pairPhone(alex, "A")).reg;
    const b = (await pairPhone(alex, "B")).reg;
    expect(a.room).not.toBe(b.room);
    // B's key and id in A's room: the daemon refuses (the room admits only A)
    await expect(MobileLink.open({ relay: relayUrl, room: a.room, kid: `d:${b.device.id}`, psk: await hkdfKey(unb64u(b.key)), timeoutMs: 3_000 })).rejects.toMatchObject({ code: 4403 });
    await alex.client().mobileRevoke(a.device.id);
    // A's room is released: nothing answers there any more (the relay says no computer holds it)
    // (the release reaches the relay on the daemon's socket; a connect racing it may see another refusal first)
    await waitFor(async () => (await deviceLink(a).then(() => null, (e: { code: number | null }) => e))?.code === 4404, { what: "room released" });
    const lb = await deviceLink(b);
    expect((await lb.request("GET", "/v1/me")).status).toBe(200);
    lb.close();
  });

  test("the phone can unpair itself", async () => {
    const { reg } = await pairPhone(alex);
    const link = await deviceLink(reg);
    await link.unpair();
    await waitFor(async () => !(await alex.client().mobile()).devices.some((d) => d.id === reg.device.id), { what: "device gone" });
    link.close();
    await expect(deviceLink(reg)).rejects.toThrow();
  });

  test("a paired phone survives a daemon restart (the device key is persisted)", async () => {
    const { reg } = await pairPhone(alex);
    await alex.restart();
    const link = await waitFor(async () => deviceLink(reg), { timeoutMs: 15_000, intervalMs: 300, what: "relink after restart" });
    expect((await link.request("GET", "/v1/me")).status).toBe(200);
    link.close();
  });

  test("removing the member signs every phone on their machine out", async () => {
    const { reg } = await pairPhone(kira);
    const link = await deviceLink(reg);
    expect((await link.request("GET", "/v1/me")).status).toBe(200);
    const closed = new Promise<void>((resolve) => { link.onClose = () => resolve(); });
    await alex.client().setRole("kira", "removed");
    await waitFor(async () => (await kira.client().mobile()).devices.length === 0, { timeoutMs: 15_000, what: "kira's devices revoked" });
    await closed;
    await expect(deviceLink(reg)).rejects.toThrow();
  });
});

/** A phone-side WebSocket that records every frame and can replay or alter what it sends. */
function tapSocket(mode: "record" | "replay" | "tamper") {
  const sent: Uint8Array[] = [];
  const recv: Uint8Array[] = [];
  class Tap extends WebSocket {
    constructor(url: string | URL) {
      super(url);
      this.addEventListener("message", (ev: MessageEvent) => {
        if (typeof ev.data !== "string") recv.push(new Uint8Array((ev.data as ArrayBuffer).slice(0)));
      });
    }
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (typeof data === "string" || data instanceof Blob) { super.send(data); return; }
      const src = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      const b = new Uint8Array(src.byteLength);
      b.set(src);
      sent.push(b.slice());
      const transport = b[0] === 3; // after the handshake
      if (mode === "tamper" && transport) b[b.length - 1] = (b[b.length - 1] as number) ^ 1;
      super.send(b);
      if (mode === "replay" && transport) super.send(b);
    }
  }
  return { WS: Tap as unknown as typeof WebSocket, sent, recv };
}

describe("the relay only carries ciphertext; the channel refuses tampering and replay", () => {
  test("no plaintext (paths, channel names, message text, handles) in any frame either way", async () => {
    const { reg } = await pairPhone(alex);
    const tap = tapSocket("record");
    const link = await MobileLink.open({ relay: relayUrl, room: reg.room, kid: `d:${reg.device.id}`, psk: await hkdfKey(unb64u(reg.key)), WebSocket: tap.WS });
    const marker = "PLAINTEXT-MARKER-7f3a";
    expect((await link.request("POST", "/v1/post", { channel: "general", text: marker })).status).toBe(200);
    const events = await link.request<{ events: { body: { text?: string } }[] }>("GET", "/v1/events?channel=general&limit=20");
    expect(JSON.stringify(events.body)).toContain(marker); // the phone did get it back...
    link.close();
    const all = [...tap.sent, ...tap.recv].map((b) => Buffer.from(b).toString("latin1"));
    expect(all.length).toBeGreaterThan(3);
    for (const needle of [marker, "/v1/", "general", "alex", "\"op\""]) {
      expect({ needle, seen: all.some((s) => s.includes(needle)) }).toEqual({ needle, seen: false }); // ...the relay did not
    }
  });

  test("an altered frame ends the session", async () => {
    const { reg } = await pairPhone(alex);
    const tap = tapSocket("tamper");
    const link = await MobileLink.open({ relay: relayUrl, room: reg.room, kid: `d:${reg.device.id}`, psk: await hkdfKey(unb64u(reg.key)), WebSocket: tap.WS });
    const closed = new Promise<{ code: number | null }>((resolve) => { link.onClose = (e) => resolve(e); });
    const r = await link.request("GET", "/v1/me");
    expect(r.status).toBe(503); // never answered: the daemon dropped the link
    expect((await closed).code).toBe(4403);
  });

  test("a replayed frame ends the session", async () => {
    const { reg } = await pairPhone(alex);
    const tap = tapSocket("replay");
    const link = await MobileLink.open({ relay: relayUrl, room: reg.room, kid: `d:${reg.device.id}`, psk: await hkdfKey(unb64u(reg.key)), WebSocket: tap.WS });
    const closed = new Promise<{ code: number | null }>((resolve) => { link.onClose = (e) => resolve(e); });
    await link.request("GET", "/v1/me").catch(() => null);
    expect((await closed).code).toBe(4403);
  });
});

describe("availability", () => {
  test("the daemon re-links after the relay restarts, and a paired phone connects again", async () => {
    const { reg } = await pairPhone(alex);
    const port = relay.port;
    relay.stop();
    await waitFor(async () => !(await alex.client().mobile()).linked, { what: "link down" });
    relay = startRelay({ port, hostname: "127.0.0.1", connectRate: { capacity: 1_000, perSecond: 1_000 }, perIpConnections: 1_000 });
    await waitFor(async () => (await alex.client().mobile()).linked, { timeoutMs: 15_000, what: "link back up" });
    const link = await waitFor(async () => deviceLink(reg), { timeoutMs: 15_000, intervalMs: 300, what: "phone reconnects" });
    expect((await link.request("GET", "/v1/me")).status).toBe(200);
    link.close();
  });

  test("with every phone signed out and no pairing open, the daemon drops its relay connection", async () => {
    await alex.client().mobileRevokeAll();
    await waitFor(async () => { const s = await alex.client().mobile(); return !s.linked && s.devices.length === 0; }, { what: "unlinked" });
  });
});
