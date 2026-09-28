# Install and join a team

Requirements: macOS or Linux. That's all for **Walkie Direct** (the default since v0.2): machines connect
peer-to-peer over QUIC, punching through NATs and falling back to an encrypted relay, and find each other by their
keys. Outbound UDP helps (direct paths); with only HTTPS out, traffic goes through the relay.

A team can use **Tailscale** instead: [Tailscale](https://tailscale.com) signed in, and every teammate's machine
reachable on your tailnet (teammates on other tailnets share their machine with you). A team uses one or the other;
existing v0.1 teams stay on Tailscale.

## 1. Put `walkie` on the machine

```bash
curl -fsSL https://getwalkie.vercel.app/install.sh | sh      # verifies the release, installs to ~/.local/bin, runs setup
```

The installer needs only `curl`, `openssl` (the LibreSSL that macOS ships works) and `shasum`/`sha256sum`. It
downloads the release's `SHA256SUMS` and `SHA256SUMS.sig`, verifies the signature with the Walkie release key
(ECDSA P-256, `openssl dgst -sha256 -verify`), requires the signed `version` line to be the release it asked for
(`WALKIE_VERSION=vX.Y.Z` pins one; otherwise the tag GitHub's "latest" resolves to), checks the binary's SHA-256,
and removes the binary again if `walkie version` doesn't report that version. Without `openssl` it refuses.

By hand instead:

```bash
mkdir -p ~/.local/bin
install -m 755 walkie-<os>-<arch> ~/.local/bin/walkie      # release binary, or dist/ after `bun run build`
walkie version
```

Later, `walkie update` fetches the newest release the same way (signature, signed version, checksum), keeps a copy
of the old binary, and puts it back if the new one doesn't report the signed version. It never downgrades unless
you pass `--allow-downgrade`. With the service installed it then restarts the daemon and waits up to 30 s for it to
answer as the new version; if it doesn't, `walkie update` says so and exits non-zero (the binary stays updated).

## 2. Run the daemon as a service

```bash
walkie daemon install          # launchd (macOS) or systemd --user (Linux); restarts on crash and at login
walkie doctor                  # the network (Walkie Direct or Tailscale), daemon, socket permissions, database
```

On a Walkie Direct team the daemon runs an iroh endpoint on its node key (a UDP socket; no inbound port to open) and
connects to a relay; `walkie doctor` shows `walkie direct: endpoint … · relay …`. Relays are n0's public ones unless
`~/.walkie/config.json` lists your own (`"relays": ["https://relay.example.com"]`); a relay only ever sees
encrypted traffic.

On a Tailscale team the daemon's peer API listens on this machine's Tailscale IPv4. If Tailscale isn't connected yet when the daemon
starts (at login, say), it keeps retrying (2 s, growing to once a minute) and comes up on its own when Tailscale does;
`walkie doctor` shows `peer api: retrying (next in Ns): <reason>` meanwhile. It also re-checks the address every
minute: if it changes, the daemon moves the listener and re-joins through the roster authority so teammates reach the
new address. That needs the authority online; until it is, `walkie join <authority>` does the same by hand.

The local socket (what the CLI, hooks and `walkie doctor` talk to) never waits on Tailscale: startup gives the
Tailscale CLI 3 s, then starts without it (under the OS hostname, as when Tailscale is down) and lets the peer
API retry as above. On macOS the launchd agent runs as `ProcessType` `Standard`. Installs from v0.1.0–v0.1.2 used
`Background`, which macOS throttles hard under load; run `walkie daemon install` once to rewrite it.

## 3. Create or join the team

`walkie setup` asks whether to create or join. Or by hand:

**Walkie Direct** (default). The first person creates the team and gives each teammate a one-time invite code:

```bash
walkie init "Our Team" --handle alex --direct
walkie invite --handle kira --role owner       # owner | member | observer; prints a wk1… code, valid 7 days, single use
```

Send the code privately (whoever holds it can join once as that handle). The teammate runs, on each machine
(one code per machine; an invite for an existing handle adds a machine for that person):

```bash
curl -fsSL https://getwalkie.vercel.app/install.sh | sh -s -- --invite <code>    # install + join
walkie join <code>                                                               # already installed
```

The dashboard's Team page makes codes too (**Add a teammate**, with a copy button).

**Tailscale.** The first person creates the team and invites everyone by their **Tailscale login**. The login is
what `tailscale whois` shows for their machine; it isn't always their email.

```bash
walkie init "Our Team" --handle alex --tailscale
walkie invite kira@example.com --handle kira --role owner     # owner | member | observer
```

Everyone else runs this once on each of their machines, pointing at any teammate's machine:

```bash
walkie join sams-macbook-air          # or its 100.x address
```

The machine is admitted automatically when the login is on the roster (Tailscale) or the invite is valid (Direct),
and the team's **roster authority** is online. The authority is the machine that ran `walkie init`, until an owner moves it (`walkie team authority <machine>`);
`walkie who` marks it. Any teammate's machine forwards you to it. On Tailscale teams, owners can turn on manual
approval (`auto_admit: false` in the authority's `~/.walkie/config.json`) and approve joins in its dashboard; a
Direct invite is itself an owner's approval.

Roster changes (invites, roles, channels) made on any owner's machine are applied by the authority. If it is
offline they are queued and applied when it comes back (`walkie` reports `queued`). Keep the authority on a machine
that is usually online, and move authority before retiring that machine: a team whose authority machine is lost
has to be re-created (`walkie init`).

## 4. Connect your agents

```bash
walkie hooks install claude     # Claude Code: status hooks + MCP tools (restart sessions afterwards)
walkie hooks install codex      # Codex: notify hook + MCP tools
```

Sessions that were already running when you installed the hooks don't load them until they restart, and headless
seats (`claude -p`, `codex exec`) often run without hooks at all. The daemon still shows them accurately: every 15 s it
looks at your own processes for Claude Code, Codex, Kimi and Grok and shows each running session under the same name
its hooks will use (`cc-3f9a2b`, `codex-…`), `working` while its transcript is being written or a turn is in progress
(CPU counts only for a session without a transcript), `idle` when it is doing nothing, and `offline` the moment it
exits. It never replaces a fresher status a hook or `set_status` reported, marks a hook-reported session of this
machine `offline` once its process is gone, never looks at other users' processes, skips claude-mem's observer
sessions, and reads nothing from a process's environment except its session id, `WALKIE_AGENT` and its config
directory. To turn discovery off, set `"discover_agents": false` in `~/.walkie/config.json` and restart the daemon.

**What your team sees.** Each session's state (working, idle, waiting on you, stuck, offline), runtime, model,
machine, person, repo name and branch. Nothing from your prompts, your tools' inputs, your notifications or your
directory paths unless you opt in, in `~/.walkie/config.json` (the daemon picks a change up by itself):

- `"share_prompts": true`: status titles from your prompts' first line (and Codex's last-reply line). Off by default,
  also on installs from before this setting existed. `WALKIE_SHARE_PROMPTS=0` forces it off.
- `"share_activity": true`: the text of tool calls and notifications (commands, file names, search patterns, URLs),
  redacted for secrets. Off: a fixed phrase such as "Running a command", "Editing files" or "Needs your permission".
- `"share_paths": true`: the working directory (home-relative). Off: repo name and branch only.

Titles your agents set with `walkie_set_status`, and titles you type with `walkie status "…"`, are always shared;
prompt text is not. (The tool tells agents so: describe the kind of work, never paste prompt text, customer names,
secrets or confidential details.)

Statuses already sent stay in your teammates' logs; turning a setting off stops new disclosure only.

**Coverage limit:** sessions of the Codex desktop app or an IDE (`codex app-server`) are not discovered as processes:
they appear when a turn ends (the Codex notify hook) and when the agent calls `walkie_set_status`.

**Sub-agents.** A Claude Code session's sub-agents (Agent / Task tool) show as their own rows under the session in
Mission Control, with the session saying "N sub-agents working". Their descriptions are prompt text: your own
dashboard shows them, your team sees them only with `share_prompts` on (else the sub-agent's type). This needs the
hooks of this version (`SubagentStart`, `SubagentStop`, `PreToolUse` for Agent / Task): the daemon adds them to an
existing install when it starts after an upgrade, as new entries only. It never changes or removes an entry that is
there (your timeouts, matchers, entries shared with your own hooks, events you removed stay as they are), never adds
an event again after you removed it, keeps a symlinked `settings.json` a link and keeps the file's mode, and leaves a
read-only file alone. `walkie doctor` shows "claude hooks" (what is missing, what you changed, whether the file is
writable); `walkie hooks install claude` rewrites Walkie's entries in full by hand. Claude Code sessions started
before that pick the new events up when restarted. Codex sub-agents
(`spawn_agent`) are not shown as sub-agents yet: Walkie reports Codex through its `notify` hook (turn end) and
discovery, not through Codex's own hooks file (`~/.codex/hooks.json`), which is where Codex 0.156 offers
`SubagentStart` / `SubagentStop` (docs/plans/MISSION-SUB-1.md).

**Upgrade every machine before adding members.** A machine that joins later is served old statuses as stubs only by
machines running this version; an older machine serves them in full, and a machine that is served a stub it doesn't
understand stops replicating that origin until it is upgraded.

Mission Control and `walkie who` show agents that are working or waiting on you; idle and ended agents move to the
**Agent archive** (`walkie agents archive [--machine] [--search] [--limit] [--offset]`, or the Archive tab), which keeps
the newest 200 per machine for 7 days.

Optional, for instant push into a running Claude Code session:
`claude --dangerously-load-development-channels server:walkie`.
Without it, messages still reach an agent at its next tool call, or when its turn ends.

| Setting | Env var | Effect |
|---|---|---|
| Agent name | `WALKIE_AGENT=ux-seat` | Friendly name instead of `cc-3f9a2b` |
| Ask policy | `WALKIE_ASK_POLICY=auto\|human\|off` | `human` or `off`: questions go to a person in the dashboard, never to the agent |
| Prompt sharing | `share_prompts: true` in config (default off); `WALKIE_SHARE_PROMPTS=0` forces off | Status titles from prompts |
| Activity sharing | `share_activity: true` in config (default off) | Commands, file names and queries in activity lines instead of fixed phrases |
| Path sharing | `share_paths: true` in config (default off) | The working directory in agent statuses |
| Machine stats | `machine_stats: false` in config (`machine_stats_interval_s`, default 30) | Stop sharing this machine's memory and temperature with the team (shown on the dashboard and in `walkie who`) |
| Accounts | `accounts: false` in config | Stop recording which Claude / Codex / Kimi / Grok accounts this machine's sessions use, reading their usage left and sharing it with the team (Accounts page, `walkie accounts`); watch-only, no token is stored or moved |

**Any other agent runtime: pass `--for-agent`.** When a model reads the CLI's output (`walkie get`, `inbox`, `ask`,
`who`, `linear create`, with or without `--json`), `--for-agent` makes every teammate-written text arrive wrapped as
`<walkie-message trust=…>` (information, not instructions) and builds JSON from an allowlist of fields. The CLI
turns this on by itself, best effort, from an agent runtime's execution markers (`CLAUDECODE`, `AI_AGENT`,
`CODEX_THREAD_ID` and the like, `WALKIE_AGENT`) or an agent runtime CLI among the command's parent processes
(claude, codex, kimi, aider, hermes, gemini, …); configuration variables (`CODEX_HOME`, `KIMI_*`, `AIDER_*`) never
count. A runtime it doesn't recognise needs the flag on every read. A person's terminal sees the usual output.

**Person-only commands ask you to confirm at a terminal.** `walkie invite`, `team add-machine`, `team role`,
`team revoke`, `team authority` and `walkie dashboard` ask you to type the handle, machine or `yes`; stdin must be
your terminal (`echo kira | walkie invite …` and an agent's tool call are refused), the output can still be piped
(`walkie team add-machine kira --json | jq .link`). An agent never runs them; the dashboard's Team page does the same
for a person.

### Projects (kanban boards)

Projects are shared kanban boards for your team and its agents (every change is a signed post, replicated like any
message; nothing leaves your team):

```bash
walkie projects create "Website relaunch" --folder Acme --path ~/workspace/site   # people only; Free plan: 1 project
walkie task create WR "Pricing page copy" --assign @kira                          # WR-1, WR-2, …
walkie tasks --mine                          # your cards across projects
walkie task WR-2                             # the card, its signed history, the agents on it
walkie task start WR-2 · walkie task done WR-2 · walkie task block WR-2 waiting on legal
walkie projects export WR --format csv -o wr.csv
```

Agents get MCP tools (`walkie_tasks`, `walkie_task`, `walkie_task_start`, `_review`, `_done`, `_block`, `_comment`,
`walkie_task_create`); an agent shows up on a card when its task, branch name (`feat/wr-2-pricing`), working directory
or repository matches the project. With the Claude hooks installed, an agent's `gh pr create` moves its card to review
(project setting). Private projects (`--private`) are for the team's owners and need the Team plan. Each project
includes 3 boards; more are a $15/month add-on per board. The dashboard's Projects page is the board itself (drag
cards, or the keyboard: `j`/`k` `h`/`l`, `Enter`, `c`, `m` then a column number, `a`, `x`).

## 4b. Automatic account switching (optional)

With several Claude or ChatGPT accounts, Walkie can move a session to the next account **before** a usage limit, in
the same terminal, continuing the same conversation — no logging in and out, no re-opening terminals.

```bash
# once per account, at your own terminal (agents are refused):
claude setup-token | walkie accounts add claude   # or run it bare and paste the token (hidden)
walkie accounts add codex                         # runs `codex login` into a dedicated CODEX_HOME for that account
walkie accounts vault                             # what is stored, the policy, sessions on each

# once per machine: records the trusted claude / codex and makes every `claude` / `codex` go through the switcher
walkie accounts shims install --profile           # shims in ~/.walkie/bin + one PATH line in your shell profile
exec $SHELL -l                                    # (or open a new terminal)
```

`walkie setup` offers the shims step too (`--switching` answers yes without a prompt). Without the shims, start
sessions as `walkie claude …` / `walkie codex …` (the CLI's own arguments, unchanged) after recording the trusted CLIs
once with `walkie accounts trust-cli`. Credentials go only to that recorded binary, and only when it is the
**native** `claude` / `codex` (a compiled executable — install it with `curl -fsSL https://claude.ai/install.sh | bash`
for Claude, the standalone binary or `brew install codex` for Codex); an npm-installed script launcher is refused with
that install command. The binary must not be inside the project you are running from, in a repository or a
`node_modules/.bin`, and must sit in a place only you or root can change. Any other `claude` found first on PATH runs
without Walkie accounts, with one line saying why.

What happens: the session starts on the account with the most room (sessions spread over accounts; an account whose
usage window is at or over 95 % — `"switch_threshold_pct"` in `~/.walkie/config.json`, or `WALKIE_SWITCH_AT=90` — is
picked only when nothing has more room). Walkie **switches when an account hits its limit; the session resumes
automatically on an account with room**. When the CLI reports the limit, the CLI is ended, one line says
`walkie: switched to bo***@gm***.com: al***@gm***.com reached its five-hour limit (resets 15:40)`, and the same
session resumes on the next account (`claude --resume <id>` / `codex resume <id>`, with "Continue where you left off").
If the session has background work still running (a background shell, a background agent, a Codex exec session), it
first says so in one line and waits for it, up to 10 minutes. A prompt you typed after the limit is not lost: the
resumed session is asked to answer it. A session is never ended before its account's limit. When every account is
out it says when the earliest one resets, waits, and resumes by itself. `WALKIE_NO_SWITCH=1` runs the real CLI
untouched for one command; a command that sets its own `CLAUDE_CODE_OAUTH_TOKEN` / API key keeps it. Subcommands
(`claude mcp …`, `codex login`, …) always pass straight through.

- **Credentialed sessions ignore redirects**: `ANTHROPIC_BASE_URL` and other endpoint overrides, unix sockets, CA and
  TLS overrides (`NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, …) and `CLAUDE_CODE_REMOTE` are removed from a
  session Walkie gives a token to, and pinned in the `--settings` it passes, so a project's `.claude/settings.json`
  cannot put them back (your own `--settings` is merged in). So are `HTTP(S)_PROXY` / `ALL_PROXY`, unless you run
  `walkie accounts allow-proxy on` (for a corporate proxy you trust). A custom CA for a TLS-inspecting proxy is not
  used by credentialed sessions.
- **Codex routing**: a credentialed Codex session runs with its provider and endpoints pinned to OpenAI's (`-c`
  overrides), its account home holds copies of your config.toml and profile files (`<name>.config.toml`) without
  provider / base-URL settings and no `.env`, voice (realtime conversation) is off,
  and Codex's endpoint / CA override variables are removed. A `-c` of your own that changes the provider or its
  endpoints runs Codex without Walkie accounts. A settings file that gives Claude Code its own credential
  (`apiKeyHelper`, an API key) also runs it without Walkie accounts.
- **Picking an account**: the 95 % threshold only ranks accounts; any account below its hard limit can still be
  picked. Walkie waits for a reset only when every account is at its limit.
- **Claude token hand-over**: the setup-token reaches Claude Code on file descriptor 3
  (`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, checked on Claude Code 2.1.283). A Claude Code too old to know that
  variable would silently use its own login instead: set `WALKIE_TOKEN_VIA=env` to pass `CLAUDE_CODE_OAUTH_TOKEN`.
- **Codex**: Codex reports the account's usage after every turn (shown on the Accounts page and used to pick the
  account at the next launch).
- **Scripts and launchers** (headless): `walkie claude -p …` picks an account and retries a limit-hit run on the next
  one (resuming its session); `walkie accounts pick --provider claude --json` names the account a new session would
  get (exit 75 when all are out, with `waiting_until`); `walkie accounts exec --provider claude|codex -- <command…>`
  runs any command on the picked account (Claude: `CLAUDE_CODE_OAUTH_TOKEN` in its environment; Codex: `CODEX_HOME`)
  and exits with its status. A `walkie seat run` launcher can call either.
- **Your other machines** (optional): `walkie accounts policy <account> own` lets your other machines use a Claude
  setup-token from this machine's vault (handed out over the team's encrypted peer channel, never written to disk
  there — but readable by that machine's user while the session runs); those machines need only the shims, no vault
  of their own. `shared --with kira` also a teammate, once this machine's config has `"vault_sharing": true` and Kira
  ran `walkie accounts borrow on`; his own accounts are always used first. Codex logins stay on their machine: run
  `walkie accounts add codex` on each (a Codex login is a 0600 `auth.json` like Codex's own, not encrypted; Claude
  tokens are encrypted).
- `walkie accounts remove <account>` forgets a login (revoke a setup-token in your Claude account settings to cut off
  sessions already running on it); `walkie accounts shims uninstall --profile` turns switching off.

The Accounts page shows a **Switchable** badge on vault accounts and every wrapped session on each account.

## 5. Open the dashboard

```bash
walkie dashboard
```

## 6. Plan and license

A new team starts on a 14-day Team trial (no card). `walkie license` shows the plan, seats used and the days left.
To buy, run `walkie upgrade` (or use the pricing page). After checkout the welcome page shows your **activation code
once** (copy it then; within 24 hours of checkout) and the command to run on the team's **roster authority**
(`walkie who` marks it):

```bash
walkie license activate <code>
```

The authority exchanges the code at `https://getwalkie.vercel.app/api/license/bind` for a license bound to this team
(a code activates one team; another team gets `license_bound_elsewhere`), records it for the whole team, and saves a
renewal token in `~/.walkie/license-renew-token` (0600). If you move the roster authority to another machine, copy
that file there. The authority renews automatically once a day when the license is within 7 days of expiry: it
sends the license id and the renewal token to `https://getwalkie.vercel.app/api/license/renew` and nothing else. If
renewal fails the daemon logs `license_renew_failed` and tries again the next day; an expired license keeps working
for 14 days. Allow those HTTPS calls from the authority's machine if it sits behind an egress firewall (and, on a
Walkie Direct team, outbound UDP and HTTPS to the relays). (For local
development of the site only: `WALKIE_DEV=1 WALKIE_LICENSE_URL=http://127.0.0.1:<port>` points the daemon at it; any
other value is ignored.)

