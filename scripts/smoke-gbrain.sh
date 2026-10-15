#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

cd "$scratch"
GBRAIN_SMOKE_HOME="$scratch" bun "$repo/scripts/smoke-gbrain.ts"
