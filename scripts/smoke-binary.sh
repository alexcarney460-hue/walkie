#!/bin/sh
# Start the packaged daemon in an isolated home and check its local endpoints.
set -eu

binary="${1:?usage: scripts/smoke-binary.sh <walkie-binary> [expected-version]}"
expected="${2:-}"
case "$binary" in /*) ;; *) binary="$(pwd)/$binary" ;; esac
[ -x "$binary" ] || { echo "SMOKE FAIL: binary is not executable" >&2; exit 1; }

scratch=$(mktemp -d /tmp/wsm.XXXXXX)
daemon_pid=
cleanup() {
  if [ -n "$daemon_pid" ]; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mkdir -p "$scratch/h" "$scratch/d"
chmod 700 "$scratch/h" "$scratch/d"
cat > "$scratch/d/config.json" <<'JSON'
{"peer_host":"127.0.0.1","peer_port":0,"local_port":0,"discover_agents":true,"machine_stats":true,"accounts":false,"transport":"tailscale"}
JSON

version=$(env -i HOME="$scratch/h" WALKIE_HOME="$scratch/d" WALKIE_SOCKET="$scratch/d/s.sock" \
  PATH="/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin" NO_COLOR=1 "$binary" version)
echo "version: $version"
if [ -n "$expected" ] && [ "$version" != "walkie $expected" ]; then
  echo "SMOKE FAIL: version mismatch" >&2
  exit 1
fi

env -i HOME="$scratch/h" WALKIE_HOME="$scratch/d" WALKIE_SOCKET="$scratch/d/s.sock" \
  PATH="/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin" NO_COLOR=1 \
  "$binary" daemon run > "$scratch/out" 2>&1 &
daemon_pid=$!

ready=0
attempt=0
while [ "$attempt" -lt 60 ]; do
  if grep -q agent_discovery_worker_ready "$scratch/out"; then ready=1; break; fi
  if ! kill -0 "$daemon_pid" 2>/dev/null; then break; fi
  sleep 0.5
  attempt=$((attempt + 1))
done
if [ "$ready" -ne 1 ]; then
  echo "SMOKE FAIL: discovery worker did not become ready" >&2
  exit 1
fi
echo "agent_discovery_worker_ready: yes"

# Allow asynchronous worker failures to surface after its ready message.
sleep 4
if grep -qiE 'worker[a-z_]*(unavailable|failed|error)|Cannot find module|ModuleNotFound|ENOENT.*worker' "$scratch/out"; then
  echo "SMOKE FAIL: worker error in daemon log" >&2
  exit 1
fi
echo "worker errors: none"

if ! health=$(curl -fsS --max-time 5 --unix-socket "$scratch/d/s.sock" http://walkie/v1/healthz); then
  echo "SMOKE FAIL: healthz request failed" >&2
  exit 1
fi
if ! printf '%s' "$health" | grep -q '"ok":true'; then
  echo "SMOKE FAIL: healthz did not return ok" >&2
  exit 1
fi
echo "healthz: ok"

local_port=$(grep -o '"local":[0-9]*' "$scratch/out" | head -1 | cut -d: -f2)
if [ -z "$local_port" ]; then
  echo "SMOKE FAIL: no local port in daemon log" >&2
  exit 1
fi
if ! code=$(curl -sS -o "$scratch/index" -w '%{http_code}' --max-time 5 "http://127.0.0.1:$local_port/"); then
  echo "SMOKE FAIL: dashboard request failed" >&2
  exit 1
fi
bytes=$(wc -c < "$scratch/index" | tr -d ' ')
echo "dashboard GET /: $code ($bytes bytes)"
if [ "$code" != 200 ] || [ "$bytes" -eq 0 ]; then
  echo "SMOKE FAIL: dashboard did not serve a page" >&2
  exit 1
fi
# The daemon serves a placeholder page (HTTP 200) when the dashboard bundle is missing from the binary.
if grep -q "dashboard bundle is not built" "$scratch/index"; then
  echo "SMOKE FAIL: the binary serves the placeholder page, not the dashboard bundle" >&2
  exit 1
fi

kill "$daemon_pid"
wait "$daemon_pid" 2>/dev/null || true
daemon_pid=
echo "SMOKE PASS"
