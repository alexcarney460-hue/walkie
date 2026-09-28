# Changelog

Releases are cut with `scripts/release.sh vX.Y.Z` (or the `release` workflow on a `v*` tag); both refuse a tag
without a matching `## vX.Y.Z` section here. The section becomes the GitHub release notes.

## v0.2.0-pre.8

- **Faster, never-stuck daemon**: fixed indexes that made common queries walk every event; a watchdog names anything
  that blocks for more than half a second. Store migration 13 is safe to replay.
- **WalkieTalkie runs on its own on the lead machine.** No more pressing Start: on the machine that leads, a start by
  hand now means "run automatically", and a pre.6 or pre.7 WalkieTalkie that was started by hand there becomes automatic
  on upgrade. `walkie talkie auto` (and the dashboard's Resume button) returns a stopped machine to automatic; a start
  by hand on a machine that doesn't lead still asks first.
- **Only one WalkieTalkie leads at a time.** The team authority grants a renewable lease, and only the person at the
  machine can give WalkieTalkie shell access. WalkieTalkie runs from its own folder without inheriting Claude settings,
  and the dashboard keeps showing it as running while it works.

### Seats v2

- **Seats get a proper task, workspace and account.** A launcher can hand a seat a brief (written into its work tree
  as `TASK.md`, never on the command line or in a post, removed however the seat ends), let it work in the host's own
  clone of a repo (`walkie seats repo add <id> <path>`; a worktree on a `lane/…` branch, a detached checkout or a
  fresh copy), run it on a named account (`--account <owner>:<id>`), and get a result file back (`--result-file`,
  fetched with `walkie seat fetch <id> --save`; `--file=true` remains as a deprecated alias).
- **Kimi seats.** Kimi runs only with full access, so a host person opts in explicitly
  (`walkie seats allow --runtimes claude,codex,kimi`); Kimi seats run as the person, never as a seat user.
- **Accounts for seats.** Without a named account a seat keeps using the machine's own login. With one, the usual
  vault rules apply, and while the team's company account pool is on, a pooled login works too (for owners and
  members, never observers). A Codex login from another machine is leased as an access-only copy.
- **`CLAUDE_CONFIG_DIR` reaches same-user seats**, so the seat env file (`~/.walkie/seat-env`) can point seats at a
  separate worker login instead of your own `~/.claude`.
- **`--dir ~` fix:** `walkie seats allow --dir '~/work'` is stored as `~/work` (it used to become `~/~/work`).
- **Seat requests stay safe across machines.** Replicas handle the newer seat requests consistently, and a borrowed
  account's reserved capacity stays protected for the account owner while a seat is running. Empty macOS temporary
  folder leftovers no longer take up seat slots. `walkie seat fetch <id> --save` saves the result file.
- Your agents can set this machine's seats repos (with agent admin on, recorded in the audit trail).

### Board steward

- **Every project board keeps itself accurate.** The board steward moves cards from evidence: a live builder agent on a
  card moves it to In progress; its branch's own commits plus a review request or an audit agent move it to Review; a
  merge into a release branch or tag, its Linear issue Done, or a "done" comment move it to Done; work idle for a day
  goes back to To do (or is marked blocked with its last error) and its owner is mentioned; duplicates are flagged
  with a comment, never archived. Every move posts its evidence on the card; a person's move wins and pins the card
  for 24 hours. `walkie board steward run --project P [--dry-run]`, `walkie board steward on|off --project P`, and
  `walkie board steward auto on --project P` (this machine keeps P's board every 15 minutes). The steward's switch and
  lease are a person's; an agent may only dry-run it.
- Moving a person's card needs every machine on v0.2.0-pre.8; until then the steward says which machine to upgrade.
  A machine that already had `steward.auto` on takes the lease of every project it stewards and nobody holds, once.

### Company account pool

- **Share the team's logins when you want to (a team setting, off by default).** A team owner turns it on with
  `walkie accounts pool on`; everyone is told once. While it is on, every vault login not marked personal can be
  leased by every owner's and member's machine (never an observer's); `walkie accounts personal <account>` keeps one
  of yours out.
- **A 10 % reserve** of every window is kept for the login's own person: a borrower never uses the last 10 %.
- **Codex renewals happen on the account's own machine.** Other machines can use the access-only copy without taking
  over renewal.
- **Honest about what a lease is.** A Claude setup-token cannot refresh, so lending one hands out a bearer credential
  for that account until it expires or its person revokes it at claude.ai; turning the pool off stops new leases but
  cannot take one back. A Codex login is lent as an access-only copy (never its refresh token), and only its home
  machine refreshes it.
- `walkie accounts --all` shows every machine's accounts, windows and reset times and who uses what now;
  `walkie accounts split` suggests how many seats each login can carry; `walkie accounts promote` makes this
  machine's own login of an account the one teammates lease from. The dashboard has a company pool panel.

### Team compute (local models)

- **Serve a model on the best machine** (`walkie pool serve <model>`), and connect to it from any machine
  (`walkie pool connect <machine>`: an OpenAI-compatible endpoint on 127.0.0.1).
- **Split runs** load each machine's share from its own disk (`walkie pool prepare`), size shares by what each machine
  really holds, and use one pool job per machine at a time.
- **Macs with Apple Silicon join the pool** (Metal), and a machine under critical memory pressure stops its stage
  instead of swapping.

### Agent visibility

- **Every agent shows up, hooks or not.** Mission Control and `walkie who` now find Kimi, headless `claude -p` and
  `codex exec` runs, Grok, Gemini, opencode and ACP agents by their processes; `walkie hooks install kimi` adds Kimi's
  status hooks; local model servers count as machine load. Prompts are never published. `walkie discover --once`
  prints the local census without the daemon.

### Linear import (one command to switch, then sync)

- **`walkie import linear`: switch from Linear in one command.** A dry run reads the workspace and writes an editable
  plan (JSON + a table): per Linear project the Walkie project it becomes (collision-safe prefix, folder from the
  initiative or team), counts per column, and flags for completed or canceled projects (unticked), stale backlog,
  likely duplicates and earlier imports. The run imports projects, cards (column by state, labels, assignee, estimate,
  due date, parent, link back) and a history + comments digest per card; it re-runs safely (updates, never
  duplicates), resumes after an interruption, and finds its cards in the signed log if its local map is lost.
  Dashboard: Projects → Import from Linear (connect, plan with checkboxes, live progress, sync toggles). Dashboard
  Linear import and model buttons now work.
- **Board ops batch.** `POST /v1/projects/:channel/batch` signs up to 250 card writes in one transaction, from a
  separate import budget (10 000 ops per hour, people only). Measured: 2 000 cards + 1 200 history comments imported
  in 6.2 s and replicated to a second daemon in 17.6 s with production sync timings (3.96 MB); the interactive path
  needed ~52 minutes for the same posts at a person's write rate. The batch changes no fold or validity rule: older daemons show the
  cards as they are.
- **Sync while switching.** `walkie import linear --sync` / `--schedule 10m`: new Linear issues become cards, moves and
  renames reach imported cards; `--two-way` also sets the Linear issue's state when a card moves in Walkie. Both
  changed: the latest change wins and the card gets a note.

### Known limitation

- **WalkieTalkie with shell access.** When a person lets WalkieTalkie run shell commands, a background job
  that a short-lived shell starts and detaches can outlive a lease handoff on macOS: the machine that loses the lead
  stops WalkieTalkie and every tool call is refused, but such a job keeps running until it ends or is stopped by hand.
  WalkieTalkie's default setup runs no shell commands, so this arises only when a person turns on full access or the
  bypassPermissions permission mode. A later
  release will run full-access WalkieTalkie as its own OS user, so its processes can be found and stopped reliably.

## v0.2.0-pre.7

- **Codex seats keep working**: the access-only Codex login a seat receives now carries an empty `refresh_token` field, which current Codex CLI versions require; the real refresh token is never copied.

- **Account reset countdown** (RESET-CLOCK-1): every account remembers when each usage window resets, learned from usage data Walkie already reads (no extra pings). The dashboard counts down live ("resets in 2h 14m", the local time on hover) and `walkie accounts` shows the time left when you run it; both say "should be available again (not yet confirmed)" once the time passes. The account router skips an account until its remembered reset and, when every account is out, names the one that frees first. Times the provider does not reveal are shown as unknown, never guessed.

### Agents set Walkie up (agent admin and remote admin)

- **Your agents can now do Walkie's setup for you.** On your machine, an agent can turn seats on, add accounts,
  install hooks, share the machine for pooled models, start or stop WalkieTalkie, mint invites and add-machine links,
  and change project settings, without asking you to type anything. Every such action is recorded in
  `~/.walkie/admin-audit.jsonl` and posted to `#general` naming the agent.
- **Owners can set up any team machine remotely** (`walkie admin --machine <name> <command>`, or
  `--machines all-mine|all`): one allow-listed `walkie` command at a time over Walkie, never a shell, with a timeout,
  capped and redacted output, and the caller re-checked while it runs. Members (and their agents) administer only their
  own machines. The machine's person is mentioned in `#general` on every remote action. A machine still on
  v0.2.0-pre.6 or older answers "update it first".
- **Two kill switches on every machine, both the person's.** `walkie agents admin off` stops local agents (and remote
  admin with them); `walkie admin remote off` stops remote admin. Both are on the dashboard's Seats page too. They are
  on by default; an agent or a remote owner can turn them off but never back on: that takes the person at the machine.
  Each machine posts one notice after the upgrade saying so.
- **What stays a person's:** dashboard login links and phone pairing codes, removing a member or another member's
  machine, moving the roster authority, turning a kill switch back on, and talking to WalkieTalkie or reading its
  conversation. Remotely, an owner also can't set what the machine's person sets there: seats `--env`, `pool install
  --dir`, WalkieTalkie's `--permission-mode`, `--cwd` and access (`walkie talkie access`), integration key paths, owner
  invites, and the private-data integrations (Fireflies, Wispr Flow).

### WalkieTalkie (the orchestrator)

- **The orchestrator is now WalkieTalkie** in the dashboard, `walkie who` and the CLI (`walkie talkie …`;
  `walkie orchestrator …` still works).
- **It starts on its own.** Once a machine has a Claude login, one WalkieTalkie per team starts on the team's lead
  machine (the roster authority first, then owners' machines); other machines wait on standby and take over if the lead
  is gone for 5 minutes. Stopping it by hand keeps it stopped. Without a login it says the one step to take.
  Upgrading: a WalkieTalkie that was running in pre.6 keeps running as a start by hand, outside the election; one that
  was stopped stays stopped. Stop it by hand to hand over to the elected lead.
- **First-run onboarding.** On its first start (and when the team has no projects yet) it opens the conversation
  itself: it offers to bring in your projects from Linear, GitHub, your local repos or existing boards, asks for
  credentials once and stores them through integrations.
- **Other computers.** It asks whether you have other machines to add and makes the add-machine link or invite for you,
  with three plain steps, in your private chat only.
- **Access and model switching.** `walkie talkie access platform|full` (platform, the default, lets it use Walkie's
  tools; full lets it do everything) and `walkie talkie model <opus|sonnet|haiku|fable|default|id>` switch without
  losing the conversation; a switch during a reply waits for it to end. Both are in the dashboard's chat header and
  Start dialog.
- **`walkie stale`** lists what went stale: cards in progress or review with no update for hours, agents silent while
  "working", and online machines sitting idle while cards wait. WalkieTalkie uses it to keep the boards current.

### Public source

- **Walkie's source is public** under the Functional Source License (FSL-1.1-ALv2), with RC Studios as licensor: you
  can read, build and run it, and each version becomes Apache-2.0 two years after its release. The README explains how
  to build from source.
- **Contributions need a Contributor License Agreement** (CLA.md), signed once with a comment on your first pull
  request; you keep your copyright.

### Seats

- **The seat env file moved to `~/.walkie/seat-env`** (`seat-env` in the Walkie home). Seats source it for their login
  environment (for example `CLAUDE_CODE_OAUTH_TOKEN` or `CODEX_HOME`); `seats.env_file` in `config.json` names another
  file (an absolute path or `~/…`; read at start, never set through the API). The previous file name is no longer
  read: move its contents to `~/.walkie/seat-env`. Codex seats also look for `codex` in `$CODEX_HOME/bin` after `PATH`.

## v0.2.0-pre.6

- **A fresh look for the dashboard** (UI-POLISH-2): one colour system everywhere: an indigo accent, status colours
  (working green, waiting on you amber, stuck red, review violet, to do sky), a colour per runtime (Claude, Codex, Kimi,
  local) and per machine, coloured kanban columns, gradient usage meters, loading skeletons, and a gentle fade-in that
  respects reduced motion. Presentation only; contrast checked in light and dark.

### Data Room

- **A Data Room for every project** (DATA-ROOM-1, Alex: "that's how humans do projects"). A "Data Room" tab beside the
  project's boards lists its files, pinned documents first: name, size, type, who added it (a person, or an agent,
  marked), when, versions, and the cards it is attached to. Drop files anywhere on the tab or use Upload; download any
  version from History; rename, pin / unpin and remove / restore are for people. Access is the project's: a private
  project's room is the team's owners', and anyone else's machine never receives file names or bytes.
- **Cards have files.** A card's drawer lists its files: drop files there to add them to the room and attach them,
  attach one already in the room, detach. Dropping a file on a card on the board does the same; cards show a
  paperclip count.
- **Versions.** Adding a file with the name of one in the room adds a version (identical bytes add none); every
  version stays downloadable with its uploader and time (`walkie room <project> history <name>`).
- **Pinned documents reach agents.** An agent that starts a card (`walkie_task_start`, `walkie task start`) gets the
  project's pinned documents (small text files inline, wrapped as teammates' information) and the card's files; Claude
  Code also gets them once per card on its next prompt. Agents can add files and read them (`walkie_room`,
  `walkie_room_read`, `walkie_room_add`, `walkie_room_attach`), never remove, rename, pin, or replace a pinned file:
  a pinned file's text is always the latest version a person added or had in view when pinning. If the room can't be
  read, the agent gets a one-line note saying so instead of nothing.
