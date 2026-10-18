# Claude Code plugin

Sqwakie can be installed as a Claude Code plugin from this repository. The plugin adds the same Claude Code hook entrypoint and MCP server that `walkie hooks install claude` configures. It does not install the `walkie` binary, does not run `walkie setup`, does not change the `install.sh` path, and adds no hook entries to `~/.claude/settings.json`. Claude Code itself records the marketplace (`extraKnownMarketplaces`) and the enabled plugin (`enabledPlugins`) in that file when you install it.

## Prerequisite

Install the binary first, the same way the [README](../README.md) does:

```bash
curl -fsSL https://sqwakie.si/install.sh | sh
```

The installer puts `walkie` in `~/.local/bin` and prints a note when that directory is not on `PATH`. The plugin runs `walkie` from `PATH`, and if it is not there, from `~/.local/bin/walkie`. A binary installed somewhere else is used only when that location is on `PATH`.

When the binary is missing, the hook and the MCP launcher write one line to stderr and exit 1:

```text
Sqwakie needs the walkie binary on PATH. Install: curl -fsSL https://sqwakie.si/install.sh | sh
```

A hook that exits 1 does not block the Claude Code action. The MCP server does not start.

The daemon still has to be running (`walkie setup` starts it). The plugin does not start the daemon. `walkie mcp` talks to the default home `~/.walkie` and socket `~/.walkie/walkie.sock` unless `WALKIE_HOME` or `WALKIE_SOCKET` is already set. The plugin does not set those variables. `walkie hooks install claude` does not set them either.

## Remove the installer's Claude Code hooks first

When the `claude` CLI is on `PATH`, the installer and `walkie setup` connect Claude Code on their own: they write Sqwakie's hooks into `~/.claude/settings.json` and run `claude mcp add --scope user walkie`. Turn that off before you enable the plugin. This step is required:

```bash
walkie hooks uninstall claude
```

It removes Sqwakie's entries from `~/.claude/settings.json` (your own hooks in that file stay) and, when the `claude` CLI is on `PATH`, runs `claude mcp remove --scope user walkie`.

Running `walkie setup` again, or the install line again (it runs `walkie setup`), writes those hooks back when the `claude` CLI is on `PATH`. Add `--no-hooks` to keep them off:

```bash
walkie setup --no-hooks
curl -fsSL https://sqwakie.si/install.sh | sh -s -- --no-hooks
```

`walkie update` does not write them back, and the daemon's hook refresh after an upgrade changes nothing once Sqwakie's hooks are gone. [If both are on](#if-both-are-on) says what goes wrong when you skip this step.

## Install from the marketplace

In a Claude Code session:

```text
/plugin marketplace add alexcarney460-hue/walkie
/plugin install walkie@walkie
```

From a shell:

```bash
claude plugin marketplace add alexcarney460-hue/walkie
claude plugin install walkie@walkie
```

The marketplace name in `.claude-plugin/marketplace.json` is `walkie`. The plugin name is `walkie`, shown as Sqwakie. The install id is `walkie@walkie`.

One session can also do both, on a Claude Code build that supports it:

```text
/plugin install walkie --marketplace alexcarney460-hue/walkie
```

## What it sets up

### MCP server

A stdio server named `walkie`, launched as `walkie mcp`. That is the command `walkie hooks install claude` registers:

```text
claude mcp add --scope user walkie -- <walkie> mcp
```

`<walkie>` is the installed binary (or, in a source checkout, `bun` plus `src/cli/main.ts`). The server is `src/mcp/server.ts`, started by `walkie mcp` in `src/cli/commands/agents.ts`. In `/mcp` a plugin server is listed as `plugin:walkie:walkie`. Its tools keep the names from `src/mcp/tools.ts` (`walkie_post`, `walkie_read`, `walkie_ask`, `walkie_inbox`, `walkie_answer`, `walkie_who`, and the other `walkie_*` tools) with Claude Code's plugin prefix `mcp__plugin_walkie_walkie__`.

### Hooks

`hooks/hooks.json` registers the events in `CLAUDE_EVENTS` (`src/hooks/install.ts`). Each one runs `walkie hook claude` with a 5 second timeout, the same entrypoint and timeout as `ourEntry` in that file. The handler is `runClaudeHook` (`src/hooks/claude.ts`).

| Event | Matcher |
| --- | --- |
| SessionStart | |
| UserPromptSubmit | |
| PreToolUse | `Agent\|Task` |
| PostToolUse | `*` |
| Notification | |
| Stop | |
| SessionEnd | |
| SubagentStart | |
| SubagentStop | |

The settings line the CLI writes ends with `# walkie-managed`. That text is a shell comment so a later install can find its own entries. It is not passed to `walkie`. The plugin adds no hook entries to `~/.claude/settings.json`.

## If both are on

If the plugin and the installer's hooks are both enabled, both call `walkie hook claude` for the same events, and Sqwakie does not merge the two calls: a Claude Code hook report carries no delivery id, so the repeat check in `src/daemon/hook-dedupe.ts` does not apply to it (only the Grok hook sends one, `src/hooks/grok.ts`).

The visible effect is on sub-agent titles. Each sub-agent launch can be recorded twice (`recordLaunch` in `src/hooks/subagents.ts`), and a starting sub-agent takes the oldest recorded launch of its type. So when you start two or more sub-agents of the same type, a later one can show an earlier one's title on the dashboard until the launch reply for it arrives and corrects the title (`recordLaunched`). For a sub-agent that runs in the foreground, that reply arrives when it finishes, so the wrong title can stay for its whole run.

The user-scoped MCP server named `walkie` and the plugin server `plugin:walkie:walkie` are separate processes, and Claude Code lists the `walkie_*` tools once for each.

The fix is the step in [Remove the installer's Claude Code hooks first](#remove-the-installers-claude-code-hooks-first): run `walkie hooks uninstall claude`.

## Check the files

From the repository root:

```bash
claude plugin validate . --strict
```
