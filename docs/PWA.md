# Walkie on your phone (WALKIE-PWA-1, ALE-5293)

A phone gets Mission Control for its owner's computer: who is working on which machine, the asks waiting for the
person (answer or decline), and channel posts with a reply box. Nothing is installed on the phone but a web app, and
nothing on the computer listens for it: the phone and the daemon meet at a relay that forwards end-to-end encrypted
frames it can't read.

```
phone (PWA, getwalkie.vercel.app/m)  ──wss──▶  walkie-relay (Fly)  ◀──wss──  daemon (the owner's computer)
          └──────────── end-to-end: P-256 ECDH + PSK handshake, AES-256-GCM ───────────┘
```

Design decisions (Alex, 2026-09-26): no Tailscale on the phone, no dashboard listener exposed anywhere; a static app on
the Walkie site, a stateless relay, a QR code with a one-time secret, a long-lived device key.

## Pairing

1. `walkie mobile pair` (or Team → Devices → **Pair a phone**) mints a pairing: a relay room claimed with a random
   **claim key only the daemon holds** (never in the code), and a 128-bit secret; 10 minutes, one use, at most 3 open (a
   newer one retires the oldest, and every retired, expired or voided pairing gives its relay room up; so does a
   consumed one, whether its registration succeeded or failed, and one the relay drops, which withdraws the code and
   says so in `walkie mobile` and Team → Devices). The code is
   `<room>.<secret>`; the QR carries `https://getwalkie.vercel.app/m#pair=<room>.<secret>`, and it is shown only once
   the relay has confirmed the room (else "relay unavailable"). The code is in the **fragment**, which no browser sends
   to any server, the site included; the app removes it from the address bar on load.
2. The daemon connects to the relay (only now) and claims the room; the phone joins that room and derives the
   handshake PSK from the secret (HKDF-SHA-256, `src/mobile/crypto.ts` `pairingKeys`). Holding a code lets a phone
   join the room, never claim it, and the relay never hands a held room to a second claimant, so nobody with the code
   can stand in for the computer.
3. Handshake (below) with the pairing PSK. The phone asks `info` and shows the person who is on the other end ("Pair
   with <team> as @handle on <computer>?"); a link someone else made would name their team. Only on **Pair** (or
   **Switch**, when the phone is already paired: an existing pairing is never replaced silently) does it send
   `register {name}`; the daemon consumes the pairing, creates a device with a fresh 256-bit **device key**, waits
   until the relay confirms the device's own room, and answers with the device id, that room id and the key. The
   pairing room is released.
4. The phone imports the device key as a **non-extractable** `CryptoKey` (HKDF) and keeps it in IndexedDB; script can
   use it but never read it back. It reconnects to its own room with key id `d:<device id>`. Every device has its own
   room (its relay key derived on the daemon from a secret that never leaves it), which admits only that device and
   is given up when the device is signed out: a signed-out phone knows no room that is still held, and one phone
   can't take another's slots.

**iPhone.** A Home Screen web app has its own storage, separate from Safari's, so a pairing made in Safari would not
be in the installed app. When the QR code opens in Safari (not standalone), the app shows the steps: copy the code,
Share → Add to Home Screen, open Walkie there and paste the code. "Use Walkie in Safari instead" pairs right there.
Android shares storage between Chrome and the installed app: pairing happens at once, and an Install banner follows.

A pairing link that ends without registering counts as a failed attempt (with a wrong secret only the phone can
tell); five void the pairing (this is abuse control, not a guessing defence: the 128-bit secret is that). A link
must send a valid encrypted frame within 10 s of joining (the phone sends one right after the handshake) and a
pairing link must register within 2 minutes.

## Handshake and channel (`src/mobile/crypto.ts`)

A custom protocol shaped like Noise NNpsk0 (not an implementation of Noise), WebCrypto only (the same code runs in the
daemon, the phone and the tests). Authentication proves possession of the shared secret; there is no separate daemon
identity, so whoever holds a device key can also answer as the computer to that phone (no key-compromise
impersonation resistance):

