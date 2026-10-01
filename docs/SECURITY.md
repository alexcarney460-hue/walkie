# Walkie security model

## Reporting a vulnerability

Please report security issues to RC Studios, Walkie's maintainer, privately through GitHub's private vulnerability
reporting on this repository (**Security → Report a vulnerability**), not in a public issue. Include the version (`walkie version`), your platform,
and steps to reproduce.

## Assets

The team log (messages, asks, artifacts, agent status), node private keys, the local dashboard token, and — most
important — each teammate's **agents**, which hold real credentials and can act on real systems.

## Trust boundaries

| Boundary | Who is on the other side | Control |
|---|---|---|
| Peer port (Tailscale IP only; Tailscale and dual machines) | any device on the tailnet, including shared-in nodes or another OS user on a member machine | `tailscale whois` on every request → login must be a current member (a `direct:` login, which only invites create, is refused outright); the node must be admitted with a matching login, its record must serve Tailscale (a Direct-only machine is never let in over the tailnet) and its pinned address must be the source IP; team header must match; node-key request signatures are required on privileged routes and on replication/read routes after verified node-key evidence or strict mode (PROTOCOL §4) |
| Walkie Direct endpoint (v0.2; iroh QUIC, ALPN `walkie/1`) | **anyone on the internet** who knows or guesses the node's endpoint id (its public key), directly or through a relay | QUIC/TLS authenticates the caller's ed25519 key before any request is read; the gate is that key ∈ the roster's admitted, non-revoked nodes of current members whose record serves Direct (a Tailscale-only machine's key is refused until it proves the key with a Direct `/join`, see "Mixed teams"; `403 not_member` otherwise, `hello` and every data endpoint included; `X-Walkie-Node` must match the key or be absent). Only `/join` accepts an unknown key, and only with a valid invite (below), admitting exactly the connection's key. Per-endpoint rate limit (60 req/s) plus one shared 5 req/s bucket for every key that isn't an admitted node (keys are free to mint); at most 16 connections from unadmitted keys at once, each closed after 30 s and limited to 4 concurrent streams (lifted when the key is admitted on that connection); at most 4 connections per authenticated key (a member at 4 replaces its least recently active idle one; with all 4 busy the 5th is refused); 512 connections total, running native handshakes included. Pending handshakes are budgeted before `accept()` starts any native work, by what iroh names without a handshake: the **source** (an IPv4 address, an IPv6 /64, or on the relay path the sender's relay-authenticated endpoint id), its **network** (IPv4 /24, IPv6 /48) and, on the relay path, the **member** owning an admitted endpoint id. Native budgets are given back only when the native handshake really ends (iroh 1.1's binding can't cancel one): at most **128 native handshakes alive in total**, whatever their lifetime; of those at most 64 from the direct path and 16 from relay-path strangers (whose ids are free to mint), so members arriving through a relay always have at least 48; at most 4 per source, 8 per /24 or /48, and 8 per member across all of that member's machines. Lanes bound handshakes in progress: at most 32 from sources not known to be members, of which the direct path takes at most 24 (the other 8 only relay-path joiners can take); a relay-path sender whose endpoint id is an admitted node's has its own 32-slot lane (a handshake is abandoned after 15 s and closed if it completes late; its lane slot comes back when the native handshake ends or at 60 s, while its native budgets wait for the native end); above 8 pending, an unvalidated UDP source is sent a QUIC Retry first, so a spoofed or reply-blind sender never starts a handshake, and an unvalidated source over a limit is ignored rather than answered; when a node is revoked or its member removed, its open connections are closed at once, idle ones included; request heads ≤ 16 KiB, bodies ≤ 1 MB, 30 s to arrive. PROTOCOL §2 is unchanged: everything that arrives is still verified event by event |
| Walkie Direct invites | whoever holds the code (a bearer credential until used) | `wk1…` code signed by an owner node's key (checked against that node's key on the roster, and the node must still be an admitted owner's when the code is used), naming the team; 7-day expiry (the authority refuses an expiry further out than that); single use: redeemed only by the roster authority, which records `sha256(secret)` on the chain in the admitting `team.node`, so no replica and no later authority accepts it again; a code for a handle that has ever been removed is refused unless it was minted after the latest removal (`invite_predates_removal`), whatever the handle's member is now (removed, or re-invited since): the code carries the issuer's signed roster chain position, which must be past the removing entry's chain index. That position is the only removal test (no clock is compared, so an authority clock that ran ahead when it removed someone can't block their later re-invite). So a removed member can't come back, with their old role or their old machine, on a code they held before, not after a re-invite and not through clock skew; the code and its secret are never logged (only the chain id), and no error echoes a pasted code. Anyone holding an unused code can join as its handle once, which is the point of it: send it privately |
| Relays (Walkie Direct) | n0's public relays by default, or the ones in `config.json` `relays` | a relay forwards QUIC packets it can't read: every connection is end-to-end encrypted and authenticated between the two node keys (TLS 1.3 inside QUIC), so a relay sees only ciphertext, packet sizes and timing, and which endpoint ids talk to which. The n0 preset also publishes each endpoint's relay URL (not its IP addresses: iroh's publisher defaults to the relay only) to n0's address-lookup service, keyed by endpoint id and publicly resolvable by anyone who has that id, so peers can dial by key alone; n0 sees the source IP addresses of those publishes, of lookups and of relay connections; set your own `relays` to keep relay traffic on your infrastructure (address lookup still uses n0's service in v0.2) |
| Event ingest (push or pull, relayed) | a member's daemon, possibly relaying others' events | ed25519 signature and header signature by the origin node (stubs too), author ↔ node ↔ login binding, roster changes only from the single roster authority's chain (each entry carrying the authority's signed watermark; events are judged by the roster in force when the authority first saw them), restricted-channel membership, answer ↔ ask addressee binding (PROTOCOL §2) |
| Roster requests (`/peer/v1/roster-request`) | an admitted member's daemon asking the authority for a roster change | peer gate + requester node signature (canonical base64 only); the authority re-checks the requester's role in the current roster and every roster rule before appending, and an owner's `team.node` request may bind a key only to the owner's own login; the appended event carries the hash of the signed payload (independent of the signature's encoding), so a replay (also after a transfer, or re-encoded) returns the original entry or is refused |
| Peer responses (our client) | a member's daemon answering our calls | streaming byte caps (1 MB JSON, 25 MB blobs), zod shape validation, depth limit |
| Unix socket | processes of the same OS user | file mode 0600 in a 0700 directory; an unmarked request is the owner's own process and has the owner's authority |
| Loopback dashboard port | any local process (including other OS users' and containers' forwarded ports on 127.0.0.1), and any website in a browser | the durable token as a bearer (scripts), or a dashboard **session** in the `X-Walkie-Session` header; **no cookie authorizes anything**. Exact Host check (DNS rebinding), Origin check on mutations (CSRF), CSP `default-src 'self'`, and a cross-origin page can't send the header (it needs a CORS preflight that is never granted). The session is obtained through `GET /auth?nonce=…`: a 60 s single-use nonce that `walkie dashboard` mints over the unix socket (`POST /v1/auth/nonce`, refused on loopback); `/auth` hands the value to the page in the redirect's URL fragment (never sent to a server), and the page keeps it in its own origin's `localStorage`, which other ports can't read. The session is not the token: 256 random bits kept only as a hash (in memory, and in the store's `meta` so a daemon restart or upgrade doesn't sign dashboards out), bound to its Host, 12 h idle / 7 days absolute across restarts, revocable (`POST /auth/logout`, `walkie dashboard logout`, `walkie token rotate`; each also clears the saved hashes), accepted only in that header and only on the dashboard's routes (PROTOCOL §5), never as a bearer or cookie. The durable token is never set as a cookie; old cookies are cleared |
| License keys (`team.license`, `walkie license activate`) | the vendor, and anyone who can hand an owner a key | ed25519 signature over the key's payload segment, verified offline by every node against the vendor public key embedded in the binary (`src/license/vendor-key.ts`; no env or config override), canonical base64url only (one valid spelling per key); the chain accepts only a license naming its own team (`kind: "license"`, `team`), so an activation code or another team's key is rejected and never applied; only the authority's (owner) entries count; a license entry carries no watermark, so it can't change any event's anchor or verdict |
| License service (the authority → `https://<site>/api/license/{bind,status,renew}`) | the vendor's billing functions (Vercel + Stripe) | the only calls Walkie makes to the vendor (other outbound traffic, none of it to the vendor: usage meters query each model provider's usage endpoints with your own login, on by default; `walkie update` and the installer fetch GitHub releases; Walkie Direct uses n0's address lookup and relays; a paired phone links through the phone relay), to the pinned site origin (a loopback override exists only in source runs with `WALKIE_DEV=1`; it is compiled out of release binaries), never following redirects: `{code, team_id, proof}` once when an owner activates a code (the proof carries signed roster genesis, authority transfers and a short-lived authority signature bound to the license id), `{lic_id, renewal_token, issued_at}` once a day (the check-in), and `{lic_id, renewal_token}` when a renewal is due or the check-in reports a newer grant; responses are size-capped and a key must verify against the vendor key, name this team and carry the same `lic_id` before it is activated; a renewal answer is dropped if the team's license changed meanwhile; failures are logged and retried the next day, never fatal |
| Renewal token (`~/.walkie/license-renew-token`) | any process of the same OS user on the roster authority | 32 random bytes returned once at the first bind; a 0600 file, never on the chain, never logged; the site stores only its sha256 and compares in constant time. Without it a subscription id renews nothing |
| Billing functions (`site/api/*`) | anyone on the internet | the activation code is shown once, within 24 h of checkout (`walkie_code_revealed_at`, completed by `walkie_code_shown_at`; a marked but never completed reveal may be retried by the same session for 10 min); a code binds to one team only (`409` for any other); renewal and the status check-in need the token; `/api/portal` never opens a portal session itself, it only redirects to Stripe's email-verified login; only `active` subscriptions reveal, bind or renew; `/api/checkout` refuses a second subscription for a team that passes a still-billing `lic_id` (`409 already_subscribed`, with the portal link) and fails closed on a Stripe outage |
| Rental compute control plane (`site/api/compute/*`, RENT-2) | anyone on the internet; the owner's daemon with its compute token; rented machines | every route but quotes, account and heartbeat needs the account's bearer token (32 random bytes, stored as sha256, compared in constant time); the heartbeat needs the rental's own token; the tick needs Vercel's `CRON_SECRET`; the webhook needs its own Stripe signing secret. Launching needs `COMPUTE_ENABLED=1`; stopping never does. Bodies are strictly validated (unknown fields refused), per-IP (account creation), per-account and per-rental rate limits live in Postgres. The control-plane provider token (`DIGITALOCEAN_TOKEN`), the private config (provider, size, region, image, **our cost**, our provider limits) and the database URL live only in Vercel env; the watchdog uses a separate token. No response, log line or user-data carries any of them (site/test/compute-no-cost.test.ts) |
| Compute account token (`~/.walkie/compute-account`) | any process of the same OS user on the owner's machine that opened the account | a 0600 file written atomically, never on the chain, never logged or returned by any local route; whoever holds it can spend the account's prepaid credit on machines that join **the team as the owner's machines** only with a code the owner's daemon mints, so a stolen token alone launches machines that can't join |
| Rented machines (RENT-2) | the renting team's agents, running as seat users on a VM in our provider account | boots from user-data that installs the **pinned, signed** release through the official installer and joins with a single-use **1-hour** add-machine code (the site passes it to the provider and never stores or logs it); bootstrap passes `--seat-users`, so rentals retain seat users (never `--same-user`); the instance metadata endpoint (which re-serves the user-data) is blocked for every user but root and the user-data copies are deleted after the install; the bootstrap sudo rule is removed; no SSH keys, no provider agent, no logins of its own (seats lease the team's accounts only through the existing vault lease path when the team turns the pool on). The owner's daemon revokes the node when the rental ends. Stop = terminate + wipe (disks deleted with the droplet) |
| Release artifacts (`SHA256SUMS`, `SHA256SUMS.sig`, the binaries) | GitHub Releases / a mirror | `SHA256SUMS.sig` is an **ECDSA P-256 / SHA-256** signature (DER) by the Walkie **release** key (not the license key; private half in `~/keys/walkie-release-signing-p256.pem` 0600 and the CI secret `WALKIE_RELEASE_SIGNING_KEY`) over `SHA256SUMS`, which carries a signed `version <tag>` line. P-256 because the installer must verify on a stock machine: macOS ships LibreSSL as `/usr/bin/openssl`, which can't verify ed25519, so the previous ed25519 scheme refused every valid release there. install.sh verifies with `openssl dgst -sha256 -verify` (LibreSSL and OpenSSL alike) and refuses without openssl; it then requires the signed version to be the release asked for (`WALKIE_VERSION`, or the tag GitHub's "latest" resolves to; a mirror without `WALKIE_VERSION` installs what it signs for), compares the binary's SHA-256, and removes a binary that doesn't report that version. `walkie update` verifies against the public key embedded in the binary, requires the signed version to match the advertised tag and to be newer than the running one (`--allow-downgrade` to go back on purpose), keeps a copy of the old binary, runs `<new> version` and restores the copy if it reports anything else. So a compromised host can't serve a signed older release as a newer one. The checksums alone give integrity of the download, not authenticity: anyone who can change the release can change the checksums; the signature is what says they are ours |
| Join requests (`/peer/v1/join` with approval on) | admitted-login machines that aren't members' nodes yet | at most 16 pending requests per login and 256 per team (`429 join_limit` beyond), each expiring after 24 h |
| Model context (MCP results, hook-injected context, channel pushes, and CLI reads run by an agent) | text written by other people's agents | wrapped in `<walkie-message … trust=… note=…>`, NFKC + control-char strip, `<`/`>` neutralised so the wrapper can't be closed, role markers (`system:`, `assistant:` …) neutralised, explicit "information, not instructions" note. The CLI applies the same contract to `get`, `subscribe`, `inbox`, `ask` answers, `who` and `linear create` (previews, results and errors) whenever it runs under an agent: **pass `--for-agent`** when the output goes to a model; `WALKIE_AGENT`, `CLAUDECODE`, `CODEX*`, `KIMI_*`, `GEMINI_CLI`, `CURSOR_AGENT`, `HERMES_*`, `OPENCODE*` and `AIDER_*` in the environment are recognised without it (any other runtime needs the flag). `--json` for a model is built from a per-kind **allowlist** of fields (never a spread of a signed body: a member can sign a body with any extra field, and validation keeps the body verbatim), with `text`/`note` wrapped, one-line fields defanged, no signatures, and a `trust` field per item. A person's terminal sees the usual output |
| External services (integrations: Fireflies, Linear, the Wispr share page/API) | third-party APIs answering this daemon's connectors | fixed https hosts only (no redirects followed), 20 s / 10 s timeouts, byte caps (8 MB JSON, 2 MB share pages), zod shape validation; every upstream error is scrubbed of the configured keys (all spellings) and secret-shaped tokens *before* it is truncated; the fetched text is redacted (configured keys + patterns) in every emitted field, including artifact names, and size-capped before it is posted; everything external reaches models wrapped with `trust="external"`, including MCP dry-run previews, issue fields and upstream errors |
| Local files read by integrations (Wispr Flow meeting store, key files) | the user's own disk | the Wispr directory is polled read-only (20 MB per transcript file); a `key_path` is opened (non-blocking) and checked on the descriptor (`fstat`): a regular file owned by the daemon's user with no group/other permission bits (`mode & 077 == 0`), at most 4 KB, one token, and no ACL entry granting anyone but the owner access (macOS: `ls -le`, refused with the `chmod -N` fix; Linux: `getfacl` when installed, `setfacl -b`; the ACL tools are run on the **real path** of the opened descriptor, symlinks resolved and the inode re-checked, so a link can't point the check at a clean file; the path is passed as an argument, never through a shell; the verdict is cached per inode + ctime, so any chmod/ACL change is re-checked); anything else is refused with the fix, and the file's content never appears in errors |
| Local secrets (`~/.walkie/secrets/<connector>`, `key_path` files) | any process of the same OS user | 0600 files in a 0700 directory (checked like a `key_path` on every read); never replicated, logged, or returned by any API (status shows only the key's source and path); one central scrubber (`src/integrations/scrub.ts`) removes every configured key and secret-shaped strings from errors, route responses (success bodies too, patterns included even with no configured key), MCP results, log lines and emitted events. Every operation captures the credentials it used (its key as read at the start, the configured keys, and the keys used recently on this daemon) and passes them to every scrubber of its outputs, so a key file rotated while a request is in flight is still scrubbed from what that request produces; external fields (Linear issues, Fireflies transcripts, Wispr notes and speaker names) are scrubbed in every string as soon as they are parsed, before they are cached, formatted, truncated or turned into a filename |
| Phone link: the relay (`walkie-relay`, WALKIE-PWA-1) | anyone on the internet, and the relay's operator | end-to-end encryption between the phone and the daemon (P-256 ECDH + PSK handshake, AES-256-GCM with strict counters, docs/PWA.md): the relay forwards frames it can't read or forge, and a frame it alters, replays, drops or reorders ends the session. A room is claimed only by the holder of its key (room id = hash of the key). The daemon connects out only while a phone is paired or a pairing is open; no listener is added on the computer. The relay limits sockets and new connections per address (IPv6 by /64), messages and bytes per socket (computer sockets 16×), frame size (1 MiB), phones per room (4) and per computer connection (64); it stores and logs nothing about frames, rooms or addresses. What it does see: room ids, handshake device ids, connection times, sizes and addresses (the phone's IP, the computer's IP). The daemon treats it as hostile: controls are shape-checked and budgeted, and a violation drops the link (threat 14) |
| Phone link: a paired phone | the owner's phone (or whoever holds it) | a device key (256-bit PSK; on the phone a non-extractable CryptoKey in IndexedDB, on the daemon `~/.walkie/mobile/devices.json` 0600) proves the phone in every handshake, and the daemon drops a link that hasn't sent a valid encrypted frame within 10 s; requests run as the person (never an agent) on an allow-list: Mission Control reads, `post` (existing channels, no `raw`, no `artifacts`), `answer`, and the live stream; answers are projected for the phone (posts, asks and answers only; no plan, license, account, login, address or signature). Per device, across all its connections: 20 req/s, 8 in flight, 2 streams, 1 MiB/s of responses, 256 KB per response, 100 events per list, and its own write bucket. Ends 30 days unused, 90 days after pairing, on revocation or eviction (open links end at once), and when this machine stops belonging to a member |
| Phone link: pairing | whoever sees the QR code or the code under it within 10 minutes | 128-bit secret in the URL **fragment** (no server receives it); the pairing's relay room is claimed with a random key only the daemon holds and the relay never hands a held room to a second claimant, so a code lets its holder pair a phone but never stand in for the computer; one use; five unregistered attempts void it; `walkie mobile pair` refuses to run under an agent and the route refuses `X-Walkie-Agent` |
| The `claude` summarizer (Wispr, opt-in) | the user's own CLI, fed an external transcript | the transcript is redacted (configured keys + patterns) before it is written to the CLI's stdin; the CLI runs in its own process group with no tools or MCP servers; stdout is capped at 64 KB while streaming; on timeout, cap, failure or exit the whole group is SIGKILLed and reaped |
| The orchestrator (PROTOCOL §9, opt-in: `walkie orchestrator start`) | the person's own `claude` CLI with tools on this machine, fed the person's messages; shell-capable access runs as the dedicated `walkie-talkie` OS user | local only: the conversation is stored in this machine's database and shown only on its dashboard and CLI; never an event, never replicated, never served to a peer or a paired phone (no route, and its stream never carries it); only the person drives its conversation; only a person can grant shell access or elevated permissions; WSL leadership needs a local person's opt-in and all other owner machines offline; each queued message is authorised again when it runs (signed out, past its session's deadline or token rotated: refused); replies are redacted and capped at 256 KiB; its team-wide status is generic; the child excludes inherited Claude setting sources, never inherits `ANTHROPIC_*` or a parent session's `CLAUDE_CODE_*` (subscription, not API billing), and its stderr is scrubbed before anything is cut, logged or shown; a separate monitor checks wall and monotonic lease deadlines and invokes the existing `talkie-destroy` sudo verb if the daemon disappears; the root helper checks its ownership record before destroying the dedicated uid; long turns using a locally read token with a known expiry are interrupted and resumed with a refreshed login before expiry |
| Remote seats (PROTOCOL §11, opt-in per machine: `walkie seats enable`) | launchers (the team's owners and their agents by default) starting `claude`/`codex` with tools on the host, as the host's OS user by default on company machines | nothing runs on a machine whose person hasn't opted in locally (`config.json`, people only; `deny` stops every seat); the host judges each request itself: signed launch/stop posts in `seats-<node>`, the author an allowed launcher at request time (`@h` covers h and their agents on admitted machines; `@h/<machine>` limits them to that machine; an exact agent entry covers only that agent), fresh (10 min), judged once, within the launcher's cap, the host's `max` and 10 launches/min; the channel must be private to the host's person and the launchers' people (the authority lets only the host's person shape it, owners included); the prompt is stdin data, never argv or a shell; the child drops API keys and parent-session markers, runs in its own process group with a wall-clock limit, and its output is scrubbed before it is posted |

## Threats and mitigations

**Join credential delivery.** `POST /v1/team/invite-code` and `/v1/team/add-machine` return raw credentials to an
unmarked request on the owner's socket or an authenticated person dashboard session. An unmarked owner-socket request
means a process with the owner's OS-user authority; headers cannot prove a human is present. Agent-marked requests,
requests carrying the live orchestrator token, and requests carrying the dedicated WalkieTalkie proxy's
`X-Walkie-Talkie-Shell: 1` marker receive only a receipt. The credential is placed in a private local WalkieTalkie
message for the person, outside the model transcript. In the integrated pre.10 line, shell-capable WalkieTalkie uses a
dedicated OS user whose only daemon path is a token-checked proxy that forces the orchestrator agent and shell marker.
Platform-mode WalkieTalkie uses `walkie_cli`, which refuses `--agent`; seats have their own OS users and seat sockets.

**Other OS users on a member machine (PEER-SIG-1).** Tailscale's source IP and whois login are
shared by OS users on that machine; the public node id in `X-Walkie-Node` alone does not distinguish
the owner's daemon from a seat or the `walkie-talkie` uid. The owner-only 0600 node key now signs
privileged peer requests, closing header-only access to remote admin, vault hand-outs and usage,
pool controls and tunnels, and re-pinning an admitted node through `/join`. A new Tailscale key under
a login that has ever had a machine, including a revoked or removed one, waits for owner approval even when `auto_admit` is on;
a valid owner-issued add-machine credential admits it in one step. The first machine for a login
keeps the configured auto-admit behavior. Pending requests show hostname, login and request time.
Replication, vector and blob routes require the same proof after this receiver verifies a node-key
request signature or signed `/vv` proof, or the authority's signed roster records `peer_sig_v1` for
that node. The roster marker survives re-pins and replicates to every member. A signed new-node join,
including a pending join later approved by an owner, produces that marker. Unknown capability is
served unsigned on Tier B during the mixed-version rollout, with `peer_unsigned` logged at most once
per node per ten minutes. An unsigned `/vv` reply cannot upgrade or downgrade a node's trust state.
A member that verifies a node's `/vv` signature sends its compact node-key proof to the authority in
a signed peer request. The authority verifies the proof against the admitted node's key and the
reporting member's challenge before writing the roster marker; a member's claim alone is insufficient.
When every admitted, non-revoked node has trusted evidence, including a founder-only team, the authority
records strict mode and Tier B becomes strict automatically. An owner may explicitly disable it with
`walkie team peer-sig-strict off` to admit a legacy machine; the signed waiver is consumed by that
admission, so automatic strict mode resumes when all nodes have evidence. The owner decision is logged.
`walkie team peer-sig-strict on` enables it explicitly. Strict mode rejects unsigned Tier B and
new unsigned joins with an update message on upgraded receivers; a pre.9 daemon cannot enforce the
new marker until it updates. Cached capability claims lacking authenticated provenance
are ignored.
A pre.9 owner cannot remote-admin or borrow the vault of a pre.10 machine until it updates.
A known pre.9 node without trusted evidence may re-pin unsigned only to its whois-observed source IP
while retaining its recorded port; the authority logs this legacy re-pin. A port change requires a
signed request. Once it has signed, every re-pin requires its signature.
During the mixed window, another OS user on a member machine can still impersonate a node that has
never produced trusted evidence, as on pre.9. Protection is complete for a node after its first
verified proof or signed admission and team-wide after strict mode engages.
Walkie Direct already binds the caller to
its QUIC key. A receiver refuses signatures stamped before its current boot, so a captured request
cannot replay after its in-memory nonce book resets. New-key joins never occupy nonce-book slots;
the requester table evicts old entries rather than refusing a new admitted requester. A busy
requester's nonce set retains a timestamp floor when trimmed: older signed requests are refused,
while later fresh nonces continue. Refusals distinguish stale, replay, clock skew and invalid proof.
Whether seat users can reach the
tailnet on macOS was not live-tested for this change; the signature gate does not depend on that.

1. **Outsider on the tailnet** (a shared-in device, a guest node): whois login isn't a member → 403 on every peer
   endpoint, including `hello` and `join`. **Outsider on the internet** (Walkie Direct): its key isn't an admitted
   node → 403 on every endpoint; `/join` without a valid invite → 403. A spoofed `X-Walkie-Node` is refused (the key
   decides). A revoked node's key, or a removed member's machines, get 403; an explicitly revoked key can't come
   back with a fresh invite (an owner must re-admit it), while a machine revoked only by its member's removal may
   join again after a re-invite (over Direct, a code minted after the removal), as over Tailscale. A stolen **unused** invite admits the thief once as that handle
   (like a leaked invite link); a used or expired one admits nobody, nor does one minted before its member was
   removed, and an owner sees every admission on the roster (`walkie who`) and can revoke that one machine
   (`walkie team revoke <machine>`, which also closes its open Direct connections) or remove the member.
2. **Member impersonation** (a member's daemon forges another member's post): events are signed by the origin node,
   and the author handle must belong to that node's login. Relays can't alter or invent events, and can't invent or
   re-route stubs either: a stub needs the origin's header signature, and a receiver that can see the stub's channel
   refuses it and pulls the real event. Nobody can make a daemon store rows under its own origin. Signatures must be
   canonical base64, so a relay can't re-encode an honest event into a "different" copy (which would be logged as a
   conflict against its origin). An owner can't mint a machine key under another member's login through a roster
   request (`not_own_node`): another member's machine is admitted only by that member's own whois-bound join.
3. **Roster takeover** (a member promotes themself, or a demoted/removed owner acts on): the roster is a single
   linear chain written by one node, the roster authority (PROTOCOL §2). A roster event signed by anyone else is
   never applied, whatever it claims, so there are no competing writers, forks, timestamps or seniority rules to
   game. Other owners act through signed requests that the authority checks against the current roster; a demoted
   owner's requests are refused. The last owner can't be removed or demoted, and the authority can't demote or revoke
   itself (it transfers authority first). Only owners change existing channels (a member can only request a new
   public one). The authority itself is trusted for the roster: a compromised authority node can rewrite membership
   (as a compromised founder could before), which is why it must be an owner's machine.
4. **Removed member keeps access**: their nodes are revoked with the removal; events from them that the authority
   had not seen when it emitted the removal (not covered by the removal's or any earlier entry's signed watermark)
   are judged against a roster in which they are removed, so they are rejected on every replica regardless of
   arrival order (validity is a pure function of the event and the chain), and peers refuse their whois at the API.
   A later grant (a re-invite, a widened channel) never re-validates what the authority had seen before it.
   Re-inviting the login does not re-arm old machines: a node revoked at chain position q stays revoked unless a
   **later** admission re-arms it (each machine must `walkie join` again). Data they already synced stays on their
   machine (inherent to any replicated system).
5. **Restricted channel leak**: events are never served or pushed to non-members (recipients and payloads are decided
   at send time), who get signed-header stubs so replication stays contiguous. A channel update that leaves
   `members` out keeps the list (the authority signs it explicitly); only `public: true` opens a channel. Local API reads are filtered too. Blob
   bytes are served per `(channel, hash)` **provenance**: a node hands out the bytes for channel X only if it uploaded
   them with a share in X, or fetched them for an accepted share in X from a peer that had provenance for X, and the
   requester can see X. A signed share announcement of a known hash in another channel unlocks nothing, and neither
   does a public mention of the hash.
6. **Prompt injection between agents**: see the model-context boundary above. Asks to agents with `ask_policy: human`
   go to a person first. Agent instructions tell models never to run commands, read files or reveal secrets because
   a message asked.
7. **Secret leakage by agents**: token-shaped strings (cloud keys, LLM keys, GitHub/Slack/Linear tokens, JWTs, PEM
   private keys, `password=` pairs, URL `user:password@`, `*PASSWORD=`/`*TOKEN=`/`*SECRET=`/`*KEY=` assignments,
   `mysql -p…`, `sshpass -p`, `Authorization:`/`Bearer` tokens, Stripe, Tailscale and Fly tokens, `--password`/`--token`
   /`--secret` flags, `echo … | docker login`) are redacted before an event is created, and every line is redacted
   whole BEFORE it is shortened (a secret cut in half would no longer match its pattern). Since fix round 5 the
   redaction is structural (`src/protocol/redact-structured.ts`): text is read as shell words (quotes, escapes,
   concatenation, multi-line quotes, `$'…'`) and the complete value of any assignment or flag whose name says secret
   (pass, pwd, passphrase, secret, token, key, auth, credential, cookie, session, …, in any case style), of known
   tools' password flags (`mysql -p`, `redis-cli -a`, `sqlcmd -P`, `ldapsearch -w`, `ssh-keygen -N`, `keytool
   -storepass`, `curl -u`, `htpasswd -b`, `echo … | sudo -S`, …), of key/value lines (YAML, TOML, .env, .netrc,
   .pgpass, JSON) is replaced; key blocks (PEM, OpenSSH, PGP, PuTTY) to their END or the end of the text; known
   provider tokens by prefix; and any other random-looking token (long, mixed character classes switching often; not a
   UUID, git or sha256 hash, path or word). Redaction is **best-effort defence in depth for text people and agents
   write on purpose**, not a guarantee: it does not recognise confidential prose. So agent statuses carry, by default, only the
   state, runtime, model, machine, person, repo name and branch: **prompt titles** and their issue keys (and Codex's
   last-reply line) only with `"share_prompts": true`, **except** titles and issue keys set deliberately: typed by a
   person (`walkie status`) or set by an agent with `walkie_set_status`. An agent-set title is an intentional
   publication; the tool's description and the MCP instructions tell the model that the whole team sees it and to
   describe the kind of work, never prompt text, customer names, secrets or confidential details; nothing can verify
   that a model complies. **Tool and notification text** only
   with `"share_activity": true`, the **working directory** only with `"share_paths": true`, all off by default and
   on installs that never set them. This is enforced in ONE place, where the daemon signs every agent.status
   (`src/protocol/status-projection.ts`, applied in `Core.emit`), so no writer (hook, MCP announcement, set_status, CLI,
   discovery, a custom local client) can bypass it; text of unknown origin is dropped. An input too long to redact
   whole shows no detail at all. **Hermes** is stricter: every Hermes profile shows its state (working, idle, offline) and
   never an activity line, whatever `share_activity` says, unless `config.json` lists the profile in
   `"hermes_activity_profiles"` (`walkie hooks install hermes --activity name[,name]`). No profile name is special and no
   environment variable decides: the hook, the daemon's `POST /v1/hermes/status` and discovery each read the list from
   `config.json` through one function, a missing or invalid list is empty, and the route drops the line of an unlisted
   profile before it is stored. A profile taken off the list shows nothing from the rows the daemon stored while it was on it,
   and its card loses the line within one discovery scan.
   Statuses already replicated stay in teammates' logs: turning sharing off stops new disclosure only. A machine that
   joins later is served, by a machine on this version, superseded statuses and this node's statuses signed under a
   wider policy only as header-signed stubs (and pushes never carry them). The node re-signs its non-compliant
   statuses (50 per minute), each copy keeping `observed_at` = when it was really observed, so a dead agent is never
   made to look alive. A superseded status is served in full only when it can't disclose anything (this node's own
   compliant status, or one with no free text), whatever the requester claims; an older peer that is served a stub
   stops replicating that origin until upgraded: **upgrade every machine before adding members**. The redactor is
   linear-time: text past 64 KB gets only the key-block and provider-token passes, so a long post can't stall the
   daemon. Ref names (repo, branch) and the model are never scanned for random-looking tokens; a name such as pass,
   token, session or auth redacts its value only when the value isn't plain (a short number or word, a UUID, code). Home paths are made `~`-relative.
7a. **Local file reads by discovery**: a session file is read only for a plain session id (`[A-Za-z0-9-]`), inside
   `<config dir>/projects` after resolving symlinks, and only when the opened descriptor is a regular file owned by the
   daemon's user (opened `O_NOFOLLOW | O_NONBLOCK`, so a FIFO swapped in can't block the daemon); at most 32 KB (1 MB
   when the last record is longer) per changed file.
8. **Flooding/abuse**: per-agent and per-peer token buckets (512 keys max, LRU), body caps (256 KiB per event,
   1 MB peer batches and responses, 25 MB artifacts), JSON depth ≤ 32, a 64-client SSE cap with a 1 MB per-client
   queue, peer pages byte-budgeted to 768 KiB (the client retries smaller pages and isolates failures per origin),
   and at most 1000 hidden (signed-but-invalid) non-roster rows per origin, this node's own included, enforced on
   every transition into hidden; schema-invalid events keep only their signed header. A non-authority roster event
   costs O(1) (it never reaches the chain) and at most 200 are kept per origin. Re-validation after a roster change
   touches only rows the authority hadn't seen (unanchored) and is paged at 1000 rows per event-loop tick, answers of
   a flipped ask included. Held (pending) events are indexed by what they wait for and re-ingested only when that
   arrives, off the ingest path; they are capped at 10 000 rows and 8 MB per relaying peer and per claimed origin,
   and those of an origin nobody admits expire after 1 h. Channel creation is capped (20 per member per day through
   requests, 500 per team). Admissions are capped (16 non-revoked machines per login, 1024 node ids per team over
   its lifetime, `409 node_limit`), and the watermark carries only admitted origins, so a member minting keys can't
   grow it past what a roster event can carry and freeze the authority; revocation, removal and transfer are never
   capped. Stub backfill backs off per (stub, peer) and rotates fairly. Stored events are never
   re-signature-checked after ingest.
   **Answer hijack**: an answer is valid only from the ask's addressee (handle, machine, agent), in the ask's channel.
9. **Integrations** (docs/INTEGRATIONS.md): a connector only emits `msg.post` and `artifact.share` through
   the normal local path, as the local member, so everything above (signatures, channel rules, redaction)
   applies unchanged and no protocol surface is added. Connectors never create channels: enabling one for a
   channel that doesn't exist is refused (409 `unknown_channel`), and the person creates it with the normal
   channel API. External text is untrusted: redacted (configured keys + patterns, in every emitted field),
   capped, and wrapped `trust="external"` for models. Configuration (`POST`/`DELETE /v1/integrations/:id`) is for
   people only: a request carrying `X-Walkie-Agent` is refused, and on loopback it needs the token (or a dashboard
   session) and a same-origin `Origin` like every mutation. The agent names `fireflies`, `wispr` and `linear` are reserved
   on the local API so a local agent can't wear a source badge. The share-link unfurler fetches only
   `https://notes.wisprflow.ai/shared/<slug>` and the matching `api.wisprflow.ai` endpoint, never follows
   redirects, ignores posts by connectors (no loops) and posts older than 10 minutes, and replies at most
   once per post and link on this machine. The `claude` summarizer runs the user's own CLI with no tools and
   no MCP servers, on a redacted transcript, contained in its own process group (see the table).
   **Linear export**: an issue carries a thread out of Walkie only when the initiating message, its thread
   root and every reply are accepted, unredacted, currently visible to this member and in the initiating
   message's channel; otherwise the export is refused (403, never partially filled; an initiating message
   the member can't see is a 404, like a read). The channel must also be postable (not archived, visible)
   **before** the issue is created (409 `post_failed`); if creation succeeds and the backlink post still fails
   (the channel was archived meanwhile), the answer is a `207` partial success carrying the issue URL, and the
   backlink is a persisted job the connector's next runs post (never a second issue). A person or agent chose to
   file it. `POST /v1/integrations/:id/run` (a sync now) is for people, like every other integration change.
   **Disable/remove**: each connector has a configuration generation; configuring, disabling or removing it
   ends the generation, which aborts in-flight fetches and the `claude` summarizer (its process group is
   killed), cancels scheduled callbacks (unfurl delays and retries), fences every later post or state
   write of work captured before, so removed state can't be recreated, and makes the claims that work
   held stale, so the next run (always of the current generation: a run of an ended generation is
   waited for, never joined) takes them over. **Crash safety**: dedup rows are `claimed` (with a time)
   until `posted`; a claim older than 10 minutes, or left by the previous process (all claims are stale
   at startup), is taken over; a post and its attachment share are each recorded in the same transaction
   as their emit, and an emit's publication (SSE, in-process listeners, the peer push) waits for the
   outermost transaction to commit, so a failed ledger write leaves nothing anywhere and its sequence
   number is reused; a retry completes a half-done item (the unfurler checks its own ledger before it
   treats another daemon's reply as done) instead of posting it twice. A window (Fireflies), snapshot or
   watermark (Linear) never advances past an item another attempt still holds. Fireflies continues by
   time (just past the last page's oldest meeting), not by offset, so an upstream deletion can't shift
   the next page; Linear reads an issue's whole recent history (up to 425 entries) before judging it.
   Each connector posts at most 30 items per hour.
   **Integration slots** (PROTOCOL §2 "Licenses"): enabling a connector is a roster change
   (`team.integration`) the authority appends only within the plan; a daemon enables a connector
   locally only after the authority accepted (queued while it is offline), so the count can't be
   exceeded by a partition or a race between machines.
10. **Local key theft**: `node.key` and `local.token` are 0600. Anyone who can read them is already the same OS user
   (who can also read the browser profile, where the dashboard keeps its session). Rotation: `walkie token rotate`
   (the daemon writes a new token, the old one stops working at once, requests still open with it are closed, and
   every dashboard session is signed out); the first start after v0.1.3 rotates once by itself (the old token may
   have leaked through the old cookie, threat 12). Node key rotation = owner revokes the node and it re-joins.
11. **Clock manipulation**: timestamps only order the display. The roster is ordered by the authority's seq, and
    validity uses its signed watermarks. Validity never depends on wall clock, except ask expiry, which is advisory
    (the per-member daily channel quota uses the authority's own clock). Plan decisions (trial, license expiry and
    grace) use the authority's plan time, `max(clock, plan_floor)`. The floor is persisted and raised by exactly two
    things: the node's **own** clock (every emit, every hour) and the **roster chain's** entry timestamps, clamped to
    `clock + 5 min`; at startup it is rebuilt from the persisted value and the chain only. **No other member's event
    moves it**: a teammate whose machine clock is ten years ahead can't drop a paid team to Free or make fresh keys
    look expired (the HIGH finding of the final audit). Anything a **member** stamps more than 24 h ahead of this
    clock is **held** (`future_ts`), not judged, until the clocks agree, after it is authenticated (a forgery is
    rejected, never held); within that band the timestamp is accepted but moves no clock-derived state beyond
    `now + 5 min`: the plan floor, an agent's staleness (a status counts from its receipt) and an ask's expiry (its
    own timeout, capped at a day, from receipt). The **authority's** events are never held for their timestamp:
    everything a timestamp can move is clamped anyway, and holding them pinned its chain on every member for as
    long as the hold outlived a corrected clock (FINAL-2 Fable 3). Setting the clock back can't revive a trial or a
    lapsed license within the same run; at startup a persisted floor more than a day past `max(clock, clamped
    chain max)` is reset (logged `plan_floor_reset`), so an authority whose clock was wrong for a while recovers
    after a restart. The trade, accepted on purpose: an owner who sets the authority's clock back by more than a
    day and restarts it, or moves authority to such a machine, revives a trial or a lapsed license on their own
    machine (plan enforcement is soft and emit-time only; see "Limits"). A team created with a clock in the future
    has no trial once the clock is corrected (`team.create` must be within 5 min of the raw clock). A node's own
    emits are stamped at most 5 min ahead of its clock, so a corrected clock doesn't leave it emitting events its
    peers hold forever. This is a guard for trusted authority software, not a
    proof: a modified binary, or a store edited by hand, can skip it (see "Known limits").
12. **Cookie leak to other loopback ports** (WALKIE-SEC-COOKIE-1 and -2): browsers don't isolate cookies by port
   (RFC 6265 §8.5), so every cookie for `127.0.0.1` also goes to any other listener there: another OS user's
   server, a container's forwarded port, a dev server a page steers the browser to. In v0.1.3 and earlier the
   dashboard cookie **was** `local.token`, a full local-API bearer that never expired. The first fix made the cookie
   a revocable session, but the audits replayed a captured one with a forged `Origin` against the dashboard's routes:
   read the event log, and `POST /v1/team/invite` made the attacker a permanent owner (Codex FAIL, Opus HIGH,
   2026-09-26). Now **no cookie authorizes anything**: the session reaches the page in a URL fragment and lives in
   the page origin's `localStorage` (port-isolated), and the daemon accepts it only in the `X-Walkie-Session`
   header, which a page on another origin can't send. Verified live: after login the browser sends no cookie to
   another loopback port, and replaying anything it sent (or even the live session value as a cookie) with a forged
   `Origin` answers `401` on `/v1/events` and `/v1/team/invite`. Invite also no longer changes a current member's
   role (it used to replace it); role changes go through `/v1/team/member`, which a session can't reach. The upgraded
   daemon rotates the durable token once on its first start and clears the old cookies on any response, so the
   v0.1.3 value stops working without a manual `walkie token rotate`. A second, confirmation-grade check for owner
   operations from the dashboard was considered and not added: with no cookie credential there is no replay path it
   would close. **What remains**, all needing more than a loopback listener: (a) a process running as the same OS
   user, or a browser extension with access to `127.0.0.1`, can read the session from the browser (or read
   `local.token`, threat 10); (b) a script injected into the dashboard page (XSS, which the CSP and markdown
   renderer are there to stop) can now read the session value and use it elsewhere until it ends, where the HttpOnly
   cookie only let it act while the page was open; (c) the redirect URL with the fragment may be recorded in the
   browser's local history, where it is worthless once the session ends (logout, token rotation, 12 h idle, 7 days; a daemon restart no longer ends it, LIVE-2); (d)
   whoever holds a live session can do what the dashboard can (post, answer, invite and admit, connectors,
   license activation) until it ends, and what they do (a membership, an admitted machine) outlives the session.
13. **Startup must not unlink a live daemon's socket**: the daemon takes an exclusive `flock` on `<socket>.lock`
   before it looks at the socket and holds it until it stops, so two starters can't both find the socket stale and
   one unlink the other's fresh socket; the second fails with "already running". The kernel drops the lock with its
   holder, so a lockfile left behind is never stale and is never deleted (deleting it would reopen the race). An
   existing socket file is then removed only when connecting to it is refused. Bun reports a refused socket and one
   it may not connect to (mode 000, a live daemon's included) alike, as `ENOENT`; a path that is still a socket
   counts as refused only if this user may write to it, otherwise startup refuses. A process that accepts the
   connection but doesn't answer `healthz` within 500 ms (a busy machine) is treated as live: startup refuses with
   the path and the fix, instead of stranding that daemon without its socket. The daemon removes its own socket on
   stop before releasing the lock.
14. **Phone lost, stolen or shared** (WALKIE-PWA-1): whoever holds the unlocked phone can use Walkie on it as the
   owner, within the phone allow-list (read Mission Control, post, answer), until the device is signed out:
   `walkie mobile revoke <id>` (or `--all`), Team → Devices → Sign out. Revocation ends its open links at once (streams
   stop, requests abort), tells the phone over the encrypted channel so it forgets its key, and gives up its relay
   room; expiry and eviction by a ninth pairing take the same path. Removing the member or the machine signs out every
   phone paired to it. The phone can't reach tokens, accounts, the roster, licenses or integrations, can't ask on the
   owner's behalf and can't pair other phones; what it is shown is projected for it (posts, asks and answers only;
   no plan, license or billing data, account data, logins, addresses or signatures).
   **A pairing code** seen by someone else in its 10 minutes pairs their phone instead: treat it like a password, and
   sign out any device you don't recognise (the list shows every paired device). The other way round, a link someone
   sends you would pair your phone with their team: the app shows the team, the person and the computer and asks
   before it pairs, and never replaces an existing pairing without an explicit "Switch".
   **The relay** can't read or change the application data (tested: no path, channel, handle or message text appears
   in any frame) but can refuse service, and it sees metadata: room ids (stable per device), the device id in each
   handshake (plaintext), which phones share a computer's connection, both sides' IP addresses, frame sizes and timing
   (no padding). A hostile relay can't exhaust the computer either: every inbound message is budgeted before it is
   looked at (every WebSocket frame, continuations and controls included, as its header arrives), fragments are
   capped (64 per message, no empty non-final one) and reassembled into one growing buffer, a frame must arrive within
   30 s, every control is shape- and state-checked, slots are bounded, joins, handshakes (ECDH), queued bytes and
   per-device bytes (answers and stream messages, by encoded size) are budgeted, the daemon speaks to the relay through
   its own WebSocket client (native pings rate-limited and answered through the bounded queue, message sizes judged
   from frame headers before anything is kept, TLS chain and host name checked), the relay must echo pings to prove it
   reads (past an 8 MiB unechoed window, more with many rooms, sends are refused, each room, its first message included,
   at most its share of it (never less than one full frame) so an idle room can always send one, reserved before
   sealing, released exactly as acknowledgements arrive; no acknowledgement progress for max(20 s, outstanding ÷
   2 KiB/s) closes the link: lenient on purpose so honest slow phones are never cut off, so a hostile relay can hold up
   to the window for a long time and a black hole may take minutes to notice, memory staying bounded; a silent link is
   pinged every 30 s and a dead one noticed;
   connect, TLS and upgrade must finish within 15 s;
   tested against a real TCP peer that stops reading, and at 2 and 1 Mbit/s), slot generations keep a kick or frame
   meant for a phone that left from reaching the next one, its refusals are logged as a summary at most once a minute,
   and a violation drops the link and backs off (tested with 2 000 joins, 10 000 error controls, negative and
   out-of-range slots, empty and oversized frames). One room's excess (joins, bytes, a bad frame) ends that room's
   phone only, at the relay (which keeps what it forwards below the daemon's budgets, in total and per room) and at
   the daemon (tested: 36 join/close cycles from two addresses and four 8 MiB pre-handshake floods leave another
   room's phone connected). The phone bounds what it receives the same way.
   **The protocol is custom** (NNpsk0-shaped, not an implementation of Noise): authentication proves possession of the
   shared secret, with no separate daemon identity, so whoever obtains a device key (the phone's storage, or
   `~/.walkie/mobile/devices.json`) can act as that phone *and* answer as the computer to it (no key-compromise
   impersonation resistance); forward secrecy holds for past sessions.
   **Credentials on the computer**: `~/.walkie/mobile/devices.json` and `state.json` (0600) are remote credentials:
   anything running as your OS user can read them and reach Walkie through the relay as a paired phone, like
   `local.token` gives it the local API. Pairing asks for a person the same way the other person-only routes do: the
   CLI refuses under an agent and the route refuses an `X-Walkie-Agent` header, but on the unix socket a process of
   your user that omits the header is indistinguishable from you (tested and documented, as for integrations).
   **The site is trusted**, and a compromise of it outlives a fix. The phone app is JavaScript served by
   `getwalkie.vercel.app`; whoever can change what that origin serves (its Vercel project, or this repository before a
   deploy) can ship an app that takes the stored device key object (WebCrypto non-extractability stops reading the raw
   key, not using it or passing the key object to another origin by structured clone), keeps using it after the page
   closes, captures pairing secrets, or installs a service worker of its own. SRI or CSP hashes delivered by the same
   origin can't authenticate the app (a compromised origin serves new ones). **Recovery**: on every computer run
   `walkie mobile revoke --all` (device keys and rooms end on the computer, where it counts); deploy a fixed site with
   `m-sw.js` set to its kill switch (`KILL = true`: browsers fetch the worker script themselves, bypassing any worker,
   on navigation and at least daily, and the new one deletes caches, unregisters and reloads); have people press "Reset
   this phone" at `/m/reset` (clears the pairing, caches and worker; a deliberate button, so another page can't wipe a
   phone by sending it there; a compromised page could of course have kept a copy of the key object, which is why
   revocation on the computer is the step that counts); then pair each phone again. The app stays on the site's origin for now; a dedicated origin (no landing page, no billing functions
   sharing it) and an independently verified, signed app bundle are later steps (docs/PWA.md).

15. **Someone else drives or reads the person's orchestrator** (ORCH-FIX-11/12; eleven audit rounds of designs that carried
   the conversation over the team's sync failed, docs/audits/2026-09-26-*-orch-r*.md). The conversation never leaves
   the machine: no teammate, owner, same-login spare, relay, older version or phone has anything to receive, and no
   channel is involved (an `orch-…` channel is an ordinary one). Only the person at the machine drives it: a
   dashboard session or the CLI (the dashboard's Start button starts it with the daemon's defaults only: a session
   can't name a `claude` binary, `PATH`, folder, model or permission mode, so a hijacked dashboard page can't make it
   run another program or skip permissions); every orchestrator route refuses an `X-Walkie-Agent` header and a paired phone's
   request, and the CLI refuses every `walkie orchestrator` subcommand under an agent (marker or ancestor process). A queued
   message is authorised again when it runs, so a dashboard session that signed out (or reached its deadline, checked
   then, not only by the sweep) or a rotated token can't have a message run later. A 1.5 MB reply is stored and shown
   capped at 256 KiB and never reaches the phone's stream (tested with the phone tunnel). **The dashboard login is the person's** (Codex r12/r13 HIGH, closed with WALKIE-ADD-MACHINE):
   `walkie dashboard` is a person-only command (a terminal confirmation, and it refuses under an agent's marker or
   ancestor process), and the daemon mints no dashboard nonce for an agent-marked request (an agent header, or the CLI
   saying it runs under an agent), so an agent gets no person session to drive the orchestrator through; nor can it
   sign out every dashboard or rotate the token (tested: `/v1/auth/nonce`, `/v1/auth/logout` and `/v1/auth/rotate` are
   403 to an agent-marked caller). An agent that hides every signal is indistinguishable from the person (the Unix
   socket row). The routes' agent refusal is detection, not proof: a process of the person's OS user that sends no
   agent header is the person, as everywhere on the local API. Limits: agent detection in the CLI is by environment, not proof (`env -i walkie orchestrator
   say …` is indistinguishable from the person); what Claude does is bounded by the permission mode the person chose;
   for platform access, an `apiKeyHelper` or settings `env` block in the person's own Claude settings still makes that
   `claude` bill the API, as in their terminal. Shell-capable access (`full` or `bypassPermissions`) requires the person to install the
   root-owned seat helper with `walkie seats setup-user --apply`; a missing or stale helper refuses the change. Claude
   and anything it starts run as the dedicated `walkie-talkie` uid, with a Claude login credential and an authenticated
   local Walkie socket. A local Claude login can provide an expiring access token; a vault login or
   `CLAUDE_CODE_OAUTH_TOKEN` in the daemon's environment may provide a long-lived setup token. The runner projects the
   credential without a refresh token into its private config directory and removes it when the run ends. On stop or
   lease loss, the helper stops every process of that uid, including a detached job
   reparented after its shell exits, then verifies that the uid's processes, services, schedules, files and account are
   gone. Platform access continues under the daemon's user and has no shell permission.
   A qualified destroy helper call is bounded to 180 s. Failed cleanup remains a durable obligation: the daemon hands it to
   the uid monitor, whose cleanup owner record has a short renewed lease, and keeps a watchdog retry in case that monitor
   wedges. Boot retry and the automatic pilot guard retain the lead lease during pending cleanup; Stop, close,
   automatic pause and lease loss release it. A different machine may then lead safely because the uid is local to
   this machine, and the old shell token is rejected as soon as its lead lease is invalid. A monitor completion for
   the handed-off generation is accepted only after durable verification; an unverified exit schedules another
   qualified retry. If a monitor removes
   the uid unexpectedly while the host is running, the host faults and stops instead of continuing with a stale socket.
   After twelve failed cleanup attempts, status points the person to `walkie talkie cleanup --repair`.
   Run it in a terminal: releasing an empty owner row requires the person's fresh sudo password.
   `talkie-status` remains passwordless. The generated sudoers file gives `talkie-repair` its own
   `PASSWD` command rule and a command-scoped `timestamp_timeout=0`, so a direct helper invocation
   cannot reuse a prior sudo authentication timestamp.
   Run `walkie seats setup-user --apply` to install the updated helper and sudoers rule before repair.
   At account creation, the root helper records the invoking daemon's PID and process start time in its
   root-owned ledger. It refuses owner-row release while that process, a daemon lease, or a shell socket
   is live, even if the daemon user unlinks the lease and socket paths. A legacy row without that
   process identity cannot pass stopped verification automatically.
   The empty-uid file check refuses any mount point or skipped subtree it cannot inspect; a sweep note does not
   count as proof that the uid left no files there.
   Startup `talkie-reconcile` carries the generation observed before it queues on the shared root lock and the
   daemon owner's per-socket identity. The helper checks both against its machine-wide ownership ledger under the
   lock before removing the uid. A stale reconcile from an aborted Start cannot remove a later run, and a daemon
   using a different socket refuses shell access while the first owns the dedicated uid. An account from an older
   helper with no daemon owner requires `walkie talkie cleanup --repair`; install the current helper with
   `walkie seats setup-user --apply` before enabling shell access.
   The dedicated user operations share `<ledger>.talkie.lock` (`/var/db/walkie-seat-admin.sqlite.talkie.lock` on macOS,
   `/var/lib/walkie/seat-admin.sqlite.talkie.lock` on Linux). `setup-user --apply` creates it as root with mode `0600`;
   the first helper use also creates it if missing, including during cleanup of a user left by an older install.
   Never unlink this file during normal operation: replacing its inode while another helper holds it defeats their
   shared lock. If it was deleted, run `walkie seats setup-user --apply` from the person's terminal, or let the next
   helper use recreate and verify it. If the disk is full and the ownership ledger cannot be written but the lock
   file exists, a generation-qualified cleanup uses the read-only owner record to stop the recorded uid's processes while retaining
   the account and cleanup obligation. Free disk space; the next cleanup retry resumes the full sweep and removes the
   account only after processes, services, schedules, mounts, files and home are verified gone. If the lock file is also
   missing and cannot be created (a full volume), cleanup of a user that still exists fails closed and signals nothing until
   space is freed; then run `walkie seats setup-user --apply` (or let the next helper use recreate the lock).
   Round 13 (ORCH-FIX-13): an agent-marked caller can't sign out every dashboard or rotate the token either; the agent
   name `orchestrator` is reserved on every write route for the host's own Claude, which proves itself with a per-run
   secret only its process gets (another agent or process naming itself orchestrator is refused; a process of the same
   OS user that can read that child's environment is the same-user limit); a fresh
   session's transcript is a JSON array between random boundaries, so a reply quoting untrusted text can't forge a
   `person` turn; live text is redacted, sent as whole lines at most 10 frames a second, tool frames and tool lines are
   capped; Claude's process group survives a daemon crash only until the next start, which ends it after confirming it
   is the same group (leader start time and command); starts are serialised, so no second Claude runs unsupervised.

   **Schedule reset.** Only a team owner may reset a claimed-slot mark, over the owner's local unix socket or an
   authenticated dashboard session. Paired phones and loopback requests using the durable token are refused. The CLI
   asks the person to type the exact schedule id, and the server checks the same id in `confirm`; `"reset"` alone is
   refused. Agent-marked requests (`X-Walkie-Agent` or `X-Walkie-Under-Agent`) are refused, including WalkieTalkie's
   marked tools. Every accepted reset is logged locally and posted to `#general` as `walkie-admin`. A process running
   as the owner's OS user can omit its agent identity and use the owner's unix socket, so it has the owner's authority.
   The separate seat-user socket serves only seat posts and refuses reset. In this checkout, WalkieTalkie's child is
   launched with the owner's socket path; it does not have a separate restricted socket or dedicated OS user.

16. **Remote seats: remote code execution by design** (PROTOCOL §11). A seat is an agent with tools that a teammate
   starts on someone else's machine. On a consented company machine, `seats enable` defaults to **same-user** seats:
   launchers have the person's OS power. They can read and change that person's files and keys, reach the daemon
   socket and local token, and use accessible provider logins. `~/.walkie-workers/<seat-id>/` holds private 0700
   per-run Claude, Codex and temp directories, but it is organization, not a security boundary between processes
   running as the same OS user. Access-only file logins are copied where possible; named vault or leased homes and
   logins that cannot be safely projected retain their **selected** working path, never another account's default.
   Projection requires enough token life for the seat's timeout plus a 10-minute margin; a selected worker login
   keeps its refreshing path, while an unprojectable default login refuses the launch. Doctor warns when a known
   projected login is near expiry. Each root is seeded
   with Walkie's worker hooks and instructions. Personal Claude/Codex settings, CLAUDE.md and hooks are not inherited
   by default, including on existing same-user machines after an upgrade; local
   `seats allow --inherit-person-config --yes` opts into those settings and their login paths. The worker root is removed when the seat ends or
   after a best-effort check finds no process of the crashed seat still using it; pending cleanup survives restart. The person's own provider homes and logins are never deleted.

   Same-user seats have no kernel containment. When a seat ends or crashes, its instance-unique worker root and the credentials in it are removed once its process group exits, even if a helper the seat started escaped into another process group; that helper loses the seat's credentials. Seat credentials never outlive the seat, and a worker-root path is never reused.

   `--seat-users` or `setup-user --apply` opts into OS-user separation; existing seat-user configurations remain in
   that mode until the person runs `seats migration-preflight` and `seats migrate --same-user` locally with typed consent,
   after denying seats and clearing held users. **For seat-user mode, the boundary is the OS user, a fresh one
   per run, never reused** (Codex r5,
   Opus r5: any reuse of a uid let state cross runs through a home's inheritable ACL, files outside the home, the cron
   spool or a launchd domain, whatever was wiped): `walkie seats setup-user --apply` installs a root-owned helper that
   sudo runs as root with only `seat-admin create <n>` or `seat-admin destroy <n>`; before each seat it makes
   `walkie-s<n>` (n above every id it ever used, in a root-owned SQLite ledger changed only in `BEGIN IMMEDIATE`
   transactions, so concurrent helpers can't lose or reuse an id, Codex r6 HIGH 3, Opus r6 HIGH 1; recorded before
   anything is made, and kept in the daemon's `seats.json` before it asks, Codex r6 MEDIUM 4; its own new group, no
   login, a fresh `0700` home verified to have no ACL, cron and at denying it), and after the seat it destroys it:
   every process stopped then killed until none is left, its launchd domains booted out, its crontab removed and the
   spools checked, **its files removed by the seat user itself** (a descriptor-relative sweep, as that user, of `/tmp`,
   `/var/tmp`, `/Users/Shared`, `/Library/Caches`, its own `/var/folders` folder and its home; Linux `/dev/shm` too), then
   its emptied home, user and group, each stage safe to repeat, all verified. **Root never deletes a file outside the
   seat's home by path** (the one exception: its regular crontab file in the root-only cron spool, unlinked by root
   directly and verified gone; a directory or symlink entry is refused; Codex r6 CRITICAL 1, HIGH 2: a root `find | rm` of a seat's files turned a name with a newline,
   or a directory swapped for a symlink, into deletion of anyone's files): the seat user can remove only what it could
   while it ran, and the walk never follows a link or crosses a mount, and removes a directory only once empty. It
   clears its own protections first (macOS `uchg`/`uappnd` and ACLs on its own entries). macOS can leave protected
   residue in that user's own `/private/var/folders/<xx>/<hash>` tree. The sweep runs as the seat user. At any depth
   and under any name, it accepts an opaque entry when `lstat`/`fstatat`, read-open, directory open, or list returns `EPERM` to that user,
   every ancestor from the verified per-user root is freshly checked as the same uid-owned directory on the root's
   device and inode, and a stat-visible entry is that uid's non-symlink on the same device. The opaque per-user root
   itself also requires a verified macOS system-protection flag. `SF_NOUNLINK`,
   `SF_RESTRICTED`, and `UF_DATAVAULT` can also prevent removal of otherwise verified residue. A stat-visible readable
   regular file is accepted after unlink `EPERM` only if it has one link and the sweep opens that same inode for write,
   finds no extended attributes (including a resource fork) on that descriptor, truncates it, and verifies size zero
   on that descriptor. Read-only rechecks accept such a file only while it remains empty and has no extended attributes.
   Below the per-user root, flags do not disqualify an entry whose stat or open itself returns `EPERM`. The per-user root and `0/` can be
   `0755`: accepted opaque entries are refused to the seat user by macOS, while accepted readable files are empty;
   listable directories are swept and contain only verified residue. User-settable flags alone,
   `EACCES`, other owners, changed ancestors, symlinks and mounts do not qualify.
   The sweep removes user extended attributes from every owned, listable per-user directory it keeps, including the
   root and empty protected shells. It rechecks the directory descriptor after removal. An attribute that remains or
   cannot be removed prevents verification; the exact system-maintained `com.apple.rootless` and
   `com.apple.provenance` names are recorded as notes and may remain. Read-only residue verification also rejects
   user attributes on listable directories.
   Destroy kills every process of the seat uid before the sweep: a still-running process could otherwise create a
   hard link between the link-count check and truncation, emptying the file through its other name.
   On macOS 26.5.1, read-only observations found unflagged `TemporaryItems` and stat-denied `dmd` and nested vaults; attempts by an unprivileged
   owner to induce `EPERM` with flags, ACLs, modes or xattrs failed or returned `EACCES`, while a mount changed `st_dev`.
   Those probes ran outside `/private/var/folders`. Inside it, macOS makes some folders (for example `T/**/TemporaryItems`) write-only drop boxes for their owner, so a seat CAN leave content beneath one, and the sweep then accepts it as residue. That content stays on disk, but no later seat user and no other ordinary user can read it: `T/` is `0700`, macOS denies reading it even to the same uid, the uid is retired and its per-user folder is never reused (root and entitled macOS system processes are outside this guarantee). The cost is disk space left behind.
   A listable directory is still walked and emptied. The sweep records each
   protected path and why, while still removing entries it can remove. Destroy accepts this residue only after
   verifying that the account is deleted and no process of its uid exists. The root-owned ledger retains that uid
   forever and allocates future seat users above every uid ever issued, so no later seat user receives either the
   uid or its per-user folder. macOS seat homes use the same verified owned-ancestor EPERM rule for protected entries,
   but the root helper then checks the expected home is a real directory of the seat uid and that no readable
   unreported entry remains. It changes the home itself to root:wheel `0700`, moves it into root-only
   `/Users/.walkie-retired/<name>-<uid>`, verifies the move, and records the tombstone before deleting the account.
   A symlinked or wrong-owner home, failed lock or move, and any readable leftover still quarantine the user.
   Direct children of `/Library/Caches` are accepted only when the seat-user sweep observed `EPERM` and root's
   no-follow stat independently confirms the same uid and `UF_DATAVAULT` or `SF_RESTRICTED` flag. The protected
   vault stays in place and is recorded in the root ledger. Other entries outside the per-user tree, entries owned
   by another uid, removable files left behind, live processes, failed account deletion, and unverified ownership
   still refuse destroy and keep the
   user quarantined. This never-reused uid rule applies to seats. WalkieTalkie uses the fixed uid 550000 for later
   generations of the same dedicated principal. The root-owned ledger keeps one residue row per per-user folder.
   Each destroy runs the sweep as that dedicated user over its current folder and every recorded older folder, removes
   what it can, and refuses account deletion if an older folder cannot be verified. `walkie talkie cleanup --repair`
   is a person-run retry of that destroy and sweep before it can clear the cleanup obligation. The sweep walks only
   where it could have written, so another owner's deep tree can't block it (Opus r7
   3); the seat's own mounts are force-unmounted first (Opus r7 4); world-writable directories setup found on the
   machine are swept too (Opus r7 6). A create and a destroy of the same id never run at once (the ledger holds each id
   for one operation: Codex r7 HIGH 1); a process surviving SIGKILL stops the destroy before any sweep or account
   deletion (Codex r7 MEDIUM 2); an interrupted create's home is recognized and removed (Codex r7 MEDIUM 4); ids are
   recorded durably by the daemon before it asks, and at every start (whenever the helper is installed, whatever the
   seats settings: Kimi r11 LOW 2) it destroys the ids the helper still holds for
   it (Codex r7 MEDIUM 3); each id belongs to the person whose daemon asked for it (sudo's `SUDO_UID`), so one
   person's daemon can't destroy another's seat users. **What that protects**, with the person's home closed to other users (`chmod 700 ~`, required
   unless `--accept-readable-home`): the person's Walkie (the daemon's socket and `local.token` are in its `0700` home:
   before seat users, a seat connected to that socket by path and acted as the person, Opus r2), the person's home and
   files in it, **other seats** (their homes, tokens and processes belong to other users, Codex r3), **later seats**
   (nothing of a user survives it: no home, no file of it in the places above, no schedule, no launchd job, and its
   uid never comes back; named POSIX shared-memory objects a seat creates may outlive it, since macOS can't list them,
   but later seats run under other uids, Codex r6 MEDIUM 7), and **lifecycle control**: busy stops every process of the seat's user (`kill(-1)` as that
   user, verified; said paused only once verified, Codex r4 MEDIUM 6, Codex r5 MEDIUM 3), and ending a seat destroys
   its user, so neither `setsid`, detached workers nor killing or stopping its own runner lets a seat outlive it (Codex
   r3 HIGH 1, Opus r3 HIGH 2). A destroy that can't be verified is reported ("its processes or files may remain") and
   the user quarantined and retried, never reused; a runner that dies early is reported as lost control and its user
   destroyed. Deny is processed before anything else (Codex r4 MEDIUM 3). **What a seat still reaches**: the network, its own home, anything on the machine every user may read
   (system files, other users' open homes, `/tmp`), the seats' own `0666` socket (useless without a live per-seat
   token), and **the machine's own Claude login**, which Claude seats run on by default (its token in their
   environment, or its credentials file in their per-run config, `0600`, gone with the user; a login only in the
   Keychain can't be handed over, and Claude seats then say to set a token, Codex r5 LOW 7): a running seat can read
   it and so use the person's subscription while it runs; `walkie seats token set` gives seats a token of their own
   instead (recommended). Codex seats likewise run on the machine's own Codex sign-in. A sign-in handed as a file is
   an **access-token-only copy** (SEATS-FIX-8, Opus r8 2): Claude's `.credentials.json` without its refresh token (not
   handed at all within 10 minutes of expiry), Codex's `auth.json` without its refresh token or any API key, `0600` in
   the run's fresh config and gone with the user. So a seat can't refresh (and so can't sign the machine out where
   refresh tokens are single-use), and what it can read lives only as long as that access token (hours for Claude's;
   Codex's as its provider sets). A dedicated `claude setup-token` token (`walkie seats token set`) is long-lived and
   readable by every running seat: it is the seats' own, revocable separately. The seats channel is allowed on every
   plan because it is no general restricted channel: every replica accepts in a `seats-<node>` channel only seat
   requests (`run`/`stop`, their text exactly the daemon's fixed format, no mentions or artifacts; no asks or answers
   at all: Opus r9, Codex r9 MEDIUM 2) and the host daemon's own posts and shares (SEATS-FIX-8, Opus r8 1, Codex r8 MEDIUM 4); a
   repo bundle travels with the request that names it, not as a share; and the Free exemption needs an active machine
   of a current member, that member in the channel and every member current. The authority can't check the host's
   opt-in or its launchers (they are the host's local settings): other members of the channel can only send seat
   requests, which the host refuses unless they are its launchers. An agent's launch or stop must name the agent
   (an unnamed one, marked by the CLI, is refused locally, so it never acts as its person: Codex r9 MEDIUM 1); nothing
   may register as a sub-agent of the host's `seats` card (Opus r9 LOW), and a seat running as the person
   (`--same-user`) is never published by process discovery (Opus r9 LOW). The helper's list of seat users it still
   holds is read before the first seat user is made, however seat users came on (at start, or later through `allow`:
   Codex r9 MEDIUM 4), and a sweep whose access check fails for any reason but a denial is not verified (Codex r9
   MEDIUM 3). **Seats and compute sharing are never on together
   on one machine** (Opus r9 HIGH): a split run's `rpc-server` (a stage served here) and `llama-server` (a run headed
   from here) listen on loopback, can't tell users apart and have an open code-execution bug (CVE-2026-78147, see
   "Split runs"), so a seat user connecting to one would run code as the person. The daemon enforces it both ways,
   with the same refusal (409 `seats_pool_conflict`: "seats and compute sharing can't be on together on one machine:
   seats run other people's agents as separate users, and the shared model server can't tell users apart", plus
   which one to turn off): while seats are turned on (`seats.allow`, whatever their isolation) **or anything of a
   seat may still run** — a seat or a queued launch, a deny still stopping them, a seat user not verified removed
   (quarantined or being destroyed), the helper's list of seat users not read yet while seat users are on or one is
   still held (Codex r10 HIGH, Opus r11 LOW), or the daemon still starting and not yet having read `seats.json`
   (fails closed: Opus r11 MEDIUM) — sharing can't
   be turned on, no stage starts (a running one is stopped by the stage watchdog), no run is headed and the machine
   publishes itself as not sharing, and a run already going is stopped by the run's own watchdog; while sharing is on, a stage or run is running, or any `llama-server` /
   `rpc-server` this daemon started (or is starting) still runs, seats can't be allowed and no seat launches (a head
   stopped while its server was starting stops that server when it appears: Opus/Codex r10 MEDIUM). A `config.json` edited to have both runs neither. `walkie seats enable` and `walkie pool share on`
   say which to turn off before they do anything; `walkie seats doctor` shows it. **Known limits:** Linux seats are not verified yet (the runner makes itself non-dumpable,
   `PR_SET_DUMPABLE 0`, so other processes of its user can't open its `/proc` descriptors, best effort, Opus r4 MEDIUM
   3); ACLs are read with `ls -led`/`getfacl`, and ACLs above the home or on other places the person keeps files aren't
   inspected; there is no CPU, memory, process-count or disk quota per seat (Codex r4 LOW 7); Codex seats as seat users
   have no sign-in of their own yet; the sweep covers the places above (not files in other mounts, in world-writable
   directories elsewhere, or in another user's directory it could write but not list; not named shared memory, which
   macOS can't enumerate; on Linux it sweeps `/dev/shm` as the seat user); the sweep's libc layouts are checked against
   node:fs on the machine before it runs and verified only on macOS arm64 so far; the helper, launchd bootout, crontab
   removal and the sweep as a real seat user were checked with fakes and must be proven on a real Mac (INSTALL.md §8).
   The helper and runner start with cwd `/` and a fixed environment, and the release binary never autoloads a
   `bunfig.toml`, `.env`, `tsconfig.json` or `package.json` from where it runs (Opus r6 LOW 3). Each new seat user is checked by number: uid 600000+n, none of its effective groups (primary and supplementary) the
   daemon's primary group or an administrative or shared one (the seats' own group aside); administrative groups that
   can't be read stop seats rather than being guessed (Codex r3 MEDIUM 4, Codex r4 MEDIUM 4, Codex r5 MEDIUM 6); cron
   and at deny files are parsed exactly as cron does, an ambiguous entry refused (Codex r5 MEDIUM 4).
   Inspection errors (a home, an ACL, a scheduler file that can't be read) are reasons not to run; the runtime copies
   are checked like the runner before every launch and the permission probe runs as the seat user (Codex r4 MEDIUM
   5). The runner and every directory above it must be root-owned
   and not group/other-writable (checked at setup and before every launch, Codex r3 LOW 6), and the sudoers file is
   checked by `visudo` after it is installed. Isolation is decided from `config.json` and the OS at start, at every
   change and **before every launch**: a configuration enabled before seat users existed runs nothing until the person
   sets them up or consents to same-user mode (Codex r3 HIGH 2). Without seat users (the company default on a new machine,
   explicitly consented to in the CLI or dashboard) a seat runs as the person: it reaches their
   Walkie by path and everything they can, including SSH agents and anything it installs to outlive a stop (a
   LaunchAgent, a `setsid`'d process, cron); opt in like that only on machines, and for launchers, you would hand a
   terminal to. The seats' socket then lives in a fresh, unpredictable `/tmp/walkie-seats-<uid>-<random>` directory of
   the daemon's (0711), checked before every launch; no seat starts while it isn't listening there (Opus r3 LOW 5).
   The runner refuses an input line over its limit before reading it (Codex r3 LOW 7), reaps the runtime's group as
   soon as the runtime exits (Codex r3 MEDIUM 5), and honours its test-only overrides in source builds only. A seat's
   token is a `0600` file named by `WALKIE_SEAT_TOKEN_FILE`, never in its environment, removed on every way out.
   Mitigations inside Walkie: **opt-in** is local
   to the host (`config.json`, written only by `POST /v1/seats/config` without an agent header; the CLI refuses
   `allow`/`deny` under an agent's session marker) and **revocable at any time**: `walkie seats deny` and a local
   `walkie seat stop` work for the machine's person whatever the roster says (removed, revoked, observer), and stop a
   seat in every phase (preparing, running, post-run git) before they return; a host that stops being an admitted,
   non-observer member ends its seats itself; a daemon that died with seats running ends every survivor of their
   process groups at its next start (the runtime only if its pid and start time still match, so a reused pid is
   never signalled; once the runtime has exited, the members left in its group). **No person-level access through
   Walkie:** a seat never gets the host daemon's socket or home; its `WALKIE_SOCKET` is the seats' own socket and
   its `WALKIE_SEAT_TOKEN` a per-seat credential the daemon issues at spawn and revokes when the seat ends, bound to
   the seat's agent name `seat-<id>` (the caller can't omit or change it), good only for posting in the seat's own
   thread of the host's seats channel; the host's own local API refuses `seat-*` names. **Who can launch** is
   decided on the host at request time, never trusted from the request: an allowed launcher (the owners and their
   agents at that moment, or the host's named list), signed by that person's own admitted machine. `@h` covers h
   and every agent h runs on an admitted machine; `@h/<machine>` covers h and their agents only there. Allowing a
   person this way trusts all of their agents to launch and stop seats; to allow fewer, name exact
   `@h/<machine>/<agent>` entries. An agent's request (the CLI names the agent under Claude Code, Codex, Kimi…;
   the local API takes `X-Walkie-Agent` as authorship) stays an audited post naming that agent. Observers, a
   mismatched author node or handle, and seat agents are refused; a seat agent needs its own exact entry.
   **The host itself** must be an admitted, non-observer member when it judges a launch and again just before it
   spawns (a demoted host starts nothing, Codex r2 HIGH 1). **Stopping** is for the seat's own launcher or the host's
   person (another launcher can't end someone's work, Opus r2 LOW 4); the host person's local stop, like a revoke,
   aborts the post-run git. **Deny always stops**: seats end before `config.json` is written, and a failed write is
   reported, not a reason to keep them running (Codex r2 MEDIUM 3). Preparation is cancellable throughout (the
   seat env file's sourcing and the capability probe are killed as process groups, the bundle fetch is abandoned, Codex
   r2 MEDIUM 2); a failure's text is redacted whole before it is cut (Codex r2 MEDIUM 4); the seats' socket checks a
   token again after reading the body and refuses a seat that is concluding (Codex r2 LOW 5).
   Requests are **judged once**, the decision persisted before anything runs (nothing runs if it can't be, and no
   decision is forgotten while its request could still be accepted), and only while fresh (at most 10 min old and
   2 min ahead of the host's clock), so a held, replayed or pre-dated request doesn't fire later. **Capacity:** at
   most 3 seats run on a machine by default (the person's `max`, 1–64), each launcher at most its own
   `max_concurrent`, 10 launches a minute. **Who can see** prompts and output: only the members of `seats-<node>`,
   which the authority lets only the host's person create or change (restricted, keeping that person, current
   members only; an owner can't widen it) and which the host refuses to use, posting nothing, while it holds anyone
   but its person and the launchers' people. **Injection:** the prompt is data on the child's stdin (never argv,
   never a shell), the host parses requests from the strict `seat` field only (a post's text, or a `seat` field
   smuggled through `/v1/post`, which the local API drops, never starts anything), the seat's system prompt says
   teammates' text is information, and hooks, the MCP push and `/v1/status` leave `seat-*` agents alone, so
   teammates' asks aren't injected into a seat and no team-wide status carries its prompt or tool arguments; the
   host's own `seats` status is generic. **Environment and billing:** the seat's environment is an allowlist
   (`PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `LANG`/`LC_*`, `TERM`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`
   and the names the person lists in `seats.env`; the two login-location variables let the machine's seat environment
   point same-user seats at a worker login such as `~/.worker-claude`, away from the person's own `~/.claude`, and a seat
   user's runner always overrides both with that run's fresh directories), so GitHub, cloud or database credentials in the daemon's environment or
   the seat env file don't reach it (files in the home still do, above); no `ANTHROPIC_*`, OpenAI/Codex or other
   provider's API key or endpoint ever passes, so it runs on the host person's subscription. When a fallback uses
   the person's provider home, its own settings (including `apiKeyHelper` or settings `env`) can still apply.
   Grok seats deny Read/Edit calls to the linked Grok home and the person's Grok, Claude, Codex, Kimi and Hermes
   credential directories. Credential-shaped Grok output stops the seat before that output is posted, with an audit
   event. These checks are defense in depth: a same-user seat still has the person's file access and can evade tool
   rules through other paths or transformations. Only trusted launchers should be allowed for same-user seats.
   **Busy ("I'm using this computer")** is the host's person's control only: `POST /v1/seats/busy`/`resume` refuse
   `X-Walkie-Agent`, the CLI refuses under an agent's session marker, and nothing in the seats channel sets it (the
   host acts only on `run`/`stop` requests; readers trust a host's `op: "host"` availability post only from that
   host's own daemon), so a launcher or a teammate's agent can't pause, queue or un-pause anything on someone else's
   machine; only with `--same-user` could a running seat reach its host daemon's own socket by path and call `resume`
   (a seat user can't). Pausing a seat user's seat is `SIGSTOP` of every process of that user, re-applied every 2 s
   while paused (a `setsid`'d process is paused too); with `--same-user` it is the seat's process group, which a
   detached process leaves. A paused seat keeps its memory, files and open connections. Stops,
   revokes, shutdowns and the loss of admission still end paused seats (continued first, then the group is killed)
   and queued launches (answered, never started); a queued launch is judged again (launcher, runtime, opt-in) before
   it starts, since it may wait for hours; at most 32 wait, and they count against the launcher's rate.
   **Output** is scrubbed of secrets before it is posted (tool lines redacted whole, then shortened), capped (200
   posts per seat) and rendered by the dashboard's hardened Markdown renderer (React elements only, per-message
   error boundary); states and output count only when posted by the host node's own daemon. **Results:** commits
   come back as a git bundle artifact (not scrubbed: what the seat committed is what the launcher gets). Every git
   call the host makes runs in its own process group with no system or global config, and after a seat ended the
   host never reads its repository's config: HEAD is read from the files and git runs in a scratch git directory of
   the host's over the seat's objects, index copy and work tree, so hooks, `core.fsmonitor`, filter/diff/merge
   drivers, `core.sshCommand`, credential helpers and `include`/`includeIf` a seat planted never run, and the host
   person's global filters (e.g. LFS) don't run at the clone. Limits: the channel rule is enforced by the authority
   when it signs (replicas don't re-judge history), so a pre-seats or modified authority doesn't enforce it (the
   host's fitness check still keeps new output out of a widened channel, but what the channel already held is served
   to anyone it adds); agent detection in the CLI is by environment, not proof (an agent that clears every marker
   speaks as the person); a seat can reach the host daemon's own socket and token by path (same OS user, above); a
   process a seat detaches from its process group (`setsid`, a LaunchAgent) survives a stop; the fitness check counts
   people, not their agents (every agent of a launcher can read the channel).

## Mixed teams (v0.2)

One team may hold Tailscale-only machines, Direct-only machines (joined with an invite code) and dual machines
(`walkie direct enable`: both listeners). PROTOCOL §4 "Mixed teams" has the rules; what they defend:

- **Each listener keeps its own gate, keyed on what that transport authenticates.** Over the tailnet: the whois
  login, the record's login and pinned source address, and the record serving Tailscale. Over Direct: the
  QUIC-authenticated key, compared in full with the record, and the record serving Direct. Neither gate accepts the
  other transport's proof, so:
  - a Direct key can't pass as a Tailscale machine: the node id is a digest of the key and the gate compares the
    stored key; `X-Walkie-Node` must name the connection's own node; a roster request must be signed by, and name,
    the calling node;
  - a tailnet caller can't pass as a Direct-only machine: that record serves no Tailscale and has no pinned address;
    a whois login shaped like a Direct login (`direct:…`) is refused; and a Tailscale `/join` naming a Direct-only
    machine's key is refused, so nobody can re-pin an invited machine to a tailnet address (Tailscale joins never
    prove possession of the key they name);
  - a Tailscale machine's key gets Direct access only after proving it: a Tailscale join records a key without a
    proof of possession, so a member could have named a key that isn't theirs. Such a key is refused at the Direct
    gate until the key itself completes a QUIC handshake to the authority and `/join`s (no invite needed: it is
    already admitted), which appends a re-pin adding `"direct"`; the login, address and key stay as they were.
- **Removal and revocation close both doors.** A removal revokes every node of the member; the tailnet gate refuses
  each later request (there is no session to close), and the Direct side closes the machine's open connections at
  once, idle ones included. The removal is pushed to the machine it cuts off by the authority, which reaches it.
- **Budgets.** Everything on the Direct side (rate limits, per-source, per-network and per-member handshake budgets,
  connection caps) applies to Direct-only and dual machines alike; a dual machine's member budget groups it with
  the member's other machines by login, as on a Direct team, and a Tailscale-only machine's key counts as a
  stranger's there.
- **Relays are ordinary peers.** A dual machine that pushes an event on to the peers its origin can't reach, or
  fetches an artifact from its uploader for such a peer, hands over only what it would serve anyway: events are
  verified end to end by their origin's signature on arrival, restricted channels get stubs, and artifact bytes are
  fetched only for an accepted share the caller may see and must hash to the share's hash. It relays one hop only
  (an event pushed by its own origin; bytes only from a share's origin), so relays can't loop. Relayed liveness
  (`vv.online`) is display only and comes only from a peer this machine just synced with.
- **The authority stays reachable.** Invite codes need a Direct-serving authority, and a transfer to a machine some
  active machine can't reach is refused before it is emitted or requested (`409 authority_unreachable`). This is a
  check in honest daemons, not a chain rule (v0.1 machines must keep accepting the chain): a modified owner daemon
  can still transfer to an unreachable machine, cutting the other side off from roster changes until it is moved
  back, as it could already stall a team by going offline.

## Split runs (WALKIE-POOL-2, hardened in POOL-3)

One model split across several machines with llama.cpp RPC (PROTOCOL §3 "Split runs").

> **Sharing lets every non-observer teammate machine that heads a run send data to a program that has had
> code-execution bugs. Only share with people you trust with your computer.** (The same words appear when you run
> `walkie pool share on` and under the dashboard's share switch.)

**Residual risk, plainly: the guard allow-lists op types and message shapes; parameters of allowed ops are passed to
llama.cpp unchecked; sharing gives teammates' machines a path to code with a history of memory-safety bugs; only
share with people you trust with your computer.** (POOL-5 adds two cheap shape checks, below, and nothing more:
anything that would need data-dependent checks, such as row indices, `op_params` meanings or per-op source
consistency, is not attempted.)

llama.cpp's `rpc-server` has NO authentication, lets its client allocate and write device memory, and has had
unauthenticated remote code execution bugs: CVE-2024-42479 (fixed b3561), CVE-2026-34159 / GHSA-j8rj-fmpv-wcxw (fixed
b8492), and **CVE-2026-78147 / GHSA-f4vj-w5xq-5xph, published 2026-08-23, which is NOT fixed in any release**: the
upstream issue (ggml-org/llama.cpp#25289, a controlled indirect call through a custom op's function pointer in
`op_params`) was closed "not planned" on 2026-08-18 and the pinned b11205 (2026-09-26) still copies `op` and `op_params` off
the wire unchecked (`rpc_server::deserialize_tensor`, ggml-rpc.cpp:1417, read at the b11205 tag). Issue #25299 (a crash via graph node id
0) is likewise unfixed. So Walkie defends in layers:

- **Loopback only, no new port.** `rpc-server` and `llama-server` bind 127.0.0.1 on random ports; the head's tunnel
  listeners too. Bytes between machines cross Walkie's existing authenticated transport (a Walkie Direct QUIC stream,
  or a WebSocket on the existing peer API port), after the ordinary peer gate. Verified with `lsof` in
  test/integration/pool-split-real.test.ts and pool-security.test.ts.
- **The RPC guard (allow-lists, POOL-4).** The worker parses the head's bytes before rpc-server sees them and lets
  through only what llama-server sends: allow-listed commands at their exact struct sizes, and tensors whose op is
  one of the 26 ops observed in real runs of the catalog's architectures (llama, Qwen3, Phi, gpt-oss, DeepSeek;
  PROTOCOL §3 "RPC guard" lists them). Custom ops (the CVE-2026-78147 primitive), training ops, every other op,
  node id 0 and a first message that isn't HELLO close the tunnel; HELLO's transport capabilities are zeroed so
  nothing is upgraded to RDMA off the tunnel. The guard is written against b11205's wire format, so a stage starts
  only if the rpc-server executable and its RPC library hash to the pinned b11205 files, and only after the guard
  passes its self-test. It narrows what reaches rpc-server; it does not make rpc-server safe: allowed ops still
  run upstream code on data the head chooses (below). The warning above stands.
- **Shape checks (POOL-5).** Two checks legitimate llama-server graphs never trip (every measured model ran through
  them): a leaf tensor (op NONE, not a view, non-empty, non-null) must be laid out contiguously for its type
  (type sizes and block sizes read from b11205's libggml-base), and a view whose source is in the same message must
  fit inside it (view_offs + its strided byte extent ≤ the source's extent, the invariant ggml asserts when it builds
  a view; rpc-server copies view_offs unchecked). Not checked: `op_params` of allowed ops (e.g. CONCAT's dimension,
  ROPE's parameters), `nb[]` of non-leaf tensors, whether an op's sources are present (a missing src is a null
  dereference, i.e. a crash), and anything read from tensor data (row indices of GET_ROWS / SET_ROWS / ADD_ID).
- **What the guard relies on upstream (b11205, ggml/src/ggml-rpc/ggml-rpc.cpp).** Offsets and sizes are not checked
  by the guard; rpc-server checks them: `deserialize_tensor` refuses a type ≥ GGML_TYPE_COUNT or with block size 0
  (1380-1389), drops a buffer handle it didn't allocate (1404) and asserts the tensor's data lies inside its buffer
  (1408-1414, an abort, i.e. a crash not an overflow); SET_TENSOR checks its header size (1433) and that data +
  offset + size stay inside the buffer (1456-1464); SET_TENSOR_HASH likewise (1527-1537); GET_TENSOR (1596-1606);
  MEMSET_TENSOR against the tensor (1347-1351) and the buffer (1360-1365); COPY_TENSOR that the destination buffer
  holds the source (1637); a graph node with data but no known buffer is refused (1675). Not checked upstream:
  `view_offs` is copied as is (1708), and the index-driven ops on the allow-list (GET_ROWS, SET_ROWS) read row
  indices from tensor data at compute time: the CPU backend asserts them; whether the Metal and CUDA kernels bound
  them is [UNCLEAR]. The guard does not track buffers from ALLOC_BUFFER replies to re-check offsets itself (all
  the checks above exist upstream in this build).
- **Least privilege for the child.** rpc-server gets a minimal environment (no daemon variables, tokens or keys), a
  private HOME deleted at the end, and no disk cache (`-c` is off).
- **Opt-in per machine, by its person.** Sharing is off by default and published to the team; a worker refuses a
  stage while it is off, cancels one that is still starting, and kills a running one the moment it is turned off.
  Since AGENT-ADMIN-1 an agent of the machine's person may turn it on, start or stop a run while that person's agent
  admin switch is on (audited to #general; "Agent admin and remote admin" below); pairing a phone stays person-only
  (the pairing code is a credential). The same gate covers serving a model, connecting to one and preparing
  weights (POOL-REAL-1); installing the pinned, sha256-checked runtime also needs a NAMED agent (`403 agent_unnamed`).
  Same boundary as invites: a process that omits the header on the owner's own socket is the owner's own process.
- **Only the run's head, only while it runs.** A tunnel is accepted only from the node that started the stage, while
  its lease lives (renewed every 10 s, 45 s max) and while that node may still head a run (not revoked, member not
  removed, not demoted to observer), capped at 4 open (slots reserved at grant time) / 20 new per minute.
- **Memory.** Daemon memory per stage: at most 4 tunnels x (8 MiB credit window + 16 MiB graph buffer) = 96 MiB
  (the largest graph measured in real runs was 0.43 MiB). The worker measures its own free memory at admission: a stage gets at most min(cap, free − 1 GiB),
  whatever the head claims. Each tunnel end queues at most 8 MiB (the WebSocket credit window; a peer that ignores it
  is disconnected), in both directions, so a hostile head or worker can't grow a daemon's memory. Bytes into
  rpc-server are metered (burst = budget + 1 GiB, then 64 MiB/s). A best-effort watchdog stops a stage whose
  rpc-server's RESIDENT memory passes the budget by 10 % + 512 MiB; NVIDIA VRAM isn't resident memory, so there the
  admission check and the head's sizing are the limit.
- **Nothing outlives the daemon.** rpc-server and llama-server run under a supervisor that kills them when the
  daemon's pipe closes (a SIGKILLed daemon included), and a restarting daemon reaps recorded children that still run
  as recorded (PID + start time + name; never a reused PID). Every kill after the child may have been reaped (the
  supervisor's watcher, the daemon's grace SIGKILL) re-checks the PID's start time first (and its name, where the
  daemon has it). Verified by SIGKILLing the daemon by PID in
  test/integration/pool-orphans.test.ts, with a real llama.cpp run too.
- **Local processes.** On a worker, any local process of any user can connect to rpc-server's loopback port while a
  stage runs (llama.cpp gives no way to authenticate it); on the head, local processes can reach the tunnel listeners
  until the run serves (then new connections are refused) and the OpenAI endpoint with the key file (0600). Split runs
  assume single-user machines, like the rest of Walkie's loopback surface. **So no pool process runs on a machine
  that allows remote seats** (threat 16; Opus seats r9 HIGH): seats run other people's agents as other OS users on
  this machine, and any of them could reach these loopback ports. The daemon refuses sharing, stages and run heads
  while seats are on or anything of a seat may still run (a deny still stopping them, a quarantined seat user), and
  refuses seats while sharing is on, a stage or run is running or any model server it started still runs (409
  `seats_pool_conflict`, naming which one to turn off; threat 16).
- **Supply chain.** The llama.cpp build and the catalog GGUF files are pinned by sha256 (release asset digests; Hugging
  Face repository revision + LFS object id) and checked before use.


## Served models (POOL-REAL-1)

A model one machine serves whole on its GPU (PROTOCOL §3 "Served models"). Unlike a split run, no teammate's bytes
reach llama.cpp's RPC server: members send OpenAI-style HTTP requests, which reach llama-server only through an
allow-list proxy on the serving machine.

- **Consent.** Another machine may start a model or connect only while the serving machine's owner shares it
  (`walkie pool share on`, the same switch and warning as split runs); turning sharing off drops every other
  machine's connection at once and stops a model another machine started. Seats on the machine stop it. Starting,
  stopping, connecting and disconnecting are admin (AGENT-ADMIN-1): the person, or an agent of theirs while agent
  admin is on, audited.
  Once connected, any local process on the connecting machine that can read the key file can use the endpoint:
  that is the point (agents use it), and it is why the key file is 0600 in the person's Walkie home.
- **What reaches llama-server.** Only `GET /health`, `GET /v1/models`, `POST /v1/chat/completions`,
  `POST /v1/completions` (bodies ≤ 4 MiB, ≤ 4 in flight per key). Not reachable: `/slots` (other clients' prompts;
  also `--no-slots`), `/props`, `/metrics`, LoRA, tokenizer, infill, the web UI (`--no-webui`). The prompt text and
  sampling fields are passed to llama-server's HTTP/JSON parser and chat template as they are: a member can make the
  serving machine's GPU work (bounded by the in-flight cap and the 8K context) and could reach bugs in that code.
  Share only with people you trust with your computer.
- **Keys.** llama-server's own key never leaves the serving daemon; each connected machine gets its own key (dropped
  on disconnect, lease loss, sharing off, or the member being removed or made an observer); the serving machine's
  person has a local key file. Requests with another key are refused before anything is forwarded.
- **Loopback and the tunnel.** llama-server and the proxy bind 127.0.0.1; members reach the proxy only through
  Walkie's authenticated transport, only after `connect`, ≤ 8 tunnels at once and 60 new a minute per machine.
- **Files.** Only catalog models with pinned revisions and sha256 (never a path from another machine); downloads
  resume after a broken connection and are checked whole before use.
- **Resources.** One served model per machine, never alongside a stage; it must fit the GPU memory free now (the
  owner's cap applies to another machine's start); no request for 30 minutes stops it.
## Projects (WALKIE-PROJECTS-1)

Boards are folded from ordinary signed channel posts (PROTOCOL §10), so every existing defence applies to them
unchanged: signatures, authorship, channel membership, observer read-only, stubs for non-members, the hidden cap, rate
limits. What the Projects layer adds:

- **Private projects are the owners'.** A private project is a restricted channel whose members the roster authority
  keeps equal to the team's current owners (promote and they gain it, demote and they lose it: the next posts are
  stubbed for them; what they already received stays on their machine, as for any restricted channel). Removing a
  member also drops them from every restricted channel (design F10), archived ones and ones left with no member
  included, as part of the removal itself (the authority signs the channel entries in the same call, before any later
  roster event), so a re-invite, however soon, doesn't hand back channels they used to be in. Memberships left over
  from removals before this version are cleaned while the member is still removed (the authority's reconciler); one
  removed AND re-invited before the upgrade can't be told apart from a deliberate re-grant. A demoted owner's agents: their
  statuses are theirs; statuses never carried the private keys. A non-member sees that a private project exists (the roster names the channel and its members),
  nothing else: its name, cards and history are stubs.
- **Opaque channel names.** `p-<8 random hex>`: a project's name never reaches the roster (every member sees channel
  names); the `p-` prefix is reserved so nobody can pre-create or squat a project channel through a post or
  `/v1/channels`.
- **A project can't be taken over.** Only the channel creator's first project root counts; a second root, or a
  settings change by anyone but the project's creator and the owners, is ignored by every replica (and refused early by
  the local API). People-only actions (settings, visibility, automations, archive, delete / restore, board changes,
  deleting cards, moving or reassigning a person's card, export) are refused to agents at the API AND (except
  export, which signs nothing, and automations at creation) ignored by the fold, so an agent that signs such an op
  directly changes nothing. Since pre.5 (AGENT-PROJECTS, fold 8) a NAMED agent may create a project or add a board
  for its person, as in Linear: its person becomes the creator and keeps every admin right; the agent is held to
  the person's plan limits (Free: 1 project; boards past the included three consume the team's bought add-on
  boards), may create a private project only when the person is an owner, can't set automations or path / repo rules at creation, and
  writes at the lower agent rate. An unnamed agent caller is refused before any channel is created. Risk accepted:
  a prompt-injected agent can create projects and boards up to those limits (visible, attributed to the agent,
  deletable by its person).
- **Nobody can pin a field.** Ops are ranked by their causal parent (PROTOCOL §10 "Convergence"), never by a number
  the author picks or a timestamp: backdating or future-dating changes nothing, ops arriving later never lift an old
  one, and an op can't be pre-signed to out-rank a future one (it would need that op's signature). Chaining one's own
  ops from one machine gains no rank (a person's other machine counts as anyone else); two colluding members (or
  machines) alternating ops can still out-rank a concurrent edit, and among ops of
  equal rank the tie-break (origin, seq) is fixed. The next change by anyone who saw a change always wins. A member
  removed later doesn't take down the accepted edits others built on theirs (hidden ops carry rank).
- **Cross-channel replies are nothing.** A card is folded from posts in its own channel only: a member who learns a
  private card's id (stubs carry ids) and replies to it from a public project changes and removes nothing.
- **Key numbers can't be poisoned, and aren't identities.** A proposed number more than 100 past the highest kept
  before it is renumbered, and a card op is validated before it is signed (a refused card leaves no post). Keys are
  labels that can change (concurrent, offline or backdated creation); the card id and its short id never change.
  Automation and tools resolve a reference (`WEB-12-7f3a09c1`) by its short id against the card ids (8 hex of
  sha256; the key part is advisory), and a bare key is refused with the candidates whenever another card holds,
  proposed or held that number, so nothing acts on a card because a key moved. A member can still grind a card
  whose short id matches another's (about 2^32 tries: new node keys offline, then an admitted node, or burnt seqs);
  that makes the reference ambiguous, and it is refused rather than resolved to either card.
- **Hidden board ops: bounded, and never dropped while curable.** Only a board op whose rejection is final (anchored)
  can be reduced to a header stub, and only past the lowest 20 000 per origin per project channel, so replicas that
  learn a cure (an add, a readmission) in different orders keep the same rows. Curable ones are kept in full up to
  64 MB per origin per project channel; past that new ones are refused unstored and offered again later. Every
  replica stores these, non-members of the project too (a row rejected for a roster reason, such as an author who
  isn't in the channel, is kept in full on every node so it can be re-judged). So one member can make each other replica store, per project channel: up to 64 MB of
  curable board ops plus 20 000 final ones of at most 16 KB each (about 320 MB) — until an owner removes them and the
  authority's chain anchors their rows. Board ops over 16 KB, or not schema-valid, are ordinary posts under the general
  hidden cap (1 000 per origin).
- **Private card keys stay out of statuses.** An own agent's status never carries a private project's keys (any
  prefix it ever had): `PREFIX-<digits>` as a whole token, with a reference's short id (`PREFIX-<digits>-<8 hex>`,
  which hashes a card id non-members see in stubs) masked with it, drops task / branch and is masked (same length) in
  every other text field before signing, and every key-shaped token while the index rebuilds. Private projects get an
  opaque prefix by default, so the forms the scrub misses (`layoff-4b`, `wt/layoff1`, zero-width splits, a key in a
  commit message) reveal nothing readable; a person who picks a readable prefix is warned. Statuses peers received
  before a project became private can't be recalled.
- **Legacy `p-` channels are left alone.** Only a channel created with the projects marker is a project channel; the
  authority refuses new unmarked `p-` channels, so an upgrade never rewrites the members of an older `p-…` channel,
  which stays an ordinary channel managed through `/v1/channels`.
- **agents_can_close is a guardrail, not a boundary.** The local API refuses an agent's move into (or card created
  in) a done column while it is off; a member's machine could sign the same op without an agent name, so the fold
  doesn't pretend to enforce it (and never re-judges an accepted op when the setting changes).
- **Secrets.** Titles, descriptions, labels, comments, block reasons and project names are redacted before they are
  signed (the post redactor, config `redact`); card text reaching a model is wrapped (§6 wrapper) by the MCP tools and
  by the CLI under an agent. A card assignment to an agent is a wrapped mention: information, never an instruction;
  agents are told never to start a card their user didn't ask for.
- **Exports** are for people only; CSV cells that would start a spreadsheet formula (`= + - @`) are prefixed with `'`.
  The NDJSON export is the signed posts as signed (verifiable against members' keys), visible ones only.
- **Limits.** Card keys are not stable across concurrent creation on two machines (the later card is renumbered):
  scripts should keep card ids. When a member unknowingly reuses a private project's prefix, the earliest created
  project answers to the shared keys; the other is reached by channel / card id. Plans and bounds (1 project on Free, 3 boards per project, 2 000 open cards per board,
  20 000 per project, 200 projects) are soft, checked where things are created, like every plan limit; a modified
  daemon can exceed them, and every other daemon still folds what it sends. The extra-board checkout is a stub until
  the site sells the add-on.

## Linear import (LINEAR-IMPORT-1)

- **The key.** The import uses the Linear integration's stored key when it is on, else a key file (`--key-file`,
  checked like an integration key file: a regular file you own, mode 600, no ACL, one token) or LINEAR_API_KEY, which
  the CLI hands to the local daemon over the socket or loopback for that one operation. The key never enters a
  response, a log line, the plan file, the import map (`~/.walkie/linear-import.json`, 0600) or a signed post: every
  Linear response and error is scrubbed of it (and of every configured key) before anything else sees it, and
  `/v1/import/linear/*` answers through the integrations scrubber. A scheduled sync keeps only a key FILE PATH, or
  uses the integration's key; LINEAR_API_KEY can't be scheduled.
- **Agents can read, not write.** A dry run (the plan) is open to agents (it reads Linear with the configured key, as
  `walkie_linear` lookups already do; project names in its agent output are defanged). Starting, resuming or
  cancelling an import, syncing, the schedule and `POST /v1/projects/:channel/batch` are people only: refused to
  agent-marked callers by the daemon, and to agent-marked terminals by the CLI first. The bulk path therefore can't
  be used to escape an agent's 20 writes a minute.
- **A person can't flood the team either.** Bulk writes take tokens from a separate import budget (10 000 ops per
  hour per person key; a paired phone has its own key), at most 250 ops per request, and the project bounds (2 000
  open cards per board, 20 000 per project, 200 projects) apply to the batch as a whole before anything is signed.
- **`ext` is not trusted from others.** The recovery that finds earlier imports by `ext`, and the adoption of an
  earlier script's `[ALE-12]` cards, consider only roots authored by the importing person. A teammate who forges an
  `ext` on their own card changes nothing: their card is neither updated from Linear nor written back.
- **Sync writes as the person who turned it on.** Imported cards and every sync change are signed by that person's
  machine without an agent name (an agent-signed move of a person's card would be ignored by the fold), so the
  scheduled sync acts for them while they are away, like the connectors post as them.
- **Two-way sync writes one thing.** Off by default; with it on, a card moved in Walkie sets its Linear issue's state
  (`issueUpdate {stateId}`), only for cards this person imported (the import map, or their own earlier script import
  adopted by its `[KEY-n]` title), only to one of the team's existing workflow states; titles, labels, assignees and everything else stay one-way. Anyone who can move a synced card changes the
  issue's state through the enabling person's key: that is the feature. When both sides changed a field since the
  last pass, the latest change wins (Linear's `updatedAt` against the card's) and the card gets a note naming both.
- **Linear data is external.** Every response is validated (zod), capped (8 MB per response, 200 pages per query),
  redacted with the post redactor before it is signed, and wrapped (§6) when card text reaches a model. The plan a
  person edits is a selection only: the run re-reads Linear and re-validates every field.

## Data Room (DATA-ROOM-1)

A project's Data Room is built from the same signed events as everything else (PROTOCOL §10 "Data Room"): each file
is an ordinary `artifact.share` of its bytes plus a signed room op in the project's channel. What that gives, and what
the room adds:

- **Access is the project's, exactly.** The bytes are served only under the existing blob rule (an accepted share in a
  channel the caller can see, from a node with provenance), and the room ops and shares of a private project are
  restricted-channel events: a non-member (a member who isn't an owner) holds header stubs only, no file name, size,
  hash or bytes, and every room route answers 404 for a project it can't see. Tested end to end: a member's store,
  local API and a direct peer-API request for the hash all come back empty until the member is promoted.
- **Agents add and read; people curate.** Rename, remove / restore, pin / unpin and detach are refused to agents by the
  local API and ignored by every replica's fold (`person_only`), so an agent that signs such an op itself changes
  nothing (tested with a crafted op). An agent may add a new version of an unpinned file, never of a pinned one
  (`person_pinned`): pinned documents reach other agents' context, so only people put text there. This is judged
  causally, not by the order the fold happens to apply ops in: while a file is pinned, its current content (what
  agents receive) is the latest version a person added, or one a person's pin descends from (the pinner had it in
  view). An agent version signed without having seen the pin, or crafted to name a parent older than the pin, stays
  in the history flagged "not the pinned document" and is never sent as pinned text (tested with a crafted op). An unnamed agent
  caller is refused before anything is signed.
- **Pinned text reaching a model** (the MCP `walkie_task_start` result, `walkie task start` under an agent, the Claude
  hook's once-per-card context) is wrapped with the §6 wrapper (`trust="team-member"`, a note that it is reference
  material, not instructions), capped (16 KB per file, 48 KB in total) and redacted in that copy. Bytes fetched from peers for it are capped at
  32 MB per task start, counted on what arrives (not on the size a room op claims); a binary type is never fetched,
  and a large file of unknown type that this machine doesn't hold is listed "large: fetch it" instead of fetched.
  If the room can't be read, the agent gets one line saying so (the hook tries again on the next prompt). Risk accepted: a
  person who pins a document containing instructions gives every agent that starts a card that text as information;
  the wrapper, the note and the MCP instructions tell the model it is not an instruction, but a model may still act
  on it. Pin what you'd hand a new teammate.
- **Secret warning, not a filter.** Text uploads are scanned with the post redactor's detectors; a finding refuses the
  upload until a person confirms (dashboard "Upload anyway", CLI `--allow-secrets`); an agent is always refused. The
  scan is best effort (the redactor's limits apply; random-looking tokens alone don't warn; binaries and bytes past
  the first 4 MB aren't scanned; a single NUL byte in the first 64 KB makes a file count as binary, so it skips the
  scan), and a confirmed file is shared exactly as uploaded.
- **Removing is not erasing.** A removed file leaves the room on every replica, but its shares stay in the signed log,
  members can still fetch its versions by id, and machines that downloaded it keep the bytes. Old versions stay
  fetchable for the same reason. To get rid of a leaked secret: rotate it.
- **Where bytes live.** On the uploader's machine and every member machine that downloaded them (content-addressed,
  `blobs/<aa>/<hash>`, 0600). The room lists files whose bytes no online machine has; downloads then fail with "not
  available right now", as for artifacts.
- **Limits.** 1 000 live files per room, 100 versions per file, 25 MB per file: checked where files are added, like
  card limits. A modified daemon can sign past them; every replica's fold ignores a person's versions past 100 and an
  agent's versions past 100, counted apart (`version_limit`: agent versions, crafted ones included, never push a
  person's version out), and shows at most 1 000 live files that an agent created and nobody pinned (in create order,
  which the signer chooses; pinned files and files a person created always show), so the room stays bounded. Names are not
  unique on the wire: two machines adding a name offline make two files, and a name lookup that matches both is
  refused with their ids. A crafted room op may name any hash; its bytes are served only if a share of that hash is
  accepted in the same channel, so it can't reach bytes of another channel.