## 7. Walkie on your phone

Mission Control, the asks waiting for you and your channels, on your phone. Nothing to install but the web app, and
nothing opened on your computer: the phone reaches your computer's daemon through Walkie's relay, end-to-end
encrypted (the relay can't read it). Your computer must be on and online.

1. On the computer: `walkie mobile pair`, or in the dashboard **Team → Devices → Pair a phone**. A QR code appears,
   good for 10 minutes and one phone.
2. **iPhone**: scan it with the Camera app and open the link in Safari. Copy the code it shows, tap **Share → Add to
   Home Screen**, open Walkie from your Home Screen and paste the code. (A Home Screen app keeps its own storage, so
   it pairs itself; "Use Walkie in Safari instead" pairs the Safari tab.)
   **Android**: scan it and open the link in Chrome; it pairs, then tap **Install** (or the menu's Install app).
3. The phone stays paired for 30 days after its last use (90 days at most). See and sign out phones with
   `walkie mobile devices` and `walkie mobile revoke <id>` (or `--all`), or Team → Devices; the app's Settings →
   Unpair signs itself out. Lost the phone? Revoke it.

The code under the QR code is the key to your Walkie for those 10 minutes: don't share it. Nothing about the phone
link is stored off your computer and phone. (Local development only: `WALKIE_DEV=1 WALKIE_RELAY_URL=ws://127.0.0.1:<port>
WALKIE_MOBILE_APP_URL=http://localhost:<port>/m` points a source-run daemon at a local relay and app; run the relay with
`bun src/relay/server.ts`.)

## 8. Remote seats (optional)

A **seat** is a Claude Code or Codex agent that a teammate starts on your machine through Walkie (PROTOCOL §11). It
is remote code execution by design, so it is off until you turn it on, and each seat should run as an OS user of its
own: a seat running as **your** user can reach your Walkie daemon (and act as you on the team) and every file you can.

Seats and compute sharing (`walkie pool share on`, split runs) can't be on together on one machine: the shared model
server listens where any user of the machine, a seat user included, can reach it. Walkie refuses the second one and
says which to turn off (`walkie pool share off` / `walkie pool stop` before seats; `walkie seats deny` before sharing).

1. Close your home to other users (seat users included): `chmod 700 ~` (check: `stat -f %Lp ~` prints `700`).
   Setup refuses an open home unless you pass `--accept-readable-home`, and then seat users can read what it shows.
   **The short way:** `walkie seats enable` does steps 2–4 in one go (it asks for your password through sudo once),
   and prints what it did and whether the machine is ready (`walkie seats doctor` checks it again any time). Joining
   with `--allow-team-agents` (`… | sh -s -- --invite wk1… --allow-team-agents`, or `walkie join … --allow-team-agents`)
   runs it too; `walkie setup` asks after you join someone else's team. On a Mac whose Claude login is only in the
   Keychain: `claude setup-token | walkie seats enable --yes --claude-token-stdin`.
2. Let Walkie give every seat a fresh OS user of its own, made for it and destroyed after it, never reused (asks for
   your password through sudo; macOS or Linux):

   ```sh
   walkie seats setup-user           # prints what it will do
   walkie seats setup-user --apply   # does it
   ```

   It makes the group `walkie-seats`, a root-owned `/usr/local/libexec/walkie` with root-owned copies of walkie as
   `walkie-seat-runner` and `walkie-seat-admin` (the helper that creates and destroys seat users) and of your
   `claude`/`codex` binaries in `runtimes/` (an npm `codex` script is listed for you to install where seat users can
   run it), and one sudoers file, checked with `visudo -c` before and after: your user may run exactly
   `walkie-seat-runner seat-runner` as a member of `walkie-seats`, and exactly `walkie-seat-admin seat-admin create
   <n>` / `destroy <n>` as root, without a password. It keeps `~/.walkie` at 0700, checks it all and turns seat users
   on. Each seat then runs as `walkie-s<n>` (uid 600000+n, n always new) under `/Users/walkie-s<n>/walkie-seats/`.
   Re-run `--apply` after `walkie update` (and after updating `claude`/`codex`) so the copies match.
3. **Claude login.** Claude seats run on this machine's own Claude login (your subscription): its
   `CLAUDE_CODE_OAUTH_TOKEN` (in your environment or the seat env file, `~/.walkie/seat-env`) or, without one, its `~/.claude/.credentials.json`,
   handed to each run only and gone with its user. A running seat can read that login. If your login is only in the
   macOS Keychain (the usual case on a Mac), a fresh user can't use it: `walkie seats` says so, and you give seats a
   token: `claude setup-token`, then `walkie seats token set < token.txt` (recommended anyway; `walkie seats token
   clear` goes back). Codex seats run on this machine's own Codex sign-in (`~/.codex/auth.json`, from `codex login`),
   handed to each run the same way.
4. Turn seats on: `walkie seats allow` (or `walkie join <peer> --allow-seats`). Without seat users this is refused;
   `walkie seats allow --same-user` runs them as you anyway, with a warning, when you accept that. A configuration
   from before seat users (`seats: {allow: true}`) runs nothing until you do one or the other; `walkie seats` says so.

**Check it on a real Mac once** (the tests fake the OS under the helper; this proves the real one). The helper by hand,
one user made and destroyed:

```sh
ls -ld /usr/local/libexec/walkie /usr/local/libexec/walkie/walkie-seat-{runner,admin}   # root wheel, 755
sudo visudo -c                                        # every sudoers file parses
sudo -n /usr/local/libexec/walkie/walkie-seat-admin seat-admin create 90001    # {"ok":true,"name":"walkie-s90001",…}
sudo ls -l /var/db/walkie-seat-admin.sqlite           # -rw------- root: the id ledger
cat /usr/local/libexec/walkie/seat-roots.json         # the world-writable directories also swept (root's, 0644)
id walkie-s90001                                      # uid=690001 gid=690001(walkie-s90001) groups=690001,<walkie-seats>
ls -led /Users/walkie-s90001                          # drwx------ walkie-s90001, and no ACL lines under it
grep -x walkie-s90001 /usr/lib/cron/cron.deny /usr/lib/cron/at.deny            # listed in both
sudo -u walkie-s90001 crontab -l                      # "You (walkie-s90001) are not allowed to use this program"
sudo -u walkie-s90001 /bin/ls ~                       # Permission denied (your home is closed)
sudo -u walkie-s90001 /bin/cat ~/.walkie/local.token  # Permission denied
# leave things behind as that user: a file in /var/tmp, a KeepAlive LaunchAgent, a background process
H=/Users/walkie-s90001; P=$H/Library/LaunchAgents/test.walkie.keepalive.plist
sudo -u walkie-s90001 /bin/sh -c "echo x > /var/tmp/walkie-s90001-left; mkdir -p $H/Library/LaunchAgents; (nohup sleep 600 >/dev/null 2>&1 &)"
sudo -u walkie-s90001 /usr/bin/plutil -create xml1 $P
sudo -u walkie-s90001 /usr/bin/plutil -insert Label -string test.walkie.keepalive $P
sudo -u walkie-s90001 /usr/bin/plutil -insert ProgramArguments -json '["/bin/sleep","600"]' $P
sudo -u walkie-s90001 /usr/bin/plutil -insert KeepAlive -bool true $P
sudo launchctl bootstrap user/690001 $P && sudo launchctl print user/690001/test.walkie.keepalive | grep state   # running
ps -U 690001                                          # the sleeps and the agent's job
# what turned the old root cleanup into deletion of anyone's files: a name with a newline spelling out another path,
# and a link of the seat's to a directory of yours; plus files in /Users/Shared and /Library/Caches
mkdir -p /private/tmp/walkie-victim && echo mine > /private/tmp/walkie-victim/keep                 # yours
sudo -u walkie-s90001 /bin/sh -c 'd="/private/tmp/walkie-s90001-probe
/private/tmp/walkie-victim"; mkdir -p "$d" && echo x > "$d/keep"
ln -s /private/tmp/walkie-victim /private/tmp/walkie-s90001-link
echo x > /Users/Shared/walkie-s90001-left; echo x > /Library/Caches/walkie-s90001-left
mkdir /private/tmp/walkie-s90001-locked && echo x > /private/tmp/walkie-s90001-locked/f
chflags uchg /private/tmp/walkie-s90001-locked/f /private/tmp/walkie-s90001-locked
echo x > /private/tmp/walkie-s90001-acl && chmod +a "everyone deny delete" /private/tmp/walkie-s90001-acl'
# and (optional) a disk image of its own, mounted by it: it must be unmounted and not survive
sudo -u walkie-s90001 /bin/sh -c 'cd /private/tmp && hdiutil create -quiet -size 1m -fs HFS+ -volname s90001 walkie-s90001.dmg && hdiutil attach -quiet -mountpoint /private/tmp/walkie-s90001-mnt walkie-s90001.dmg'
mount | grep walkie-s90001-mnt                        # "mounted by walkie-s90001"
sudo -n /usr/local/libexec/walkie/walkie-seat-admin seat-admin destroy 90001   # {"ok":true,…}
id walkie-s90001; ls /Users/walkie-s90001; ls /var/tmp/walkie-s90001-left      # all: no such user / file
cat /private/tmp/walkie-victim/keep                   # mine: nothing of yours was touched
ls -d /private/tmp/walkie-s90001* /Users/Shared/walkie-s90001* /Library/Caches/walkie-s90001* 2>&1   # none left (the locked ones and the image too)
mount | grep walkie-s90001                            # nothing: its mount was forced off
ps -U 690001; sudo launchctl print user/690001        # nothing; "Could not find domain"
sudo find /private/tmp /private/var/tmp /private/var/folders /Users/Shared /Library/Caches -xdev -user 690001   # nothing
rm -r /private/tmp/walkie-victim
sudo -n /usr/local/libexec/walkie/walkie-seat-admin seat-admin create 90001    # refused: never reused
sudo -n /usr/local/libexec/walkie/walkie-seat-admin seat-admin pending          # {"ok":true,"ids":[]}
walkie seats allow && walkie seats                    # "seats allowed as fresh seat users"; nothing quarantined
```

Then, from a launcher's machine, seats that probe their limits and leave things behind:

```sh
walkie seat run --machine <this Mac> --runtime claude --wait -- \
  'Run exactly these shell commands and report their output: id; ls ~<you>; curl -s --unix-socket /Users/<you>/.walkie/walkie.sock http://x/v1/me; echo x > /var/tmp/planted-$(id -u); mkdir -p ~/.claude && echo "{\"hooks\":{\"SessionStart\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"touch /tmp/walkie-hook-ran\"}]}]}}" > ~/.claude/settings.json; (crontab -l; echo "* * * * * touch /tmp/walkie-cron-ran") | crontab -; (nohup sleep 600 >/dev/null 2>&1 &); echo planted'
walkie seat run --machine <this Mac> --runtime claude --wait -- 'Run: id; ls -la ~; ls /var/tmp'
walkie seat run --machine <this Mac> --runtime claude -- 'Run this and never stop: trap "" TERM; while :; do (sleep 1000 &); sleep 0.05; done'
walkie seat stop <that seat>
```

Expect: the first seat's `id` shows `walkie-sN`, `ls` and `curl` fail with permission errors, and its `crontab` is
refused; the second runs as a **different** `walkie-sM` whose home has no `.claude` and whose `/var/tmp` listing has no
`planted-*` file; on this Mac afterwards `ls /tmp/walkie-hook-ran /tmp/walkie-cron-ran` finds neither, `dscl . -list
/Users | grep walkie-s` lists no user of an ended seat, and `ps -U <uid>` of each is empty (the forking seat that
ignores SIGTERM included); `walkie seats` shows nothing quarantined.

**A seat user that stays quarantined.** `walkie seats` (and the dashboard) list it with the helper's reason. Walkie
retries every minute; a reason that doesn't clear on its own names what to look at: a process that survives SIGKILL
(`ps -U <uid>`: usually one stuck in the kernel, gone after a reboot), a mount it couldn't force off (`mount`), a file
of its with a system flag (`ls -lO`; `sudo chflags noschg <path>`), an entry of another user inside a directory of its
(`sudo ls -la <dir>`: whose it is), or a missing `seat-roots.json` (re-run `walkie seats setup-user --apply`). Once
fixed, the next retry removes it; a daemon restart retries too.

One person per machine takes seats for now: the sudo rules name one daemon user, and a second person's `setup-user`
is refused (it names whose seats the machine takes; `/usr/local/libexec/walkie/seat-owner`). Seat user ids run
1–99,999 per machine and are never reused; after the last, no seat user is made and Walkie says so.

What this does not clean: named POSIX shared-memory objects a seat creates may outlive it (macOS has no way to list
them; later seats run under other uids), and files it left on another mount or inside another user's directory it
could write but not list. The destroy's file sweep runs as the seat user through `sudo -u` from root, which the
default sudoers allows (`root ALL=(ALL) ALL`); if yours doesn't, destroys fail and seat users stay quarantined.

Turn seats off (and stop every running seat) with `walkie seats deny`; `walkie seats busy` pauses them while you
use the machine.

## Remove

```bash
walkie hooks uninstall claude && walkie hooks uninstall codex
walkie daemon uninstall
rm -rf ~/.walkie ~/.local/bin/walkie
```

Hook installers back up your settings first, to `settings.json.bak-walkie-<ts>` and `config.toml.bak-walkie-<ts>`.
