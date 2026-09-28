# Verification log

## 2026-09-25 — live cross-tailnet run

Two real machines on **different tailnets** (one node shared into the other), each running a daemon from source
with a temp `WALKIE_HOME` and peer port 17458. Identity came from real `tailscale whois` in both directions: each side
resolved the other's login correctly.

| Check | Result |
|---|---|
| `walkie init` → `walkie invite <login>` → `walkie join <ip>:17458` from the second machine | joined in 0.55 s, full roster synced |
| Presence (`walkie who` on both sides) | both online; rtt 68 ms / 84 ms |
| `ask @kira` → auto-responder on the other machine answers → asker unblocks (10 rounds) | 75 75 77 81 81 93 107 108 123 173 ms, **median 93 ms** |
| Offline catch-up: stop one daemon, post 20 events on the other, restart | 20/20 present within 4 s of restart, in order |

In-process suite: `bun test` 144/144. Push delivery 2–8 ms, ask to MCP channel push on another node ~22 ms.

## 2026-09-25: release binaries

`bun scripts/build.ts --all` produces single-file binaries with the dashboard embedded:

| Target | Size |
|---|---|
| darwin-arm64 | 62.6 MB |
| darwin-x86_64 | 70.3 MB |
| linux-x86_64 | 95.7 MB |
| linux-arm64 | 94.7 MB |

- **darwin-arm64**, run from /tmp with no source tree: daemon start, init, `/auth` 302, and the index plus hashed JS served from the embedded map.
- **linux-x86_64** on WSL2 (kernel 6.18): `version` and `daemon start` work. `init` refuses with `tailscale_unavailable` because WSL has no Tailscale node of its own, which is correct. Linux hosts need `tailscale` on PATH.