## Agent admin and remote admin (AGENT-ADMIN-1)

Walkie no longer makes a person do its setup. **A local agent can now administer Walkie on its person's machine**, and
**a team owner (or an owner's agent) can administer any team machine remotely over Walkie**, including letting
teammates' agents run there (seats). A member or observer, and their agents, administer only their own machines.

- **What an agent may do on its machine.** Everything its person could do there to set Walkie up: seats (enable, allow
  with `--same-user`, `--launchers`, `--max`, `--runtimes`, `--dir`; setup-user; busy; token), accounts (add, remove,
  policy, shims, borrow), pool (share, install, run, stop), hooks, integrations, orchestrator start/stop/status,
  invites and add-machine links, role changes, revoking the person's own machines, join approvals, project settings
  (automations, path rules) and card delete/restore, phone sign-outs, token rotation and dashboard sign-out. It is
  the same trust as before in fact (a process running as the person's OS user always could call the socket without
  the agent headers, "Known limits"); what changed is that honest agents are no longer refused, and every such action
  is recorded.
- **What stays a person's.** A dashboard login link and a phone pairing code (credentials shown in plain text),
  removing a member and revoking another member's machine, moving the roster authority, turning an admin switch
  back on, and a project's board steward switch and lease (FO-6: an agent may only dry-run the steward). Talking to the local orchestrator and reading its conversation also stay a person's (an agent's words would
  be read as the person's). There is no "delete the team" command.
- **Remote admin is not a shell.** One peer route (`POST /peer/v1/admin/run`) runs one allow-listed `walkie`
  subcommand (src/protocol/admin.ts), as the target machine's OS user, with stdin closed, a timeout (default 300 s,
  max 1800 s) that ends the command's whole process group, output capped at 64 KB per stream (drained for at most
  5 s after it ends) and redacted before it is cut and returned. A grandchild that calls `setsid` (or double-forks into
  a session of its own) leaves the process group and is not ended by that kill: none of the allow-listed commands do
  so, but it is a limit of the group kill. A running command also re-checks its caller every 30 s: demoted, removed,
  revoked, or the person switched remote or agent admin off, and the run ends (exit 125, `revoked`). The subcommand is read with the CLI's own parser and switch
  list, and the target runs the canonical form it checked (`[command, options…, "--", positionals…]`), so a leading
  option (`accounts --json exec`) can't hide a subcommand; `accounts exec` and `accounts trust-cli` are refused
  remotely by name and by the commands themselves. At most 4 remote commands run at once on a machine, 2 from one
  calling machine; a caller who may not administer the machine is refused before its request body is read, the body
  must arrive within 10 s, and the caller is looked up again in the current roster right before the command runs
  (revoked, removed or demoted in between: refused). The run's token and agent name are taken out of the environment
  before anything the command spawns (sudo, codex, claude, llama.cpp) could inherit them; options that read stdin or name a program (`--claude`,
  `--claude-token-stdin`, `--key`, `--bin-dir`, `-`) are refused, and the admin switches can only be turned off
  remotely. Options the machine's person sets there are refused too (round 3): `--env` on seats (which of the
  machine's variables, API keys included, its seats get), `--dir` on `pool install` (the default location only),
  `--permission-mode`, `--cwd` and `--access` on `orchestrator start` (or `talkie start`), WalkieTalkie's access
  switch (`talkie access`; switching its model stays allowed), `--key-path` on `integrations enable`, an owner
  invite (`--role owner`), and an invite or add-machine code for a current owner's handle (it would admit an owner's
  machine). `integrations enable wispr|fireflies` is refused remotely: those read the person's own meetings and
  dictation, and wait on the team's sharing decision; other integrations stay allowed. The target re-checks the caller from the peer API's own authentication (tailnet identity or Walkie Direct
  key → admitted node → roster member): owner, or the same handle as the machine's person. A pre-v0.2.0-pre.7 target
  answers 404 (`target_outdated`).
