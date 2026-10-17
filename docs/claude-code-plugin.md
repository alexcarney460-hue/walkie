# Claude Code plugin

Sqwakie can be installed as a Claude Code plugin from this repository. The plugin adds the same Claude Code hook entrypoint and MCP server that `walkie hooks install claude` configures. It does not install the `walkie` binary, does not run `walkie setup`, and does not change `~/.claude/settings.json` or the `install.sh` path.

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

A hook that exits 1 does not block the Claude Code action. The MCP server does not start, and Claude Code reports that failure with the same line.

The daemon still has to be running (`walkie setup` starts it). The plugin does not start the daemon. `walkie mcp` talks to the default home `~/.walkie` and socket `~/.walkie/walkie.sock` unless `WALKIE_HOME` or `WALKIE_SOCKET` is already set. The plugin does not set those variables. `walkie hooks install claude` does not set them either.

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

The settings line the CLI writes ends with `# walkie-managed`. That text is a shell comment so a later install can find its own entries. It is not passed to `walkie`. The plugin does not write `~/.claude/settings.json`.

### Skills

The bundled Talkie skills under `skills/talkie/<name>/SKILL.md` are loaded from that directory. Plugin skills are normally `skills/<name>/SKILL.md`, so the manifest points `skills` at `./skills/talkie/`. The six skills are `browser`, `scrape`, `skill-creation`, `sqwakie-ops`, `telegram-web` and `whatsapp-web`. Each file has `name`, `description` and `uses`. Claude Code reads `name` and `description` and ignores a frontmatter field it does not recognize, so `uses` stays in the file for Sqwakie's own catalog (`src/daemon/skills/catalog.ts` requires those three keys). They are invoked as `/walkie:<name>`.

The skill text names Sqwakie tools such as `walkie_who` and `browser_open`. Claude Code's name for a tool on this plugin's server is `mcp__plugin_walkie_walkie__` plus that tool name.

## Alongside `walkie hooks install claude`

The installer and `walkie setup` still connect Claude Code by writing `~/.claude/settings.json` and running `claude mcp add` when the `claude` CLI is on `PATH`. This plugin does not replace that. If both are enabled, both call `walkie hook claude` for the same events. The daemon applies one delivery of the same hook event once (`src/protocol/hook-delivery.ts`, `src/daemon/hook-dedupe.ts`). The user-scoped MCP server named `walkie` and the plugin server `plugin:walkie:walkie` are separate processes.

## Check the files

From the repository root:

```bash
claude plugin validate . --strict
```
