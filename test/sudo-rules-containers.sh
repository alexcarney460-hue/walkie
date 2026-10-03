#!/usr/bin/env bash
# WALK-93 (SUDO-RS-1): Walkie's seat-user sudo rules, written by this repo's own code, through the REAL sudo of throwaway
# containers. A manual / opt-in check (docker and bun on this host; skipped without them): everything privileged happens inside
# `docker run --rm` containers, never on this machine's sudoers, users or groups.
#
#   bash test/sudo-rules-containers.sh              every image below
#   bash test/sudo-rules-containers.sh rules        only the rules checks
#   WALKIE_OLD_TREE=/path/to/checkout bash test/sudo-rules-containers.sh rerun
#       the rerun check needs the code from before the fix (a checkout with node_modules, e.g. `git archive <commit before the
#       fix> src package.json` plus a copy of node_modules): it fails at the sudo check like the machine that hit this, then the
#       fixed code reruns on the same container and completes (the group, directories and copies are reused)
#
# What each run shows (test/helpers/sudo-rules-inner.sh):
#   Ubuntu 24.04  sudo 1.9.15p5   the original sudo: the rules keep !requiretty (a system with Defaults requiretty refuses seats
#                                 without those lines: shown as a control); runner, helper, repair and refusals all behave
#   Ubuntu 25.10  sudo-rs 0.2.8   setup refuses before changing anything; the same rules installed by hand parse and are refused
#   Ubuntu 25.10  original sudo   the way out of that: `sudo` installed next to sudo-rs and selected with update-alternatives
#   Ubuntu 26.04  sudo-rs 0.2.13  no !requiretty lines; the fallback on the exact error; everything behaves; a rerun reuses state
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
want=${1:-all}

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then echo "skipped: no docker here"; exit 0; fi
BUN=$(command -v bun) || { echo "skipped: no bun on this host (the containers run the checks with it)"; exit 0; }
BUN=$(readlink -f "$BUN")

runs=("rules ubuntu:24.04 sudo" "rules ubuntu:25.10 sudo-rs" "rules ubuntu:25.10 sudo-rs+sudo /usr/bin/sudo.ws" "rules ubuntu:26.04 sudo-rs")
if [ -n "${WALKIE_OLD_TREE:-}" ]; then runs+=("rerun ubuntu:26.04 sudo-rs"); elif [ "$want" = rerun ]; then echo "skipped: set WALKIE_OLD_TREE to the code from before the fix"; exit 0; fi

status=0
for run in "${runs[@]}"; do
  read -r mode image pkg select <<<"$run"
  if [ "$want" != all ] && [ "$want" != "$mode" ]; then continue; fi
  printf '\n=== %s on %s (%s%s) ===\n' "$mode" "$image" "$pkg" "${select:+, then $select}"
  mounts=(-v "$ROOT":/walkie:ro -v "$BUN":/usr/local/bin/bun:ro)
  if [ "$mode" = rerun ]; then mounts+=(-v "$WALKIE_OLD_TREE":/walkie-old:ro); fi
  docker run --rm "${mounts[@]}" "$image" nice -n 10 bash /walkie/test/helpers/sudo-rules-inner.sh "$mode" "$pkg" ${select:+"$select"} || status=1
done
exit $status