- **Secret warning.** Text files are scanned before they are shared; a file that looks like it contains a key or a
  password waits for the person's "Upload anyway" (`--allow-secrets`), and agents can't upload one. Files are never
  altered.
- CLI: `walkie room <project> [ls|add <file…> [--pin] [--card KEY]|get <name|id> [-o out] [--version n]|history|rm|
  restore|pin|unpin|rename|attach|detach]`.
- Protocol: no new event kind. A room file is an `artifact.share` plus a board op `{op: "file"}` in the project's
  channel (PROTOCOL §10 "Data Room"); older daemons show them as a channel message and an artifact. VALIDITY and FOLD
  versions unchanged; stored project posts are classified once more as board ops (room ops now count under the board
  hidden-row bound).

## v0.2.0-pre.5

Hotfix pre-release for our own team (not "latest"; the site installer installs it by default once released, or pin
it with `WALKIE_VERSION=v0.2.0-pre.5`). Everything in v0.2.0-pre.4 plus:

- **The installer no longer freezes at setup's first question** (`curl … | sh` on macOS). The installer hands
  `walkie setup` the terminal's own device, and every prompt (setup's questions, `walkie seats enable`'s hidden token
  prompt and its "yes" confirmation) reads the controlling terminal directly (`src/cli/prompt.ts`), closed after each
  answer so `sudo` gets its own input. The terminal is read non-blocking, so a question that timed out leaves no read
  behind to take the next answer or a child's password. A question left unanswered takes its default after 5 minutes;
  Ctrl-C cancels.
  The installer change alone also unfreezes setup for the already-released pre.4 binary.
- **Seat users work on macOS.** The first real seat launch on a teammate's Mac failed ("walkie-s1 is in other groups
  (12, 61, 701, 100)", then "crontab: you (walkie-s1) are not allowed to use this program"). The seat-user helper now
  excuses only the groups every local Mac account is in through the built-in `everyone` / `localaccounts` nesting
  (a group that lists the user, or can't be explained from the local directory, is still refused), and removes a
  cron-denied seat user's crontab by unlinking it from the cron spool as root, verified gone. Linux is unchanged.
- **`walkie seats doctor` tells a stale seat helper.** `walkie update` and the installer replace walkie, never the
  root-owned copies in `/usr/local/libexec/walkie`, so the macOS fix above isn't there until they are reinstalled.
  The doctor runs each copy's `version` (read-only, no sudo; only once the copy's path is root's) and fails the check
  "the seat helper is from an older Walkie … → walkie seats setup-user --apply"; a copy it can't read is reported
  unknown, never ok. The daemon's seats view carries the same (`local.helper_version`) and the dashboard's Seats page
  shows it.
- **Start and Stop buttons on the dashboard's Orchestrator tab.** Start (in the not-running card and under a
  conversation) starts it with the daemon's defaults and shows the daemon's refusal inline (not in a team, Claude
  not found, an observer); Stop (in the header, after a confirmation) stops it, keeping the conversations. A dashboard
  session may only start it with the defaults: its model, folder, permissions and `claude` path stay with
  `walkie orchestrator start` (any of them from a session is `403`). Agents and the paired phone are still refused.
