// Walkie mobile link, protocol v1 (WALKIE-PWA-1): the end-to-end encryption between a paired phone and its daemon.
// Shared by the daemon, the phone app and the tests; WebCrypto only (runs in Bun and in the browser alike).
//
// A relay forwards opaque frames between the two sides; it never holds a key. Each connection starts with a
// Noise-NNpsk0-shaped handshake: both sides send an ephemeral P-256 ECDH key, and the session keys are derived from
// the ECDH secret AND a pre-shared key (PSK) with HKDF-SHA-256, bound to the transcript (both ephemeral keys and the
// key id). The PSK is the pairing secret (from the QR code, single use) or, after pairing, the device key the daemon
// handed the phone (kept there as a non-extractable CryptoKey). A relay without the PSK can't complete either side:
// the daemon's reply carries a key-confirmation message the phone checks before it sends anything.
//
// After the handshake every frame is AES-256-GCM with its own key per direction and a 64-bit counter as the nonce and
// the additional data; a receiver accepts exactly the next counter, so a replayed, dropped, reordered or altered frame
// ends the session. Fresh ephemeral keys per connection give forward secrecy.
//
// P-256 rather than X25519: WebCrypto X25519 needs iOS 17 / Chrome 133; P-256 ECDH works in every current browser.

export const PROTO = "walkie-mobile-v1";
export const FRAME_HELLO = 1;
export const FRAME_REPLY = 2;
export const FRAME_DATA = 3;
/** Largest handshake frame either side accepts. */
export const MAX_HANDSHAKE = 1_024;
const TAG = 16;
const HEADER = 9; // type + 64-bit counter

const subtle = globalThis.crypto.subtle;
/** Every buffer here is ArrayBuffer-backed; WebCrypto's typings want that spelled out. */
const buf = (b: Uint8Array): BufferSource => b as unknown as BufferSource;
const utf8 = new TextEncoder();
const CONFIRM = utf8.encode(`${PROTO} confirm`);

export class ProtocolError extends Error {}

// ---- encoding ------------------------------------------------------------------------------------------------------

export function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict base64url (no padding, no other characters). */
export function unb64u(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new ProtocolError("bad base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

/** A length-prefixed field (so no two transcripts encode alike). */
function field(b: Uint8Array): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, b.byteLength);
  return concat(len, b);
}

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", buf(concat(...parts))));
}

// ---- keys ----------------------------------------------------------------------------------------------------------

/** Imports key material as an HKDF base key; non-extractable, so a stored device key can't be read back out. */
export function hkdfKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey("raw", buf(raw), "HKDF", false, ["deriveBits"]);
}

async function hkdf(base: CryptoKey, salt: Uint8Array, info: string, bits: number): Promise<Uint8Array> {
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(utf8.encode(`${PROTO} ${info}`)) }, base, bits));
}

/** The relay room a daemon claims with `relayKey`: 16 bytes of SHA-256, base64url (22 characters). */
export async function roomOf(relayKey: Uint8Array): Promise<string> {
  return b64u((await sha256(utf8.encode("walkie-relay-room-v1\n"), relayKey)).slice(0, 16));
}

export const ROOM_RE = /^[A-Za-z0-9_-]{22}$/;
export const PAIRING_SECRET_BYTES = 16;
export const PAIRING_SECRET_RE = /^[A-Za-z0-9_-]{22}$/;
/** A pairing code (the QR fragment's `pair=`, and what a person pastes): `<room id>.<secret>`. */
export const PAIRING_CODE_RE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/;

/**
 * What a pairing code stands for: the relay room the daemon holds for it, and the handshake PSK derived from the
 * secret. The room is claimed with a random key that only the daemon has (never in the code), so knowing a code lets
 * a phone *join* the room, never *claim* it.
 */
