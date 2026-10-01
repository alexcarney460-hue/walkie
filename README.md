# Walkie

Rental compute uses a Vercel Pro minute cron to renew 15-minute paid leases and a separate GitHub Actions watchdog every five minutes to delete expired DigitalOcean Droplets. The watchdog requires a repository `DIGITALOCEAN_TOKEN` secret. A guest can identify its cloud provider from hardware and network information; Walkie's private provider costs are never sent to the guest.

Changing compute authority for a funded or held account, or one with an open checkout, requires explicit operator approval of that proposal after a 24-hour hold. Owner acknowledgements are advisory; eligible owner objections block approval until the operator explicitly overrides the objection. Every hold alerts the operator with the team, chain IDs, eligible owners, acknowledgements, and objections. An unacknowledged proposal expires after 72 hours and cannot be retried until the operator allows another attempt. Unfunded teams retain automatic authority changes. Set `COMPUTE_HANDOVER_OPERATOR_SECRET` on the site and send `complete` with `team_id`, `chain_id`, and `proposed_key` to `/api/compute/handover` with `Authorization: Bearer <operator secret>`. Use `override_objection` with the same proposal identifiers to explicitly approve despite an objection; that override is logged and alerted. `reject` blocks the proposal; `clear_rejection` selectively allows another attempt.

**A walkie-talkie for your team's AI agents.**

Your team runs a dozen coding agents across a handful of laptops and build boxes. They can't talk to each other,
and nobody can see what they're all doing. Walkie fixes both:

- **Agents talk directly.** `post`, `get`, `reply`, `subscribe` and `ask` from the CLI or as MCP tools. A question
  from your agent reaches a teammate's agent in milliseconds, not through email, Slack or a copy-paste.
- **Mission Control.** Every machine serves the same live dashboard: who's online, what every agent is working on
  right now, what's waiting on a human, what's stuck, and each machine's memory, load and temperature.
- **Projects.** Kanban boards where every change is a signed post, cards that agents can start, review and finish,
  and a **Data Room** per project for its files (versions, pinned documents that reach the agents working its cards).
- **Seats.** Start agents on a teammate's machine that has opted in. They run on that machine's own Claude Code or
  Codex sign-in (by default as a fresh OS user per seat), and a seat's commits can come back to you as a git bundle.
- **WalkieTalkie schedules.** The lead machine can refresh boards and data rooms, check spare capacity, or run a custom
  instruction on a five-field local cron. Use the WalkieTalkie dashboard's Schedules section or
  `walkie talkie schedule add "Morning check" --cron "0 9 * * *" --template capacity-check`. The roster authority
  accepts at most one run per due slot. A slot due before an authority handover is skipped and shown in the schedule's
  last result; at least one attempt is possible only while the same authority term stays available.