- **What remote admin can reach (an owner decision, Alex 2026-09-27).** A remote owner can do on a teammate's machine
  what that teammate's own agent could: install hooks, change the vault's policies, install llama.cpp, start or stop the
  orchestrator (with its defaults), configure integrations other than the private-data ones, share the machine's
  compute for split runs (`pool share on|off`), run pooled models (`pool run`, which moves the model files a run names
  into the team's stages on the sharing machines), and turn seats on for the team. **Remote seats setup by an owner is equivalent to letting that owner run agents as that person**:
  `seats enable|allow --same-user --launchers @owner --dir …` lets the owner (and every agent they run) start Claude
  Code / Codex agents on the teammate's machine, as fresh seat users or, with `--same-user`, as the teammate's own OS
  user with their files and their Walkie. This is on purpose (an owner's agents set up teammates' machines); the
  machine's person is mentioned on every such command in #general, and can refuse it at any time with
  `walkie admin remote off` (and turn seats off with `walkie seats deny`). Setting up seat users needs root: without a terminal it runs
  `sudo -n` and fails with a clear message when sudo would ask for a password, so remote admin never gets root that the
  machine's person did not already grant without a password.
- **Schedule writers.** Only the current roster authority signs schedule changes. The fold verifies its term and
  signed sequence window and rejects agent-authored changes; demoting an owner or revoking a machine never changes earlier schedule state.
  Other owners pass the local admin gate and forward a node-key-signed operation, body, audit id, requester id and
  timestamp over the rate-limited peer route. The authority derives the requester handle and hostname from its
  roster, verifies that node's signature and owner role, and checks cron and the 20-schedule limit before committing the change and
  audit post together. If it is offline, management returns `503` and does not queue a change. The reserved
  `#talkie-schedules` channel is repaired to exactly the current owners, including newly promoted owners. A process
  running as the owner's OS user keeps that owner's authority. Reset is local to the authority's person session.
- **Audit trail.** Every agent or remote admin action is appended to `~/.walkie/admin-audit.jsonl` (0600) on the
  machine it happened on and posted to `#general` by the reserved author `walkie-admin` (no caller may post as it),
  naming the actor as `@handle/machine/agent` (an unnamed agent: its runtime, "claude-code (unnamed)"). A remote
  action is posted once, with its command line (secrets redacted) and exit code, and mentions the target machine's
  person. Refusals are logged locally only. The dashboard's Seats page shows the newest entries.
- **Kill switches (per machine, the person's).** `walkie agents admin off` refuses agent admin on this machine (and
  remote admin with it, since a remote command runs there as an agent); `walkie admin remote off` refuses remote admin
  to this machine. Both are also toggles on the dashboard's Seats page. Default ON for new and existing installs
  (config.json without the keys reads as on; a config.json that can't be read reads as off). Off is sticky: an agent,
  or a remote owner, can turn a switch off but never on; on takes a person at that machine (a terminal confirmation,
  or the dashboard, never a phone). After the upgrade each machine posts one notice to its person saying all this and
  how to turn it off; the join page and the installer say it before anything joins.
- **Known limits.** Agent detection happens in the CLI only (markers, ancestor processes, `--for-agent`, no terminal):
  the daemon trusts the absence of the agent headers. It can't tell who is on the other end of its unix socket: Bun
  exposes no peer credentials (SO_PEERCRED / LOCAL_PEERPID) for an accepted connection, and its listener gives no file
  descriptor to ask with FFI (checked for this release; not implemented). So "person-only" (turning a switch back on,
  the dashboard login, removing a member, the authority) is **best effort against an agent running as the same OS
  user**: such an agent can call the socket without the headers, or edit `~/.walkie/config.json` itself. The kill
  switches protect against remote admin and against agents that identify themselves (every runtime Walkie detects,
  and every seat, which runs as another OS user); they do not stop an actively hostile agent running as the person.
  An owner's machine that is compromised can administer every team machine that has remote admin on.

## Seats v2 (FO-2)

What a v2 seat request (PROTOCOL §11 "Seats v2") adds to threat 16, and what bounds it:
- **Accounts.** A seat may run on a named router account instead of the host's default login. The host person's own
  accounts (in this machine's vault, or `own`/`shared` in their vault on another of their machines) serve any
  launcher allowed on their machine: allowing seats is that consent (FLEET-ORCH-1 §5.1). A teammate's account shared
  with the host person serves a seat only when its launcher is also allowed by that account's share policy (the owner,
  or listed in `share_with`), and the owner's machine checks its own policy and `vault_sharing` again before it hands
  the token out. While the team's company pool is on, a pooled login (not personal) also serves a seat whose host
  person and launcher are each an owner or member (never an observer), under the lender's 10 % reserve. Without a
  named account a seat keeps the machine's own login. A Codex login from another machine is leased as an access-only
  copy (never its refresh token), in a leased home deleted when the seat ends; Kimi logins aren't vault accounts. The
  token is in that run's environment only and a router lease names the seat while it runs.
- **The person's clone.** Walkie changes only what it owns there: worktrees under `.worktrees/<label>` it made (a
  marker in the worktree's admin directory) and branches `lane/…`/`walkie/…` it created (an ownership ref under
  `refs/walkie/lanes/`), moved only by fast-forward. A branch or directory of that name it didn't make is refused,
  never reset or removed. `.worktrees` must be a real directory inside the clone. Refs served to a seat are branches,
  tags or commits on them (never stashes or remote-tracking refs). Checkouts there run with the clone's filter drivers
  neutralized and no in-tree attributes (git 2.42+), no hooks, no submodule recursion.
- **The brief.** Never on argv or in a post: a blob, written 0600 as TASK.md, kept out of commits by info/exclude and
  checked with `git check-ignore` (a seat refuses to start otherwise); commits that touch it aren't returned. It is
  removed however the seat ends, and at the next start after a crash.
- **Seat users' workspaces** are a bundle of exactly the requested commit, staged 0600 in the daemon's 0700
  `seats-stage` directory (swept at every start), at most 1 GiB, streamed to the seat's runner over its stdin.
- **Kimi** seats are full access only (its prompt mode runs tools unasked): they need `permission_mode
  bypassPermissions` and the host person's explicit opt-in (`walkie seats allow --runtimes …,kimi`), and never run as a
  seat user.
- **Result files** are read without following a symlink (every directory on the way re-checked by device and inode
  after the open), at most 64 KiB, redacted.

## Rental compute (RENT-2)

Teams can rent machines ("Add compute") that Walkie runs in **its own** provider account (v1: DigitalOcean, whose
terms allow resale) and that join the team like any other machine. The control plane is the site
(`site/api/compute/*` + a minute cron); the site never talks to a customer's machine and never holds a team key.

- **Customers never see our cost.** The public catalogue (`site/api/_lib/compute/catalog.ts`) carries tier, name,
  specs and price only; provider, size, region, image, our cost and our provider limits come only from the private
  env var `COMPUTE_PRIVATE_CONFIG`. The daemon parses every site answer with strict schemas (an unknown field such as a
  cost is refused as `bad_site_reply`), and tests on the site, the CLI and the dashboard fail if a cost key, a cost
  figure, a provider size/region slug or the provider name appears in any customer-facing payload, receipt text,
  user-data or log line. A misconfiguration that prices a tier below its cost is refused at config load.
- **Money.** Prepaid only: credit blocks bought in Stripe Checkout (a person pays; an agent can only produce the link),
  credited from the signed webhook once per checkout session. Credit must cover the first hour of every machine in a
  request. Burn is per started minute (GPU starts at least 5 minutes), computed from the minute count so a doubled,
  late or concurrent tick can't double-charge (row lock per account, unique ledger keys). At a balance of $0 or below
  every machine of the account stops; a dispute or refund freezes the account and stops everything. The compute
  Stripe key must be a test key unless `COMPUTE_STRIPE_LIVE=1`.
- **Our provider account runs only machines customers paid for** (Alex, binding: the card on file is strictly for
  selling compute). A tier on a real provider launches only against **paid** credit: Stripe live-mode purchases, never
  test-mode credit, free adjustments, or internal/test teams. It is checked when a rent is accepted, when the tick
  moves a queued machine forward, when a fresh code starts it, and once more immediately before the driver's create
  call (`site/test/compute-paid.test.ts`: no create call without paid credit). FakeCloud is the only driver tests and
  demos use; the real driver has only been exercised with read-only GETs.
- **Capacity.** Beyond the provider account's limits machines are queued (FIFO per quota group), never refused; a
  queued machine starts when the owner's daemon supplies a fresh 1-hour code (the site keeps none).
- **Abuse.** Mining heuristic: a GPU at 95 % or more with no busy seat and no pool job for 10 minutes stops the machine
  and puts the account under review (no new rentals). Egress: shaped with `tc` on the machine (rate from the private
  config), 1 TiB included then billed per GiB, and a hard stop at the private cap (5 TB default). Idle (no busy seat
  or pool job, default 30 minutes), a heartbeat missing 15 minutes, and a machine that never heartbeats within 15
  minutes (credited back) stop too. Every tick terminates any provider instance tagged as ours that no live rental
  owns.
- **Agents.** Renting and stopping are admin actions (AGENT-ADMIN-1): an agent may, only while agent admin is on, and
  each action is audited and posted like other admin actions. Buying credit is always a person in Stripe Checkout.
- **Provider token (least privilege).** The site's DigitalOcean custom-scoped token uses `droplet:create`, `droplet:read`,
  `droplet:update`, `droplet:delete`, `tag:create`, `tag:read`, and `tag:delete`, plus the required read dependencies
  `regions:read`, `sizes:read`, `actions:read`, `image:read`, and `snapshot:read`. Tag attachment requires
  `tag:create` and `droplet:update`. The independent watchdog token uses only `droplet:delete`, `droplet:read`,
  `regions:read`, `sizes:read`, `actions:read`, `image:read`, and `snapshot:read`; it has no create, update, or tag-write scope.
  See [DigitalOcean's droplet delete scope](https://docs.digitalocean.com/reference/api/scopes/droplet/delete/) and
  [tag API scopes](https://docs.digitalocean.com/reference/api/reference/tags/). A Cloud Firewall applied to the tag
  `walkie-managed` with no inbound rules is created once by an operator; its outbound granularity is **[UNVERIFIED]**
  (the `tc` shaping and the egress cap do not depend on it). Keep the provider account separate from anything else.
- **Limits (v1).** The compute token lives on the one owner machine that opened the account (another owner machine
  would open its own account). Queued machines start only while that owner's daemon runs. The heartbeat is reported by
  the rented machine itself (root-only timer and token): a customer who is root on the machine could under-report
  egress or load; the provider's own metering is not yet reconciled against it. A code in flight to the provider is
  visible to the provider. Stop always wipes: there are no kept disks in v1.

No pre-digest rental compute authority data exists because rental compute has never been deployed with `COMPUTE_ENABLED` set.

Rental compute has a 15-minute paid lease. The guest powers off 15 minutes after its last lease deadline. A launched
Droplet starts with a `wk-paid-until-<unix>` tag at most 60 minutes ahead. The minute tick renews tags with under
30 minutes left, oldest deadline first, and persists failures for retry. The independent watchdog deletes only
`walkie-managed` Droplets after the paid tag plus 20 minutes; an invalid or missing deadline is bounded by creation
plus 60 minutes, then the same grace. It alerts on invalid tags and continues past individual delete failures.

Run `scripts/compute-watchdog.ts --apply` every five minutes on an operator-owned Mac using
`scripts/launchd/dev.walkie.compute-watchdog.plist`: replace its checkout, token file, site origin, HMAC secret, and
log directory placeholders before installing it in `~/Library/LaunchAgents`. Set the token file to mode 0600 and
use the separate watchdog token scopes above. The script reads only the path from `COMPUTE_WATCHDOG_TOKEN_FILE`;
neither the token nor the HMAC secret is logged. Set the same `COMPUTE_WATCHDOG_HMAC_SECRET` on the site. Each run
POSTs a signed timestamp to `/api/compute/watchdog-heartbeat`; a tick alerts via the configured Telegram hook after
20 minutes without one. The pinned GitHub Actions workflow is an hourly backstop using separate
`COMPUTE_WATCHDOG_TOKEN` and `COMPUTE_WATCHDOG_HMAC_SECRET` secrets and a `COMPUTE_SITE_ORIGIN` variable. The Vercel
minute cron in `site/vercel.json` remains registered for billing and renewals; the deployment uses Vercel Pro.
A powered-off Droplet continues to incur provider charges until deleted.

The provider and approximate region remain observable to a shell user through hardware identifiers, CPU information and the public IP. Bootstrap replaces the provider APT mirror with the standard Ubuntu archive. Provider cost figures remain private to the control plane; provider visibility is not a security boundary.

## Known limits

- **Person-only commands: the gate is a person confirming at a terminal; detection is best effort
  (WALKIE-ADD-MACHINE-2/3/4/5; narrowed by AGENT-ADMIN-1).** Since AGENT-ADMIN-1 `walkie invite`, `team add-machine`,
  `team role` (other than removing) and `team revoke` (of the person's own machines) are admin: an agent, or a caller
  with no terminal, runs them for its person while agent admin is on (audited; the section above). What remains
  person-only below is `team authority`, `team role … removed`, revoking another member's machine and `walkie
  dashboard` (the login). Those run only when stdin is a terminal, and only after the person types the handle or
  machine the command acts on (or "yes" for the dashboard) within 2 minutes; the prompt goes to /dev/tty, so the
  output can still be piped (`--json | jq`), and Ctrl-C, Ctrl-Z, Ctrl-\\ or Ctrl-D cancel ("not confirmed").
  Most agents' tool runners give commands no terminal (checked live: Claude Code's Bash tool and a `kimi -p` tool call
  report stdin not a TTY; `codex exec` could not be checked here, its account being over its usage limit), so an
  honest agent there is refused with "run this yourself in a terminal, or use the dashboard" whatever detection says.
  Known gaps, where only the extra signals below may still stop an agent: runtimes that run commands on a
  pseudo-terminal (interactive Aider does, through pexpect; Codex's unified exec can); `tmux` (a pane is a terminal,
  and `send-keys` types into it) and `ssh -tt` (a remote terminal, which also leaves the local ancestry and markers
  behind); and an agent typing into a person's own terminal (computer use, a paste), which is indistinguishable from
  the person.
  Extra signals, refused first with the reason named (src/cli/agent-detect.ts):
  - an execution marker with a real value (not empty, `0`, `false` or `no`): `CLAUDECODE` and `AI_AGENT` (Claude
    Code, seen live), `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CODEX_CI` (Codex, live from an unsandboxed `codex exec`
    child), `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`, `WALKIE_AGENT`; best effort `GEMINI_CLI`,
    `CURSOR_AGENT`, `OPENCODE`. Configuration (`CODEX_HOME`, `OPENCODE_CONFIG`, `AIDER_*`, `KIMI_*`) is never a marker;
  - an agent runtime CLI among the ancestors: `claude`, `codex`, `kimi` / `kimi-code` (Kimi sets no variable),
    `cursor-agent`, `gemini`, `aider`, `opencode`, `goose`, `amp`, `crush`, `qwen`, `copilot`, `cline`, `hermes`,
    `grok`, also run through node/bun/deno/python/a shell: past interpreter options, runner subcommands
    (`bun run …`, `deno run -A npm:@google/gemini-cli`) and as a module (`python -m aider`; the Hermes gateway,
    `python -m hermes_cli.main gateway run`, whose tool commands carry only `HERMES_HOME`, which is configuration, not a
    marker). Best effort for gemini, cursor-agent, copilot, cline, goose, amp, crush, qwen (names from their
    installers, not verified here). GUI apps are never agents: nothing inside an app bundle (`*.app/Contents/…`:
    Claude.app, Codex.app, Cursor, Windsurf, Hermes.app, "Grok Bot", their "… Helper (Plugin)" processes) counts,
    since people's terminals run there too. On Linux the process table and each ancestor's exact argv come from /proc
    (no `ps`, which a sandbox may forbid); on macOS from `ps -ww`, whose command lines can't say where an argument with
    spaces ends, so the executable and the script are taken as the longest word run that is a file on the machine. A
    process table that can't be read is a diagnostic ("process inspection unavailable"), not a decision;
  - `--for-agent` (or `=true`/`=1`/`=yes`/`=on`).
  The daemon also refuses these routes to requests marked `X-Walkie-Agent` or `X-Walkie-Under-Agent: 1`. A person
  whose terminal inherited a marker (a tmux server started from an agent's shell hands `CLAUDECODE` to later panes)
  unsets it. The macOS desktop app is not the CLI: it asks the daemon for its dashboard login nonce over the unix socket
  itself, with no terminal. The Windows desktop app makes that same socket call from the selected WSL user via a
  fixed `wsl.exe --exec python3` bridge. It asks the daemon for its effective dashboard port, and before it sends the
  nonce to Windows `127.0.0.1:<port>` (which another Windows process can take, and where the daemon's identity is
  public, so a saved copy replays) it makes that listener prove it is the daemon. It registers a random challenge
  over the socket and gets the daemon's HMAC answer there, keyed by a secret made at boot that never leaves the
  daemon; it opens the login URL only if the Windows listener gives the same answer to the same challenge (compared in
  constant time; PROTOCOL §5). The daemon answers a loopback request once, for a challenge registered over the socket
  less than 10 s ago, so a saved response, the identity or another daemon's answer proves nothing, and registering
  is a person's, like the nonce. Limits: a squatter that can also reach the owner socket, a process of the person's
  OS user running `wsl.exe`, can answer too, and could mint its own nonce there anyway. The proof also assumes that a
  squatter has no second path from Windows to the daemon's loopback listener: one that did could relay the app's
  challenge to the real daemon and hand its real answer back, and the check would pass. The daemon binds IPv4
  `127.0.0.1` only and answers the proof on that listener only, but whether WSL gives a Windows process some other way
  in (another forwarder or loopback binding, a networking mode that exposes the listener) is a fact about the machine
  that the app cannot test and that has not been verified on Windows. A process of the person's OS user can also keep
  the app from signing in without being able to pass the check: it can register 32 more challenges within 10 s, which
  pushes the app's own out (the oldest goes first), or read the challenge off the `wsl.exe` command line (it is public
  by design) and ask the daemon's loopback listener first, which uses up the single answer. Either way the app's ask
  gets `404`, the proof fails and no login link is sent. A Windows process that can reach only the loopback listener
  cannot register challenges (that route is the owner socket's: `401` without a credential, `403` with the token), so
  a squatter cannot do this. The check ends when the webview connects, so a listener swapped in between the last check
  and the navigation (milliseconds, with the check made last) is not caught. It does not use `walkie dashboard` or
  carry an invite; Windows joins use the PowerShell bootstrap from the join page. The trade-off:
  anything running as the person's OS user can do the same (or read
  `~/.walkie/local.token`); telling the app apart from such a process would need the caller's code signature, which
  Walkie doesn't check. None of this stops a hostile agent running as the person's OS user; agents that must not act
  as the person run as other OS users (seats, PROTOCOL §11). An add-machine link also stays in the browser history
  (and synced history) wherever it is opened until it is used or expires (7 days); the /join page strips it from the
  address bar and its own history entries.
- **Limit resets (ACCOUNTS-RESET-1/2).** The only write on the Accounts page is using a Codex limit reset, through the
  Codex CLI's own app-server on the machine that holds the login (Walkie reads no token for it; the CLI signs itself
  in). Claude resets are used on claude.ai and Walkie only links there; Walkie never calls Anthropic's reset endpoint.
  - *Person-only, and its limit (accepted).* **Any process running as you can reach the daemon's socket and act as
    you, including using a reset.** The reset routes refuse a request that marks itself as an agent's
    (`X-Walkie-Agent`, any value, or `X-Walkie-Under-Agent`) and are served only to a dashboard session, never to the
    durable token the CLI and MCP server use; that stops agents that identify themselves. An unmarked process running
    as the daemon's OS user can still mint a dashboard session (ask the unix socket for a login nonce, as the desktop
    app does, or read `local.token`) and spend a reset. That is the same trust level as every other person action in
    Walkie (see "Person-only commands" above: `walkie dashboard` needs a person at a terminal, and the daemon refuses
    login nonces to agent-marked callers); real isolation is seats, which run agents as other OS users.
  - *Bound attempts.* The daemon mints each attempt when the sheet opens and binds it to the account (the Walkie and
    ChatGPT account ids) and its login directory, from one read of the login. An email or sign-in-mode change with the
    same account id is the same account. The binding is checked at confirmation and again right before the use is
    sent, and the app-server must name the bound ChatGPT account (no name: nothing is sent). The remaining window is
    the instant between that last check and the app-server acting on its own loaded login.
  - *Unconfirmed attempts.* The attempt is written down as running, and as sent with its credit, before the use goes
    out; if the disk refuses either write, nothing is sent. The sheet pins its attempt for its lifetime: a retry is
    always the same id (a final answer is replayed, an unconfirmed one reconciled), never a new attempt. An
    unresolved attempt never expires on a clock (a clock jump can't release it); only Codex's answer to a retry or a
    person saying "I checked usage" (resolve) releases it. "Sent" is recorded apart from "running": an attempt the daemon stopped before sending
    reloads as not sent ("nothing was used"). A use whose answer was lost is kept per account in accounts.json and
    handed back instead of a new id until it is resolved; a retry waits for a usage reading that started at least 30 s
    after the try, then repeats the same attempt (same
    idempotency key and credit), so Codex reconciles it rather than spending a second reset. How long Codex honours an
    idempotency key is not documented; the re-read before any retry lets a person see whether the first try landed.
  - *Per machine only.* Serialization is per daemon. The same Codex login on two machines can be reset from both
    dashboards at once (different attempts, different keys); Walkie does not coordinate them. The sheet says so when
    the login is on another machine.
  - *The ledger.* Reset attempts, polling holds and the recovery marker live in their own file,
    `~/.walkie/reset-attempts.json`, which older daemons never touch (a rollback to pre.2 rewrites accounts.json only).
    Both files are read row by row and written atomically and durably (temp file + fsync, directory fsync around the
    rename). If the ledger, or any attempt row in it, cannot be read, a copy is kept as
    `reset-attempts.json.corrupt-<ms>` while the original stays until a recovery marker is written over it, and resets
    are refused, across restarts, until a person says "I checked usage on all my Codex accounts" (the copies are then
    renamed `.checked`); a leftover unconfirmed copy blocks at startup on its own. That confirmation lets resets through
    for every account on the machine. An unreadable accounts.json is only copied aside: it is rebuildable, and the
    holds are in the ledger. Accounts are capped at 64 in memory and in the file alike.
  - *Backup restore (known limit).* Restoring `~/.walkie` from a backup older than an unconfirmed attempt brings back
    an older ledger without it: Walkie can't tell, and the next attempt gets a new idempotency key. Check Codex usage
    before using a reset after a restore.
  - *Polling holds.* A person's refresh, or the re-read after a reset, never polls earlier than a provider's
    Retry-After, a backoff or a Keychain hold; the hold survives discovery passes and restarts, is enforced at
    every poll, and counts from when the answer arrived.

- **Provider accounts: watch-only in phase 1 (ACCOUNTS-1).** Walkie records which Claude / Codex / Kimi / Grok
  account each running session uses and how much of each usage window is left, and shares that with the whole team
  (every member's daemon, observers' included, reads the `accounts` field of `vv`; the dashboard, `walkie accounts`).
  What travels: a 24-hex account id (a hash of the provider's account ids), the provider, a masked email
  (`al***@gm***.com`), the plan, the names of the agents using it, and numbers (percent used, reset times) with a
  state enum. What never leaves the machine: tokens, full emails, login paths, provider responses. **No token is
  stored, logged, sent to a peer or moved between machines in phase 1**; accounts.json (0600) holds ids, masked
  labels and readings only. To read usage, the daemon on the machine that holds a login reads that CLI's *current*
  access token read-only for one request to a fixed usage URL (an allow-list of four exact URLs; GET, no redirects,
  15 s timeout, 256 KB cap). Errors are **fixed codes** (`HTTP 429`, `usage request failed (TimeoutError)`), never a
  response body or an exception's text, so nothing a provider echoes back (a token included) can reach a log. It
  **never refreshes a token** (tests fail on any request to a token or refresh endpoint): a token expiring within
  2 minutes is left for the CLI to refresh, so Walkie can't cause the rotation fights two refreshers do. Sessions on an
  environment token (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`) are detected by
  variable NAME only (the value is never read into a result) and shown as "Token login, account unknown", never polled.
  A reading is attributed to an account only while its login still identifies as that account (re-checked before and
  after every request; Kimi through `/me` on every poll), so a login change can't credit one account with another's
  usage. On macOS the Claude token is read from the Keychain with `/usr/bin/security` — the tool Claude Code writes
  the item with, so it is on the item's access list and reads without a prompt — in its own session (no terminal to
  prompt on), with a minimal environment and a hard 3 s deadline (SIGTERM, then SIGKILL; the poll never waits past
  it). A timeout or any failure other than "not found" turns Keychain reads off for 6 h and the account shows
  "unknown". Residual: macOS has no per-command switch that forbids the Keychain's GUI prompt for `security`, and a
  helper that could forbid it would not be on the item's access list (so it would prompt, or fail, on every read). If
  the item's access list ever stops trusting `security` or the Keychain is locked, a prompt can appear for up to 3 s,
  at most once per 6 h, and is never answered by Walkie. Grok's token is never used (no usage API: its auth file is
  parsed for `user_id`, `team_id`, `email`, `expires_at` and whether a refresh token is present, and its CLI log is
  scanned for spent-usage failures). Labels are a controlled vocabulary, not free text: an account label is a masked
  email or a fixed provider label, a plan is a known plan word, a model scope is a model name; the schema enforces this
  when this machine publishes and when a peer's snapshot is read, so a full email, a secret fragment or an instruction
  can't travel. Peer-sent accounts are also shape-checked (≤ 16 accounts, ≤ 6 windows, percentages 0–100, known
  enums; unknown keys stripped) and dropped when malformed. Readings stay per reporting machine and per member: a
  member reporting another member's account id gets a separate entry marked as an unverified claim and can't change
  the owner's tile or an agent's chip (which uses its own machine's reading); a reading dated beyond the allowed clock
  skew is rejected and reset times are capped at the reading + 8 days. For a model, `walkie accounts` (text and
  `--json`) goes through the agent-output contract: rebuilt from an allowlist, labels re-validated, `trust` and the
  reporting node (`reported_by`) on each account, and the text wrapped per account in the §6 wrapper from its
  reporting machine. The values are self-reported by the member's daemon and are shown, never acted on. `"accounts": false`
  in `~/.walkie/config.json` turns recording, polling and sharing off. Provider terms forbid sharing account logins;
  phase 1 shares only the numbers, and later phases that hand out logins are owner-only by default (docs/plans/ACCOUNTS-1.md).

- **Account vault and automatic switching (ACCOUNTS-2).** A person can store logins so `walkie claude` / `walkie
  codex` (and the `claude` / `codex` shims) switch when an account hits its limit: the session resumes automatically
  on an account with room.
  *What is stored, where.* `~/.walkie/vault.db` (0600 in the 0700 walkie home; never replicated, never in an event
  or a snapshot). A Claude `setup-token` (a one-year token with no refresh token) is sealed with AES-256-GCM, a fresh
  IV per seal, AAD = vault id | account id | provider (a row copied to another account or vault does not open). The
  32-byte data key is not in the database: macOS Keychain generic password `walkie-vault` (written with
  `/usr/bin/security -i`, the key on stdin, never on a command line; read back with `security` without a prompt),
  on Linux a 0600 `~/.walkie/vault.key` with a warning (a key an earlier version stored in libsecret is still read, but
  a NEW key never goes there: `secret-tool` cannot store create-only, so a stale writer could replace a published key;
  also WSL, headless boxes, `WALKIE_VAULT_KEYSTORE=file`). A Codex account is a dedicated CODEX_HOME (`~/.walkie/vault/codex/<id>`,
  0700) where `codex login` wrote its own `auth.json` (0600, Codex's own format, refreshed by Codex itself — one
  refresher per login); other entries there are symlinks to the user's own CODEX_HOME (sessions, history, skills, …)
  — except config.toml, a Walkie-managed copy with every provider / base-URL key removed (round 5), and `.env`, which
  is never linked (Codex loads it into its own environment) — and removing the account unlinks the links without
  following them (a real entry Codex wrote there is moved into the
  user's CODEX_HOME with `--move`, or the removal is refused — never deleted recursively). **Codex logins are
  protected like Codex protects them; Claude tokens are encrypted**: that `auth.json` is a plain 0600 file exactly
  like Codex's own `~/.codex/auth.json`, so a copy of `~/.walkie/vault/codex/` (a backup, a disk image) holds a
  working Codex login without any key. Walkie itself **never refreshes** anything. The data key is never replaced
  silently: a vault whose key went missing while sealed tokens exist refuses to add more (with the recovery steps),
  and the first key is made only by the holder of a `key_claim` (pid + nonce, taken in a SQLite write transaction; taken
  over only from a process that no longer exists, by compare-and-swap; released only while it still holds our nonce),
  so two first `add`s in parallel — in one process or two — cannot each make one; the key store write itself is
  create-only (Keychain without `-U`, a file opened `O_EXCL`; never libsecret) and the claim holder reads
  the key back after writing, so a writer that outlived its claim never replaces a key tokens are sealed with.
  *What this protects against, and what not.* Other OS users, copies of the disk or of `~/.walkie` without the key
  store (Claude tokens only: see Codex above), and leaks through logs, events, snapshots, errors or the dashboard (no API returns a token except the
  unix-socket hand-out route to the same user's wrapper). It does **not** protect against code running as you: a
  process of your user (an agent with a shell included) can ask the Keychain for the key with `security` as Walkie
  does, or run `walkie accounts exec -- <anything>` and read the token from its environment. That is the same
  boundary as the CLIs' own logins (`~/.claude/.credentials.json`, the `Claude Code-credentials` item, `auth.json`).
  *Who may change it.* `walkie accounts add|remove|policy|borrow|allow-proxy|trust-cli` and `shims install` refuse to run under an
  agent with the same detection as every person-only command (PRE4 RC: `--for-agent`, the agent markers of §6 in the
  environment, or an agent runtime among the ancestor processes; `CODEX_HOME` alone does not count) and need a
  terminal (`/dev/tty`) for a confirmation, `trust-cli` and `shims install` included. **This is a speed bump, not a boundary**: it stops an agent
  from changing the vault
  by accident or on a teammate's say-so, but code running as you can clear those variables, open a pseudo-terminal,
  or read the vault's key and database directly. The OS user is the boundary. Agents may run sessions on the vault's
  accounts (`walkie claude`, `accounts pick`, `accounts exec`) — that is the feature.
  *Which binary gets a credential.* Only the `claude` / `codex` recorded by `walkie accounts shims install` (or
  `trust-cli`), and only a NATIVE executable (Mach-O or ELF, by its magic bytes): a script launcher (`#!`, an npm
  prefix install) is refused with the official native install command, since an interpreter, its start-up files and
  the scripts it loads cannot all be pinned. Every symlink hop is followed by hand and every lexical ancestor directory
  of every hop is checked, as is the final file: not inside the project the command runs from (the nearest directory
  at or above the cwd holding a project marker — `.git`, `package.json`, `Cargo.toml`, … — never the home directory
  itself, so launching from `~` puts nothing off limits), not in a git work tree (the home directory itself as a
  dotfiles repository excepted; the exact Homebrew prefixes /opt/homebrew, /usr/local/Homebrew and
  /home/linuxbrew/.linuxbrew excepted — never recognised by what a directory contains) or a `node_modules/.bin`; owned
  by the person or root; not other-writable; not group-writable — except a directory writable by the macOS `admin`
  group (Homebrew's), accepted only when every member of `admin` other than root and macOS service accounts (an
  `_`-name with uid < 500 and shell /usr/bin/false or /sbin/nologin, checked with dscl) is the person (no nested
  groups) and it is owned by root or the person; and on macOS no ACL entry that lets anyone but the person write.
  ACL entries (`ls -led`) are parsed structurally — principal (spaces allowed), `inherited`, allow/deny, rights — and
  an entry that cannot be parsed, a right that is not known, or an `ls` that fails means refused. Start-up and
  redirect settings are removed from the credentialed process's environment: NODE_OPTIONS, NODE_PATH, BUN_OPTIONS,
  BASH_ENV, ENV, ZDOTDIR, every DYLD_* and LD_*; every `ANTHROPIC_*_URL` / `CLAUDE_CODE_*_URL` and OPENAI / CODEX base
  URL; NODE_EXTRA_CA_CERTS, NODE_TLS_REJECT_UNAUTHORIZED, SSL_CERT_FILE / SSL_CERT_DIR, REQUESTS_CA_BUNDLE,
  CURL_CA_BUNDLE, CLAUDE_CODE_REMOTE, ANTHROPIC_UNIX_SOCKET, the Claude endpoint hosts and CLAUDE_CODE_USE_BEDROCK /
  VERTEX / FOUNDRY; and HTTP(S)_PROXY / ALL_PROXY / CLAUDE_CODE_*PROXY* unless the person turned on
  `walkie accounts allow-proxy` (config `allow_proxy`; a person-only command). **Settings files cannot put them back**
  (round 4): Claude Code applies the `env` of every settings file it loads — a project's `.claude/settings.json`
  included — inside its own process, so a credentialed launch gets ONE `--settings` from the wrapper (flag settings
  outrank user, project and local settings key by key; only managed policy settings rank higher) that pins
  ANTHROPIC_BASE_URL to https://api.anthropic.com, every other known endpoint / socket / provider switch and (unless
  allow-proxy) every proxy key to "" (unset), NODE_TLS_REJECT_UNAUTHORIZED to 1, NODE_EXTRA_CA_CERTS to "", and the
  CA-file variables to the system bundle. A caller's own `--settings` (JSON or a file) is merged into it — its keys
  and hooks stay, the pinned keys win; one that cannot be read means that run gets no Walkie credentials. Checked
  against the real Claude Code in a network-sandboxed lab with a fake token: a project settings `env` redirected an
  unpinned session's token to a local capture server; with the pinned settings the request went to the pinned
  endpoint and the capture server saw nothing (test/integration/switch-real-claude.test.ts, opt-in). **Managed
  settings are inside the trust boundary** (owner decision, round 5): a managed policy settings file installed by an
  administrator (root-owned) outranks the pins by Claude Code's design — an organisation that routes Claude Code
  through its own gateway does so for every login, the vault's included; Walkie does not fight it. Residual: an
  endpoint variable a future Claude Code adds is not pinned until it is listed. A settings file the session loads that
  gives it its OWN credential (an `apiKeyHelper`, `awsCredentialExport` / refresh helpers, or an API key / token in its
  `env` — the caller's `--settings`, the user settings, or any `.claude/settings(.local).json` from the cwd up to the
  home directory) means the vault credential is not handed over at all (the session would run on that credential
  anyway); one line names the file and key.
  **Codex routing is pinned the same way** (rounds 5 and 7): every credentialed Codex launch, and the `codex login` of
  `walkie accounts add codex`, carries `-c model_provider="openai"`, `-c chatgpt_base_url=
  "https://chatgpt.com/backend-api/"`, `-c openai_base_url="https://chatgpt.com/backend-api/codex"` and `-c
  features.realtime_conversation=false` (Codex applies `-c` over every config file). Where they go matters: a
  subcommand's own `-c` list REPLACES the root one (checked on codex 0.156.1), so the pins are placed at the root AND
  right after every subcommand (`exec`, `exec resume`, `resume`, `login`, …), and the caller's own earlier `-c`
  overrides are carried after them (round 7: before that, `codex exec -c x=y -p work …` dropped the root pins and a
  profile's gateway received the token). Every TOML file of the account home is a cleaned copy — config.toml and each
  profile, which codex 0.156 keeps as `<name>.config.toml` next to it (`-p work` loads work.config.toml) — with
  model_provider, model_providers, chatgpt_base_url, openai_base_url, the voice (realtime) endpoints and the thread
  store endpoint removed everywhere; the result is parsed and checked, and a file that cannot be cleaned means no
  credentials. Voice (realtime) has its own endpoints that a trusted project's config could set, so it is switched off
  for credentialed launches (`--enable realtime_conversation`, which outranks `-c`, is refused). Project-local Codex
  configs cannot set the provider / base-URL keys (Codex ignores them there); the account home has no `.env`; a
  caller's own `-c` that names one of these keys anywhere — its key in any spelling, or inside its value such as an
  inline profile table — means no Walkie credentials for that run. The environment loses Codex's endpoint, auth,
  refresh / revoke-token, login-issuer and cloud overrides (CODEX_REFRESH_TOKEN_URL_OVERRIDE,
  CODEX_REVOKE_TOKEN_URL_OVERRIDE, CODEX_AUTHAPI_BASE_URL, every CODEX_*_URL / _OVERRIDE / _ISSUER / _CERTIFICATE —
  names read from the codex 0.156 binary), its CA override and the CA lists it reads (CODEX_CA_CERTIFICATE,
  GIT_SSL_CAINFO, CARGO_HTTP_CAINFO, PIP_CERT, BUNDLE_SSL_CA_CERT), OPENAI base URLs and WSS_PROXY. Checked against the
  real Codex 0.156.1 in a sandboxed lab with a fake ChatGPT login and a capture server
  (test/integration/switch-real-codex.test.ts, opt-in): the auditors' cases — user / project / profile-file providers
  and base URLs, inline-profile `-c` overrides, `exec -c … -p work`, root `-c … -p work`, the interactive TUI and
  `resume` under a pty, project voice / thread-store endpoints — send nothing to the capture server, and the pinned
  endpoint receives the token. Round 8: the command line is read with codex 0.156.1's own option table (generated
  from every subcommand's `--help`: which options take a value, a list, or none, and which subcommands nest), so a
  value-taking option before a nested subcommand (`exec -o file resume …`, `exec fork`, a root `-i` list) cannot hide
  where the pins must go; a line the table cannot read with certainty (an option it does not know — another Codex
  version, a typo — a value given to a flag, a subcommand-looking word after an argument) gets no vault credentials,
  with one line saying why. Refused as well: `--remote` / `--remote-auth-token-env` (a remote app server), `--enable`
  of any realtime / voice feature, a profile name with path pieces (`-p`, `--profile`, `-c profile=…`), and any `-c`
  naming a sub-agent `config_file`. Sub-agent role configs (`[agents.<role>].config_file`, which could name a provider
  for that role's sub-agents) are cleaned into the account home like profiles and the line is pointed at the copy; a
  role config in a form that cannot be rewritten, missing, or naming another config file means no credentials; the
  `agents/` directory is a cleaned copy, never a link. (The round-8 audit exercised role configs on codex 0.156.1 with a
  lab model reply that spawns a sub-agent: roles from a project's `.codex/agents/*.toml` cannot change the provider or
  base URL, and the child's requests reached only the official endpoint — its cases CTL5, CTL6 and CTL8; CTL5 and
  CTL6 re-run for round 10, the child spawned and nothing reached the capture server.) Round 9: a
  caller's `-c` is DECODED as TOML before it is checked (escapes in quoted keys such as `"\u0072ealtime_conversation"`,
  quoted and dotted keys, inline tables — every key and nested value). Round 9 also claimed that an override that does
  not decode is refused; it was not — a value Bun's TOML reader rejected was read as a plain string, and Codex's reader
  accepts forms Bun's does not (a TOML 1.1 datetime without seconds, `1979-05-27T07:32`), so
  `-c 'agents={x={t=1979-05-27T07:32,"\u0063onfig_file"=…}}'` passed the key check (Opus r8). Round 10: an override
  that does not decode is refused unless it is a plain word (no `{`, `}`, `[`, `]`, `=` or quote), which Codex would
  also take literally; and because Bun's reader also MIS-reads some values it accepts (`t=1979-05-27` becomes
  `{t=1979,"05"=27}`), any `-c` containing a backslash is refused outright — a routing key can be kept out of the raw
  text (which is checked for every routing key name in any spelling) only through an escape in a quoted key. The pins are
  also placed at the END of the last command's options, so no caller `-c` comes after them (the voice switch-off is
  final); an image list (`-i` / `--image`) followed by a subcommand name is refused as ambiguous (codex 0.156.1 reads
  that name as another image — `codex --image a.png resume --help` prints the root help — while the audit read it as
  the subcommand); a code-mode script completes a polled exec session only when it is, in exact shape, a lone
  `tools.write_stdin` poll (aliases, bracket access or any other call make it ambiguous). Round 10 (Opus r8): the
  refusal checks read the line with the same reader as the pin placement, so an option's value is never taken for an
  option or for `--`, and every spelling of `-p` (`-p x`, `-px`, `-p=x`, `--profile=x`) is checked; a separate value
  that starts with "-" (`-m -- …`, `-m --remote`) makes the line unreadable, as codex 0.156.1 rejects it too. The
  hidden `--yolo` alias (not in `--help`) is read as `--dangerously-bypass-approvals-and-sandbox` on exactly the
  commands that list that flag (all 60 command paths of the table checked against the real binary); it was a false
  refusal before. A relaunch after a usage limit puts the session id and the continuation prompt after `--`
  (`codex resume <options> -- <id> <prompt>`, and `<options> -- <prompt>` for the fresh-summary fallback), so an image
  list among the caller's options (`-i a.png`, which takes every following word) cannot swallow them — checked on
  codex 0.156.1 in a sandboxed lab: the relaunch resumed the session with the image and the prompt, where the old
  order sent no prompt at all. The real-Codex lab test now runs in the resolved temp directory (on macOS `/tmp` is a
  link, and Codex matches project trust against the resolved path, so the project-config cases had tested nothing),
  with a control case showing the trusted project's config is loaded (its `model` reaches the pinned endpoint); the
  project voice case no longer sets `experimental_thread_store_endpoint`, which codex 0.156.1 refuses outright
  ("no longer supported": no run at all). `walkie accounts exec
  --provider codex` gives the command CODEX_HOME (the cleaned home) and cannot pin the command's own arguments. Before EVERY credential-bearing launch —
  the first and every relaunch — the CLI found on PATH must be the recorded path and all checks run again; the objects
  validated are compared (device, inode, size, mtime) right before the spawn, and the validated real file is what
  runs (an update that replaced the binary in place is accepted after the checks and the record refreshed). Anything
  else runs without Walkie credentials, with one line saying why. `walkie accounts add codex` runs `codex login` the
  same way (round 4): only the trusted (or, before one is recorded, a check-passing) native codex, the validated file
  re-compared right before the spawn, in the cleaned environment without API keys.
  `walkie accounts exec -- <command>` is the explicit exception: it gives the token to the command you name.
  *How a token reaches the CLI.* Claude: on file descriptor 3 (`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3`, a pipe the
  wrapper writes and closes), so it is not in the process's environment (`ps eww`) or argv; Claude Code 2.1.283 was
  checked to drop the variable from its hooks' and tools' environment. `WALKIE_TOKEN_VIA=env` uses
  `CLAUDE_CODE_OAUTH_TOKEN` instead — read only from the environment the person started `walkie` with: release
  binaries are built without Bun's `.env` / `bunfig.toml` autoload, so a project's `.env` cannot set it (or any other
  `WALKIE_*`), and `WALKIE_REAL_CLAUDE` / `WALKIE_REAL_CODEX` (test overrides of the CLI path) are ignored by release
  binaries; `walkie accounts exec` always uses the environment (for launchers that start
  `claude` themselves). The wrapper removes `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / an inherited token from the
  session it starts, and steps aside entirely for a command that brings its own token. Codex: `CODEX_HOME` only.
  *What crosses machines.* Nothing, unless the owner sets a policy: `own` lets the owner's other machines, `shared`
  also the named teammates — and `shared` works only while that owner's `~/.walkie/config.json` has
  `"vault_sharing": true` (off by default: the customer default is owner-only). Only Claude setup-tokens move whole (a copied
  Codex login would fight its twin over the refresh token; a Codex login is lent as an access-token copy, see Company pool): `POST /peer/v1/vault/lease` on the owner's machine, over
  the authenticated peer channel (WireGuard; whois login must be a member; the calling node admitted, owned by that
  login, from its pinned IP), with a 60 s timestamp window, a nonce replay guard, 10 hand-outs per calling node per
  hour, and the reply sealed to a one-time X25519 key of the requesting daemon (HKDF-SHA256, AES-256-GCM, bound to the
  account and both node ids). The requester never stores it: its daemon returns it over the unix socket to the
  wrapper, which writes it to the session's fd 3. The owner's log records each hand-out and refusal (account id,
  node, handle, agent — never the token). **A hand-out gives the borrower's OS user the plaintext token for the
  token's whole lifetime** (up to a year): anything running as that user on that machine can copy it while the session
  runs, and nothing Walkie does later (removing the account, turning sharing off) takes it back — only revoking the
  setup-token at the provider does. `vault_sharing` is read at every hand-out, so turning it off stops new ones at once.
  *Company pool (RESET-CLOCK-1; Alex 2026-09-27: "Team setting, on for us").* A TEAM setting, OFF by default: an
  owner (the person, or the owner's agent — agent setup is allowed by design) runs `walkie accounts pool on|off`; the
  setting travels on the owner machine's accounts snapshot, every machine takes the newest OWNER setting it has seen
  (its time moved onto the local clock by the measured peer skew), keeps it in `~/.walkie/team-pool.json` (0600) so a
  restart or an offline owner does not forget it, and treats "unknown" as OFF. An owner's machine with accounts off
  still advertises its setting. Nothing changes on upgrade: logins keep their policy, and nothing is pooled until an
  owner turns the pool on. While it is on, every vault login its person has not marked personal (`walkie accounts
  personal <account> [off]`, person-only, at any time) is lent to every admitted machine of every owner and member —
  never an observer — with no share list and no `vault_sharing` flag; each login's own policy (local / own / shared
  with `vault_sharing`) applies exactly as before alongside it. Turning it on posts a notice to #general; each member
  also sees a dashboard banner and a one-time line in `walkie accounts`. Turning it off stops new leases at once (the
  lender checks the setting at every hand-out); what was already handed out is not taken back (below).
  **What a lease really is.** A Claude setup-token cannot refresh, so the "lease" of one IS the setup-token: a usable
  bearer credential for the account until it expires (a year) or its person revokes it at claude.ai. The borrower's
  wrapper keeps it in memory and hands it to the CLI on fd 3, but anything running as the borrower's OS user on that
  machine can copy it while the session runs, and nothing Walkie does later (pool off, personal, remove) takes it back.
  That is the owner's accepted trade-off for the company pool. A Codex login is lent as a copy with an access token
  only: an EMPTY `refresh_token` (codex-cli 0.156.1 refuses the file without the field), an `id_token` rebuilt with
  only the plan type and ChatGPT account id (no email or name; codex-cli accepts it), `last_refresh` set to the lease
  time so Codex does not try to refresh it, no API key. It is lent only when its access token's expiry can be read and
  has at least 30 minutes left; the borrower re-checks it (a reply carrying a refresh token is refused), writes it 0600
  into a fresh 0700 `~/.walkie/vault/codex/lease-<grant>` and deletes it when the session ends (homes of sessions that
  are gone — pid AND process start time, so a reused pid does not count — are swept by the daemon and the switcher).
  The access token itself is a bearer token for the account until it expires (about ten days) and carries the
  account's identity. **One refresher per login**: the refresh token never leaves the machine that holds the login;
  that machine renews it through the user's own Codex CLI (`codex app-server`, which authenticates and refreshes on
  its own; Walkie never reads or sends a token for it), one login at a time, when the access token has under 48 hours
  left or cannot be read, at most hourly per login, so an idle home keeps serving the pool. A leased copy that stops
  working is treated as expired (avoided for that run, never a lasting "needs re-login" mark). A login cannot be moved
  off an offline machine; another machine holding its OWN login of the account (a separate `walkie accounts add`, a
  separate token family) becomes the lender with `walkie accounts promote`, and borrowers try every online holder in
  turn, newest home first, skipping a copy that needs a re-login. **The 10 % personal reserve** (Alex decision) is
  enforced three times: the router never picks another person's pooled login whose last reading (any age; a window
  past its reset counts as unused) shows 10 % or less left, or with no reading at all; the lender refuses such a lease
  unless its own reading under an hour old shows more than 10 % (409 `reserved`); and a borrowed session is moved at
  that line like at a limit, without marking the login (checked every minute from the session's own reading or the
  team's pooled view). **The local lease route** (`POST /v1/vault/lease`, unix socket only) stays open to every
  process of the OS user, agents included, on purpose: `walkie accounts exec -- <anything>` is meant for agents and
  hands the same credential to any command, and code running as the user can read the vault's key and database
  anyway (the OS user is the boundary, above), so limiting the route to the wrapper and the seats host would add no
  boundary. **Downgrade**: a pre.8 daemon ignores `company`, `personal`, `home_at` and `team_policy` (it strips them)
  and lends only by policy; a pre.8 lender never lends Codex. The vault's new `personal` column is ignored by older
  versions. What crosses to the team: the badge (`company`, `personal`, `home_at`), readings, remembered reset times
  and leases; never a token.
  *Borrowing.* A teammate's shared account is used only by a person who opted in (`walkie accounts borrow on`,
  config `borrow_shared`) and only when EVERY own account is affirmatively at its limit (a fresh exhausted reading, a
  window at 100 %, or a limit a session hit) — never because an own account is unknown, stale, near the threshold,
  failing its credentials, or unreachable (its vault machine offline: unreachable is not exhausted). Accounts are
  identified by owner AND account id throughout (round 4): a teammate advertising the same account id is a separate,
  borrowed candidate and can never hide or stand in for an own account; every own account is evaluated before any
  teammate's. The switch threshold (95 %) only ranks: an account below its hard limit is always eligible, and "every
  account is out" means every account is AT its limit. Scheduling uses only verifiable inputs: an account's readings from its owner's own
  machines, and leases reported by the owner's own machines or naming a live grant this (owner) daemon issued for that
  account to that machine (every hand-out gets a grant id; one grant backs one lease). Anything else a member reports
  is shown as a claim (at most four per machine and account, listed after verified ones) and never excludes or
  down-ranks a local account. Each stored credential has an opaque generation, advertised with the vault badge and
  returned with a hand-out; a mark (a limit hit, a refused token) — local or learned by a borrower — binds to the exact
  generation and to the owner (a borrowed account's marks are keyed `owner:id`, round 5: what a teammate's account
  with the same id hit never lands on an own account), so replacing a credential drops what anyone learned about the
  old one. A limit mark lifts only with hysteresis: a reading taken at least 10 minutes after it, not exhausted, with
  its relevant windows below 100 %. "You've reached your <model> limit" marks only that model (the account stays usable
  for others; applied when the model is unknown). A refused token is a strike: one refusal moves the session and the
  account is avoided for that run, a second within a day confirms "needs re-login"; a failed hand-over never marks
  anything; the generation is part of what
  the daemon publishes, so a replaced credential is advertised at once and its old reading is dropped and re-polled.
  `walkie accounts exec` records the hand-out's grant in its lease like a wrapped session.
  *What the team sees.* Each account's vault badge and policy (with the handles it is shared with) and every wrapped
  session on it (member, machine, agent name, since) — leases are team-visible by design (Alex, 2026-09-26). No
  session id, path, transcript or token is shared.
  *Local side files* (`~/.walkie`, same user only): `leases/` (which wrapper pid runs which account), `account-marks.json`
  (limits and refused tokens the sessions saw), `session-readings.json`, `run/switch-<pid>.jsonl` (SessionStart /
  UserPromptSubmit / SessionEnd: event name, session id, transcript path, Claude Code pid — no text; the hook writes
  only to a regular file of the user's inside `run/`). Anything running as the same user can append to that file (a
  tool in the session included) and so claim a session id or a prompt after a limit: that at most points the switcher
  at the wrong transcript or makes the resumed session answer the last message — the same-user boundary above; it
  never reaches a credential.
  When a resumed conversation is refused on the new account, the wrapper writes a local summary of the recent
  conversation (text messages only, secrets redacted with the §6 patterns, ≤ 6 KB, no tool output or thinking) to a
  0600 file in `~/.walkie/run/` and starts the new session with only an instruction to read that file — the
  conversation is never on a command line — and deletes the file when it exits. Marks name the credential generation
  they are about: re-adding an account (a new credential) is never held back by what an old one hit.
  *When a session is ended.* Only at the account's HARD limit (round 3: no early switching). The account is chosen at
  launch (most room first); a running session is moved only once the CLI itself reports the limit, on affirmative
  quota evidence only (round 4): Claude — an API-error record with quota headers (quotaLimits rejected, or a named
  5-hour / weekly / model window not merely warned about) or one of Claude Code's own limit messages ("You've hit
  your … limit", "out of usage credits", the cc_cli_limit_message link); a transient per-minute rate limit or an
  overload never moves a session; Codex — `usage_limit_exceeded` (its retry time read from "try again at <date>" or
  "try again at 8:29 PM", the next such time; Claude's own "resets 8:30am (<zone>)" / "resets Sep 25 at 11pm" when no
  quota header names the reset); or a refused token. Before
  ending the CLI the wrapper waits — bounded, 10 minutes, with one line saying so — while the transcript shows
  background work that may still be running, read conservatively: Claude background shells (a result naming a
  `backgroundTaskId`: run_in_background, Ctrl+B, a timeout), background agents (`async_launched`), Monitor watches
  and other tasks (a result naming a `taskId`; a successful TaskStop naming it ends it), and any run_in_background call (`true` or the string `"true"`) whose
  result named no task — until a runtime `<task-notification>` reports the task over, recognised ONLY in the records
  Claude Code writes for one (a queue operation's content, a `queued_command` attachment, a user message of origin
  task-notification, each starting with the notification), never in text inside a tool result; Codex exec sessions
  reported running (`session_id` with no exit code, or "Process running with session ID N") and code-mode cells
  ("Script running with cell ID N") until a later call that polled that session (write_stdin, directly or inside a
  code-mode script) or waited on that cell AFFIRMATIVELY reports it over in its own result (an exit code in the
  structured result or "Process exited with code N"; "Script completed / failed …") — never JSON quoted inside a
  command's output, a silent poll or a failed write (round 5); Codex drops a session's id once it exits, so completion
  is read by correlating the call; Codex subagents (spawn_agent / resume_agent / send_input answers and the collab_*
  events) until a status says they are over (completed, errored, shutdown, not found) or close_agent closes them — a
  spawn whose answer names no agent stays pending until an event names it. Background work still running at the bound is ended with the CLI,
  and the resumed session is told which (its description and id) so it can start it again. After the wait (or at its bound) the account
  selection runs, the transcript is read again, and anything written meanwhile postpones the end by a tick. A prompt
  the person submitted after the limit (the UserPromptSubmit hook, or a typed user record in the transcript / a Codex
  task_started or user message after the limit) is carried over: the resumed session is told to answer the most
  recent message instead of just continuing. Remaining risks: background work that outlives the 10-minute bound is
  cut off when the CLI ends (its output stays in the transcript up to then; the resumed session is told); text typed
  but not submitted when the CLI is ended — a half-typed prompt in the input box — is lost, since nothing reports an
  unsent draft (the CLI was already refusing work at its limit, and the switch line says what happened). A Codex session whose rollout cannot be tied
  to its process is never moved: an explicitly requested session binds only to ITS rollout (never another file the
  process holds open, such as a subagent thread's), and a new session only to the single root conversation among the
  open rollouts (session_meta with a user source and no parent; ambiguous → not bound). When nothing is usable because
  own accounts are unreachable (their vault machine offline), the wait line says so by name rather than calling every
  account exhausted.
  *Terms.* Account sharing and automatic switching use each person's own subscriptions; check your providers' terms
  for your plan. The product default stays owner-only (`local`, `vault_sharing` off, the company pool off); a team
  owner turns the pool on deliberately (`walkie accounts pool on`).

- **Machine stats are team-visible.** Every member's daemon, observers' included, reads each machine's memory
  (total, used, swap, pressure) and hottest CPU temperature from the `vv` answer, and every dashboard and `walkie who`
  shows them. They say how busy and how hot a machine is, not what runs on it: no process names, paths or users. A
  member who doesn't want to share them sets `"machine_stats": false` in `~/.walkie/config.json` and restarts the
  daemon. The values are self-reported by the member's daemon (a modified daemon can report anything) and are shown,
  never acted on. Reading them needs no privilege: `vm_stat`/`sysctl` and the IOKit HID sensor API on macOS (never
  `powermetrics` or sudo), `/proc` and `/sys` on Linux. Peer-sent values are shape-checked (numbers in range, the
  pressure enum) and dropped when malformed; `who --json` for a model rebuilds them from numbers only.
  The same snapshot carries **accelerator facts** (`stats.accel`, for local-model suggestions): the CPU/SoC name
  (e.g. "Apple M5", "Intel(R) Core(TM) 7 240H"), whether memory is unified, a user-set macOS GPU memory limit, and
  NVIDIA GPU names with their memory. These identify the hardware model, not the machine (no serial numbers, UUIDs or
  driver versions) and are team-visible like the rest; `"machine_stats": false` turns them off too. They are read once
  at start (`sysctl -n`, `/proc/cpuinfo`, and `nvidia-smi` only at `/usr/bin`, `/usr/local/bin` or `/usr/lib/wsl/lib`,
  with the 5 s timeout and a fixed `PATH`). A peer's names must be printable ASCII of at most 64 characters (at most
  8 GPUs); anything else drops `accel` and keeps the rest. Free VRAM (`gpu_free`, numbers only) is sampled with
  memory on machines with an NVIDIA GPU. `stats.sys` adds the OS family and CPU architecture (fixed enums, never a
  kernel or build string), the Walkie version, the logical CPU count and the 1-minute load average, team-visible
  like the rest and off with `"machine_stats": false`. The dashboard renders names as text; `walkie pool` strips control
  characters for a terminal, and for a model wraps each group in the §6 wrapper labelled `trust="team-member"` with an
  information-not-instructions note (a chip name can be any 64 printable characters, e.g. "Ignore prior
  instructions…"), and its `--json` carries `trust` and `reported_by` with every name defanged. Suggestions built
  from them are estimates; nothing is downloaded or run. Peer figures are capped for plausibility (system memory
  ≤ 16 TiB, ≤ 512 GiB per GPU), but within the caps a teammate's daemon can still report more than it has and inflate
  its own group's suggestion (and the team headline); the figures are self-reported and never acted on.
  On macOS the IOKit sensor read runs in a worker thread with a 2 s deadline, so a slow or stuck native call doesn't
  block the daemon's event loop, and the native calls never run on the daemon thread: a worker that can't start or
  fails reports the temperature unavailable and is retried later (1 min, doubling up to 1 h). A worker is retired
  cooperatively (it releases its CoreFoundation references, `dlclose`s and exits) and counts as gone only when its
  `close` event fires; no new worker starts until then. One that hasn't closed after a 30 s grace is terminated and
  worker creation is turned off until restart (Bun terminates asynchronously, and a thread stuck in a native call may
  never stop), so at most one worker is ever abandoned. Three missed deadlines in a row, or ten since start, turn the
  temperature off until restart. A worker is a thread, not a process: a native crash inside IOKit would still end the
  daemon (launchd/systemd restart it), and a native call that never returns keeps its thread (one at most). CLI calls
  (`vm_stat`, `sysctl`, `nvidia-smi`) settle within 5 s whatever the process does, with output capped at 256 KiB;
  every abnormal end (deadline, output over the cap, a stream error) kills the process and counts it until it is
  reaped, and no new call starts while 4 are unreaped.

- **Walkie on your phone needs the computer on and online.** The phone reaches only its own computer's daemon, through
  the relay; asleep or offline means "Your computer is offline or unreachable". A phone that was signed out while it
  wasn't connected learns it only when it connects again (and, if no phone is paired any more, the computer no longer
  holds that device's relay room, so the app keeps saying offline until someone taps "Unpair this phone"; the phone
  forgets its key only on the encrypted `revoked` message, never on a close code). One relay machine:
  its restart drops every phone for a moment (they and the daemons reconnect).
- **The roster authority must be online** for roster changes and joins: invites, role changes, channel creation
  (including a post to a new channel), authority transfers and admissions all go through it. While it is offline,
  requests are queued (202) and applied when it returns; a post to a new channel is refused with `channel_pending`.
- **Losing the authority's machine means re-initialising the team** (v1): nobody else can write the roster, and
  there is no recovery or forced takeover. Transfer authority (`walkie team authority <machine>`) before retiring the
  machine.
- A later admission re-arms a machine only for events the authority had not seen before re-admitting it: those it
  signed while revoked that the authority never saw become valid; those it saw stay rejected.
- The hidden-row cap keeps each origin's 1000 lowest-seq hidden rows; bodies beyond that are discarded (header stub
  only) and can't be re-judged later. Two replicas can end up with different sets only for an origin with more than
  1000 simultaneously hidden **unanchored** events, and only if one of those later becomes valid (an anchored
  event's verdict never changes).
- A node's own hidden rows beyond the cap become header stubs too. Peers that hadn't pulled those rows before then
  can't get them from it (a stub in a public channel is refused), so that node's later events stall on those peers
  (as for any origin whose junk only some peers hold).
- An origin with more than 200 non-authority roster events (an honest daemon never signs one) gets the rest refused,
  which stalls replication of that origin. If such a node later became the authority, its roster events past the
  cap could never be stored and the roster would freeze; don't transfer authority to it. Which 200 are kept can
  differ between replicas that received them in different orders.
- A declined admission (`team.admit` with `approve: false`) is not deduplicated: its retry finds no join request.
- **Node limits** are lifetime per team: 1024 node ids ever admitted (every re-key or new machine uses one; a
  revoked id still counts). A team that reaches it can't admit new machines and must re-init. Per login, 16
  non-revoked machines; an owner revokes old ones to make room. Auto-admit now applies only to a
  login's first machine. More keys under that login require owner approval or an add-machine code;
  the 16-node limit still applies after approval.
- A non-member that receives a valid restricted event in full before the authority's watermark covers it (only a
  relay racing a membership change, or a misbehaving one, sends it that) keeps it in full, never shown, like the
  hidden rows every node already keeps in full, so its verdict can be re-judged; one received after it is anchored
  is kept as a stub only.
- Held rows are re-judged on an origin's roster change only while the daemon runs; after a restart they wait for
  their own dependency (or expire and are pulled again), as before.
- A replica that received a restricted channel's events while it could see them keeps them in full after the
  channel is narrowed (valid either way; another replica may hold the same events as stubs).
- A member who pushes permanently invalid (junk) events only to some peers stalls replication of **their own** origin
  on nodes that can pull it only from those peers (the junk is kept as a header stub, which other nodes can't tell
  from a hidden restricted event, so they wait for the full copy). Other origins are unaffected.
- **The plan floor follows the chain only up to 5 minutes ahead of the local clock, and is reset at startup when
  it is more than a day past the clock.** An owner who rolls the authority's clock back by more than a day and
  restarts it, or transfers authority to such a machine, gets a trial or grace period back on that machine. The
  trade: the previous rules (any accepted event's `ts` floors the clock; a persisted floor is never lowered; the
  chain is held when it is stamped ahead) let any member with a wrong clock brick the team's plan, and left an
  authority whose own clock had been wrong for an hour on Free for good with its chain stalled on every member.
  Plan limits are enforced on the authority's own machine only, at emit time, so this is the owner's machine
  lying to the owner.
- **A member whose clock is more than a day ahead is silent to the team** until it is fixed: every event it signs
  is held (`future_ts`) on every peer, expires from the hold after 24 h and is pulled again (peers resume pulls past
  the held row, so the origin isn't re-fetched every round). Nothing it says is lost, but nothing is shown either.
  The authority is exempt (its entries apply whatever their `ts`). `walkie doctor` reports clock skew above 5 s.
- **Durability**: a transaction that writes an event this node signed commits with `synchronous=FULL` (on disk before
  it is acknowledged or pushed), so a power cut can't make the node reuse a sequence number its peers already hold
  under different content. Peers' events and verdicts commit with `NORMAL`: a lost one is pulled again.
- **Plan limits are enforced by the authority's daemon only, at emit time** (soft enforcement by design): a modified
  authority binary can ignore them, and every node still accepts what it signs, because plans never enter validity.
  The vendor-key trust is what licensing rests on: a leak of the private signing key (`~/keys/…`, the site's
  `WALKIE_LICENSE_SIGNING_KEY`) would let anyone mint keys until a release embeds a new public key.
- **Licensing assumes the roster authority runs our software.** Plan checks happen where the authority emits, and
  remote roster ingestion accepts any valid authority-signed addition without them, by design (plans never enter
  validity). Team binding closes the cheap bypass (one key on many teams); a patched authority binary is out of
  scope.
- **With no database, binding has the released-client compare-then-write behavior** on Stripe metadata (Stripe has no compare-and-set): of two first binds of the
  same code racing within milliseconds, both may read "unbound"; the read-back after the write refuses the one whose
  write was overwritten, but if the writes don't interleave with the reads both can succeed. Only the code's holder
  can do this, the loser's license can't renew (its token hash was overwritten), and it lapses after its period.
  The one-time reveal writes a nonce with its mark and reads it back: of two concurrent reveals only the one whose
  write stuck shows the code, the other answers 410 (same limit as binding when the writes don't interleave with
  the reads).
- A released client may send a proofless bind. Its activation code holder can choose any syntactically valid team id;
  the site has no roster proof on that path. This is the deliberate compatibility path for pre.4/pre.5 clients.
  It does not authorize changing a compute enrollment. With a database, subscription and team locks protect first
  binds where compute state may exist; without a database, there can be no funded account, hold, or open checkout.
- **The renewal token is returned once.** If the bind's answer is lost, or the authority moves to another machine
  without `~/.walkie/license-renew-token`, the license keeps working until expiry but won't renew by itself
  (`walkie license activate` reports `renewal: missing`); support must reset the binding (clear `walkie_team` and
  `walkie_renew_hash` on the subscription) so the code can be bound again. With no database the reset has main's
  immediate rebind behavior, including within 24 hours; there is no retained bind idempotency key.
- **Integration slots are the authority's decision, but a daemon's local switch is its own.** A connector enabled
  before this revision (no `team.integration` entry) asks for its slot at startup; if the plan has no room the
  authority refuses, the daemon logs it and keeps the connector on (nothing already enabled is turned off; it asks
  again hourly). A modified daemon can run a connector without asking. A queued enable (authority offline) that the
  authority later refuses stays `pending_enable` until the person enables it again or disables it.
- **Upgrade every machine before activating a license or enabling an integration.** A node running a version from
  before `team.license` (or, for `team.integration`, before this revision) can't parse the event (`bad_event`, not
  stored), so its copy of the authority's origin stops at the seq before it: every later roster event from the
  authority is held as `chain_gap` and **its roster freezes**. Until it upgrades it applies no removals,
  revocations or restricted-channel changes, so it can keep serving restricted events to people removed later.
  Activation, the automatic renewal and integration slots don't check peer versions (peers don't report one).
- The billing functions (`site/api/*`) have no rate limiting of their own; `/api/license`, `/api/license/bind`
  and `/api/license/renew` each make Stripe calls for anyone on the internet, so random ids can spend the Stripe account's
  API rate limit. Put Vercel firewall rate limits on `/api/*` before launch. `/api/portal` makes no Stripe call: it
  only redirects to Stripe's email-verified portal login.
- `retention_days` is not enforced yet.
- **Walkie Direct (v0.2)**: the endpoint is reachable from the internet by anyone who knows its id, so the peer gate
  and the unadmitted-key budgets above are what stand between a stranger and the API; a flood of fresh keys can
  exhaust the shared unadmitted budget and delay a real joiner (members are unaffected: they have their own
  buckets). **What stalled handshakes can still do.** The bound is on how many native handshakes exist, not on how
  long each lives: a sender that keeps sending packets keeps its handshake alive (QUIC's idle timer; iroh 1.1's
  binding can't cancel a server handshake), and it keeps its native budgets for as long. At most 128 are alive at
  once (64 from the direct path, 16 from relay-path strangers), so memory and native work stay bounded whatever the
  attacker does. What they can deny, and to whom:
  - One IPv4 address (any number of ports) or IPv6 /64: at most 4 native handshakes; one IPv4 /24 or IPv6 /48 (a
    routed /48 is 65,536 /64s): at most 8. That alone locks nobody out.
  - **A fixed set of real addresses is enough** to fill the direct path; no rotation is needed. Addresses in 3 /24s
    (or /48s) fill its 24 lane slots whenever their handshakes are in progress: handshakes they let end and restart
    keep it full indefinitely. Addresses in 8 /24s (or /48s) that keep 64 handshakes alive fill its native share
    for as long as they keep sending. Past 8 pending a source must answer a QUIC Retry first, so these must be
    addresses that receive our replies (spoofed sources can take only the first 8 slots).
  - While the direct path is full, **new direct-path handshakes are refused**: a member reconnecting over a direct
    UDP path (a member is unknown on that path until the handshake) and a joiner dialing by address. **Still let
    in:** a member arriving through a relay (recognized before the handshake by its relay-authenticated endpoint
    id; own 32-slot lane and at least 48 native slots), and a joiner arriving through a relay (8 general slots the
    direct path can't take). iroh dials a peer over its relay and a direct path at once, so with relays (the
    default) members and joiners still get through. Connections already open are unaffected.
  - Relay-path strangers can mint endpoint ids freely: together they hold at most 16 native handshakes, so while
    they keep 16 alive they deny new relay-path joins by strangers (members' relay path is unaffected).
  - One member holds at most 8 pending handshakes on the member lane across all of their machines, so one member
    (up to 16 machines) can't fill it; 4 members colluding can fill its 32 slots while their handshakes are in
    progress, and 6 keeping 48 alive can use up the members' native room while the direct and stranger shares are
    also full.
  - **Relay-free setups** (`"relays": []`) have no relay path, so neither the member lane nor the joiner slots
    exist there: the fixed address sets above refuse every new connection, members' included, while they keep it
    up (open connections stay).
  - Members behind one NAT share their address's 4 slots and their /24's 8. A member holds at most 4 connections per machine, so at most 64 of the 512. Relays and n0's address lookup learn which endpoint ids talk to each other and their IP addresses
  (never content). The invite code is a bearer credential: whoever holds an unused one joins as its handle. The
  authority records an invite's use on the chain; two different codes for one handle each admit one machine. Owners
  can't list or cancel unused codes (an unused code lapses after 7 days, or when its issuing machine stops being an
  owner's); removing the member voids every code for their handle minted before the removal, for good (a re-invite
  doesn't revive them). The cut-off is the issuer's signed chain position, so no clock is involved; an owner whose
  replica hasn't yet received a removal mints codes that count as before it (refused once the removal is applied:
  mint again). A non-authority node checks a join's code against its own roster before naming the authority, so
  only a holder of a code the team's owner signed learns the authority's hostname and key (a replica that hasn't
  yet seen the issuing owner's machine refuses the code instead of redirecting). A machine's key is
  checked in full at the gate, not only its 64-bit node id. With `relays: []` a joiner can reach the authority only
  at an address it already knows (same LAN, or a static address), since invites then carry no relay hint. The
  iroh module is n0's prebuilt Node-API binary (pinned by SHA-256 in `scripts/iroh-napi/SHA256SUMS`) except on
  Intel Macs, where it is compiled from n0's published crate with a pinned `Cargo.lock` (a cached compile is reused
  only when it matches a `darwin-x64` pin in that file; unpinned, it is rebuilt from a clean crate every release
  build); it runs inside the daemon process. **Mixed teams** need a dual
  machine online for the two sides to exchange anything (the authority is one); while none is, each side works on
  its own and catches up when one returns. A machine that is Tailscale-only and one that is Direct-only never talk
  directly, so their live delivery depends on the relay push (one extra hop), and artifact bytes between them go
  through a dual machine's disk. A dual machine can't turn Direct off again in v0.2, and a Direct-only machine can't
  become a Tailscale one.
- **Integration source badges are a label, not an authentication.** The badge comes from `author.agent`,
  which an honest daemon reserves for its connectors; a member running a modified daemon could still sign
  a post with `agent: "fireflies"` (it is still their own, signed post).
- Two members with Wispr unfurl on can both reply to the same share link: a daemon waits 5–20 s and checks
  the thread first when the post came from another machine, which makes duplicates unlikely, not impossible.
- Upstream text that echoes only *part* of a key (e.g. a service truncating it) is not recognised as the key;
  secret-shaped patterns still apply. On Linux without `getfacl`, and on a filesystem without ACL support, a
  key file's ACL isn't checked (the mode bits are). A key file's content that *is* a valid key but was
  changed while a request was in flight is remembered for scrubbing only in memory (the last 8 keys per
  connector), not across a restart.
- Linear reads up to 425 history entries per issue per poll (the first page of 25, then 8 pages of 50); an
  issue with more changes than that between two polls logs `linear_history_capped` and can miss the rest.
- Fireflies continues by time between pages; a page of 50 meetings sharing the same start millisecond
  falls back to an offset within that millisecond, where an upstream deletion could still shift it.
- Events stored before this protocol revision carry no `hsig`; their stubs can't be verified, so a pre-upgrade
  restricted event can't be replicated as a stub to non-members.

## Company-machine provisioning consent

The enrollment grant records a local person's decision to let the named owner provision this machine. The terminal path requires a TTY; terminal, desktop and Windows consent must show the exact disclosure and require the person to type `yes`. The grant request includes that typed phrase, the exact displayed consent text and its version; any other phrase, text or version is refused. The grant binds the current team, target node, owner node and handle, profile versions, consent version, and a 90-day expiry. Renewal requires a new local confirmation. Creation and revocation are posted to `#general` once per transition. A profile reset requires a newer built-in profile and newer consent, checks recorded installer processes, and migrates old step receipts. A recorded success that fails inspection reports drift and is not installed again automatically.

This is an audit record, not proof of an independent human presence. A process already running as that OS user can access the local daemon and can imitate the UI confirmation. Same-user workers also have that user's file, key and socket access. A private worker directory provides organization, not isolation. Remote provisioning still needs the authenticated `admin/run` token, the current named owner, the grant, and both admin switches; local person-run apply is recorded as local. Turning the switches off or revoking the grant interrupts a running installer and leaves an uncertain receipt for reconciliation.

Optional owner SSH consent also permits the named owner's machines, the owner's everyday agents and WalkieTalkie to open a Direct tunnel to Walkie's SSH service on the target as the machine's OS user. That service is Walkie's own on every platform (the enrollment flows never use a server that is not Walkie's, below) and the consent says so: a Walkie SSH service that listens only on this machine and accepts only key logins (the service reads the person's own `authorized_keys`, so any key already authorized for that account works on loopback, not only the owner's; the owner key's `from="127.0.0.1,::1"` restriction applies to that one key). On macOS it is a launchd system daemon, `dev.walkie.sshd`, running `/usr/sbin/sshd -D` on its own config (127.0.0.1 and ::1 only, port 22022, public-key login only, `UsePAM no`, `PermitRootLogin no`, `AllowUsers` the enrolled person, host key and pid file in a root-only 0700 directory under `/Library/Application Support/Walkie/ssh`); on Linux and WSL it is a `walkie-sshd` systemd unit on 127.0.0.1:22. On Linux and WSL, when an SSH server that is not Walkie's already answers on 127.0.0.1:22 (a stock sshd, usually listening on every interface with password login), Walkie does not use it: owner SSH stays off on that machine in this release, because the owner's key would otherwise go into the person's `authorized_keys` and the tunnel would reach a server the consent never described. The terminal setup and `walkie provision grant` look before the question and again after the typed yes (a server can start while the person reads), right before the administrator step and the grant, and the Windows enrollment's WSL step looks right before it records the consent: they say in plain words why ("this machine already runs its own SSH server; Walkie's owner SSH needs its own service, which a later release adds alongside it; owner SSH stays off"), leave SSH out of the consent they record (and out of the one they show, when the server was already there), send the packet to no grant (before the question it has reached only this machine's own daemon, whose check spends nothing; a server found at the first look skips even that), run no SSH install for it and report nothing ready; `walkie ssh enable` says the same and installs nothing. A consent that named SSH and was already shown or typed (a terminal's, when the server started during the question; PowerShell's on Windows, which is shown before the WSL half can look) is recorded without SSH, which is less than what was agreed to, and the sentence says so (on Windows the installer's closing summary prints the WSL step's own sentence). The administrator step skips an SSH install only for a server that is Walkie's, so one that appears after both looks makes the install script refuse the taken port 22 before anything is recorded. A server counts as Walkie's only when systemd, asked as the person (`systemctl show walkie-sshd.service`), says the `walkie-sshd` unit is loaded from `/etc/systemd/system/walkie-sshd.service` and is active, so the person need not be able to read that directory; what the CLI cannot establish reads as not Walkie's. These checks are in the enrollment flows, not in the daemon: the grant route, `GET /v1/ssh/status` ("SSH server responds") and the tunnel do not look at what answers on 22, so a server that takes port 22 after enrollment, on a machine whose grant already carries owner SSH, would be reached by the owner's tunnel. A later release adds Walkie's own service beside the machine's, on another port. Walkie never asks the person to turn on macOS Remote Login (which answers on the whole network with password and PAM login), and neither uses, opens nor changes it. The service is installed inside the enrollment's one root batch, after the root marker, from a script or files staged inside root-owned directories (the enrollment's own, the service's own, launchd's), never under `TMPDIR` (a sudoers that keeps the caller's environment must not let the person's processes choose where root writes and runs a script); the root helper accepts only `install <home>` with `ssh-linux` or `ssh-macos` for the home of the person who ran sudo (the app's administrator prompt supplies `SUDO_UID` itself, from its own user id, for a bundle it has verified is the root-owned, correctly signed `/Applications/Walkie.app`). A second person's enrollment does not take over a macOS service installed for the first, and one person's un-enroll does not remove it; nor does it remove a service whose configuration cannot be read to say whose it is (the config or its directory is a link or not a plain file, it is unreadable, or no `AllowUsers` line names anyone): that service is left in place, and un-enroll says why and prints the commands that remove it by hand. A different member, a node owned by the recipient, or a node relaying on another member's behalf is refused. The signed SSH packet is bound to the target's invite admission event. It is stored as consumed only after every check that can fail before the owner key is written has passed (the root enrollment marker included), and it is given back if an install that left no owner key and rolled back completely still fails, so a refused attempt can be repeated; an installed grant, or a rollback that did not finish, keeps it consumed, and revocation does not make it reusable.

The packet reaches the machine in the add-machine link's fragment and the install command's `--owner-ssh`, so a terminal shows it to shell history and process listings as it shows the invite. It is a signed authorization for one key, one person, one invite and one machine, and cannot admit a machine by itself. The terminal and the macOS app check it against the invite, the team, the owner and the person before showing the consent (the join page checks its form, and the Windows bootstrap checks its form before and the same bindings when it records the consent, leaving SSH out on a mismatch). Before the consent question and before any administrator step they also ask the machine's own daemon to check it (`POST /v1/provision/check`: local and the person's alone, sharing the grant route's own rules so the two cannot disagree, spending and writing nothing), so a packet the daemon would refuse (bad signature, expired, another team, owner, person or invite, already used) is caught before any root work runs for it; a machine that already joined with another link is told that the owner must remove it from the team and add it again. Every path holds it in memory only (the join page strips it from the URL and history; the macOS app never writes it to the consent receipt, a log or the window, and its Keychain copy of the pending link carries a marker in its place; the Windows bootstrap keeps it DPAPI-protected until used), and sends it only in the one local grant request. SSH is reported ready only from the daemon's own status (Walkie's SSH service answering an SSH banner, owner key installed, tunnel open; the status read is asynchronous and consults nothing about Remote Login). The target logs each accepted open durably before bridging, logs its close, and posts one content-free summary to the person's `#general` feed. The source node identity is authenticated by Walkie Direct; the person-versus-agent label is reported by the source machine's same-user CLI. A process with that owner's OS user access can spoof the label, as with other same-user agent attribution.

Walkie takes an advisory `flock` on a persistent sibling lock file for its own `authorized_keys` edits. It checks the original file's inode, size, modification time and content hash immediately before each atomic rename, retries a changed file a bounded number of times, and preserves unrelated bytes on install, removal and rollback. The new contents are written to a temporary file in the same directory and synced before the rename, and the directory is synced after it, so a crash leaves the old file or the new one, never an empty or partial one that would lock the person out. The file keeps its mode: only a group- or world-writable file, which sshd refuses, is tightened to 0600, and a file Walkie creates is 0600. OpenSSH, `ssh-copy-id`, and a person's editor do not take Walkie's lock. They can still change the file in the milliseconds between Walkie's final check and rename; that remaining race cannot be eliminated with an advisory lock alone.

Owner SSH starts closed on every daemon start. It opens only when the local grant reads active, the gate is armed, and this process holds the roster authority's view of the team log: a full pull of the authority's events since the start, from an authority that advertises SSH revocation receipts. A sync with any other peer does not count, because that peer may lack a receipt the authority holds. If the authority is unreachable, SSH stays closed and doctor reports “SSH waits for the team's authority to confirm access”. A target that is itself the authority has no one above it: its own replayed log is the authority's view, because it stores its own receipts there. It also waits for every team machine that shares a transport with it, online or not, because a receipt it could not write locally survives only on peers, and doctor then says it waits for those machines. A machine that shares no transport with it (the roster refuses to move the authority to a machine some active machine cannot reach, but a machine's transports can change later) is not waited for and cannot have been sent the receipt directly. A local revoke first writes its durable records and closes the gate and live tunnels, and only then sends a target-signed receipt, asking every receiving peer at once and waiting at most 3 seconds for each, so a restart while a slow or offline authority holds the call up already finds the revocation. The receipt goes to the authority alone, since only the authority's log is consulted at startup; it stores the receipt as a signed ordinary `#general` event, which keeps the event wire format readable by pre.4/pre.5 peers. A target that is itself the authority stores the receipt in its own log and also offers it to every peer that shares a transport with it. Because storing a receipt makes the authority publish a team post for the caller, it refuses observers, accepts at most five new receipts a minute from one node, keeps one receipt per node and grant whatever the signature bytes, at most ten per node among grants created in the last 91 days (a grant lives at most 90), and nothing for an older grant. An observer's machine therefore keeps its revocation on this machine only, and its revoke says the team could not store the receipt. The target checks for a receipt that names its current grant on every new SSH open and while tunnels are live. A receipt names one grant (its creation time, with the target and the owner key), so revoking and then consenting again with the same owner key is not blocked by the old receipt. Upgrade the authority before using owner SSH.

Known limit, a revocation saved nowhere: a revocation survives a restart only if this machine wrote something a restart finds (the revocation record or audit line, the gate, the grant state or the removed key) or the team's authority stored its receipt. If every local write fails (a full or read-only disk, for example) and the authority is unreachable or refuses the receipt, nothing survives. The running process still denies SSH and closes live tunnels, but a restarted daemon finds an active grant, an armed gate, no record and no receipt, and once it has synced with the authority SSH opens again. Walkie cannot prevent this: the fact that the person asked to revoke is the very thing that could not be stored. `walkie ssh revoke` and `walkie provision revoke` then say “the revocation was not saved; SSH stays closed until restart; run it again once the disk is writable”, and doctor shows the same line until the command succeeds or the daemon restarts. Do not restart the daemon before the disk is repaired and the command has succeeded. `walkie provision revoke` sends no team receipt, so for it local storage is the only record. A target that is itself the authority is covered when a peer that shares a transport with it holds the receipt, because it waits for every such peer before opening; with no such peer holding it, the same limit applies.

Known limit, an authority change: the gate confirms with whichever node is the authority when the target starts. A target that has not yet learned of an authority change sends its receipt to the node it still believes is the authority, which stores it, and the new authority obtains it by anti-entropy. If the old authority goes offline before the new authority has pulled it, and the target then restarts with nothing saved locally (the limit above), the new authority's view lacks the receipt and SSH opens again until the old authority returns and syncs. Do not move the authority (`walkie team authority`) while doctor reports an incomplete or unsaved SSH revocation, and let the new authority finish syncing (`walkie doctor` shows each peer's behind count) before restarting targets.

## Out of scope for v1

End-to-end encryption beyond the transport's (WireGuard on Tailscale, QUIC/TLS 1.3 on Walkie Direct; every member
can read every non-restricted event by design), forward
secrecy for the log, hardware-backed keys, and defending against a compromised teammate's OS account.

## Reporting

Security issues: open a private advisory on the repository.
