#!/usr/bin/env bun
// walkie — Walkie CLI. Exit codes: 0 ok, 1 error, 2 timeout/declined, 3 daemon unreachable.
import { adoptRemoteRun } from "../client/remote-run.ts";
import { WalkieError } from "../client/index.ts";
import { VERSION } from "../daemon/version.ts";
import { parseArgs, UsageError } from "./args.ts";
import { answer, ask, inbox } from "./commands/asks.ts";
import { get, post, reply, subscribe } from "./commands/board.ts";
import { hook, hooks, mcp } from "./commands/agents.ts";
import { setup } from "./commands/setup.ts";
import { update } from "./commands/update.ts";
import { daemon } from "./commands/daemon.ts";
import { doctor } from "./commands/doctor.ts";
import { license, planLimitText, upgrade } from "./commands/license.ts";
import { dashboard, fetchCmd, share, token } from "./commands/misc.ts";
import { integrations, linear } from "./commands/integrations.ts";
import { staleCmd } from "./commands/stale.ts";
import { poolCmd } from "./commands/pool.ts";
import { orchestrator } from "./commands/orchestrator.ts";
import { seat, seats } from "./commands/seats.ts";
import { channel, directCmd, init, invite, join, status, teamCmd, whoCmd } from "./commands/team.ts";
import { accounts } from "./commands/accounts.ts";
import { discover } from "./commands/discover.ts";
import { agentsCmd } from "./commands/archive.ts";
import { mobile } from "./commands/mobile.ts";
import { projectsCmd, taskCmd, tasksCmd } from "./commands/projects.ts";
import { importCmd } from "./commands/import.ts";
import { roomCmd } from "./commands/room.ts";
import { boardCmd } from "./commands/steward.ts";
import { wrap } from "./commands/wrap.ts";
import { admin, runRemote, splitRemote } from "./commands/admin.ts";
import { CLI_BOOLEANS } from "./booleans.ts";
import { errorForModel, underAgent } from "./agent-output.ts";
import { EXIT, makeCtx, type Command, type Ctx } from "./context.ts";
import { c, safeTerm } from "./format.ts";
import { defang } from "../protocol/safety.ts";
import { writeErr, writeOut } from "./stdio.ts";