- phone → `hello {v:1, kid, e}`: `kid` is `pair` (pairing room) or `d:<device id>`; `e` an ephemeral P-256 key.
- daemon → `reply {v:1, e, c}`: its ephemeral key and `c`, the first AEAD frame (a fixed confirmation text).
- `th = SHA-256(len‖"walkie-mobile-v1" ‖ len‖kid ‖ len‖e_phone ‖ len‖e_daemon)`;
  `s1 = HKDF(ikm = PSK, salt = th, info = "… psk")`; `okm = HKDF(ikm = ECDH(e_phone, e_daemon), salt = s1, info = "… keys", 64 bytes)`;
  phone→daemon and daemon→phone AES-256-GCM keys are the two halves.
- The phone checks `c` before it sends anything: a relay (or anyone) without the PSK can't produce it. The daemon
  learns the phone holds the PSK from its first frame decrypting.
- Frames: `0x03 ‖ counter(u64) ‖ AES-GCM(key_dir, nonce = counter, aad = header)`. A receiver accepts exactly the
  next counter: a replayed, dropped, reordered or altered frame ends the session (the daemon kicks the slot).
- Fresh ephemeral keys per connection: forward secrecy for past sessions if a device key later leaks.
- P-256, not X25519: WebCrypto X25519 needs iOS 17 / Chrome 133; P-256 ECDH works in every current browser.

## What the phone may do (`src/daemon/mobile/tunnel.ts`)

Inside the channel the phone sends `ping` (once, to prove the key), `req {id, method, path, body}`, `stream {id,
path}`, `cancel {id}`, `unpair`; pairing links `info` and `register`. The daemon sends answers, stream `event`s, `end`,
`revoked` and an authenticated `ping` every 15 s (the phone closes a link silent for 45 s as stale, and a request with
no answer in 20 s resolves as 504). The daemon runs each request through the local API as that device, **a person,
never an agent**, only if it is on the allow-list:

| Allowed | |
|---|---|
| `GET /v1/me`, `/v1/team`, `/v1/agents`, `/v1/peers`, `/v1/events` (≤ 100), `/v1/events/<EventId>`, `/v1/asks` | Mission Control reads |
| `POST /v1/post` (existing channels; `channel`, `text`, `thread` only), `/v1/answer` (`ask`, `text`, `declined`) | reply and answer |
| the live stream (`/v1/stream`) | only `hello`, `event`, `agents`, `nodes`, `hidden` messages (never `accounts`) |

Every answer is **projected for the phone** (`src/daemon/mobile/projection.ts`, built from allowed fields): events of
kind `msg.post`, `ask` and `answer` only (no roster, license or status events, no signatures); `me` without the plan
or Tailscale login; `team` without the plan, logins, addresses or authority; `peers` without addresses or sync
internals. Live `event` messages go through the same filter; roster changes (`team.*`, `channel.upsert`) become a
bare `refresh {what: "team" | "channels"}` notice, and the app also reloads its views every 5 minutes.

Everything else answers 403: tokens and auth, accounts, license, integrations, Linear, artifacts, roster changes
(invite, member, authority, admit, channels), asks from the phone, agent status, diagnostics, `/v1/mobile` itself.
Paths must be `/v1/…` on the local API (no other host, no traversal). Per device, shared by all its connections: 20
requests or stream opens per second (bursts of 60), 8 in flight, 2 streams, 1 MiB/s of responses (bursts of 4 MiB),
responses capped at 256 KB of projected, encoded JSON (post, ask and answer text is cut to 4 000 characters for the
phone with "… (open on your computer for the rest)", so lists fit; the app asks again for fewer posts on 413, 40 → 20 →
10 → 5 → 2 → 1; open asks are asked for bounded (texts cut just past 4 000 characters and the list cut at 1 MiB by the local API, so the raw
answer is small whatever the asks hold; the phone's own cut then marks them: a body's own `truncated` field is never passed on), then fitted to 256 KiB by their encoded size and marked `truncated`, never a
413 (tested with 360 asks of 32 000 CJK characters); the app keeps posts per
channel, drops a slower, older load, and never replaces a view with an empty one on an error), requests at 64 KB of encoded bytes, and a write bucket of its own (60/min, not the
desktop person's).

**Against a hostile relay** the daemon charges every inbound WebSocket frame (not just every message: continuation
and control frames too) to one budget per connection (400/s, bursts of 1 000; 4 MiB/s, bursts of 8 MiB) the moment its
header arrives, before any of its payload is kept; checks every control's shape and state (slot
in 0–63 not already joined; `join`, `opened`, `closed`, `error` and `pong` only about rooms and pings it knows);
rate-limits joins (4/s, bursts of 32 per link) and handshakes (per room 1/s, bursts of 10, then 10/s, bursts of 60
across all); caps phones per room (4) and in all (64); checks each frame's size before copying it (1 KiB until the
handshake is done, 1 MiB after); and turns one room's excess into that room's problem: past 1.5 joins/s (bursts of 8)
or 1 MiB/s (bursts of 3 MiB) a room's phone is turned away or dropped, never the whole link. The honest relay keeps
what it forwards to a daemon below all of these, in total and per room (see the relay limits below), so it turns an
abusive room's phones away first.

