// The CLI's switch flags (no value): shared by the CLI's parser and the remote admin allow-list (src/protocol/admin.ts),
// so a remote command is checked exactly as the walkie that runs it will parse it (AGENT-ADMIN-1 fix round 2).
export const CLI_BOOLEANS: ReadonlySet<string> = new Set(["json", "raw", "decline", "all", "once", "status", "dry-run", "no-open", "help", "no-service", "no-hooks", "check", "allow-downgrade", "public", "no-unfurl", "no-activity", "for-agent", "new", "direct", "tailscale", "allow-team-agents", "no-team-agents", "mine", "private", "points", "profile", "switching", "no-switching", "move",
  "wait", "follow", "pin", "save", "allow-secrets", "allow-seats", "no-seats", "yes", "same-user", "apply", "accept-readable-home", "claude-token-stdin", "here",
  "include-closed", "skip-stale", "skip-duplicates", "resume", "cancel", "sync", "two-way", "one-way", "no-wait"]);