const USAGE = `walkie ${VERSION} — private line between your team's agents (Walkie Direct, or over Tailscale)

usage: walkie <command> [args] [--json]

start here
  setup                                    install, start the service, create/join a team, connect agents
           [--team <name> --handle <you> [--tailscale] | --invite <code> | --join <teammate-machine>]
           [--no-service] [--no-hooks] [--allow-team-agents | --no-team-agents (aliases --allow-seats / --no-seats)]
                                           (asks once whether your team may start agents here; no terminal: no)
team
  init <team-name> --handle <you> [--direct|--tailscale]   create a team on this machine (you become owner)
  invite --handle <h> [--role member|owner|observer]       Walkie Direct: print a single-use invite code (7 days)
  invite <tailscale-login> --handle <h> [--role …]         a Tailscale team: add their tailnet login
  join <invite-code>                       join with a Walkie Direct invite code
  join <peer-host-or-100.x-ip>             join a Tailscale team through any teammate's machine
  channel create <name> [--topic t] [--members a,b | --public]   (members = restricted; --public opens an existing one)
  who [--all]                              people → machines → agents that are working or need you (--all: idle and offline too)
  pool                                     open-weight models your machines could run locally, all of them together too
  pool share on|off [--max-gb N]           let teammates' split runs use this machine (person only; off by default;
                                           only share with people you trust with your computer: see SECURITY.md)
  pool run <model> [--quant q4|q8] [--machines a,b] | --file <x.gguf>   split one model across the sharing
                                           machines (llama.cpp RPC over Walkie); serves an OpenAI API on 127.0.0.1
  pool serve <model> [--quant q4|q8] [--on <machine>]   run a model whole on one machine's GPU (this one, the
                                           named one, or the fastest one it fits); every member machine can use it
  pool connect | disconnect <machine>      an OpenAI endpoint on 127.0.0.1 here for the model that machine serves
  pool prepare <model> [--quant q4|q8]     keep a checked copy here so split runs load this machine's share from disk
  pool status | stop [--on m] | install    this machine's run, served model and sharing; stop them; install llama.cpp
  accounts                                 model-provider accounts in use and usage left (5-hour, weekly), team-wide
  team add-machine <handle> [--json]       owner: a one-time link + install command for another of a member's machines
switching accounts at usage limits (your own logins, in this machine's encrypted vault)
  claude [args…] · codex [args…]           the real CLI, same terminal, resumed on an account with room at a limit
  accounts add claude|codex                store a login (claude: paste a \`claude setup-token\`; codex: runs codex login)
           [--account <recorded id>] [--email you@x.com]
  accounts vault [--json]                  the vault: accounts, policy, sessions on each
  accounts remove <account>                forget a login
  accounts policy <account> local|own|shared [--with a,b]   who may use it (own = your other machines)
  accounts pool [on|off]                   the team's company account pool (an owner sets it; off by default)
  accounts personal <account> [off]        keep one of your logins out of the company pool (or let it back in)
  accounts promote <account>               make this machine's own login of it the one teammates lease from
  accounts --all [--json]                  every machine's accounts: window, used %, reset time, who uses what now
  accounts split [--provider p] [--caps host=n,…] [--json]   suggest seats per login per machine
  accounts pick --provider claude|codex [--model m] [--json]    the account a new session would get (exit 75: none)
  accounts exec --provider claude|codex -- <command…>           run a command (a headless launcher) on the picked account
  accounts shims install|uninstall [--profile]                   make every claude / codex switch (PATH shims)
  accounts allow-proxy on|off              keep HTTP(S)_PROXY for credentialed sessions (off: removed)
  team authority <machine>                 move roster authority to another owner machine
  team role <handle> <role>                owner: change a member's role (owner|member|observer|removed)
  team revoke <machine>                    revoke one machine (owner); the member keeps their others
  direct enable                            a Tailscale machine also serves Walkie Direct (mixed teams: run it on
                                           the roster authority, then invite codes work on a Tailscale team)
plan
  license                                  plan, seats used/total, expiry, trial days left
  license activate <code>                  activate the code from checkout (owner, on the authority)
  license refresh                          fetch the subscription's current seats now (owner, on the authority)
  upgrade [--plan team|business] [--interval month|year] [--seats n] [--no-open]
                                           open checkout for the current seat count (the billing portal if you already subscribe)
board
  post <#chan> <text…|->                   post a message (- reads stdin) [--thread id] [--raw]
  get [#chan] [--thread id] [--limit n]    recent messages, oldest first
  reply <event-id> <text…|->               reply in a thread (answers if the event is an ask)
  subscribe [#chan…] [--status] [--once]   stream new events
projects (kanban boards; every change is a signed post in the project's channel)
  projects [list] [--all]                  projects by folder: completeness, boards, last activity
  projects create <name…> [--prefix WEB] [--folder f] [--private] [--path ~/dir] [--repo r] [--points]
                                           (a person, or a named agent for its person; --private = the team's owners; Free plan: 1 project)
  projects show <project>                  its boards, columns and open cards
  projects set <project> [--name n] [--folder f] [--prefix P] [--private|--public] [--path p]   (people only)
  projects archive|restore|delete <project>          (the project's creator or an owner)
  projects board <project> add <name…>     another board (3 per project included; more are a paid add-on)
  projects export <project> [--format csv|json|ndjson] [-o file]   (people only; ndjson = the signed posts)
  tasks [--project p] [--mine] [--search q] [--assignee @a] [--state open|archived|deleted|all] [--role active,review]
  task <KEY>                               a card with its signed history and the agents on it
  task create <project> <title…|-> [--column c] [--assign @a|me] [--label a,b] [--estimate n] [--due YYYY-MM-DD]
  task move <KEY> <column|n> · task assign <KEY> <@a|me|none> · task edit <KEY> [--title …]
  task start|review|done|unblock <KEY> · task block <KEY> [reason…] · task comment <KEY> <text…|->
  task archive|restore|delete <KEY>        (delete / restore: people only)
  board steward run --project P [--dry-run] [--repo dir,dir] [--stale-hours n]   the board steward: moves cards to the
                                           column their evidence says (live agents, branches, Linear, comments), each with a comment
  board steward on|off --project P         the project's steward switch (its admins, people only)
  board steward auto on|off [--project P] [--repo dir,dir]   run it on this machine every 15 min; --project makes this
                                           machine the one that keeps P (a lease; people only)
  stale [--hours 4] [--agent-minutes 30] [--project p] [--json]
                                           what went stale: cards in progress/review with no update, agents silent
                                           while "working", online machines idle while cards wait
data room (each project's files; access = the project's members; agents add and read)
  room <project> [ls] [--all]              files, pinned first: version, size, who added it, cards
  room <project> add <file…> [--pin] [--card KEY] [--name n] [--allow-secrets]
                                           add (same name = a new version); text is scanned for secrets first
  room <project> get <name|id> [-o path|-] [--version n]    download (old versions too)
  room <project> history <name|id>         every version: who added it and when
  room <project> rm|restore|pin|unpin <name|id> · rename <name|id> <new>   (people only)
  room <project> attach|detach <name|id> <KEY>   attach a file to a card (detach: people only)
import (switch from Linear: projects, cards, history; one signed batch per 200 writes)
  import linear --dry-run [--since 45d] [--include-closed] [--projects a,b] [--team T] [--map-users @a=Name,…]
                [--stale-days 60] [--skip-stale] [--skip-duplicates] [--folder-by initiative|team] [-o plan.json]
                                           read Linear, write a plan (JSON + table) to edit; agents may run it
  import linear [same options] [--yes]     plan and import in one go (people only)
  import linear --plan plan.json [--yes]   import an edited plan (people only) · --resume · --status · --cancel
  import linear --sync [--two-way]         update imported cards from Linear now (two-way: card moves set the Linear state)
  import linear --schedule 10m|off [--two-way] [--key-file f]   keep syncing in the background (people only)
                                           key: the Linear integration's, else LINEAR_API_KEY, else --key-file <path>
asks
  ask <@handle[/machine[/agent]]> <text…> [--timeout 300] [--channel c]
                                           block until answered (exit 2 on timeout/decline)
  inbox [--all]                            open asks addressed to you
  answer <ask-id> <text…> [--decline]
admin (agents set Walkie up: audited in #general; the machine's person keeps the switches)
  admin [status] · admin log [--limit n]   this machine's switches and recent agent / remote admin actions
  admin machines [--json]                  team machines and whether you may administer each (owners: any; others: own)
  admin --machine <host> [--timeout s] [--json] <walkie command…>
  admin --machines a,b|all-mine|all …      run an allow-listed walkie command there over Walkie (never a shell):
                                           seats, accounts, pool, hooks, orchestrator, invite, team add-machine, …
  agents admin on|off|status               may agents on this machine do its setup (default on; only you turn it on)
  admin remote on|off|status               may owners (and your other machines) administer this one (default on)
agents
  agents archive [--machine m] [--search q] [--limit n] [--offset n]
                                           idle and offline agents (the Agent archive), newest first, with last title and last seen
  status <title…> [--state working|idle|waiting|blocked] [--task ALE-1] [--agent name]
WalkieTalkie (your team's orchestrator: your own Claude Code session; walkie orchestrator … works too)
  talkie status [--json]                   running, standby (lead: <machine>), needs a model login, or stopped;
                                           it starts on its own on the team's lead machine once a Claude login is there
  talkie say <text…|-> [--new] [--thread id] [--timeout 600]
                                           send a message and print the reply (continues the latest conversation)
  talkie model <default|opus|sonnet|haiku|fable|full-id>
                                           switch its model; the conversation continues (after the reply in progress)
  talkie access platform|full              platform: Walkie tools + walkie CLI always allowed; full: every tool
  talkie lead-eligible on|off              permit this WSL machine to lead only when other owner machines are offline
  talkie stop                              stop it here; it stays stopped until you start it again (or talkie auto)
  talkie auto                              back to automatic: it runs here when this machine leads, else stands by
  talkie start [--here] [--access platform|full] [--model m] [--cwd path] [--permission-mode default|acceptEdits|bypassPermissions]
           [--claude path]                 on the lead: run it (automatic); elsewhere: start it here too (asks first;
                                           --here: don't ask)
  talkie log [--limit 20]                  this machine's conversation
seats (agents a teammate starts on a machine whose person opted in; they run on that machine's own sign-in)
  seats enable [--yes] [--same-user] [--launchers …] [--max n] [--claude-token-stdin]
                                           one step: let your team start agents on THIS machine (sets up a fresh
                                           OS user per seat with your sudo, then allows seats; prints what it did;
                                           claude setup-token | walkie seats enable --yes --claude-token-stdin
                                           also gives Claude seats a token of their own, on a Keychain-only Mac)
  seats doctor                             is this machine ready for seats (Claude/Codex signed in for them, …)?
  seats start <machine> [--count n (1-10)] [--provider claude|codex] (--prompt "…" | --brief <file|->)
              [--model m] [--permission-mode acceptEdits] [--timeout 3600]
                                           start n agents on a teammate's machine
  seats allow [--launchers @alex,@alex/alex-mac/orchestrator] [--max n (default 3)] [--runtimes claude,codex,kimi]
              [--dir path] [--env NAME,NAME (extra variables seats get)]
                                           let launchers (default: the team's owners) start seats on THIS machine
  seats deny                               turn seats off here and stop every running seat
  seats busy [--max 1] [--for 2h]          "I'm using this computer": at most --max seats keep running here (0 = none;
                                           the newest are paused, new launches queue) until you resume or --for passes
  seats resume                             "I'm done": paused seats continue, queued ones start
  seats [list]                             this machine's setting, machines that take seats, recent seats
  seats repo [list] | add <id> <path> | rm <id>   this machine's clones that v2 seats work in (by repo id)
  seat run --machine <host> [--runtime claude|codex] [--model m] [--permission-mode acceptEdits]
           [--repo <bundle|git dir|hash>] [--timeout 3600] [--max-concurrent 9] [--wait] -- <prompt…|->
                                           start a seat there (its commits come back as a git bundle)
  seat run --machine <host> --brief-file <file|-> [--runtime claude|codex|kimi] [--label x] [--account <owner>:<id>]
           [--repo-id id --ref <sha|branch> --mode branch|detached|fresh [--branch b] [--delta <bundle>]]
           [--result-file rel/path]        a v2 seat: the brief as TASK.md, the host's own clone, a named account
  seat show <id> [--follow] | stop <id> | fetch <id> [-o file.bundle] [--save (result file; --file=true deprecated)]
artifacts
  share <file> [#chan] [--note text]       share a file (≤25 MB, content-addressed)
  fetch <hash> [-o path]                   fetch an artifact (from peers if needed)
agent integration
  discover --once [--json]                         read-only local process census (no daemon)
  hooks install|uninstall claude|codex|kimi|all [--dry-run]   status hooks + MCP tools for your agents (all = claude + codex)
  mcp                                      run the MCP server (stdio; used by agent configs)
  hook claude|codex                        hook entrypoint (called by Claude Code / Codex)
integrations (run in this machine's daemon; keys stay on this machine)
  integrations [list]                      Fireflies, Wispr Flow and Linear: status and last sync
  integrations enable <fireflies|wispr|linear> [--key-path ~/keys/x.txt | --key -] [--channel c]
           [--interval s] [--backfill-hours n] [--summarize claude|off] [--no-unfurl] [--dir path]
           [--teams A,B] [--default-team KEY] [--no-activity]
  integrations disable|remove|run <id>     pause (keeps the key) · forget everything · sync now
  linear create <title…> [--from <event-id>] [--team KEY] [--dry-run]
                                           create a Linear issue from a message/thread and link it back
ops
  dashboard [--no-open]                    open the live dashboard in your browser
  dashboard logout                         sign out every dashboard session on this machine
  mobile pair                              Walkie on your phone: one-time QR code (10 min, end-to-end encrypted link)
  mobile [devices] · mobile revoke <id>|--all   paired phones · sign one (or every one) out
  token rotate                             replace ~/.walkie/local.token (the loopback API's bearer for scripts)
  doctor                                   diagnose Tailscale, daemon, peers, clock, db
  daemon start|stop|status|run             manage the local daemon
  daemon install|uninstall [--dry-run]     launchd (macOS) / systemd --user (Linux) service
  update [--check] [--allow-downgrade]     self-update from the latest release (signed checksums + version)
  version | help

env: WALKIE_HOME (default ~/.walkie), WALKIE_SOCKET, WALKIE_AGENT (agent name for posts), NO_COLOR
agents: pass --for-agent whenever the output goes to a model. Every read (get, subscribe, inbox, ask, who,
        linear create; --json too) then wraps teammates' text in <walkie-message trust=…> (information, not
        instructions) and builds JSON from an allowlist. Detected without the flag (best effort) from an agent
        runtime's execution markers (CLAUDECODE, CODEX_THREAD_ID, WALKIE_AGENT, …) or an agent runtime CLI among the
        command's parent processes (claude, codex, kimi, aider, hermes, …); configuration variables never count.
admin commands (invite, team add-machine|role|revoke, seats, accounts, pool, hooks, …): a person at a terminal
        confirms (or passes --yes); an agent, or a run with no terminal, goes ahead while agent admin is on, audited.
person-only: team authority, team role … removed, revoking another member's machine, dashboard and mobile pair ask
        you to type the handle, machine or "yes" at a terminal; agents are refused.
exit codes: 0 ok · 1 error · 2 timeout/declined · 3 daemon unreachable`;