**Transport.** The daemon talks to the relay through its own WebSocket client on `Bun.connect`
(`src/daemon/mobile/relay-socket.ts`), because Bun's built-in client answers native pings, reassembles fragmented
messages and buffers sends where the application can't see or bound them (and reports no backpressure:
`bufferedAmount` stays 0, measured). Every outbound frame (data, controls, pongs) goes through one queue of bytes the
kernel hasn't taken yet, capped; frames wait in lanes (one per room, one for controls) drained round-robin, so one
room's backlog doesn't hold back another room's next message. Inbound bytes are kept as the chunks they arrived in (never re-copied) and parsed as
they arrive: a message whose declared size (or a fragmented message whose total) is over the limit ends the connection
before its payload is kept; a message may have at most 64 fragments and no empty non-final one, and its fragments are
copied straight into one buffer that starts at the first fragment's declared length and grows from the running size (never a list of tiny slices); one frame must arrive
within 30 s and a fragmented message within 60 s (a slow drip is closed). Native pings are rate-limited (1/s, bursts
of 10) and answered through the same queue; unsolicited pongs are ignored (they still pay the frame budget, not the
ping allowance). RFC 6455 is enforced: unmasked frames, clear reserved bits, known opcodes only, minimal length
encodings, small unfragmented controls, and a Close frame's code (registered, including 1001 and 1012–1014, or private
use: an ordinary end) and UTF-8 reason checked; our own Close reasons are cut to 123 UTF-8 bytes. A `101` upgrade answer
must carry `Upgrade: websocket`, `Connection: upgrade` and the right `Sec-WebSocket-Accept`, and name no extension or
subprotocol (none is requested), or it is a violation; any other status (a proxy's 502, a 503 while the relay
restarts) is an ordinary failed attempt, retried with the usual backoff. Connecting, TLS and the upgrade answer must all finish within 15 s, then `hello`
within 5 s; a stuck attempt ends and the next is scheduled with the usual backoff. Over `wss://` the certificate chain
*and* the host name are checked in the TLS handshake before the upgrade is sent (Bun.connect reports chain errors
only to that callback and doesn't check names at all; an IPv6 relay's bracketed URL host is checked as the bare
address). A transport violation (framing, sizes, the frame budget, a slow frame) counts as a relay violation, with the
same reconnect penalty. Tested on the shipped runtime: a peer that stops reading and keeps pinging, an oversized
unfinished message, a fragmented one, `02 00` then a million empty continuations (closed at once, memory flat, timers
on time), 1 MiB in 1-byte fragments, a per-frame budget, reserved opcodes, non-minimal lengths, bad Close frames, bad
upgrade answers, a silent and a trickled upgrade (TCP and TLS), a dripped frame and a half-sent header, a masked frame,
TLS with a trusted, an untrusted and a wrongly named certificate, and TLS to `[::1]`.

