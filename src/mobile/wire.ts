// Walkie mobile link: what travels where (WALKIE-PWA-1). Shared by the relay, the daemon and the phone app.
//
// Relay (relay/server.ts): a daemon connects to /v1/daemon?v=<RELAY_PROTOCOL>, waits for the relay's `hello {v}`, and
// claims rooms with keys (room id = roomOf(key), so only the key holder can claim one); a phone connects to
// /v1/phone?room=<id>. Control messages are JSON text; data is binary, prefixed between relay and daemon with the
// phone's slot (1 byte) and that slot's generation (4 bytes, big-endian), unprefixed between relay and phone. The relay
// never sees a key of the end-to-end channel (src/mobile/crypto.ts): the data frames are opaque to it. The relay and
// the daemon must speak the same RELAY_PROTOCOL: ship them together.

/** The daemon ↔ relay protocol version (2: slot generations, echo pings, hello). */
export const RELAY_PROTOCOL = 2;
/** Bytes before a data frame between relay and daemon: slot (1) + generation (4). */
export const SLOT_HEADER = 5;

/** Largest data frame a side may send (the relay closes the sender with 1009 above it). */
export const MAX_FRAME = 1 << 20;
/** Phones connected to one room at a time. */
export const MAX_PHONES_PER_ROOM = 4;
/** Rooms one daemon connection may hold (one per paired device, at most 8, plus open pairings, at most 3). */
export const MAX_ROOMS_PER_DAEMON = 16;
/** Phones one daemon connection may have at once; the relay assigns slots 0 .. MAX_SLOTS - 1 and nothing else. */
export const MAX_SLOTS = 64;
/** Largest relay control message (JSON text) either side accepts. */
export const MAX_CONTROL = 1_024;

/** WebSocket close codes the relay and the daemon use. */
export const CLOSE = {
  /** No daemon holds the room (the Mac is off, asleep or not linked). */
  daemonOffline: 4404,
  /** The daemon left or gave the room up. */
  daemonLeft: 4410,
  /** Rate, size, connection or room limits. */
  limit: 4429,
  /** The daemon ended this phone's connection (revoked, bad handshake, protocol error). */
  kicked: 4403,
  /** Another connection of the same daemon took the room over. */
  roomTaken: 4409,
  /** A malformed frame or control message. */
  bad: 4400,
  /** Phone side only: no authenticated frame for too long (never sent on the wire). */
  stale: 4408,
} as const;

export type DaemonCtl =
  | { t: "open"; key: string }
  /** Echo request: the relay answers `pong` with the same `n` once it has read everything sent before it. */
  | { t: "ping"; n: string }
  | { t: "close"; room: string }
  /** Ends the phone in `slot` only if it is still generation `gen` (a phone that got the slot since is untouched). */
  | { t: "kick"; slot: number; gen: number };

export type RelayCtl =
  /** The relay's first message: the protocol it speaks. */
  | { t: "hello"; v: number }
  | { t: "opened"; room: string }
  | { t: "closed"; room: string; reason: string }
  | { t: "join"; room: string; slot: number; gen: number }
  | { t: "leave"; slot: number; gen: number }
  | { t: "pong"; n: string }
  | { t: "error"; message: string; room?: string };

// ---- inside the encrypted channel ------------------------------------------------------------------------------------

export type PhoneMsg =
  /** Pairing session: who is on the other end (shown to the person before they confirm). */
  | { op: "info" }
  /** Pairing session, after the person confirmed: become a device. */
  | { op: "register"; name: string }
  | { op: "req"; id: number; method: "GET" | "POST"; path: string; body?: unknown }
  /** The live stream (GET /v1/stream), delivered as `event` messages until `cancel` or the link ends. */
  | { op: "stream"; id: number; path: string }
  | { op: "cancel"; id: number }
  /** Sent right after the handshake: proves the phone holds the key (the daemon's deadline), and does nothing else. */
  | { op: "ping" }
  /** The phone forgets itself: the daemon revokes this device. */
  | { op: "unpair" };

/** Who a phone is pairing with: the team, the person and their computer. */
export interface PairInfo { readonly team: { id: string; name: string }; readonly handle: string; readonly host: string }

export type DaemonMsg =
  | ({ op: "info" } & PairInfo)
  | ({ op: "registered"; device: { id: string; name: string }; room: string; key: string; expires_at: number } & PairInfo)
  | { op: "res"; id: number; status: number; body: unknown }
  | { op: "event"; id: number; type: string; data: unknown }
  | { op: "end"; id: number; status?: number; body?: unknown }
  | { op: "revoked" }
  /** Authenticated heartbeat on an idle link: the phone treats silence as a stale link. */
  | { op: "ping"; ts: number };

/** Request ids are small positive integers chosen by the phone. */
export const MAX_REQUEST_ID = 2 ** 31;
