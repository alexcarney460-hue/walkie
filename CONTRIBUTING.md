# Contributing to Walkie

Thanks for helping. Bug reports, fixes, docs and small features are all welcome.

## Before you start

- **Security issues** go to RC Studios privately, never in a public issue: see [docs/SECURITY.md](docs/SECURITY.md).
- For anything bigger than a fix, open an issue first so we can agree on the approach before you write the code.

## The Contributor License Agreement

Walkie is made by RC Studios and published under the [Functional Source License](LICENSE) (FSL-1.1-ALv2). Every
contributor signs the [Contributor License Agreement](CLA.md) once. It keeps your copyright with you, and gives
RC Studios the right to use, license and relicense your contribution, for example under Apache-2.0 when a version
converts or under other terms.

Signing takes one comment. When you open your first pull request, the CLA bot comments on it and its check fails
until you post, on that pull request:

> I have read the CLA Document and I hereby sign the CLA

The bot records the signature (your GitHub username and id, the pull request and the time) on this repository's
`cla-signatures` branch and the check passes. Comment `recheck` if it doesn't update. Everyone who authored a commit
in the pull request needs to have signed.

## How a pull request flows

This repository gets **one commit per public release**, exported from the maintainers' working repository. So a pull
request is not merged here directly:

1. You open a pull request against `main` and sign the CLA.
2. We review it here. CI runs the typecheck, the tests and the build on macOS and Linux.
3. Once it's accepted, we apply it in the working repository, and the pull request is closed with a note naming the
   release it will ship in.
4. It appears here in that release's commit.

## Building and testing

Requires [Bun](https://bun.sh) 1.3.

```bash
bun install && (cd web && bun install) && (cd site && bun install)
bun run typecheck
bun test                      # the whole suite; `bun test test/unit/<file>` for one file
bun run build                 # the dashboard + a binary for this machine in dist/
bun run walkie <command>      # the CLI straight from source
```

Please keep pull requests focused, add or update tests for what you change, and describe what you tested. Wire
protocol changes need a matching update to [docs/PROTOCOL.md](docs/PROTOCOL.md), and anything touching a trust
boundary needs one to [docs/SECURITY.md](docs/SECURITY.md).