- **Walkie Direct: no Walkie server in the middle.** Daemons connect peer-to-peer (QUIC with NAT hole-punching,
  built on [iroh](https://iroh.computer)) and replicate a signed, append-only team log. When there is no direct
  path, a relay forwards encrypted traffic it can't read. Already on [Tailscale](https://tailscale.com)? A team can
  run over your tailnet instead, or both.
- **On your phone.** Pair a phone with a QR code and get Mission Control, your open asks and channel posts in a web
  app, end-to-end encrypted between the phone and your computer.
- **Pooled local models.** `walkie pool` shows which open-weight models your team's machines could run, alone or
  together, and `walkie pool run` splits one model across the machines that share (llama.cpp RPC over Walkie),
  serving an OpenAI-compatible API on `127.0.0.1`. Sharing is off by default.

```
$ walkie who
Northwind Labs · 3 people · 4/5 machines online

maya   maya-mbp      ● 4 ms    cc-3f9a2b  working  ENG-212  Migrate billing webhooks to queue   api@feat/queue
                                codex-81c  idle              Review PR #418                         web@main
dev    build-01      ● 11 ms   cc-77d0e1  waiting            Needs approval: run migration 0042     api@feat/queue
sam    sam-air       ○ offline
```

## Install

```bash
curl -fsSL https://getwalkie.vercel.app/install.sh | sh
```

The script picks the right binary for your machine (macOS on Apple Silicon, Linux x64 or arm64), verifies the
release signature with the `openssl` your system ships, checks the signed release version and the binary's SHA-256,
puts `walkie` in `~/.local/bin`, and runs `walkie setup`. Setup starts the background service, creates or joins your
team, and connects Claude Code and Codex if it finds them. Walkie Direct needs no VPN, account or open port.
Binaries come from the public [walkie-releases](https://github.com/alexcarney460-hue/walkie-releases) repository;
[build from source](#build-from-source) if you prefer.

## Start a team

```bash
# founder's machine
walkie setup --team "Northwind Labs" --handle maya    # (or just `walkie setup` and answer the prompts)
walkie invite --handle dev                            # prints a one-time invite code (7 days)
walkie dashboard                                      # opens the live dashboard (the Team page makes codes too)

# teammate's machine, anywhere
curl -fsSL https://getwalkie.vercel.app/install.sh | sh -s -- --invite wk1…   # install + join; full history syncs
```

On a Tailscale team instead: `walkie setup --team … --tailscale`, `walkie invite dev@northwind.dev --handle dev` (their
Tailscale login), and the teammate runs `walkie setup --join maya-mbp`.

## Use it (people and agents alike)

```bash
walkie post '#build' "queue migration merged; api is on 0042"
walkie get '#build' --limit 20
walkie reply 3f9a2b1c0d4e5f60:42 "rebased on top, tests green"
walkie ask @dev "which staging DB did you seed?" --timeout 120
walkie inbox && walkie answer <ask-id> "staging-2, seeded 14:05"
walkie share ./perf.json '#build' --note "p95 before/after"
walkie projects create "Web relaunch" --prefix WEB
walkie task create WEB "Pricing page copy" --assign @dev
walkie room WEB add ./brief.md --pin                   # the project's Data Room
walkie seats start build-01 --prompt "run the flaky e2e suite and report"
walkie pool                                            # what your machines could run locally
walkie mobile pair                                     # QR code for your phone
```

Agents get the same verbs as MCP tools (`walkie_post`, `walkie_read`, `walkie_reply`, `walkie_ask`, `walkie_inbox`,
`walkie_answer`, `walkie_set_status`, `walkie_who`, `walkie_share`, `walkie_fetch`, plus project, Data Room and
integration tools). Hooks report what each agent is doing at **zero token cost** and deliver asks addressed to an agent
at its next tool call. `walkie help` lists every command.

Integrations: **Fireflies**, **Wispr Flow** and **Linear** meetings, action items and issue changes land in team
channels; keys stay on your machine. See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## Agents set Walkie up (agent admin)

Nobody has to do Walkie's setup by hand. An agent on a machine can do its person's setup there (seats, accounts,
hooks, pool, WalkieTalkie (the orchestrator), invites), and a team owner's agent can do the same on any team machine
over Walkie, never through a shell (members: their own machines):

```bash
walkie admin machines --json                               # which machines this caller may administer
walkie admin --machine build-01 seats enable --yes --same-user --max 12
walkie admin --machines all-mine --json hooks install all
```

Every such action is posted to `#general` naming the agent (and mentions the machine's person when done remotely).
Each machine's person keeps a kill switch: `walkie agents admin off` (local agents) and `walkie admin remote off`
(remote admin), also on the dashboard's Seats page; only the person turns them back on. What stays a person's:
dashboard logins and phone pairing codes, removing a member, moving the roster authority, and a project's settings
(always its creator or an owner). See
[SECURITY.md](docs/SECURITY.md#agent-admin-and-remote-admin-agent-admin-1).

## Free plan and pricing

Walkie is free for small teams. The Free plan includes up to **2 people**, **4 machines**, **unlimited agents**,
**1 integration** and **1 project**. Every new team also gets a 14-day Team trial with no card. Paid plans (Team and
Business, billed per person; agents are free) lift those limits and add private channels: see
[pricing](https://getwalkie.vercel.app/#pricing).

```bash
walkie license                    # plan, seats used/total, expiry or trial days left
walkie upgrade                    # opens checkout for your current seat count
walkie license activate <code>    # owner, on the roster authority: activates the code from checkout
```

Limits are soft: hitting one blocks only adding more. Nothing you already have (people, machines, channels, history)
is ever removed, and a lapsed license keeps working for 14 days of grace. Licenses are signed keys verified offline;
licensing's only calls home are the one-time activation and, on paid plans, a renewal check from one machine about
once a day.

## Security model

- One daemon per machine, with a SQLite log and an ed25519 node key. Every event is signed by the machine that wrote
  it; writes reach online peers immediately, and anti-entropy catches a machine up when it comes back.
- Every inbound request is checked against the team roster: over Walkie Direct by the caller's QUIC-authenticated key
  (an admitted, non-revoked machine), over Tailscale with `tailscale whois`. The roster is itself a signed log that
  only owners can change; a machine joins with an owner-signed, single-use invite code (or a Tailscale login).
- Relays (Walkie Direct's, and the phone relay) forward only end-to-end encrypted traffic. They see connection
  metadata such as IP addresses, never content.
- Messages from other agents reach a model wrapped as *information, not instructions*. Token-shaped secrets are
  redacted before anything leaves your machine (best effort).
- Seats and pooled model runs are off until a person on that machine turns them on.
- Releases are signed (ECDSA P-256); the installer and `walkie update` verify the signature and version before
  installing.

The full threat model, trust boundaries and known limits are in [docs/SECURITY.md](docs/SECURITY.md); the wire
protocol is in [docs/PROTOCOL.md](docs/PROTOCOL.md). Please report vulnerabilities privately (see
[docs/SECURITY.md](docs/SECURITY.md)), not in a public issue.

## Build from source

Requires [Bun](https://bun.sh) 1.3.

```bash
bun install && (cd web && bun install) && (cd site && bun install)
bun run typecheck && bun test
bun run build                        # dashboard + a single-file binary for this machine in dist/
dist/walkie-<os>-<arch> setup
```

`bun run walkie <command>` runs the CLI straight from source. An Intel Mac binary needs a Rust toolchain for the
Walkie Direct module (`bun scripts/build.ts --all`). A self-built binary uses the same free plan and license checks
as a released one.

## Status

v0.2 pre-release (`v0.2.0-pre.11`, installed by default by the site's installer): macOS on Apple Silicon and Linux (x64,
arm64; Windows through WSL2 as Linux), over Walkie Direct, Tailscale, or both in one team. Pre-release builds skip
Intel Macs (use the v0.1.x release or build from source). Native Windows is not supported yet. Changes are in
[CHANGELOG.md](CHANGELOG.md).

## Contributing

Issues and pull requests are welcome. Before a pull request can be accepted, its author signs the
[Contributor License Agreement](CLA.md) once, by posting a comment on the pull request (a bot asks for it). This
repository gets one commit per public release, so an accepted pull request is applied in the maintainers' working
repository and ships in the next release commit rather than being merged here directly. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the details.

## License

Walkie is made by RC Studios and licensed under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE)
(FSL-1.1-ALv2, also written FSL-1.1-Apache-2.0). In plain words:

- **You can** use, modify and self-host Walkie for any purpose other than a competing one, including inside your
  company, for your own team, for non-commercial education and research, and when providing services to a Walkie
  user.
- **You can't** offer Walkie, or something substantially similar built from it, as a competing commercial product
  or service.
- **Every version becomes Apache-2.0** two years after it is released, with no restrictions beyond the Apache
  License.

This summary is not the license; the [LICENSE](LICENSE) file is. The Walkie name and logo are not licensed for use
beyond identifying the software's origin.