export async function pairingKeys(code: string): Promise<{ room: string; psk: CryptoKey }> {
  const m = PAIRING_CODE_RE.exec(code);
  if (!m) throw new ProtocolError("bad pairing code");
  const base = await hkdfKey(unb64u(m[2] as string));
  const psk = await hkdfKey(await hkdf(base, new Uint8Array(0), "pairing psk", 256));
  return { room: m[1] as string, psk };
}

async function ephemeral(): Promise<{ priv: CryptoKey; pub: Uint8Array }> {
  const kp = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) as CryptoKeyPair;
  return { priv: kp.privateKey, pub: new Uint8Array(await subtle.exportKey("raw", kp.publicKey)) };
}

async function importPub(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== 65 || raw[0] !== 4) throw new ProtocolError("bad ephemeral key");
  try {
    return await subtle.importKey("raw", buf(raw), { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    throw new ProtocolError("bad ephemeral key");
  }
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey("raw", buf(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Session keys: HKDF over the ECDH secret, salted with a PSK-derived value bound to the transcript. */
async function sessionKeys(psk: CryptoKey, dh: Uint8Array, th: Uint8Array): Promise<{ p2d: CryptoKey; d2p: CryptoKey }> {
  const s1 = await hkdf(psk, th, "psk", 256);
  const okm = await hkdf(await hkdfKey(dh), s1, "keys", 512);
  return { p2d: await aesKey(okm.slice(0, 32)), d2p: await aesKey(okm.slice(32)) };
}

async function transcript(kid: string, ePhone: Uint8Array, eDaemon: Uint8Array): Promise<Uint8Array> {
  return sha256(field(utf8.encode(PROTO)), field(utf8.encode(kid)), field(ePhone), field(eDaemon));
}

// ---- transport -----------------------------------------------------------------------------------------------------

/**
 * One direction pair of AES-GCM with strict counters. `seal` and `open` are each serialized internally, so frames
 * leave (and are accepted) in counter order even though WebCrypto is asynchronous.
 */
export class Channel {
  private sendCtr = 0n;
  private recvCtr = 0n;
  private sendChain: Promise<unknown> = Promise.resolve();
  private recvChain: Promise<unknown> = Promise.resolve();
  private dead = false;

  constructor(private readonly sendKey: CryptoKey, private readonly recvKey: CryptoKey) {}

  seal(plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const run = this.sendChain.then(async () => {
      const ctr = this.sendCtr++;
      const header = new Uint8Array(HEADER);
      header[0] = FRAME_DATA;
      new DataView(header.buffer).setBigUint64(1, ctr);
      const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: buf(nonce(ctr)), additionalData: buf(header) }, this.sendKey, buf(plaintext)));
      return concat(header, ct);
    });
    this.sendChain = run.catch(() => undefined);
    return run;
  }

  /** The plaintext of the next frame; throws (and the channel is dead) for anything else. */
  open(frame: Uint8Array): Promise<Uint8Array> {
    const run = this.recvChain.then(async () => {
      if (this.dead) throw new ProtocolError("channel closed");
      try {
        if (frame.byteLength < HEADER + TAG || frame[0] !== FRAME_DATA) throw new ProtocolError("bad frame");
        const header = frame.slice(0, HEADER);
        const ctr = new DataView(header.buffer).getBigUint64(1);
        if (ctr !== this.recvCtr) throw new ProtocolError("replayed or out-of-order frame");
        let pt: ArrayBuffer;
        try {
          pt = await subtle.decrypt({ name: "AES-GCM", iv: buf(nonce(ctr)), additionalData: buf(header) }, this.recvKey, buf(frame.slice(HEADER)));
        } catch {
          throw new ProtocolError("frame failed authentication");
        }
        this.recvCtr++;
        return new Uint8Array(pt);
      } catch (err) {
        this.dead = true;
        throw err;
      }
    });
    this.recvChain = run.catch(() => undefined);
    return run;
  }
}

function nonce(ctr: bigint): Uint8Array {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, ctr);
  return iv;
}