- **Agents can create projects** (AGENT-PROJECTS, Linear parity): a named agent creates a project or adds a board
  for its person (`walkie projects create` / `walkie projects board <p> add` under an agent, `POST /v1/projects`,
  `POST /v1/projects/:channel/boards`, and the new MCP tools `walkie_project_create` / `walkie_board_add`). The
  person is the project's creator and keeps the admin rights; the ops are signed with the agent's name. Still
  people-only: settings, visibility, automations and path / repo rules (an agent's create carrying either is `403`), archive / delete / restore,
  board changes and export. Plan limits (Free: 1 project; 3 boards per project) and the agent write rate apply. An
  unnamed agent is refused (`403 agent_unnamed`) before anything is created.
- Fold 8: an agent-signed project or board root counts; every project is re-folded once at startup. Validity stays
  10 (event acceptance is unchanged). A pre.4 machine doesn't show a project or board an agent created until it is
  upgraded.
- Fix: renaming or archiving a board through the client or the dashboard answered 404 (the board id's `:` arrived
  percent-encoded and the route didn't match it).

### Teammates with seats on a Mac

1. Update to v0.2.0-pre.5 by re-running the installer: `curl -fsSL https://getwalkie.vercel.app/install.sh | sh`
   (add `WALKIE_VERSION=v0.2.0-pre.5` before `sh` to pin it). `walkie update` follows full releases only, so on a
   pre-release it reports "up to date".
2. `walkie seats setup-user --apply` (asks for your password once): reinstalls the seat helper with the fix.
3. `walkie seats doctor`: every check ✓, including "the runner and user helper are this Walkie's (0.2.0-pre.5)".

## v0.2.0-pre.4

Pre-release for our own team (not "latest"; the site installer installs it by default, or pin it with
`WALKIE_VERSION=v0.2.0-pre.4`). Everything in v0.2.0-pre.3 plus:

- **Projects with kanban boards**: project channels with cards, columns and short card references, private projects
  hidden from non-members (sections below).
- **Automatic account switching for Codex**: when an account's limit is reached, Walkie relaunches on another account
  you allowed, resuming the same session.
- **Remote seats**: a teammate's agent can start Claude Code or Codex runs on your machine, each as a fresh OS user
  that is removed after the run. Off until you run `walkie seats enable`; seats and compute sharing can't be on
  together on one machine.
- **Windows machine temperatures** for WSL machines (CPU zones through PowerShell, refusing elevated sessions).
- The new landing page and an installer that defaults to this release.
- Stored events are re-judged once on upgrade (validity 10) under the projects and seats channel rules.
- Pre-release binaries are built for macOS arm64, Linux x64 and Linux arm64 only.

### Projects

WALKIE-PROJECTS-1 (ALE-5291): Projects with native kanban boards (no Linear / Jira sync). Protocol: PROTOCOL.md §10;
security: SECURITY.md "Projects"; plan: docs/plans/PROJECTS-1.md.

- **No new event kind.** A board op is a `msg.post` in the project's channel (`p-<8 hex>`) carrying `body.board`
  next to readable text, so older daemons replicate and show it as a message. Pure fold: per-field last-writer-wins
  over a clamped Lamport rev, permissions per op against the event's roster; any arrival order gives the same board
  on every machine (property-tested).
- **Daemon.** Store migration 12 (after pre.3's orch_messages, 11; `board_projects`, `board_cards`, FTS5
  `board_fts` when available), SSE `board` deltas, `/v1/projects…` and `/v1/tasks…` (PROTOCOL §10), CSV / JSON /
  signed-NDJSON export.
- **Plans.** Free: 1 project (`402 plan_limit`, `resource: "projects"`). 3 boards per project included; a 4th answers
  `402` with the extra-board add-on link ($15/month per board; the site's checkout for it is a stub). New license
  field `extra_boards` (optional).
- **Private projects = the team's owners.** The roster authority keeps private projects' members equal to the owners,
  and removing a member now drops them from every restricted channel.
- **CLI.** `walkie projects [create|show|set|archive|restore|delete|board|export]`, `walkie tasks`, `walkie task …`;
  under an agent the CLI speaks for the agent (people-only actions refused) and wraps card text.
- **MCP.** `walkie_projects`, `walkie_tasks`, `walkie_task`, `walkie_task_create`, `walkie_task_start`,
  `walkie_task_review`, `walkie_task_done`, `walkie_task_block`, `walkie_task_comment`.
- **Hooks.** An agent's `gh pr create` / `gh pr merge` moves its card per the project's automations.
- **Dashboard.** Projects in the primary nav (the old "Board" is now "Channels"; project channels are hidden there),
  projects by folder with completeness meters and live agent avatars, the board (filters, WIP, Stuck badge, agent
  presence, pointer drag and drop, keyboard), the card drawer (every field, signed history, comments, open asks),
  a 390 px layout (column tabs, "Move to"), agent cards show their project.
- **Reserved.** Channel names starting `p-` can't be created by a post or `/v1/channels`.
- **Round-1 audit fixes** (docs/audits/2026-09-26-*-projects-r1.md): cross-channel replies ignored; key-number cap;
  removal empties restricted channels for good; stable rev clamp; restore counts against Free; `agents_can_close`
  judged at the op's time (and for new cards); private card keys scrubbed from statuses; interrupted re-folds redone at
  start; agent-safe CLI mutation output; only marked `p-` channels are projects; `gh pr merge --auto` isn't a merge.
- **Round-2 audit fixes** (docs/audits/2026-09-26-*-projects-r2.md): ops ranked by causal parent (`after`: event id +
  signature hash) instead of a clamped counter or timestamps; removal drops the member from restricted channels in the
  same call; keys renumber only on a collision, old keys keep resolving (aliases); private keys masked in every status
  field for any card number; restart recovery by event-row checkpoint; project creates serialised and the authority
  checks the project quota; legacy `p-` channels managed by `/v1/channels`; `agents_can_close` is an API guardrail.
- **Round-3 audit fixes** (docs/audits/2026-09-26-*-projects-r3.md): hidden (rejected) ops carry rank so accepted
  edits built on them stand; own follow-ups add no rank (no padding); same-length masking; restart checkpoint covers roster events; key aliases derived from the fold; fold v3.
- **Round-4 audit fixes** (docs/audits/2026-09-26-opus-projects-r4.md): the +0 step keys on the machine, not the
  person (a correction from one's other machine wins); hidden-cap stubs count like no parent and re-fold their card;
  rebuilds keep the old rows and mask every key-shaped token until done; masking covers every prefix a private project
  ever had, whole tokens only (no bare-prefix masking); private projects get an opaque prefix by default.
- **Round-4 Codex fixes** (docs/audits/2026-09-26-hestia-codex-projects-r4.md): an op whose parent was evicted to a
  stub ranks by its signed claim capped at one above the entity's highest resolvable rank; rejected rows re-fold their
  card when they arrive; collision losers take the lowest free number above their proposal.
- **Round-5 audit fixes** (docs/audits/2026-09-26-opus-projects-r5.md): board ops are never evicted by the general
  hidden cap (own bound: 20 000 hidden per origin per project), ranks come only from the parent chain (the claim
  rule and key aliases of rounds 2-4 are gone), card references `WEB-12-7f3a` (key + short id) for tools, hooks and branches, ambiguous bare keys
  refused with candidates, rev informational +0 after one's own machine; fold v6.
- **Round-6 audit fixes** (docs/audits/2026-09-26-opus-projects-r6.md, docs/audits/2026-09-26-hestia-codex-projects-r6.md):
  only hidden board ops whose rejection is final (anchored) count toward the 20 000 bound and can be reduced; curable
  ones are kept (64 MB per origin per project, then refused unstored and offered again), and a reduced one comes back
  from a full copy while curable; board-op counts kept by triggers (a 20 005-op flood ingests in linear time); only
  schema-valid board ops of at most 16 KB are board ops; 8-hex short ids resolve references regardless of key or
  prefix, bare keys a card held before are ambiguous, references follow keys and are masked whole; fold v7.
- **Merged into pre.4** on top of v0.2.0-pre.3 (orchestrator, pool, phone, add-machine, Mission sub-agents,
  accounts resets, live updates kept); re-validation version 8 (7 was pre.3's team.integration roster kind). The phone
  tunnel's route allow-list is unchanged: project routes are not reachable from the phone in this release.
- **RC review fixes:** an agent-marked caller (`X-Walkie-Under-Agent`) is an agent for every Projects rule, and
  without a name it can't change a board (`403 agent_unnamed`); a store a projects-lane build made (boards as its
  migration 11, no `orch_messages`) upgrades instead of failing at start; board-op rows left unmarked by an older build
  after a rollback are classified at every start.
- **Delta review fixes:** board-op classification remembers what it examined (a rowid mark) and pages its scan; any
  projects-lane store shape (PROJECTS-1..6 had no `bop`) upgrades: the derived board tables are rebuilt and re-folded.

### Automatic account switching

- **`walkie claude` / `walkie codex`** run the real CLI in the same terminal (identical UX: the CLI keeps the
  terminal; resize, Ctrl-C, Ctrl-Z and exit codes are its own) on the vault account with the most room, and switch
  when an account hits its limit: the session resumes automatically on an account with room. The CLI is ended
  gracefully (after any background work it still runs, up to 10 minutes), the terminal restored, one line printed
  (`walkie: switched to bo***@gm***.com: al***@gm***.com reached its five-hour limit`), and the SAME session resumes
  on the next account (`claude --resume <id>` with the user's own config dir and transcripts; `codex resume <id>`
  through a shared sessions directory), with a continuation prompt (or, when a prompt was typed after the limit, an
  instruction to answer it). Every account out: it says when the earliest resets, waits and resumes by itself. A
  conversation the next account refuses to resume (signed thinking / encrypted reasoning) continues in a new session
  started with a local summary of it. Headless `claude -p` runs retry a limit-hit run on the next account; exit 75
  when none is left.
- **Fully automatic**: `walkie accounts shims install [--profile]` puts `claude` and `codex` shims in `~/.walkie/bin`
  (and, with consent, the PATH line in your shell profile; `walkie setup` offers it), so every terminal, launcher and
  agent that runs `claude` / `codex` switches. The shims run the real CLI unchanged when `WALKIE_NO_SWITCH=1` or when
  there is no vault, never call themselves, and subcommands always pass through.
- **Vault** (per owner, this machine only): `walkie accounts add claude` (a `claude setup-token`, sealed with
  AES-256-GCM, key in the macOS Keychain / libsecret / a 0600 file) and `walkie accounts add codex` (a dedicated
  CODEX_HOME per account, logged in with `codex login`); `remove`, `policy local|own|shared [--with …]`, `vault`.
  People only: agents are refused. `walkie accounts pick` and `walkie accounts exec -- <command>` for scripts and
  launchers.
- **Selector**: room = the least left over the windows that apply (5-hour, weekly, the model's own weekly);
  exhausted / needs-re-login / unknown / over-threshold accounts excluded; −10 points per running session so
  terminals spread out; ties go to your own account, then the soonest weekly reset, then the fewest sessions.
- **Team visibility**: the Accounts page shows a Switchable badge (with the policy) and every wrapped session on each
  account; agent chips follow the session to its account. Carried as optional `vault` / `leases` fields on the
  existing `vv` accounts snapshot (no new event kinds; older daemons ignore them).
- **Hand-outs between machines** (phase 3, opt-in): a Claude setup-token can be lent from its owner's vault to the
  owner's other machines (`own`), or to named teammates (`shared`, only with the owner's `"vault_sharing": true`),
  over the authenticated peer channel with a replay guard, 10 per node per hour, and the reply sealed to a one-time
  X25519 key; never stored on the borrower. Codex logins never move.
- Audit fixes (round 1, Codex + Opus): switching ahead of a limit happens only at a verified clean end of
  turn (nothing in flight, no background work, no prompt since, within 5 s, re-checked right before ending the CLI) —
  otherwise at the hard limit; credentials go only to the trusted `claude` / `codex` recorded by `shims install` /
  `trust-cli`; the resume-fallback summary is a redacted 0600 file, never a command-line argument; a Codex session is
  moved only when its rollout is tied to the process; own accounts always first and borrowing a teammate's shared
  account is opt-in (`walkie accounts borrow on`); leases and readings from other members are informational unless
  verifiable; a machine without a vault uses the owner's other machines' accounts; the vault key is never silently
  replaced and first-key creation is locked; marks follow the credential generation; every account out with no reset
  time waits (headless: exit 75) instead of using the own login; post-launch errors never end the wrapper while the CLI
  runs, and a failed relaunch continues the session on the CLI's own login; `vault_sharing` is read live; peer error
  text is sanitized; a retried headless JSON run prints one result; Codex account homes create their shared entries in
  the base first and never delete real entries recursively.
- Audit fixes (round 2): a script CLI is pinned to its interpreter (validated, run as [interpreter, script]) and
  interpreter start-up settings are cleared for the credentialed process; every symlink hop and every ancestor of every
  hop is checked (plus macOS ACLs), Homebrew only by exact prefix, and the trusted objects are re-validated and compared
  (inode / size / mtime) before every credential-bearing launch; an early switch needs Claude's stop_hook_summary after
  the Stop, only known synchronous tools (MCP tools count as done at their result) in that launch, the Stop's own timestamp, and the hard limit re-checks activity
  before ending the CLI; a prompt that lands after the Stop is answered on resume; Codex tool calls and exec sessions
  are tracked; the child is owned before the token hand-over and hand-over / summary failures recover to the own login;
  first-key creation uses an ownership-safe claim; hand-outs carry grant ids (one lease per grant, claims capped);
  remote marks bind to the credential generation; borrowing needs every own account affirmatively at its limit.
- Audit fixes (round 3, simplify): **no early switching** — a running session moves only at its account's hard
  limit, after waiting (bounded, 10 minutes, one line) for background shells, background agents and Codex exec
  sessions the transcript shows running; the clean-boundary machinery (Stop / stop_hook_summary tracking, the tool
  lists, the 5 s window, the per-tool hook set) is gone, and the threshold only ranks accounts at launch. Credentials
  go only to a native `claude` / `codex` executable (script launchers are refused with the native install command;
  interpreter pinning removed). ACL entries are parsed structurally and fail closed; the "inside the current
  project" rule applies only inside a project (launching from `~` works); endpoint, CA/TLS and proxy redirects are
  stripped from credentialed launches (`walkie accounts allow-proxy on` keeps the proxy); the key store write is
  create-only; a replaced credential's generation is published at once; an unreachable own account blocks borrowing;
  a prompt typed after the limit is found in the transcript too; `accounts exec` leases carry their grant.
- Audit fixes (round 4): credential routing is pinned in the wrapper's own `--settings` (the official
  ANTHROPIC_BASE_URL; endpoint, socket, provider, proxy, CA and TLS keys), merged with a caller's `--settings`, so a
  project's `.claude/settings.json` can no longer redirect the token (checked against the real Claude Code in a
  network-sandboxed lab); release binaries skip `.env` / `bunfig.toml` autoload and the `WALKIE_REAL_*` overrides;
  `walkie accounts add codex` runs only the trusted native codex in a cleaned environment; accounts are identified by
  owner + id (a teammate cannot shadow an own account); the 95 % threshold only ranks (any account below its hard
  limit stays eligible); a new vault key never goes to libsecret (0600 file, create-only); task completion is read
  only from runtime notification records; Codex exec sessions and code-mode cells are tracked by correlating the
  polling call; a hard limit needs affirmative quota evidence (a per-minute throttle never moves a session); Monitor
  watches count as background work and the resumed session is told what the move stopped; "try again at 8:29 PM" is
  parsed.
- Audit fixes (round 5): Codex routing is pinned like Claude's — `-c` overrides to the official ChatGPT endpoints on
  every credentialed launch and on `accounts add codex` (placement fixed in round 7), a cleaned config.toml copy (no
  provider / base-URL keys; profile files only from round 7) and
  no `.env` in account homes, Codex endpoint / refresh / CA override variables stripped, a caller's routing `-c`
  refused (checked against the real Codex in a sandboxed lab); an administrator's managed Claude settings are
  documented as inside the trust boundary; more Claude provider switches pinned; a settings `apiKeyHelper` / API key
  means no vault credential; TaskStop ends a task; model-scoped limit marks; "resets 8:30am" parsed; limit marks lift
  only with hysteresis; one refused token is a strike, two confirm re-login; marks keyed by owner for borrowed
  accounts; Codex background completion only from the polling call's affirmative result; Codex subagents tracked; a
  requested Codex session binds only to its own rollout; the libsecret-fallback key file is found on reopening;
  unreachable own accounts are named in the wait line.
- Audit fixes (round 7): Codex profiles (`<name>.config.toml`) get cleaned copies like config.toml; the routing pins
  go at the root and right after every subcommand (a subcommand's `-c` list replaces the root one), with the caller's
  earlier `-c` carried along; voice (realtime) is switched off for credentialed Codex launches and its endpoints, the
  thread-store endpoint and `--enable realtime_conversation` are refused or removed; routing keys are refused anywhere
  in a caller's `-c` (inline profile tables, spaced keys); a composite code-mode script never completes a background
  session; one refusal is one strike; exclusions are owner-qualified; more Claude endpoint variables stripped. The
  auditors' real-Codex cases are regression tests (opt-in lab).
- Audit fixes (round 8): the Codex command line is read with codex 0.156.1's own option table, so the pins land after
  every (nested) subcommand whatever value options come first (`exec fork` included); a line it cannot read with
  certainty gets no vault credentials; `--remote`, voice `--enable`s, profile paths and sub-agent `config_file`
  overrides are refused; sub-agent role configs and the `agents/` directory are cleaned copies in account homes.
- Audit fixes (round 9): caller `-c` overrides are decoded as TOML before checking (escaped / quoted / dotted keys,
  inline tables); the routing pins also close the last command's options (final over any caller `-c`); an image list
  followed by a subcommand name is refused as ambiguous; only a lone-poll code-mode script can complete an exec session.
- Walkie still **never refreshes a token**. Vault Claude accounts are metered on the same usage endpoint when it
  accepts a setup-token (else they switch on the limit message); Codex sessions report their own rate limits after
  every turn. Limits the sessions hit are remembered until the reset the provider named.
- **Merged into pre.4** (ACCOUNTS-2 branched before pre.2): it sits next to pre.3's limit resets (ACCOUNTS-RESET):
  accounts.json keeps its pre.3 format with an optional `vault` flag per record; the unix-only `/v1/vault/lease` route
  checks the request's listener (`listener`; `transport` on the lane, a name pre.3 uses for Walkie Direct). `walkie
  setup` asks about account switching after the team-agents question.
- **RC review fixes:** the vault's person-only commands use the shared agent detection (`--for-agent`, environment,
  ancestor processes), and `trust-cli` / `shims install` ask for the same confirmation as the others.

### Remote seats (`walkie seats`)

- **Seats and compute sharing are never on together on one machine** (round-9 audit): the shared model server
  (`walkie pool`) listens where any user of the machine can reach it, a seat user included. Walkie refuses to share,
  serve a stage or head a split run while seats are on, and refuses seats while sharing is on or a split run is
  running, saying which one to turn off; `walkie seats enable`, `walkie pool share on` and `walkie seats doctor` say so
  up front.
- **Turning seats off keeps compute sharing off until nothing of a seat can still run** (round-10 audits): a deny
  still stopping seats, or a seat user not verified removed, keeps sharing, stages and split runs refused; a split run
  stopped while its model server was starting no longer leaves that server running. Stored events the new seats
  channel rules forbid are re-judged once after the upgrade. The dashboard turns seats on or off only; who may launch
  and the rest stay with the CLI.
- **The Seats view works from the dashboard** (it was refused to dashboard sessions): allow or turn off seats, launch,
  stop, busy and resume. A seats channel now carries nothing but seat requests in the daemon's own words (no asks or
  answers); an agent's stop, like its launch, must name the agent; seat users turned on after Walkie started wait for
  the helper's list of leftovers first; a seat running as your own user no longer shows up as one of your agents.

- **Seats hand over access tokens only, and a seats channel carries seats traffic only** (round-8 audits): a seat gets
  the machine's Claude or Codex sign-in without its refresh token (so it can't refresh, or sign the machine out), and
  every machine now refuses ordinary posts and shares in a seats channel (repo bundles travel with the seat request),
  so the Free plan's exemption buys nothing but seats. After a restart that can't list the seat users its helper still
  holds, no new one is made until it can (and `walkie seats doctor` says so); `walkie seats enable` stores a supplied
  Claude token before it turns seats on. One person per machine takes seats, and says so if a second tries.

- **From the sign-up link:** `walkie seats enable` turns seats on in one step (seat users set up with your sudo if
  they aren't, seats allowed) and says what it did and whether the machine is ready; `walkie seats doctor` checks it
  any time (Claude and Codex signed in for seats, the helper, the channel…); `--allow-team-agents` on `walkie setup`,
  `walkie join` and the installer does the same, and `walkie setup` asks "Let your team start agents on this machine?"
  after you join. From another machine, `walkie seats start <machine> --count N --provider claude|codex --brief
  file.md` starts N agents there (the dashboard's launch form has "How many"). Codex seats run on the machine's own
  Codex sign-in; a Keychain-only Mac can hand Claude seats a token in the same step (`--claude-token-stdin`, or a hidden
  prompt). Seats work on Walkie Direct (Direct-only machines included) and on the Free plan; enabling while the team's
  owner machine is offline waits for it instead of failing. Fixed: setting up seat users while seats were off left
  seats unable to run until a restart.

- New: **remote seats.** Start Claude Code or Codex agents on a teammate's machine through Walkie, on that machine's
  own sign-in, with no SSH or shared keys. The machine's person opts in once: `walkie seats allow` (or
  `walkie join <peer> --allow-seats`); by default the team's owners may then launch there, and
  `walkie seats allow --launchers @alex,@alex/alex-mac/orchestrator` narrows that (an agent launches only when named
  like this). `walkie seats deny` turns it off and stops every running seat.
- Launch from any machine: `walkie seat run --machine <host> --runtime claude|codex [--model m]
  [--permission-mode acceptEdits] [--repo <bundle|git dir|hash>] [--timeout 3600] [--max-concurrent 9] [--wait] --
  "<task>"`. The repo travels as a git bundle; the seat works in a fresh directory under `~/walkie-seats` on the
  host, its progress streams back as posts, and its commits come back as a git bundle (`walkie seat fetch <id>`).
  `walkie seat show <id> --follow`, `walkie seat stop <id>`, `walkie seats` list the rest.
- Dashboard: a **Seats** view (`G S`, and from Team): this machine's opt-in (with the warning that it is remote code
  execution), the machines that take seats, a launch form, and every seat with its live output (rendered Markdown),
  a stop button and the result bundle.
- How it travels: signed posts in the host's restricted channel `seats-<node>` (members: the host's person and the
  launchers' people), so it works over any transport that replicates events. Older nodes store and relay these
  posts like any message; the roster authority must run this version to accept a member's seats channel.
- Security (SECURITY.md threat 13): the host decides every request itself (opt-in, launcher at request time, a person
  unless an agent is named, fresh, judged once, launcher cap, host max, 10 launches/min, channel private to the
  host's person and launchers, which only that person can shape, owners included); the prompt is stdin data; seats
  never inherit API keys (they run on the host person's subscription, the seat env file sourced when present) and run in
  their own process group with a hard time limit; output is scrubbed before it is posted; hooks and the MCP push
  inject nothing into a seat, and no team-wide status carries its prompt.
- Hardening after the Opus and Codex audits (docs/audits/2026-09-26-*):
  - A seat never gets its host daemon's socket or home. Its `WALKIE_SOCKET` is the seats' own socket and its
    `WALKIE_SEAT_TOKEN` a per-seat credential, bound to `seat-<id>` and good only for posting in its own thread;
    it dies with the seat. The host's local API refuses `seat-*` agent names.
  - A seat's environment is an allowlist (`PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `LANG`/`LC_*`, `TERM`,
    `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_HOME`, plus `walkie seats allow --env NAME,…`); other credentials in the
    daemon's environment or the seat env file no longer pass. A seat still has the host OS user's full file access: run
    the daemon that takes seats under a dedicated OS user (superseded below: seats now run as a seat user of their own).
  - At most 3 seats run on a machine by default (`walkie seats allow --max n`); a launcher gets
    min(`--max-concurrent`, the host's max).
  - `walkie seats deny` and a local `walkie seat stop` work for the machine's person whatever the roster says, and
    cover every phase (preparing, running, post-run git); a host removed, revoked or demoted ends its seats.
    Resetting launchers to the owners (`launchers: null`) now drops agents named before.
  - After a daemon crash, its next start kills every survivor of a seat's process group, also once the runtime
    itself has exited.
  - Requests are judged once without eviction (the decision is persisted before anything runs; nothing runs if it
    can't be) and refused when dated more than 2 minutes ahead.
  - The host's git never runs anything a seat planted in its repository (hooks, fsmonitor, filter/diff/merge
    drivers, sshCommand, credential helpers, include/includeIf) nor the host's global filters at the clone: no
    system/global config, and the seat's repository is read through a scratch git directory of the host's.
  - Tool lines are redacted before they are shortened.
- New: **"I'm using this computer"** for a machine that takes seats. `walkie seats busy [--max 1] [--for 2h]` (or the
  button on that machine's own dashboard, with a limit picker and an optional timer) keeps at most that many seats
  running there (0 = none): the newest are paused (their whole process group is stopped, nothing is lost, their
  time limits don't run meanwhile) and new launches queue instead of starting. `walkie seats resume` (or "I'm done",
  or the timer) continues the paused seats and starts the queued ones within the usual limits. Only the machine's
  person can set it (never an agent or a launcher); it survives a daemon restart. Stops, `walkie seats deny` and
  shutdowns still end paused and queued seats cleanly.
- **Each seat runs as an OS user of its own.** `walkie seats setup-user --apply` (with your sudo) creates a pool of
  no-login users (`walkie-seat1..N`, one per seat that may run at once, each with its own group), a root-owned runner
  and runtimes, and one sudo rule for exactly that runner. A seat then can't reach your Walkie daemon, your home
  (which must be closed to other users: `chmod 700 ~`, or `--accept-readable-home`) or another seat, and stop, deny,
  busy and the cleanup after every seat act on every process of its user, so a detached worker or a seat that kills
  its runner doesn't outlive them (a runner that dies early is reported as lost control). Seats run only with seat
  users or your explicit `--same-user`, checked at start and before every launch: a configuration that allowed seats
  before this runs nothing until you choose (the CLI and the dashboard say how). See INSTALL.md, "Remote seats". The
  seat's Walkie credential is a 0600 file (`WALKIE_SEAT_TOKEN_FILE`), not an environment variable.
- **Seat users are removed one step at a time, each verified, and never at the same time as they are made** (round-7
  audits). The helper holds each id for one operation (a destroy waits for its create, or cancels one whose helper is
  gone), stops a destroy wherever a process survives SIGKILL, recovers a home whose creation was interrupted, forces
  off the seat's own mounts, and also sweeps the world-writable directories `walkie seats setup-user --apply` finds on
  the machine. The seat user's sweep clears its own locks (`uchg`, ACLs) before deleting, keeps nothing of its own, and
  only walks where the seat could have written, so another user's huge folder can't block it. Each id belongs to the
  person whose daemon asked for it; the daemon saves each id durably before asking and, at every start, removes any the
  helper still holds for it. `walkie seat stop`, `walkie seats` and the dashboard say when a seat user couldn't be
  verified removed, why, and where to look; uncommitted work of a seat user's seat is reported as discarded.
- **A seat's files are removed by the seat user itself, never by root** (round-6 audits: a root `find | rm` of a
  seat's files could be steered by a file name with a newline, or a directory swapped for a symlink, into deleting
  anyone's files). Before its account is deleted, the seat user sweeps what it owns in /tmp, /var/tmp, /Users/Shared,
  /Library/Caches, its own /var/folders folder and its home, entry by entry through directory descriptors, never
  following a link or crossing a mount, then checks again; root only stops its processes and services, removes its
  crontab, removes its emptied home and deletes the account. The helper's id ledger is now a root-owned SQLite database
  changed one transaction at a time, so helpers running at once can't lose or reuse an id; the daemon saves each id
  before asking for it and destroys whatever a lost answer left. Every destroy step can be retried. Busy says "paused"
  and "resumed" only when verified, seat users not verified removed are shown with seats off too, and a token only
  mentioned in the seat env file no longer counts as a Claude login. The release binary never loads a `bunfig.toml` or
  `.env` from where it runs.
- **Every seat runs as a fresh OS user, made for it and destroyed after it, never reused** (round-5 audits: any
  reuse of a user let something cross from one seat to the next). `walkie seats setup-user --apply` installs a
  root-owned helper that sudo may run only as `seat-admin create <n>` / `destroy <n>`: it makes `walkie-s<n>` (a new
  id every time, its own group, no login, a fresh home without ACLs, denied cron and at) and, after the seat, removes
  every process, launchd job, crontab and at job, file it owns in /tmp, /var/tmp, /var/folders and /dev/shm, its home
  and the user, all verified; what can't be verified is reported and quarantined. Busy, deny and restart messages say
  only what was verified. Scheduler files are read exactly as cron reads them. When this machine's Claude login is
  only in the Keychain, Claude seats say to set a token for them (`walkie seats token set`).
- Seats after the round-4 audits: each seat user's home is wiped (verified) before and after every seat, and every
  run gets its own Claude/Codex configuration with hooks off, so nothing one seat leaves reaches the next; seat users
  may not use cron or at (setup-user denies them, checked before every launch, their jobs removed at every reap); the
  reaper stops everything first and kills until nothing is left, and says so when it can't verify that (the user is
  then quarantined); busy says "paused" only once verified; deny always works first; groups are checked by number;
  ACLs and unreadable checks fail closed; the runtime copies are checked before every launch and the permission probe
  runs as the seat user; the daily launch bound survives a restart. Claude seats run on this machine's own Claude
  login by default (a running seat can read it); `walkie seats token set` gives them a token of their own.
- Seat fixes after the round-3 audits (docs/audits/2026-09-26-*-seats-r3.md): seat users are checked by numeric id
  (never root, you, an administrator, or your group); the runner's whole path must be root's; the seats' socket
  directory is fresh and unpredictable, and nothing launches without it; the runner reaps a finished runtime's group
  at once and refuses overlong input lines; launches per launcher per day are bounded (200).
- Seat fixes after the round-2 audits (docs/audits/2026-09-26-*-seats-r2.md): a host demoted to observer starts
  nothing; only a seat's own launcher or the host's person can stop it; `walkie seats deny` stops every seat even when
  `config.json` can't be written; stopping a seat on the host also skips its post-run git; a failure summary is
  redacted before it is shortened; cancelling a seat while it prepares ends what the seat env file started; a seat that
  just ended can't post any more.
- The machine's availability is posted in its seats channel whenever it changes: other machines' dashboards show a
  **Busy until …** badge, `walkie seats` shows it per machine, and `walkie seat run` prints
  `queued: <machine> is busy until …` (`--wait` follows the seat through queued and paused). Local API:
  `GET|POST /v1/seats/busy`, `POST /v1/seats/resume` (the desktop tray can call these over the unix socket).
- **Merged into pre.4** (after projects, accounts-2, site-2 and temp-wsl): PROTOCOL "Remote seats" is §11 (§10 on the
  lane; Projects is §10); the re-validation version is 9 (seats and projects each raised it to 8 for their own rules).
- **RC review fixes:** a machine's seats channel is marked (`seats: true` on the host's upsert); the seats content rule
  applies from that mark on, so an ordinary pre.3 channel named `seats-<node>` keeps its history. The authority's
  removal sweep takes removed members out of other people's seats channels (only that). `walkie seats setup-user`
  looks past the account shims on PATH for the native claude / codex.
- **Delta review fixes:** the Free exemption and the host's own use need the seats mark (an unmarked channel is an
  ordinary restricted channel; behind an authority that drops the mark, no seat runs and the host backs off); the
  removal sweep is the authority's own upsert only, and duplicate members are refused; re-validation version 10.

## v0.2.0-pre.3

Pre-release for our own team (not "latest"; install with `WALKIE_VERSION=v0.2.0-pre.3`). Everything in v0.2.0-pre.2
plus:

- Walkie on your phone: an installable web app with Mission Control, asks and posts, end-to-end encrypted through a
  new relay (the relay deploy is separate).
- Limit resets on the Accounts page; the local model pool's split runs across the team's machines; a local
  Orchestrator tab; the liquid-glass dashboard redesign and a page per machine; Claude Code sub-agents as their own
  Mission Control rows; "Add a machine" links and person-only admin commands; a live dashboard (sections below).
- Pre-release binaries are built for macOS arm64, Linux x64 and Linux arm64 only, as for pre.2.

**Known limits in this release:**

- **Split runs (trust):** sharing a machine lets every non-observer teammate machine that heads a run send data to
  llama.cpp's `rpc-server`, a program that has had code-execution bugs (CVE-2026-78147 is unfixed upstream). Walkie's
  RPC guard checks op types and message shapes, not the parameters of allowed ops. Only share with people you trust
  with your computer (SECURITY "Split runs").
- **Phone relay allowance:** the daemon ends a relay link only after no acknowledgement progress for max(20 s,
  outstanding ÷ 2 KiB/s), so honest phones on bad links are never cut off. The cost: a hostile relay can hold up to
  the window for a long time (memory stays bounded) and a black-holed relay may take minutes to notice (docs/PWA.md).
- **Same OS user:** person-only checks (invites, admin commands, limit resets, split runs, the orchestrator) stop
  agents that identify themselves or run without a terminal; a process running as the same OS user that hides those
  markers is indistinguishable from the person. Loopback surfaces (the local API, rpc-server during a split run, the
  local OpenAI endpoint) assume single-user machines (SECURITY "Known limits").
- **Sub-agent descriptions shared by pre.2:** in v0.2.0-pre.2, with `share_activity` on and `share_prompts` off, a
  session's activity line could carry a sub-agent launch's description to teammates. pre.3 no longer sends it, but
  statuses already shared stay in teammates' logs.

### Live dashboard (WALKIE-LIVE-1/2/3)

- The dashboard's stream sends the agent roster as deltas chained by revision (`/v1/stream?agents=delta`), with a
  truthful Live indicator, a stall watchdog and backoff after flapping streams; other clients (the phone, the CLI)
  keep the full roster messages.
- Mission Control leads with working agents, shows how long each has been in its state (`state_since`,
  `activity_since`, which peers can't backdate), a Needs-you banner and a quieter Live activity; a signed-out screen.
- Dashboard sessions survive a daemon restart; logout and token rotation still end them.
- One-shot agent runs no longer come and go as agent cards; an unnamed MCP session pushes from the start and open asks
  are caught up when it announces itself.

### Limit resets on the Accounts page (ACCOUNTS-RESET-1)

- Each account tile says **"Resets available: N"**, **"No resets available"** or **"Not reported by <provider>"**,
  with when the soonest current window resets.
- **Codex**: a **Use a reset** button (only when N > 0 and the login is on this machine) opens a confirmation sheet
  ("This uses 1 of N resets on <account>; it can't be undone"). The daemon mints the attempt when the sheet opens and
  binds it to the account (its login and identity, re-checked right before the use is sent), then uses one through
  the Codex CLI's own app-server (`account/rateLimitResetCredit/consume`, the attempt's id as Codex's idempotency key)
  and re-reads the meter. A double-click or a retried request is one attempt: never two resets. A use whose answer was
  lost is kept (across restarts) and handed back, not replaced: the sheet says "an earlier attempt may have gone
  through", waits for usage to be read again, and a retry repeats that same attempt. Walkie reads no token for it.
  The count comes from the usage poll Walkie already makes. Failures say why (Codex not installed, not signed in,
  unreachable, refused). The app-server's whole process group is ended afterwards.
- **Claude**: resets are used on claude.ai (Settings › Usage › "Reset for free", per Anthropic's help centre), and
  Anthropic serves the count to claude.ai only, so the tile says "Not reported by Claude" and offers **Open Claude
  usage page**; Walkie re-reads the meter when you come back to the dashboard. **Kimi** has no resets (a link to its
  page); **Grok** shows the state only.
- Person-only: a request marked as an agent's (`X-Walkie-Agent`, `X-Walkie-Under-Agent`) is refused, and the routes
  are served to a dashboard session only, never the CLI/MCP token. That stops agents that identify themselves; a
  process running as you can still reach the daemon's socket and act as you, including using a reset: the accepted
  limit, the same as every person action in Walkie (SECURITY "Limit resets"; real isolation is seats). An account held on another
  machine says "Use on <machine>": v1 acts only on the machine that holds the login, and the same login on two
  machines is not coordinated (the sheet says so).
- A person's refresh (and the re-read after a reset) never polls earlier than a provider's Retry-After or a backoff;
  the hold survives discovery passes and restarts.
- The reset ledger lives in its own file, `~/.walkie/reset-attempts.json` (a rollback to pre.2 can't erase it), and
  both files are written durably (fsync). An unreadable ledger (or reset record) is kept aside as
  `reset-attempts.json.corrupt-<ms>` and resets are refused, across restarts, until you say you checked usage on all
  your Codex accounts in the sheet. A retry after a lost answer waits for a usage reading that starts at least 30 s
  after the try. A sheet whose attempt expired says so instead of starting a new one. Restoring `~/.walkie` from an
  older backup can bring back a ledger without a recent attempt (known limit: check usage first). A reset is never sent unless its attempt was written down first. An attempt whose answer was
  lost never expires on a clock: a retry (the same attempt, always) or "I checked usage" resolves it. At most 64
  accounts are kept per machine.

### Mobile app (PWA)

- **Walkie on your phone** (WALKIE-PWA-1): an installable web app at `https://getwalkie.vercel.app/m` with Mission
  Control (agents per machine, working first), the asks waiting for you (answer or decline), and channel posts with a
  reply box, updated live. Nothing to install but the web app; no Tailscale on the phone; no listener opened on the
  computer.
- **Pairing**: `walkie mobile pair` or Team → Devices → Pair a phone shows a QR code (10 minutes, one use; the secret
  rides in the URL fragment, never sent to a server). iPhone: add to Home Screen first and paste the code; Android:
  pairs at once, then Install. `walkie mobile [devices]`, `walkie mobile revoke <id> | --all`, Team → Devices → Sign
  out, and the app's Unpair revoke a phone; removing the member signs out every phone paired to that machine.
- **End-to-end encrypted** through a new stateless relay, `walkie-relay` (Bun WebSocket; Fly config in `relay/`,
  deployed at `walkie-relay.fly.dev` with pre.3): P-256 ECDH + PSK handshake, AES-256-GCM with strict counters; the relay can't read, alter or replay
  anything, and has per-address, per-socket and per-room limits. The phone reaches only an allow-list of the local
  API (Mission Control reads, post, answer; the live stream without accounts), as the person, never an agent.
- Audit fixes (PWA-FIX-1, Codex FAIL + Opus PASS_WITH_FINDINGS): every way a device leaves (revoke, expiry,
  eviction by a ninth pairing) ends its open links and streams at once and gives up its room; the daemon treats the
  relay as hostile (controls shape-checked, slots 0–63, join, handshake, queued-byte and per-device budgets; a
  violation drops the link and backs off); the relay claims no room for a socket that closed while hashing, runs a
  connection's room operations in order, keys limits on IPv6 /64 and gives computer sockets a larger budget; a link
  must prove its key within 10 s; concurrency and bytes are per device; the phone sees projected data (posts, asks and
  answers only; no plan, license, account, login or address) and can't send `raw` or `artifacts`; its writes have
  their own bucket; event detail takes real event ids; the app confirms who it pairs with and never replaces a pairing
  silently, forgets its key only on the encrypted `revoked` message, shows how fresh its data is, resubscribes when
  live updates stop, times requests out and treats a link silent past the daemon's heartbeat as stale; the service
  worker is versioned with a kill switch, and `/m/reset` clears the app's data.
- Audit fixes round 2 (PWA-FIX-2, Codex FAIL): the daemon budgets every inbound relay message, checks control
  state (rooms it never held are violations), summarises relay diagnostics once a minute, stops sending to a relay
  that stopped reading, caps pending encryption and charges encoded bytes of answers and stream messages to the
  device (a stream that falls behind ends with `resync`); a bad frame from one phone ends that phone only (relay and
  daemon; boundaries tested); the phone bounds frames and its receive queue; every retired, expired or voided pairing
  gives its relay room up and a code is shown only once its room is confirmed; session callbacks are bound to their
  connection; `/m/reset` clears only on a button press; roster changes reach the phone as a bare `refresh` notice.
- Audit fixes round 2, Opus (PWA-FIX-2): a pairing's relay room is claimed with a daemon-only random key (the code is
  `<room>.<secret>`) and the relay never hands a held room to a second claimant (a paired device's room is claimed
  again with backoff if refused or lost); handshakes are budgeted per room before the global budget; before the
  handshake every frame is held to a hello's size; a device removed while its room is being claimed never gets it;
  the app keeps one device link (a pairing link, Keep or Switch closes the old one, a late reconnect closes itself),
  forgets only the device a `revoked` message came for, and after five failed reconnects says the phone may have been
  signed out.
- Audit fixes round 3 (PWA-FIX-3, Codex PASS_WITH_FINDINGS + Opus FAIL): the daemon's outbound bound no longer
  relies on `bufferedAmount` (always 0 in Bun's client WebSocket): the relay must echo pings, and over 8 MiB unechoed
  or a late echo closes the link (tested with a real TCP peer that stops reading); every send, controls included,
  goes through that accounting, with a small reserve for controls and errors; per-room join and byte budgets at the
  relay (below the daemon's) and at the daemon keep one room's abuse from dropping the link; the response cap is on
  the projected, encoded payload and the app asks for fewer on 413 and keeps its last data on errors; consumed
  pairing rooms are released on every registration exit; a pairing room the relay drops withdraws the code and says
  so; the app owns pairing links like device links (overlapping pairings close each other); an open settles only after
  its first encrypted ping; the phone closes on text frames; refusal summaries keep their once-a-minute limit across
  drops; request and response caps count encoded bytes.
- Audit fixes round 4 (PWA-FIX-4, Codex FAIL + Opus PASS_WITH_FINDINGS): the daemon talks to the relay through
  its own WebSocket client on Bun.connect (bounded send queue, frame sizes judged from headers before payloads are
  kept, native pings rate-limited and answered through the same queue, TLS chain and host name checked); past the
  acknowledged window sends are refused instead of dropping the link, and only a 20 s stall ends it (tested at 2 and
  1 Mbit/s); relay protocol 2: a version handshake (a mismatched relay is reported, not looped on) and slot
  generations on joins, leaves, kicks and frames; under backpressure the relay drops the room that sent the most
  lately; long post, ask and answer text is cut to 4 000 characters for the phone, open asks are cut to what fits, the
  app keeps posts per channel (no stale cross-channel lists) and shows explicit loading/error states; the
  pending-encryption cap applies to every seal. **Relay and daemon ship together** (protocol 2).
- Audit fixes round 5 (PWA-FIX-5, Codex FAIL + Opus FAIL on one HIGH): the daemon's relay transport charges
  every frame (continuations and controls too) to the inbound budget as its header arrives, caps a message at 64
  fragments with no empty non-final one, reassembles into one buffer grown from the running size, keeps received
  chunks without re-copying, and closes a frame dripped over 30 s; `02 00` then a million empty continuations now ends
  the link at once (was: unbounded memory, a blocked event loop). Connect + TLS + upgrade must finish within 15 s; a
  silent link is pinged every 30 s and a dead path ends after 20 s (plain reconnect). Stricter RFC 6455 (reserved
  opcodes, minimal lengths, Close frame codes and reasons, `Upgrade`/`Connection` required, no unrequested extension or
  subprotocol, unsolicited pongs don't use the ping allowance); transport violations get the same reconnect penalty as
  link violations. Each room gets a fair share of the unacknowledged window, reserved before sealing, so a heavy
  reader is refused alone and a reserved send never fails after sealing. Open asks are projected and fitted before the
  raw-size check (140 asks of 31 000 characters answer 200, truncated). The 4 000-character cut never splits a
  surrogate pair; an IPv6 relay's certificate is checked against the bare address.
- Audit fixes round 6 (PWA-FIX-6, Codex + Opus PASS_WITH_FINDINGS, LOWs): a non-101 upgrade answer (a proxy's
  502/503) is a plain retry, not a violation; operational Close codes (1001, 1012–1014) are ordinary ends; the reconnect
  backoff resets only after a minute up; busy rooms' window shares sum within the window less one full frame, so an
  idle room can always send one (1/4/8/16 rooms tested); outbound frames drain round-robin per room; acknowledgements
  are positioned in write order and release each room's bytes exactly (no false throttling when acks arrive a ping
  late); a ping follows a phone message when none is in flight and the stall time grows with the backlog (8 KiB/s), so
  a slow honest uplink stays up (10 KiB/s tested); the first reassembly buffer is the declared length; close reasons
  are cut by UTF-8 bytes (≤ 123); open asks are bounded by the local API (`text_max`, `max_bytes`) before projection
  and fitted by encoded size, never a 413 (360 asks of 32 000 CJK characters tested); a phone view stopped during its
  first load schedules nothing afterwards.
- Audit fixes round 7 (PWA-FIX-8, Codex + Opus PASS_WITH_FINDINGS): the stall limit is a rate per ping: the
  next pending ping must be echoed within max(20 s, its distance past the acknowledged position ÷ 8 KiB/s) of the last
  acknowledgement, so pongs spaced out one by one can't hold a backlog below 8 KiB/s and a black hole with a full
  window is noticed once its next ping is overdue (~2 min, was ~17 min); every room's first message counts against its
  share, a share is never less than one full frame, and the window grows past 8 MiB with many rooms (N + 1 full
  frames + 64 KiB; ~12 MiB at most for 8 devices and 3 pairings), so an idle room can always send a full frame or a
  256 KiB reply (1/4/8/9/16/28/32 rooms tested with reply-sized and full-frame first messages); a kick and a room's
  close go in that room's lane after its queued data, so a signed-out phone reads `revoked` first; the phone's
  "truncated" marker comes only from the projection's own cut, never from a body's `truncated` field.
- Audit fixes round 8 (PWA-FIX-9, Opus FAIL on one HIGH + Codex PASS_WITH_FINDINGS): the round-7 stall rule
  measured a ping not yet written from its queued position, which round-robin lanes can overtake, so an honest slow
  relay with two or more rooms sending was dropped as a violator; the stall rule is now a virtual reader at 8 KiB/s over
  the written bytes (a written ping is due when the reader reaches it, echoed within 20 s of that), so honest relays at
  8 KiB/s or more are never behind it (1 to 8 rooms tested through a 128 KiB send buffer) and pongs spaced out one by
  one, over any frame sizes, gain nothing; what rooms hold above their share is added on top of the window (up to 8 MiB),
  so a reservation already granted never fails when rooms leave, kicks and closes always go out, and phones joining
  after one room filled a large share can each send a full first frame; small messages count against the room's share
  (16 KiB over it at most); the documented bound now counts used pairings whose rooms are still registering (~12 MiB
  for 8 devices and 3 pairings, ~15 MiB for 14 rooms; the hard ceiling adds 8 MiB).
- Audit fixes round 9 (PWA-FIX-10, Opus FAIL on one HIGH + Kimi PASS_WITH_FINDINGS): the round-9 virtual reader cut an
  honest 10 KiB/s link off during a single 256 KiB reply (the kernel takes a big frame in pieces), so the stall rule is
  round 7's again, with a gentler allowance: no acknowledgement progress for max(20 s, outstanding ÷ 2 KiB/s) (at
  8 KiB/s, honest links at 8.2–8.5 KiB/s were still cut off during a 256 KiB reply). Lenient on purpose: honest phones
  on bad links are never cut off; a hostile relay can hold up to the window for a long time, memory stays bounded, and a
  black-holed relay may take minutes to notice. Kept from rounds 7–8: kicks and closes in the room's lane, the
  projection-only truncation marker, first frames in the share, the above-share allowance, small messages in the
  share. Reserved sends, handshake replies and `revoked` are now held to max(hard ceiling, outstanding) + 64 KiB, so a
  window shrinking by more than 8 MiB (14 rooms, 12 leaving) doesn't fail them; the docs count per-frame overhead.
- Local API: `GET /v1/mobile`, `POST /v1/mobile/pair`, `DELETE /v1/mobile/devices[/:id]` (people only).
  Docs: docs/PWA.md (design, 13 layers), PROTOCOL §8, SECURITY threat 14, INSTALL §7.

### Local model pool: split runs (WALKIE-POOL-2)

- **"With all our machines together"**: the headline of `walkie pool` and the dashboard's local-models card is now
  the largest catalog model every online machine of the team could hold together (every member's, wherever it is, not
  only this machine's LAN), placed largest-first with the head chosen by the smallest total round trip (this machine
  on a tie; "started from this machine" speed shown when it isn't the best). Round trips come from this machine's own
  measurements, then the two machines' published ones (new `stats.peer_rtt` on `vv`), else an upper bound through
  this machine, else 50 ms shown as not measured. Speeds are labelled estimates. Below it, what this machine can
  start now from the machines that share.
- **Split runs over Walkie**: `walkie pool run <model> [--quant q4|q8] [--machines a,b] | --file <x.gguf>` (or "Run it
  split" on the dashboard) splits one open-weight model across the team's sharing machines with llama.cpp RPC: the
  head runs `llama-server`, every other machine an `rpc-server`, and the RPC bytes travel through Walkie's own
  authenticated peer transport (a Walkie Direct QUIC stream, or a WebSocket on the peer API port with an 8 MiB credit
  window). Nothing listens beyond 127.0.0.1 and no new port is opened; the head serves an OpenAI-compatible API on its
  loopback only (key file 0600) for its agents. `walkie pool status | stop | install`. Verified with a real run over
  both transports (test/integration/pool-split-real.test.ts).
- **Sharing is opt-in per machine, with a memory cap**: off by default; the machine's person turns it on with
  `walkie pool share on [--max-gb N]` or the dashboard switch (config `pool_share`, `pool_share_max_gb`), published to
  the team as `pool {share, cap, runtime, busy}`. A worker holds at most min(cap, its own free memory now − 1 GiB),
  measured on the worker, never taken from the head; one stage at a time; it stops the stage the moment sharing is
  turned off, the head's lease lapses (45 s), or the head is revoked, removed or made an observer.
- **People only**: starting or stopping a run and turning sharing on or off are refused to agents (403 with
  `X-Walkie-Agent`; the CLI refuses under an agent runtime), like invites. Observers can't start stages. Agents only
  use a serving model.
- **RPC guard and a pinned llama.cpp**: every machine runs llama.cpp **b11205** (`walkie pool install`, sha256-pinned
  release assets; a stage starts only if rpc-server and its RPC library hash to the pinned files, and only after the
  guard's self-test). The worker parses what the head sends and lets through only what llama-server sends: HELLO
  first (RDMA capabilities zeroed), allow-listed commands at their exact sizes, tensors whose op is one of the 26 ops
  measured in real runs (custom ops, the CVE-2026-78147 primitive, are refused), graphs of at most 16 MiB, contiguous
  leaf tensors and views inside their source. Children run under a supervisor that kills them if the daemon dies, and
  a restarting daemon reaps recorded children.
- **Trust warning**: "Sharing lets every non-observer teammate machine that heads a run send data to a program that
  has had code-execution bugs. Only share with people you trust with your computer." It is shown by
  `walkie pool share on`, under the dashboard's share switch, and in SECURITY.md, which states the residual risk
  plainly: the guard checks op types and message shapes, not the parameters of allowed ops, and llama.cpp's
  rpc-server has an unfixed code-execution bug (CVE-2026-78147).
- Docs: PROTOCOL §3 "Split runs" and "With all our machines together", §4 stage and tunnel routes; SECURITY "Split
  runs". Catalog GGUF files are pinned to a Hugging Face revision with each file's sha256.

### Orchestrator (local only)

- New: **the Orchestrator tab** and `walkie orchestrator start | say | status | log | stop`. Run a long-lived Claude
  Code session on this machine, on your own `claude` sign-in (never an API key), and talk to it from this machine's
  dashboard or terminal: a chat with conversations on the side, rendered Markdown replies, the tools each reply used,
  a "thinking" state, a stop button, and history that survives a reload and a restart. `G O` opens it.
- **Local only.** The conversation is stored on this machine and never synced: no teammate, other machine of yours,
  relay or phone gets any of it, and no channel is involved (channels named `orch-…` are ordinary channels). Reaching
  it from your phone or another device is not part of this release.
- Only you at this machine drive it: every orchestrator route refuses callers that identify as agents (an agent header)
  and phones, and `walkie orchestrator` refuses to run under Claude Code, Codex, Kimi and the like. That is detection,
  not proof: any process running as your OS user that doesn't identify as an agent counts as you (as everywhere on the
  local API). A message is checked again when its turn comes (a signed-out or expired dashboard session, or a rotated
  token: refused, never run). Replies are redacted and capped at 256 KiB; live text is redacted too and sent at most 10
  times a second. What the team sees is a generic status ("Thinking…", "Using tools…"). The agent name `orchestrator` is
  reserved for it: its own Claude posts, asks and answers on the team under that name (it proves it with a secret
  only its process gets), and nothing else can post as the orchestrator.
- A daemon that crashes no longer leaves Claude's tools running: the next start ends that process group once it has
  confirmed it is the same one. Agents can no longer sign out your dashboards or rotate the local token.
- Robustness: Claude runs in its own process group (a stop ends whatever its tools started), restarts with backoff
  and resumes its session after a crash; its error output is scrubbed before it is shown or logged.
- Local API: `GET /v1/orchestrator`, `GET /v1/orchestrator/messages`, `POST /v1/orchestrator/say | stop-reply | start |
  stop` (people at this machine only); SSE `orchestrator` and `orchestrator_message` (this machine's dashboards only).
  A present but empty `X-Walkie-Agent` header is now refused (400) instead of counting as a person. Docs: PROTOCOL §9, SECURITY threat 15.

### Dashboard redesign and machine page (WALKIE-UI-POLISH-1)

- **Liquid-glass design system** for the dashboard (light and dark), with 40 px touch targets for every button, tab
  and field and 16 px inputs at phone width.
- **Machine page** (`#/machines/<node-id>`, from the sidebar's machine list and the Team page's machine table): owner,
  OS and architecture, Walkie version, online / last seen, connection (Tailscale, Direct or relay, with round trip),
  roster authority; gauges for memory, CPU load and temperature and the accelerator card; the machine's agents
  (working and needing a person first, idle and archived in a collapsed section), the accounts used there, the largest
  local model it could run alone, and open asks to or from it. Offline, empty and not-found states; 390 px layout.
- **`stats.sys`**: machine stats carry optional platform facts (OS family and CPU architecture as bucketed values, Walkie
  version, logical CPU count, 1-minute load average) for the machine page; older daemons drop it, a malformed one is
  dropped and the rest kept (PROTOCOL §3, SECURITY).
### Sub-agents in Mission Control (WALKIE-MISSION-SUB-1)

- **Every sub-agent is a row of its own**: a Claude Code session's sub-agents (Agent / Task tool) show under the
  session in Mission Control, `walkie who` and the machine's page, and the session says "N sub-agents working". Their
  descriptions are shown to their owner; teammates get them only with `share_prompts` on. At most 16 live sub-agents
  per session. Needs the new hook events: the daemon adds them to an existing install at start (additive only), and
  open Claude Code sessions pick them up when restarted. Codex sub-agents are not shown yet.
- **Privacy fix:** in v0.2.0-pre.2, with `share_activity` on, a session's activity line carried its sub-agent
  launch's description (`Subagent: <description>`) to teammates even when `share_prompts` was off. From pre.3 it names
  only a built-in sub-agent type, and a daemon drops any other such line it would sign. Statuses already shared stay in
  teammates' logs.

### Add a machine (WALKIE-ADD-MACHINE-1)

- Add a machine (WALKIE-ADD-MACHINE-1): an owner's one-click link for another machine of an existing member (the
  Team page's `+` on each member row, or `walkie team add-machine <handle> [--json]`, `POST /v1/team/add-machine`).
  It gives a shareable `https://getwalkie.vercel.app/join#<code>` link (the code only in the fragment) and the install
  command pinned to the running release. The site's `/join` page reads the fragment, strips it from the address bar,
  shows the command, and makes no request (CSP `connect-src 'none'`, no referrer).
- Person-only (ADD-MACHINE-2): invite codes, add-machine links, invites, role changes, authority moves, revocations,
  join approvals and dashboard logins refuse an agent: `X-Walkie-Agent`, or the new `X-Walkie-Under-Agent: 1` the CLI
  sends whenever it runs in an agent runtime's environment (or with `--for-agent`); the CLI refuses those commands
  there too. Defence in depth for honest agents only (SECURITY.md, "Known limits").
- Agent detection (ADD-MACHINE-3): execution markers only (`CLAUDECODE`, `AI_AGENT`, Codex's `CODEX_THREAD_ID`/
  `SESSION_ID`/`CI`/`SANDBOX`, `WALKIE_AGENT`, …) with a real value, never configuration (`CODEX_HOME`, `AIDER_*`,
  `KIMI_*`), plus an agent runtime among the CLI's ancestor processes (Kimi Code sets no variable). Errors name the
  trigger. Boolean switches accept `=true|1|yes|on` / `=false|0|no|off` and refuse other values (`--for-agent=true`
  used to read as off).
- Person-only CLI commands (ADD-MACHINE-4/5) need a person at a terminal: stdin a TTY (output may be piped; the prompt
  goes to /dev/tty; Ctrl-C/Z/\\/D cancel; 2-minute timeout) and the target handle,
  machine or "yes" typed to confirm; agents' tool runners have no terminal. Detection stays as an extra signal:
  `python -m <module>` and interpreter options are looked through, Linux reads /proc/<pid>/cmdline, GUI app bundles
  (Claude.app, Codex.app, Windsurf and their helpers) are never agents, and an unreadable process table is only a
  diagnostic. `python -m hermes_cli`, `bun run`, `deno run npm:…` are recognised; Linux reads /proc (no ps). Reads
  under an agent runtime with no variable (Kimi, Hermes, Aider) get the model-safe output. A later `--switch=false`
  overrides an earlier `--switch`.
- /join handles a second link in the same tab (hashchange/popstate: stripped again, fields cleared) and describes the
  consent question only when the link says the team's build asks it (`&a=1`).
- `walkie setup` asks once whether the team may start agents on this machine (`--allow-team-agents` /
  `--no-team-agents`; no terminal: no), on builds that host seats; a build without them skips it.

## v0.2.0-pre.2

Pre-release for our own team (not "latest"; install with `WALKIE_VERSION=v0.2.0-pre.2`). Everything in v0.2.0-pre.1
(Walkie Direct + mixed teams) plus:

- Everything in main since pre.1: machine memory/temperature stats, dashboard sessions security fix, provider usage
  meters (sections below).
- Accurate Mission Control (below). Its status-history rule (superseded or over-shared statuses served as stubs to
  machines that join later) applies on Walkie Direct and to a mixed team's relayed pushes too.
- Local model suggestions and the machine-stats hardening (below).
- The dashboard session's route allow-list includes `POST /v1/team/invite-code` (the Team page's invite codes);
  `POST /v1/direct/enable` stays CLI-only (durable token).
- Pre-release binaries are built for macOS arm64, Linux x64 and Linux arm64 only (Intel Macs: the v0.1.x release
  or build from source).

### Local model suggestions (merged into v0.2.0-pre.2)

- **What your team could run locally**: a Mission Control card, a section on the Team page and `walkie pool` suggest
  the largest open-weight model (from a catalog of 13, 3B to 671B, with model-card links) that one machine could run
  from the memory it has free now, and a bigger one the machines on one local network could run split between them
  (exo, llama.cpp RPC). Each suggestion says why ("needs 43.7 GB, the group has 51 GB free") and gives a rough speed
  class (fast / usable / slow, labelled estimate). Memory already in use (agents, apps, anything) is not counted;
  "if idle" shows what an otherwise idle machine (the OS and about 4 GB of apps) could run. Machines within 5 ms of
  this one (the latency Walkie already measures) are grouped; everything else stands alone. Suggestions only: nothing
  is downloaded or run.
- Machine stats carry **accelerator facts**, read once at start: chip name, Apple Silicon unified memory, a user-set
  GPU memory limit, and NVIDIA GPUs with VRAM (`nvidia-smi`, 5 s timeout). Team-visible like the rest of machine stats.
- Machine-stats audit follow-ups: the macOS temperature read runs in a worker thread with a 2 s deadline (event-loop
  stall per sample 17.6 ms → 0.5 ms median on an M5); the sensor name is read only when it is a CFString, and a failed
  IOKit setup releases what it created; the memory-pressure sysctl is queried on its own so a missing OID keeps the
  memory values; hwmon/thermal listings filter before their 64-entry cap; peers' stats must be consistent (used ≤ total,
  bounded swap, 1–150 °C) and a far-future sample time is dropped instead of showing as "just now".
- Pool audit fixes (POOL-LLM-FIX-1, Codex 2026-09-26): `walkie pool` for a model wraps each group in the §6
  wrapper (`trust="team-member"`, information-not-instructions note) and its `--json` carries `trust`, `note` and
  `reported_by` with names defanged and capped; the IOKit read never falls back to the daemon thread (a failed
  worker means temperature unavailable, retried with backoff), workers are retired cooperatively (CF references
  released, `dlclose`) with a 30 s grace, one retiring at a time, and ten timeouts since start also turn it off; CLI
  calls settle at their 5 s deadline whatever the process or its pipe do, output capped at 256 KiB; NVIDIA "free now"
  uses the free VRAM each GPU reports (`stats.gpu_free`, sampled with memory; unmeasured = the GPU counts only if
  idle) and "if idle" total VRAM, labelled on every surface; a machine with a GPU is also considered on its CPU from
  system RAM, so a small GPU no longer hides a bigger model; "if idle" is described as an otherwise idle machine, not
  "with the agents stopped".
- Pool round-2 audit fixes (Codex r2 + Opus r2, 2026-09-26): a retired temperature worker counts as gone only
  when it closes, and one that doesn't within 30 s turns worker creation off until restart; every abnormal CLI-call
  end (deadline, output over the cap, stream error) is killed and counted until reaped; Apple Silicon machines are
  also considered running on the CPU from all unified memory (a 32 GB Mac with 4 GB in use can run Qwen3 32B,
  slowly); splits use each machine's fastest backend when it holds the model, count a runtime per machine and prefer
  4-bit over a slow 8-bit split; peer stats are capped for plausibility (≤ 16 TiB memory, ≤ 512 GiB per GPU); "free
  now" never exceeds "if idle"; the GPU note clamps free VRAM; the dashboard and CLI label alternatives alike; a
  multi-machine group's agent wrapper says `from="@walkie/group"` and names who reported; ≤ 5 ms reads "likely the
  same local network".

### Accurate Mission Control (merged into v0.2.0-pre.2)

- **Privacy: what a status carries is now opt-in.** Always shared (the product): each agent's state (working, idle,
  waiting, stuck, offline), runtime, model, machine, person, repo name and branch. **Prompt titles**
  (and Codex's last-reply line) only with `"share_prompts": true` in `~/.walkie/config.json` — **off by default,
  including on existing installs that never set the key** (before, a missing key meant on). **Tool text** (commands,
  file names, search patterns, URLs, subagent descriptions) only with the new `"share_activity": true` (default off);
  otherwise the activity line is a fixed phrase ("Running a command", "Editing files", "Searching", "Waiting on a
  subagent"). One policy covers discovery, the Claude Code hook and the Codex hook (which used to read only
  `WALKIE_SHARE_PROMPTS`). With prompts off, a title cached from an earlier prompt is never re-sent; a title set with
  `walkie_set_status` still is. **Statuses already sent stay in teammates' logs**: turning sharing off stops new
  disclosure, it does not recall history.
- **One projection for every status (fix round 2).** Whatever writes a status (hooks, the MCP server's announcement on
  start / resume, `walkie_set_status`, `walkie status`, discovery, any local client), the daemon rebuilds it from an
  allow-list where it signs it: title and issue key only with `share_prompts` or when set explicitly (or the branch's
  key), tool / notification text only with `share_activity`, the working directory only with the new
  `"share_paths": true`, and nothing unknown. A title or key cached before this release counts as a prompt's.
  Notifications are fixed phrases ("Needs your permission", "Waiting for input") and are classified before an agent
  is shown as waiting. More secret shapes (curl `-u`, `Cookie:`, API-key headers, npm / Hugging Face / GitLab /
  Google / SendGrid tokens, URL `?token=`, `openssl -pass pass:`, `security -w`, quoted multi-word values, a key
  block without its END); an input too long to redact whole shows no detail.
- **Round 6:** redaction false positives fixed (0 of 4,069 real branch names and 2 of 8,567 real commit subjects, both
  literal `sk-…` key fixtures, are changed; docker `-p` ports, versions, ref names, CamelCase and dotted identifiers,
  `pass=3`, `Tokens: 4096`, MAC addresses and `session: <uuid>` are left alone); linear-time redaction (400 KB JSON
  in ~20 ms; text past 64 KB gets the linear passes only); more credential forms (YAML block scalars, multi-line
  .netrc, numeric JSON passwords, `sudo -u … redis-cli -a`, env maps in code, Ruby `=>`, XML, "the password is …").
  Migration 10 carries the round-3 provenance over. A superseded status is never served in full unless it can't
  disclose anything, whatever the requester claims. Discovery keeps each running process's examination history (201
  sessions rotate fully), follows > 1 MB of transcript growth in chunks without forgetting open calls, and prunes
  the archive before re-signing. The task is checked against the branch as published.
- **Round 5:** redaction is structural: text is read as shell words (quotes, escapes, concatenation, multi-line
  quotes, `$'…'`) and the whole value of any secret-named assignment or flag, of known tools' password flags, of
  key/value lines (YAML, TOML, .netrc, .pgpass, JSON) is redacted, plus PGP / PuTTY key blocks, more provider prefixes
  and random-looking tokens (0 leaks on all audit corpora). Re-signed statuses keep `observed_at`, so narrowing the
  sharing policy never makes a dead agent look alive; re-signing is budgeted (50 per minute); provenance is a row per
  agent. Status history rules apply to pushes too, and old peers still get non-compliant own statuses only as stubs
  (upgrade every machine before adding members). Open tool calls are followed across reads; a hook's waiting keeps
  its authority through freshness re-sends; the whole over-cap population rotates and every scan makes progress; a
  deliberate task key survives discovery's updates; projection is idempotent. Codex app / IDE sessions are documented
  as not discovered.
- **Round 3:** a status title or issue key is `person` (typed with `walkie status`) or `agent` (set with
  `walkie_set_status`, whose description now warns that the whole team sees it); both are shared, prompt text is not.
  Quoted and escaped credentials (`sshpass -p "…"`, `security -w '…'`, `curl -u "user:multi word"`,
  `KEY="a\" b"`) and 19 more secret shapes (Vault, Slack webhooks, Telegram bots, DigitalOcean, Shopify, PyPI,
  Stripe webhook, xAI, Sentry, Atlassian, age, Azure, Discord, npm `_auth`, `--oauth2-bearer`, hex signing keys) are
  redacted. Open tool calls (no result yet) keep a session working while it runs, for Claude and Codex; unexamined or
  over-cap sessions keep a fresh status and rotate fairly under the scan budget, and the machine card shows
  "discovery incomplete"; Codex bookkeeping is not activity; branch and cwd are refreshed; the collection policy
  reloads with the config; CPU needs two busy readings. Machines that join later get superseded statuses as stubs.
  The Archive keeps its pages on a new revision ("New entries — refresh") and drops answers after unmount.
- **Accuracy fixes (round 2):** a quiet tool that is verifiably running keeps its agent working (all runtimes, heartbeat
  past the 30-minute stale mark); a big tool result followed by bookkeeping is read back to the turn; a session no
  longer reported (over the cap, or not examined within the scan's 10 s budget) is not marked exited; an unnamed
  session in a subdirectory still takes over its card; cached transcript paths, `.git/HEAD` and `sessions/<pid>.json`
  are read FIFO-safe and descriptor-checked; the Archive's "Load more" makes one request at a time and ignores stale
  answers; `who --all` / `walkie_who all` against an older daemon are capped client-side.
- **Redaction before truncation**, with more patterns: URL `user:password@`, `*PASSWORD=` / `*TOKEN=` / `*SECRET=` /
  `*KEY=` assignments, `mysql -p…`, `sshpass -p`, `Authorization:` / `Bearer` tokens, Stripe `sk_`/`rk_` keys,
  Tailscale `tskey-`, Fly `fm1_`/`fm2_`, `--password` / `--token` / `--secret` flags, `echo … | docker login`. A
  secret cut in half by shortening a line no longer slips past its pattern.
- **Accuracy fixes:** slash commands (`/model`, `/usage`), their output, meta and bookkeeping records (queue-operation,
  ai-title) are not activity, and Esc ends a turn; a background process a finished turn left running (a dev server)
  no longer keeps an agent "working"; CPU never overrides "Waiting on you" / "Stuck"; a tool result larger than the
  32 KB tail is read back to its start; a hook's `working` holds while a quiet tool runs; a failed `ps` changes
  nothing (no offline flapping); Claude's `sessions/<pid>.json` is read from the session's own config directory; an
  unnamed session takes over its hook card instead of posting a ghost beside it, and an `agent-<pid>` MCP card whose
  parent is a session reported under its own name is retired; claude-mem observer sessions are not agents; at most
  100 sessions per runtime per machine are reported.
- **Session files are read safely:** plain session ids only, paths confined to `<config dir>/projects` (symlinks
  resolved), regular files of the daemon's user only, opened non-blocking (a FIFO can't stall the daemon).
- **Archive:** machine / search / state filters apply on the daemon before the page is cut (`total`, `offset`,
  `truncated`, `--offset`); `walkie who --all` and MCP `walkie_who` say how many agents were not listed; the dashboard
  refreshes a loaded archive on a revision counter (`archive_rev`), not on counts; the new CLI and MCP work against a
  daemon from before this release.
- **`walkie subscribe`** ends when its reader goes away (`| head -n 1`) and stops on Ctrl-C even while its reader is
  not reading.

- **Agents are shown by what they are doing.** Discovered sessions (headless `claude -p` / `codex exec` seats and
  sessions without hooks) are `working` while their transcript or rollout file is written or a turn is in progress
  (CPU counts only for a session without a session file); `idle` after two quiet scans and 90 s; `offline` the moment
  the process ends. A hook's or `set_status`'s fresher state is never overwritten. Measured read-only on 2026-09-26 on two of our machines: one went from 0
  working / 12 idle to 9 working; the other from 0 working / 759 idle to 3 working with the ghosts retired.
- **Ended sessions are retired.** A hook- or MCP-reported agent whose process is gone goes offline (after 2 min;
  including MCP servers named `agent-<pid>`), so hundreds of "Connected to Walkie" ghosts no longer read as idle.
- **Agent archive.** Idle for 30 min or offline for 10 min moves an agent to the archive; it comes back the moment it
  works. Each daemon keeps the newest 200 archived agents per machine for 7 days. `/v1/agents` and the dashboard
  stream carry only the live roster plus archive counts (`?scope=archive|all`, `node`, `q`, `limit`).
- **Mission Control** defaults to working agents and those that need you ("Waiting on you", "Stuck"), with
  "N idle · M offline in the archive" per machine, and an **Archive** tab: per machine, searchable, last title and
  last seen.
- **CLI:** `walkie who` lists working and needing-a-person agents (`--all` for everything); `walkie agents archive
  [--machine] [--search] [--limit] [--json]`; MCP `walkie_who` the same (`all: true`).
- **Fix:** CLI output piped to another program was cut at 64 KB (`walkie who --json | jq`); every command now writes
  its output completely before exiting.

### Provider usage meters (accounts, phase 1)

- **Accounts page** (sidebar, `g u`, command palette) and an **Accounts strip on Mission Control**: one tile per
  model-provider account the team's agents run on (Claude, Codex, Kimi, Grok), pooled across machines, with a neutral
  monogram (no provider logos) and the owner's initials, the plan, where it is logged in, and **green meters of the
  usage LEFT** that fall as usage depletes: 5-hour and weekly, plus a thin bar for a model-scoped weekly window; amber
  below 30 % left, red below 10 %; reset countdowns; states unknown (with the reason), stale (> 15 min), exhausted
  (with when it's usable again) and needs re-login (with the exact step on the machine that holds the login). Each
  agent card shows a chip with its account and the tightest window left. Light/dark, 390 px single column,
  `role="meter"` with aria values.
- The daemon records accounts automatically from the running sessions it discovers (identity from the CLIs' own
  files, never from a token), polls usage on the machine that holds each login (Claude `oauth/usage`, Codex
  `wham/usage` plus session files, Kimi `usages`; every 5 min, every 60 s near a limit, backing off on errors) and
  shares a summary as an optional `accounts` field on the peer `vv` answer: no new event kinds, nothing in the event
  log, v0.1.3 peers ignore it. Grok sessions are now discovered too; Grok has no usage API, so its tile shows unknown,
  exhausted after a spent-usage failure in its CLI log (until the reset, else 60 min), or needs re-login when its
  login expired.
- Watch-only: **no token is stored, moved or refreshed** by Walkie; a token about to expire is left to its CLI.
- `walkie accounts [--json]`; local API `GET /v1/accounts`; SSE `accounts` messages. `"accounts": false` in
  `~/.walkie/config.json` turns it off.
- Audit fixes (ACCOUNTS-FIX-1, Codex + Opus, 2026-09-26): `walkie accounts` for a model goes through the
  agent-output contract (allowlist, validated labels, `trust`, `reported_by`, §6 wrapper per account); labels, plans
  and model scopes are a controlled vocabulary (masked email or fixed label) enforced on publish and on peer input;
  readings are kept per reporting machine and per member (another member reporting the same account id is an
  unverified claim, listed separately; an agent's chip uses its own machine's reading), far-future peer readings are
  rejected and reset times capped at + 8 days; usage errors are fixed codes (no response or exception text); the
  Keychain is read with a hard deadline in its own session and a timeout is classified correctly; environment-token
  sessions show "Token login, account unknown", any set `CLAUDE_CONFIG_DIR` is non-default, and a login change never
  credits the old account with the new one's usage (Kimi re-checks `/me` on every poll); Grok with a refresh token is
  unknown rather than re-login, zone-less times are UTC, numeric 402/429 count; only 401 means re-login and
  `Retry-After` is honoured; an idle login's expiring token is re-checked every 5 min after the first skip; login
  directories are read from the environment only, never from argument text; `web/node_modules` is no longer tracked.

### Machine memory and temperature stats

- Each machine's **memory and temperature** on the dashboard (sidebar machines list and the Team page: a memory bar
  coloured by pressure, used/total GB, the hottest CPU/SoC temperature in green below 70 °C, amber to 85 °C, red
  above; swap and the last update in the tooltip; greyed as last known while a machine is offline; "n/a" where a
  machine has no sensor) and in `walkie who`.
- The daemon samples every 30 s without root: macOS through `vm_stat`, `sysctl` and the IOKit HID sensor API (the one
  Stats and macmon use), Linux through `/proc/meminfo`, PSI and `/sys/class/thermal` / `hwmon`. WSL reports memory and
  no temperature. It publishes only on a meaningful change (≥ 5 % of memory, ≥ 2 °C, a pressure change) or every
  5 min, as an optional field on the existing peer `vv` answer: no new requests and nothing in the event log.
  v0.1.3 peers ignore the field and show no stats.
- Machine stats are visible to the whole team. `"machine_stats": false` in `~/.walkie/config.json` turns them off
  (`machine_stats_interval_s` sets the interval).

### Security: dashboard sessions (one-time token rotation and dashboard sign-in)

- Security (HIGH, WALKIE-SEC-COOKIE-1 and -2): the dashboard login cookie was the daemon's durable `local.token`,
  the same bearer the local API accepts from scripts. Browsers send `127.0.0.1` cookies to every port (cookies
  aren't port-isolated), so any other listener on the loopback address (another OS user's server, a container's
  forwarded port, a dev server a page steered the browser to) received a full local-API bearer that never expired.
  **No cookie authorizes anything any more.** `walkie dashboard` still opens a one-shot login link; the login now
  mints a separate **dashboard session** (256 random bits kept only as a hash in memory, bound to the Host it was
  issued for, 12 h idle / 7 days absolute) and hands it to the page in the URL fragment (`/#s=…`, never sent to a
  server). The dashboard keeps it in its own origin's `localStorage`, which other ports can't read, and sends it as
  the `X-Walkie-Session` header, which a page on another origin can't send. A session only reaches the dashboard's
  routes and is never a bearer. The first attempt (a session cookie, `walkie_s_<port>`) still let a captured cookie
  be replayed with a forged `Origin`, which read the event log and made an attacker a permanent owner through the
  invite route (both audits, 2026-09-26); that path is gone. Old browser sessions stop working after the upgrade
  (run `walkie dashboard` to sign in again); the daemon clears the old cookies.
- Security: the upgraded daemon **replaces `local.token` once on its first start** (the old value may have leaked
  through the cookie; recorded in `~/.walkie/local.token.rotated`). Scripts that read the token from the file pick
  up the new one. `walkie token rotate` now also closes requests still open with the old token (a stream opened
  with it used to keep receiving events).
- Security: `POST /v1/team/invite` (reachable from the dashboard) no longer changes a current member's role: it
  answers 409. New: `walkie team role <handle> <owner|member|observer|removed>` changes a role or removes someone
  (re-inviting was the CLI's only way to change a role).
- New: `walkie dashboard logout` signs out every dashboard session on this machine; the dashboard's command palette
  has "Sign out of this dashboard" (`POST /auth/logout`); a daemon restart also ends every session, and the
  dashboard now says to run `walkie dashboard` when its session has ended instead of retrying forever.
- Fix (MEDIUM): at startup a live daemon that answered `healthz` slower than 500 ms (a busy machine) was taken for
  dead and its socket was deleted. The socket file is now removed only when connecting to it is refused; a process
  that accepts but doesn't answer in time makes startup refuse with the path and the fix. A live socket in mode 000
  (which Bun reports like a refused one) is left alone too.
- Fix: two daemons starting at once on the same socket could both find it stale and one delete the other's new
  socket. The daemon now holds an exclusive lock on `<socket>.lock` from before it looks at the socket until it
  stops; a second start fails with "already running". The lock ends with the process, so a leftover lockfile needs
  no cleanup.
- Fix: a dashboard stream open at a session's 7-day limit kept delivering until the next minute's sweep; it now
  closes at the limit.
- Docs: PROTOCOL §5 (login, sessions, `/v1/auth/*`, the lock) and SECURITY (threats 10, 12 and 13, what remains;
  the rotation command in threat 10 was documented as `walkie doctor --rotate-token`, which never existed).

## v0.2.0-pre.1

Pre-release for our own team (not "latest"; install with `WALKIE_VERSION=v0.2.0-pre.1`). Everything in the v0.2.0
section below: **Walkie Direct** (no Tailscale needed; invite codes; iroh QUIC with relay fallback) and **mixed teams**
(a Tailscale team whose roster authority runs `walkie direct enable` accepts invite-code joiners; Tailscale-only and
Direct-only machines sync through dual machines). Known limits for this pre-release: the connection-flood limits in
SECURITY.md and the open audit follow-ups listed in docs/audits/2026-09-26-*-mixed.md and *-direct-r5.md.

## v0.2.0

- New: **Walkie Direct**, a second transport, so a team no longer needs Tailscale. Built on iroh 1.x (n0's official
  Node-API SDK): QUIC between machines with NAT hole-punching and an encrypted relay fallback (n0's public relays by
  default, `"relays": [...]` in `config.json` for your own). The node key is the machine's endpoint id, so peers
  dial each other by key and every connection authenticates it. The peer API, sync, push and pull are unchanged;
  its HTTP runs over one QUIC stream per request (ALPN `walkie/1`).
- New: **invite codes.** `walkie invite --handle <name> [--role …]` prints a single-use `wk1…` code (7 days) signed by the owner's machine; `walkie join <code>` (or `curl … | sh -s -- --invite <code>`)
  dials the roster authority by key and is admitted. The authority checks the signature, team, expiry and that the
  issuing machine still belongs to an owner, and records the invite on the chain (`team.node.invite`) so it can't be
  used again, by anyone, on any machine. Invites for an existing handle add a machine for that person. A code minted
  before its member was removed is refused (`invite_predates_removal`), so a removed member (even a removed owner)
  can't come back, on a new machine or their old one, with a code they held before; a new code re-invites them. The
  cut-off is permanent (re-inviting the member doesn't revive older codes) and clock-free: each code carries the
  issuing machine's signed roster chain position, which must be past the removal's; no timestamp is compared, so a
  removal made while the authority's clock ran ahead doesn't block the member's re-invite. Whitespace in a pasted code is
  ignored, and no error echoes a code. Codes are about 195 characters, 230–260 with the authority's relay hint.
- The Direct peer gate is the caller's authenticated key: only admitted, non-revoked machines of current members
  get in (`403 not_member` for outsiders, revoked machines and removed members; the full key is compared, not only
  its node id); rate limits per endpoint key, plus a shared budget for keys that aren't on the roster. Connections
  are budgeted before any handshake work: at most 128 native handshakes alive in total however long each lives (64
  from the direct path, 16 from relay-path strangers, the rest kept for members arriving through a relay); per
  source (an IPv4 address, an IPv6 /64, or a relay-authenticated endpoint id) at most 4, per IPv4 /24 or IPv6 /48
  at most 8, per member across all their machines at most 8; at most 32 in progress from sources not known to be
  members, of which the direct path takes 24 and 8 stay for joiners arriving through a relay; a separate lane for
  members arriving through a relay; a QUIC Retry (address validation) for unvalidated senders once 8 are pending. A
  handshake is abandoned after 15 s. Stranger hosts can no longer lock out members or joiners that arrive through a
  relay (PROTOCOL §4 "Connection budget"; SECURITY.md "Limits" says what fixed address sets can still deny, notably
  in relay-free setups). A dead cached connection is closed before redialing. 4 connections per key (a member at 4 replaces its stalest idle one), 512 in all; revoking a
  machine or removing its member closes its open connections at once. A Direct endpoint that fails to start at boot
  retries with backoff (2 s to 60 s), and the accept loop survives an accept error. A node that isn't the roster
  authority names it only to a joiner whose code checks out. Invite codes are never logged. PROTOCOL §2 is unchanged.
- New: `walkie team revoke <machine>` (owner) revokes one machine through the roster authority; the member keeps
  their other machines, and the revoked key can't rejoin, even with a new invite.
- `walkie setup` creates Walkie Direct teams by default (it asks when Tailscale is signed in; `--tailscale` picks
  a tailnet team) and joins with `--invite <code>` or a pasted code. `walkie init` takes `--direct` / `--tailscale`
  (default: Tailscale when signed in, else Direct). Existing Tailscale teams keep working unchanged.
- `team.node` gains optional `endpoint`, `transports` and `invite` (additive: v0.1 daemons accept and ignore them).
- Dashboard: the Team page makes invite codes with copy buttons (and the one-line install command), and shows each
  machine's network (Direct, or its tailnet IP). `walkie who` marks Direct machines; `walkie doctor` checks the
  Direct endpoint and relay instead of Tailscale on a Direct machine.
- install.sh no longer tells you to install Tailscale.
- Release binaries embed the iroh module for their target (prebuilt by n0 for macOS arm64 and Linux; compiled from
  n0's crate with a pinned `Cargo.lock` for Intel Macs; a cached Intel build is reused only when it matches a pin in
  `scripts/iroh-napi/SHA256SUMS`), so they grow by 13–21 MB.
- New: **mixed teams.** One team can hold Tailscale machines and machines that joined with an invite code over
  Walkie Direct. On a Tailscale team, run `walkie direct enable` on the roster authority (it keeps its tailnet
  listener and also serves Direct; `"direct": true` in `config.json`), then `walkie invite --handle <name>` works as
  on a Direct team and the joiner runs `walkie join <code>` (or `curl … | sh -s -- --invite <code>`) without
  Tailscale. Turning Direct on appends one re-pin of the machine's own record; nothing is rewritten, and v0.1
  machines on the team keep working (they ignore the new fields and never dial Direct-only machines).
- Each machine talks to each peer over a transport both serve, Tailscale first. A Tailscale-only and a Direct-only
  machine share none: their posts, asks, answers and statuses reach each other through a dual machine, which pushes
  an event its origin pushed to it on to the peers that origin can't reach (live, one hop) on top of the usual
  anti-entropy; artifacts are fetched through a dual machine; `walkie who` marks such a peer `via relay` and shows
  it online while a machine you sync with reports it. `walkie who` shows `tailscale+direct` for dual machines;
  `walkie doctor` checks both listeners on one.
- Each listener keeps its own gate: a Direct-only machine is never let in over the tailnet (and a Tailscale join
  can't re-pin one to a tailnet address), a whois login shaped like a Direct login is refused, and a Tailscale
  machine's key gets Direct access only after proving it holds the key (a Direct `/join` to the authority, done by
  `walkie direct enable`). Removal closes the machine's Direct connections at once and the tailnet gate refuses it.
  Authority can't move to a machine some active machine couldn't reach (`409 authority_unreachable`).
- Not in this release: listing or cancelling unused invite codes; turning Direct off again on a dual machine, or a
  Direct-only machine into a Tailscale one. With `"relays": []`, joining needs the authority on the same LAN or at a
  static address.

## v0.1.3

- Fix: the launchd agent ran with `ProcessType` `Background`, so macOS ran the daemon at priority 4 with throttled CPU
  and IO. On a busy Mac (load average 30–60) the 0.1.1 → 0.1.2 update left it for ~100 s with no socket, `0%` CPU and
  an unreaped `tailscale` child before it logged `daemon_started`. The agent now uses `Standard`, launchd's normal
  class. **Existing macOS installs: run `walkie daemon install` once** to rewrite the plist (`walkie update` restarts
  the service but launchd keeps the old `ProcessType` until the plist is reloaded). The systemd unit had no equivalent
  setting.
- Fix: the local socket waited on the Tailscale CLI (`tailscale ip`, then `whois`, 5 s timeout each), so a slow
  Tailscale kept `walkie doctor` and the hooks from reaching the daemon, and one that never exited (ignoring SIGTERM or
  holding its output pipe) kept the daemon from starting at all. Startup now gives Tailscale 3 s, then brings the
  socket up anyway and leaves the peer API to its retry loop; any Tailscale lookup still unsettled after 15 s counts as
  failed (`tailscale did not answer within 15 s`) so the retry loop can't wedge.
- `walkie update` now waits up to 30 s after restarting the service until the daemon answers `healthz` as the new
  version, and prints `daemon answering as <version> after N s`. If it doesn't answer (or answers as the old version,
  or the restart command fails) it says what it saw, where the log is and how to restart it, and exits non-zero.

## v0.1.2

- Fix: a daemon started before Tailscale answered (launchd at login) logged `peer_api_disabled` and never tried
  again, so teammates saw the machine offline until someone restarted it. It now retries with jittered backoff (2 s,
  growing to once a minute, for as long as it runs), and when Tailscale answers it binds the peer API, starts sync
  and logs `peer_api_enabled`. A bind failure is retried the same way instead of stopping the daemon.
- The daemon re-checks its Tailscale IP every minute. If it changes, the peer API moves to the new address and the
  node re-joins through the roster authority, which re-pins it (the authority re-pins its own node). If the address
  disappears, the peer API is closed and the daemon retries until it comes back. When the authority can't be reached
  for a re-pin the daemon logs `node_repin_pending` with what it needs, and keeps trying.
- `walkie doctor` shows `peer api: retrying (next in Ns): <reason>` while the peer API is down, with or without a
  team.
- New: running agent sessions show up without a restart. Claude Code loads hooks only in sessions started after
  `walkie hooks install`, so sessions already running never appeared. Every 15 s the daemon finds this user's Claude
  Code, Codex and Kimi processes and lists each as `idle` ("Running (no hooks yet — restart to see live activity)")
  with its repo and branch, named the way its hooks name it so both land on one card. It never overwrites a status
  from hooks or `set_status`, marks a session `offline` when its process exits, ignores other users' processes, and
  reads only the session id (and `WALKIE_AGENT`) from a process's environment. `"discover_agents": false` in
  `config.json` turns it off.
- Fix: Codex thread ids are UUIDv7, which start with a timestamp, so every Codex session started within the same few
  hours got the same agent name (`codex-35a3fc`) and shared one card. Codex agents are now named from the id's
  random tail. Claude Code names (`cc-…`) are unchanged.
- Fix: a Codex started from inside a Claude Code session inherited that session's `CLAUDE_CODE_SESSION_ID`, and its
  notify hook reported under the Claude session's name, overwriting that card. It now uses its own thread id.

## v0.1.1

- Fix: under launchd on macOS, the daemon couldn't read the Tailscale identity: the app-bundle CLI tried to start the
  GUI and reported "no IPv4 address". The daemon now runs the Tailscale CLI with `TAILSCALE_BE_CLI=1`, found on the
  first real install.
- Release gate: 30 s per-test timeout so machine load can't fail a correct build.

## v0.1.0

First release: **a walkie-talkie for your team's AI agents**, over your own Tailscale network. No server in the
middle: every member's machine runs a `walkie` daemon that replicates a signed team log to the others.

### What it does

- **Live team dashboard** (`walkie dashboard`): who is running which agent, on which machine, doing what
  (working, waiting, blocked, idle), plus every channel's messages, asks and shared artifacts.
- **Agents talk to each other**: `walkie post`, `walkie ask` (a directed question the asker blocks on, with an
  expiry), `walkie answer`, `walkie share` (content-addressed artifacts up to 25 MB), `walkie subscribe`.
  Claude Code and Codex get status hooks and MCP tools with `walkie hooks install`.
- **Team roster**: `walkie init`, `walkie invite <tailscale-login>`, `walkie join <teammate-machine>`, roles
  (owner, member, observer), restricted channels, join approval, authority transfer between owner machines.
- **Integrations**, running in one member's daemon with the keys staying on that machine: Fireflies and Wispr
  Flow meeting notes (with an optional local `claude` summary), Linear issue enrichment, activity and
  "create an issue from this thread".
- **Self-update** (`walkie update`) and a one-line installer (`curl -fsSL https://getwalkie.vercel.app/install.sh | sh`).

### Security model (docs/SECURITY.md)

- Every event is signed by the machine that wrote it (ed25519) and bound to the author's Tailscale login; the
  roster is a single chain written by one **roster authority**, so membership can't be forged or forked.
- The peer port accepts only tailnet identities that are current members; the dashboard is loopback-only
  behind an HttpOnly cookie obtained through a one-shot login nonce (the token never appears in a URL).
- Everything a teammate's agent wrote reaches a model wrapped and labelled (`<walkie-message trust=…>`),
  in MCP results, hook context and the CLI alike; secret-shaped strings are redacted before an event exists.
- Integration keys are 0600 files checked on the open descriptor (owner, mode, ACLs at the real path); external
  text is redacted, capped and labelled `trust="external"`.
- Plan decisions can't be moved by another member's clock; a member's events stamped more than a day ahead are
  held (after authentication: a forgery claiming a teammate's next event is rejected, never held); the roster
  authority's entries apply whatever their timestamp, and an authority whose clock was wrong recovers after a
  restart.
- Releases: `SHA256SUMS` carries a signed `version <tag>` line and is signed with the Walkie release key
  (ECDSA P-256 / SHA-256, `SHA256SUMS.sig`, verifiable with the `openssl` every Mac ships); the installer and
  `walkie update` verify the signature, require the signed version to be the release they asked for, then the
  checksum, and check the installed binary reports that version (`walkie update` keeps a copy of the old binary
  and restores it otherwise; downgrades need `--allow-downgrade`).
- `walkie upgrade` fails closed: when the plan can't be read (daemon stopped, no team on this machine) it names
  the billing portal instead of opening a new-subscription checkout.
- Agent-facing CLI JSON is built from a per-kind allowlist of fields (free text wrapped, one-line fields defanged,
  no signatures), Linear previews and results included; `--for-agent` is the documented switch, and Claude Code,
  Codex, Kimi, Gemini CLI, Cursor, Hermes, OpenCode and aider are recognised from the environment.
- The welcome page's activation code can be fetched again by the same checkout session for 10 minutes after it
  was shown (a lost response), and never after that.

### Licensing (docs/BUSINESS.md)

- Free (2 people, 4 machines, 1 integration), Team ($12/person/month, up to 50 people, restricted channels,
  all integrations) and Business ($24/person/month, unlimited people, join approval, audit export). Every new
  team starts a 14-day Team trial with no card.
- A purchase yields an **activation code**, exchanged once (`walkie license activate <code>`, on the roster
  authority) for a license bound to that team and recorded on the team chain. Licenses are ed25519-signed
  tokens verified offline by every machine; the authority renews automatically and checks in daily so seat
  changes made in the billing portal arrive the same day (`walkie license refresh` on demand).
- Existing subscribers change seats in the billing portal (`walkie upgrade` sends them there); checkout is
  for new subscriptions only and refuses a second one for a subscribed team.
- Enforcement is soft: hitting a limit blocks only adding more; nothing already on the team is ever removed.