**Outbound**, the relay must also echo `ping {n}` (every 256 KiB, after a phone message whenever no ping is in flight
(at most every 100 ms), and whenever data waits): TCP is ordered, so an echo proves it read every byte written before
that ping. A ping's position is where the kernel took it (write order, since lanes reorder), and each room's bytes are
released exactly up to the acknowledged position. Past the unacknowledged window W (8 MiB, or N + 1 full frames plus
64 KiB with N rooms with phones when that is more) a send is **refused** before anything is sealed (the phone gets a 429
or its stream a `resync`, and the link lives: an honest relay on a slow uplink is just slow; tested at 2 and 1 Mbit/s and
10 KiB/s, 262 KiB replies through a 16 or 48 KiB send buffer, and 1 to 8 rooms sending at once through a 128 KiB send
buffer); only a real stall ends the link: data outstanding and **no acknowledgement progress** for max(20 s,
outstanding ÷ 2 KiB/s). The rule is deliberately lenient: an honest phone on a bad link must never be cut off, and our
own relay is the only relay (two stricter rules, rounds 8 and 9, each cut honest slow links and were withdrawn). What
that costs, plainly: **a hostile relay can hold up to the window for a long time** (acknowledging a little now and then
resets the clock); **memory stays bounded** by the hard ceiling below; **detection of a black-holed relay may take
minutes** (a full 8 MiB backlog: ~68 min). 2 KiB/s is only the size of that allowance, not a
rate the relay is held to. **Decision (round 10):** the allowance is 2 KiB/s, not round 7's 8 KiB/s, because honest
phones on bad links must never be cut off and our own relay is the only relay: at 8 KiB/s, honest links at 8.2 and
8.5 KiB/s were still cut off during a single 256 KiB reply; at 2 KiB/s they drain (and so does a 4 KiB/s link). A room (a device, or a pairing) may have at most its share of the
window, (W − 1 MiB − 64 KiB) / N for N rooms with phones and never less than one full frame, its first message
included (small messages, errors and stream ends, may pass it by 16 KiB); rooms with data outstanding together stay
out of the last 1 MiB + 64 KiB, which only a room with nothing outstanding may use. What rooms hold above their share
now (sent while fewer rooms had phones, or by a room whose phone left) is added on top of W, up to 8 MiB more, so it
never eats the others' shares: an idle room can always send one full frame or a 256 KiB reply (tested with 1 to 32
rooms, reply-sized and full-frame first messages, and phones joining after one room filled a large share), one heavy
reader can't queue far ahead of the others, and only its own sends are refused. A reserved send, a control (kick,
close, claim) and a small unreserved message (a handshake reply, `revoked`) are held only to the hard ceiling or to
what is outstanding, whichever is more, plus 64 KiB, so rooms leaving and the window shrinking don't make them fail
(tested with 14 rooms, 12 leaving; if the transport itself is full, a send still fails and that phone's link ends). The rooms are the daemon's own (a relay can't add one): 8
devices and 3 open pairings give W ≈ 12 MiB; a used pairing keeps its room for the moment its phone registers, so a
person minting and using codes quickly can briefly hold a few more (14 rooms: ~15 MiB). The hard ceiling (W + 8 MiB,
also the transport's queue cap) is ~20 MiB for 11 rooms and never more than the 64 slots allow (~73 MiB). These are
payload bytes: each queued frame also costs its WebSocket header and a small object (and each room switch a ledger
entry), so a queue of the smallest frames (~200-byte stream events) can take up to about twice its byte count in
memory. A kick, and a room's close, go in that room's lane
after its queued data, so a signed-out phone reads `revoked` before it is kicked. A data message holds its room in the window (and in its share) *before* it is sealed,
and sends with that reservation, so concurrent writers can't both pass one check and none finds the window full
after sealing. **Liveness**: a link that heard nothing from the relay for 30 s is pinged; no answer within 20 s ends
it as a dead path (a plain reconnect, no penalty; with phone data outstanding it is a stall, a violation). At most 32
messages per phone link may be mid-encryption (plus 8 for errors and stream ends; a
heartbeat is skipped while anything is pending), and the encoded size of every answer and stream message is charged to
the device's byte budget. The relay's refusals are counted and logged as one summary line a minute at most, across
disconnects too. Any violation drops the relay link and waits at least ~30 s before reconnecting; the reconnect backoff
is reset only after a link has stayed up for a minute, so a relay that accepts and drops the link again and again is
retried ever more slowly (1, 2, 4 … 60 s).

**Slots carry a generation.** The relay numbers every phone that takes a slot; `join`, `leave` and `kick` name the
generation, and data frames between relay and daemon carry it after the slot byte. A kick or a frame meant for a
phone that has left is dropped by the relay (tested), so it can never end or reach the phone that got the slot next.
The daemon's session callbacks are bound to their connection too. The phone applies the same intake limits (text
frames close the link; 1 KiB during the handshake, 1 MiB after; at most 256 frames or 4 MiB waiting to be decrypted),
and an open settles only once its first encrypted ping is out.

**Versions.** The daemon connects to `/v1/daemon?v=2` and the relay's first message is `hello {v: 2}`. A relay of
another protocol refuses with HTTP 426 (and `X-Walkie-Relay-Protocol`); a relay that says an older version, or says
nothing within 5 s, is reported as "the relay is older than this Walkie" (in `walkie mobile` and Team → Devices) and
tried again only every minute or so. **The relay and the daemon ship together**: deploy the relay from the same
release as the daemons that use it.

## Devices

`~/.walkie/mobile/devices.json` (0600 in a 0700 directory): id, name, key, times. A device ends 30 days after its last
use and 90 days after pairing at the latest; at most 8 per machine (pairing a ninth drops the least recently used).
`walkie mobile devices`, `walkie mobile revoke <id> | --all`, Team → Devices → Sign out, and the phone's own
Settings → Unpair all revoke. Every way a device leaves (revoke, expiry, eviction) goes through one path: its open
links stop at once (streams and requests abort), are told over the encrypted channel (the phone forgets its key only
on that message, never on a close code, which a relay or a timeout can also produce), and its relay room is given up.
Removing the member, or revoking this machine, signs out every phone paired to it. `devices.json` and `state.json` are
remote credentials for anything running as your OS user (SECURITY threat 14).

## The relay (`src/relay/server.ts`, `relay/`)

Bun WebSocket server, nothing stored, nothing logged about frames, rooms or addresses.

- `WS /v1/daemon`: a daemon claims rooms with `{t:"open", key}`; the room id is `roomOf(key)`, so only the key holder
  can claim it, and a held room is never handed to a second claimant (`error {room}` "room held"; it frees when the
  holder's socket closes, and a restarted daemon claims again with backoff until then). Up to 16 rooms per connection
  (one per paired
  device, at most 8, plus open pairings, at most 3); `opened` confirms a claim, `error {room}` refuses it. Room
  operations of a connection run one at a time, and a claim whose socket closed while hashing claims nothing.
- `WS /v1/phone?room=<22 chars>`: joins a room a daemon holds (else closed `4404`, "your computer is offline").
  Frames are forwarded with a slot byte to the daemon and without it to the phone.
- Limits: 16 sockets and 20 new connections (+1/s) per client address (IPv6 by its /64; connect buckets LRU-capped
  at 10 000); per phone socket 50 messages/s (bursts of 200) and 2 MiB/s, per computer socket 16 times that; 1 MiB
  frames; 4 phones per room and 64 per computer connection (slots 0–63); 5 000 sockets; a reader 4 MiB behind is
  closed; when a computer's socket backs up, the room that sent the most lately loses its phones first (another
  room's phone stays). What it forwards to one computer stays below the daemon's own budgets: in all 3 joins/s (bursts of 24),
  300 messages/s (600) and 3 MiB/s (6 MiB); per room 1 join/s (6), 60 messages/s (150) and 768 KiB/s (2 MiB). A
  phone past its room's or its computer's share, or sending while the computer's socket is 2 MiB behind, is closed
  (4429): the computer's connection never is. It echoes the daemon's `ping` with `pong`. Client address = `Fly-Client-IP` only when `RELAY_TRUST_FLY=1` (set on Fly, whose proxy writes it), else
  the socket peer.
- What the relay sees: room ids (stable per device), the device id in each handshake, which phones share a
  computer's connection, IP addresses, frame sizes and timing (no padding). Not the application data.
- The daemon connects only while a phone is paired or a pairing is open, and reconnects with backoff (1 s → 60 s).

## 13 layers

| # | Layer | Verdict |
|---|---|---|
| 1 | Front end | **Covered**: `site/m.html` + `src/mobile/pwa` (vanilla TS, textContent only), `site/m/app.css` with the product tokens, dark/light, 390 px, safe areas, 44 px targets, focus rings, `aria-live` notices; installable (manifest, 192/512 + maskable icons, apple-touch-icon) |
| 2 | APIs / backend | **Covered**: the daemon's existing local API behind the tunnel allow-list; `/v1/mobile` (status, pair, revoke) for people only; zod-validated device file; every phone message shape-checked |
| 3 | Storage | **Covered**: `~/.walkie/mobile/{state,devices}.json` (0600); phone: IndexedDB (non-extractable key). Relay: none |
| 4 | Auth | **Covered**: pairing secret (QR fragment, 10 min, single use) → device key (PSK); mutual authentication in every handshake; 30 d idle / 90 d max; revocation |
| 5 | Hosting | **Covered**: app = static files on the Vercel site (`/m`, `/m/*`, `/m-sw.js`); relay = Fly app `walkie-relay` (`relay/fly.toml`, `relay/Dockerfile`), deployed at `https://walkie-relay.fly.dev` with v0.2.0-pre.3 |
| 6 | Compute | **Inherited/Covered**: one Fly shared-cpu-1x machine (512 MB), always on; the daemon's work stays on the owner's computer |
| 7 | CI/CD | **Covered**: unit + integration + web tests in `bun test`; `bun run m:build` regenerates `site/m/app.js` (committed, like `index.html`); rollback = redeploy the previous site / `fly deploy --image` of the previous release |
| 8 | Security | **Covered**: end-to-end encryption, allow-list plus phone projections, no plaintext at the relay (tested), hostile-relay budgets on the daemon (tested), pairing confirmation, strict CSP on `/m` (`connect-src 'self' wss://walkie-relay.fly.dev`, no inline script), no cookies, the secret never in a URL a server sees. Residual: the site's origin is trusted and its compromise needs revocation on the computers plus the service-worker kill switch and the reset page (docs/SECURITY.md threat 14) |
| 9 | Rate limiting | **Covered**: relay per address (IPv6 /64), per socket (computer sockets scaled), per room; daemon per device (requests, bytes, writes, in-flight, streams, its share of the relay window), per relay frame (count and bytes, as headers arrive), joins and handshakes, pairing failure limit; `Fly-Client-IP` honoured only behind Fly's proxy |
| 10 | Caching / CDN | **Inherited**: Vercel CDN for the static app (`no-cache` revalidation on `/m*`); the service worker caches the shell only, network first, versioned (`VERSION`), with a kill switch (`KILL`) and `/m/reset` (a "Reset this phone" button; nothing is cleared on load) for recovery |
| 11 | Scaling | **Covered for one machine** (5 000 sockets). Rooms are in memory, so a daemon and its phone must reach the same instance: more machines need room affinity (e.g. `fly-replay` to a machine chosen by hashing the room id) before scaling out |
| 12 | Errors / logs | **Covered**: daemon logs `mobile_*` events (pairing opened, paired, revoked, link up/down, refused with the stage, never keys or payloads); relay logs only startup; Fly health check `/healthz`. No Sentry (none in the stack) |
| 13 | Availability | **Covered**: relay down = phones show "your computer is offline or unreachable" and retry; nothing else in Walkie depends on it (peers, dashboard, agents unaffected). The daemon re-links with backoff (a connect, TLS or upgrade stuck past 15 s is abandoned and retried; a silent link is pinged every 30 s and a dead path noticed within 20 s more); a daemon restart keeps devices (persisted). The app shows how fresh its data is ("live" only while the stream runs on a heartbeat-proven link), says when live updates stop and resubscribes with backoff. SLO target for the relay: best effort, one region |

## Later (not in phase 1)

- Push notifications for asks (Web Push on iOS 16.4+ Home Screen apps) through the relay, still end-to-end.
- Artifacts on the phone (downloads through the tunnel in chunks), threads, starting an ask.
- Several relay machines with room affinity; a relay per region.
- Pairing without a camera or copy/paste (a short code needs a PAKE such as CPace: a low-entropy PSK in NNpsk0 is
  open to offline guessing by the relay).
- A dedicated origin for the app (no landing page or billing functions sharing it), and an app bundle verified
  independently of the serving origin (the site's code is otherwise trusted; see SECURITY threat 14).
- A daemon identity key the phone pins at pairing (key-compromise impersonation resistance), and padding to hide
  sizes from the relay.
