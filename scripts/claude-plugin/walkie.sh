#!/bin/sh
# Resolves the installed walkie binary and execs it.
#
# Claude Code's plugin hooks and MCP server call this with the same arguments
# the walkie CLI already uses:
#   walkie hook claude    (src/hooks/install.ts ourEntry; src/cli/commands/agents.ts)
#   walkie mcp            (src/hooks/install.ts installClaude: `claude mcp add --scope user walkie -- <walkie> mcp`)
#
# The binary is the one on PATH, or ~/.local/bin/walkie when that directory is
# not on PATH. That is the installer's default location (scripts/install.sh
# BIN_DIR, README install command). This script does not install walkie and
# does not change `walkie hooks install`.
set -u

missing() {
  echo "Sqwakie needs the walkie binary on PATH. Install: curl -fsSL https://sqwakie.si/install.sh | sh" >&2
  exit 1
}

if [ "$#" -lt 1 ]; then
  missing
fi

walkie=""
if command -v walkie >/dev/null 2>&1; then
  walkie=$(command -v walkie)
elif [ -n "${HOME:-}" ] && [ -x "${HOME}/.local/bin/walkie" ]; then
  walkie="${HOME}/.local/bin/walkie"
fi

if [ -z "$walkie" ]; then
  missing
fi

exec "$walkie" "$@"