// ---- handshake -----------------------------------------------------------------------------------------------------

export interface Hello { readonly kid: string; readonly e: Uint8Array }

/** Key ids: "pair" in a pairing room, "d:<device id>" in that device's own room. */
export const KID_RE = /^(?:pair|d:[0-9a-f]{12})$/;

function jsonFrame(type: number, v: unknown): Uint8Array<ArrayBuffer> {
  return concat(new Uint8Array([type]), utf8.encode(JSON.stringify(v)));
}

function parseFrame(type: number, frame: Uint8Array): Record<string, unknown> {
  if (frame.byteLength > MAX_HANDSHAKE || frame[0] !== type) throw new ProtocolError("unexpected handshake frame");
  try {
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.slice(1))) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new ProtocolError("bad handshake frame");
  }
}

/** The phone's first frame. */
export async function phoneHello(kid: string): Promise<{ frame: Uint8Array<ArrayBuffer>; state: { kid: string; priv: CryptoKey; pub: Uint8Array } }> {
  if (!KID_RE.test(kid)) throw new ProtocolError("bad key id");
  const e = await ephemeral();
  return { frame: jsonFrame(FRAME_HELLO, { v: 1, kid, e: b64u(e.pub) }), state: { kid, priv: e.priv, pub: e.pub } };
}

/** The daemon reads a hello (to pick the PSK by key id) before it answers. */
export function readHello(frame: Uint8Array): Hello {
  const v = parseFrame(FRAME_HELLO, frame);
  if (v.v !== 1 || typeof v.kid !== "string" || !KID_RE.test(v.kid) || typeof v.e !== "string") throw new ProtocolError("bad hello");
  return { kid: v.kid, e: unb64u(v.e) };
}

/** The daemon's answer: its ephemeral key and a key confirmation, and the daemon side of the channel. */
export async function daemonReply(hello: Hello, psk: CryptoKey): Promise<{ frame: Uint8Array; channel: Channel }> {
  const phonePub = await importPub(hello.e);
  const e = await ephemeral();
  const dh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: phonePub }, e.priv, 256));
  const keys = await sessionKeys(psk, dh, await transcript(hello.kid, hello.e, e.pub));
  const channel = new Channel(keys.d2p, keys.p2d);
  const confirm = await channel.seal(CONFIRM);
  return { frame: jsonFrame(FRAME_REPLY, { v: 1, e: b64u(e.pub), c: b64u(confirm) }), channel };
}

/** The phone checks the daemon's reply (the confirmation proves the daemon holds the PSK) and gets its channel. */
export async function phoneFinish(state: { kid: string; priv: CryptoKey; pub: Uint8Array }, frame: Uint8Array, psk: CryptoKey): Promise<Channel> {
  const v = parseFrame(FRAME_REPLY, frame);
  if (v.v !== 1 || typeof v.e !== "string" || typeof v.c !== "string") throw new ProtocolError("bad reply");
  const eDaemon = unb64u(v.e);
  const daemonPub = await importPub(eDaemon);
  const dh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: daemonPub }, state.priv, 256));
  const keys = await sessionKeys(psk, dh, await transcript(state.kid, state.pub, eDaemon));
  const channel = new Channel(keys.p2d, keys.d2p);
  let confirmed: Uint8Array;
  try {
    confirmed = await channel.open(unb64u(v.c));
  } catch {
    throw new ProtocolError("the other side does not hold the key (wrong or expired pairing, or a tampered link)");
  }
  if (confirmed.byteLength !== CONFIRM.byteLength || !confirmed.every((b, i) => b === CONFIRM[i])) throw new ProtocolError("bad confirmation");
  return channel;
}

export function encodeJson(v: unknown): Uint8Array { return utf8.encode(JSON.stringify(v)); }

export function decodeJson(b: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
  } catch {
    throw new ProtocolError("bad message");
  }
}