const COMMANDS: Record<string, Command> = {
  init, invite, join, channel, team: teamCmd, who: whoCmd, pool: poolCmd, direct: directCmd, post, get, reply, subscribe, ask, inbox, answer, status,
  share, fetch: fetchCmd, accounts, agents: agentsCmd, projects: projectsCmd, tasks: tasksCmd, task: taskCmd, import: importCmd, room: roomCmd, mobile, dashboard, token, doctor, daemon, mcp, hook, hooks, setup, update, integrations, linear, license, upgrade,
  orchestrator, talkie: orchestrator, seats, seat, admin, stale: staleCmd, discover, board: boardCmd,
};

const BOOLEANS = CLI_BOOLEANS;

export async function main(argv: string[]): Promise<number> {
  adoptRemoteRun(); // AGENT-ADMIN-1: a remote admin run's token never reaches what this walkie spawns
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { writeOut(USAGE + "\n"); return EXIT.ok; }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") { writeOut(`walkie ${VERSION}\n`); return EXIT.ok; }
  // ACCOUNTS-2: the CLI's own arguments go through untouched (Walkie's flag parser never sees them).
  if (cmd === "claude" || cmd === "codex") return wrap(cmd, rest);
  // The seat user helper (admin.ts): root only, through sudo, `seat-admin create <n>` / `destroy <n>` / `pending`.
  if (cmd === "seat-admin") {
    const { runSeatAdmin } = await import("../daemon/seats/admin.ts");
    const { realAdminSys } = await import("../daemon/seats/admin-sys.ts");
    return runSeatAdmin(rest, realAdminSys());
  }
  // The seat runner (PROTOCOL §11 "Seat user"): what sudo runs as the seat user; no options, input on stdin only.
  if (cmd === "seat-runner" && rest.length === 0) {
    const { runSeatRunner } = await import("../daemon/seats/runner.ts");
    return runSeatRunner();
  }
  // AGENT-ADMIN-1: `walkie admin --machine <m> <command…>` passes the remote command's own flags through untouched.
  if (cmd === "admin") {
    const wantsJson = rest.includes("--json");
    try {
      const remote = splitRemote(rest);
      if (remote) {
        const ctx = makeCtx(parseArgs([...(remote.json ? ["--json"] : []), ...(remote.forAgent ? ["--for-agent"] : [])], BOOLEANS));
        return await runRemote(ctx, remote);
      }
    } catch (err) {
      if (err instanceof UsageError) { writeErr(`walkie admin: ${safeTerm(err.message)} (see: walkie help)\n`); return EXIT.error; }
      if (err instanceof WalkieError) {
        // Machine-readable for the orchestrating agent: {"ok":false,"error":{"code","message"}} on stdout with --json.
        if (wantsJson) writeOut(JSON.stringify({ ok: false, error: { code: err.code, message: err.message } }) + "\n");
        writeErr(`${c.red("walkie:")} ${safeTerm(err.message)}${err.code ? c.dim(` [${safeTerm(err.code)}]`) : ""}\n`);
        return err.code === "daemon_unreachable" ? EXIT.unreachable : EXIT.error;
      }
      throw err;
    }
  }
  const run = COMMANDS[cmd];
  if (!run) { writeErr(`walkie: unknown command "${cmd}" (see: walkie help)\n`); return EXIT.error; }
  let ctx: Ctx | undefined;
  try {
    const args = parseArgs(rest, BOOLEANS);
    if (args.flags.get("help") === true) { writeOut(USAGE + "\n"); return EXIT.ok; }
    ctx = makeCtx(args);
    return await run(ctx);
  } catch (err) {
    // FINAL-2 Codex 3: an error message can carry text from a peer or an external service (a Linear API
    // error, a post refusal); for a model it is defanged like any other read. Release gate 2026-09-26
    // (Codex 1): an external service's error (Linear, upstream) also gets the §6 wrapper, trust=external.
    // The command's own classification (flag, environment, then ancestors: ADD-MACHINE-5), so an error under a
    // runtime with no variable (Kimi, Hermes, Aider) is wrapped for the model like its output; before a context
    // exists (a usage error in the arguments), the flag and the environment.
    const forAgent = ctx ? ctx.forAgent : rest.some((a) => /^--for-agent(=(true|1|yes|on))?$/i.test(a)) || underAgent();
    const msg = (s: string, code?: string) => (forAgent ? errorForModel(cmd, s, code) : safeTerm(s));
    const plain = (s: string) => (forAgent ? defang(s, 600) : safeTerm(s)); // Walkie's own wording (usage, codes)
    if (err instanceof UsageError) {
      writeErr(`walkie ${cmd}: ${plain(err.message)} (see: walkie help)\n`);
      return EXIT.error;
    }
    if (err instanceof WalkieError && planLimitText(err)) {
      writeErr(`${c.yellow("walkie: plan limit.")} ${msg(planLimitText(err) as string, err.code)}\n`);
      return EXIT.error;
    }
    if (err instanceof WalkieError) {
      writeErr(`${c.red("walkie:")} ${msg(err.message, err.code)}${err.code && err.code !== "daemon_unreachable" ? c.dim(` [${plain(err.code)}]`) : ""}\n`);
      return err.code === "daemon_unreachable" ? EXIT.unreachable : EXIT.error;
    }
    writeErr(`${c.red("walkie:")} ${msg((err as Error).message)}\n`);
    return EXIT.error;
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--internal-orchestrator-hook") {
    const { validChildLease } = await import("../daemon/orchestrator/supervisor.ts");
    const valid = validChildLease(process.argv[3] ?? "", process.env.WALKIE_TALKIE_RUN ?? "");
    if (!valid) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "WalkieTalkie lease expired" } }));
    process.exit(0);
  }
  if (process.argv[2] === "--internal-orchestrator-supervisor") {
    const { superviseChild } = await import("../daemon/orchestrator/supervisor.ts");
    process.exit(await superviseChild(process.argv[3] ?? "", process.argv.slice(4)));
  }
  process.exit(await main(process.argv.slice(2)));
}
