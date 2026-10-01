#!/usr/bin/env bash
set -euo pipefail
source scripts/enroll-ssh-linux.sh
count=0
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/usr/sbin" "$fixture/etc/ssh" "$fixture/etc/systemd/system"
# A stock machine: the system directories exist already, each with a mode of its own (usr/sbin is deliberately not 0755, the mode
# the script would give a directory it makes). Walkie's script must leave every one of them exactly as it finds it.
chmod 0755 "$fixture/etc" "$fixture/etc/systemd" "$fixture/etc/systemd/system"
chmod 0711 "$fixture/usr/sbin"
printf '#!/bin/sh\nexit 0\n' > "$fixture/usr/sbin/sshd"
chmod +x "$fixture/usr/sbin/sshd"
logs=$fixture/calls
: > "$logs"
state=clean
listen_before=''
listen_after='LISTEN 0 128 127.0.0.1:22 0.0.0.0:*'
policy_at_install=0
systemctl() {
  printf '%s\n' "$*" >> "$logs"
  case "$*" in
    'is-active --quiet ssh.socket') [[ $state == socket || -e $fixture/active-ssh.socket ]] ;;
    'is-enabled --quiet ssh.socket')
      [[ ! -e $fixture/durable-ssh.socket ]] && { [[ -e $fixture/enabled-ssh.socket || $state == socket ]]; } ;;
    'is-active --quiet ssh.service') [[ $state == service ]] ;;
    'is-enabled --quiet ssh.service')
      [[ ! -e $fixture/durable-ssh.service ]] && { [[ -e $fixture/enabled-ssh.service || $state == service ]]; } ;;
    'is-enabled ssh.service') if [[ $state == masked || -e $fixture/durable-ssh.service ]]; then printf 'masked\n'; return 1; fi ;;
    'is-enabled ssh.socket') if [[ -e $fixture/durable-ssh.socket ]]; then printf 'masked\n'; return 1; fi ;;
    'is-active --quiet walkie-sshd.service')
      [[ -e $fixture/walkie-active ]] || grep -q 'enable --now walkie-sshd.service' "$logs" ;;
    is-active*|is-enabled*) return 1 ;;
    'list-unit-files '*) printf '%s disabled\n' "$2" ;;
    'disable --now ssh.service')
      if [[ $state == disable_service_fail || $state == disable_both_fail ]]; then return 1; fi
      rm -f "$fixture/enabled-ssh.service" ;;
    'disable --now ssh.socket')
      if [[ $state == disable_fail || $state == disable_both_fail || $state == stop_fail ]]; then return 1; fi
      rm -f "$fixture/enabled-ssh.socket" "$fixture/active-ssh.socket" ;;
    'stop ssh.socket')
      [[ $state != stop_fail ]] || return 1
      rm -f "$fixture/active-ssh.socket" ;;
    'mask ssh.service') touch "$fixture/durable-ssh.service" ;;
    'mask ssh.socket') touch "$fixture/durable-ssh.socket" ;;
    'disable --now walkie-sshd.service') rm -f "$fixture/walkie-active" ;;
    *) return 0 ;;
  esac
}
ss() {
  printf 'ss %s\n' "$*" >> "$logs"
  if [[ -e $fixture/active-ssh.socket ]]; then printf 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n'
  elif [[ -e $fixture/walkie-active ]] || grep -q 'enable --now walkie-sshd.service' "$logs"; then printf '%s\n' "$listen_after"
  else printf '%s\n' "$listen_before"; fi
}
apt-get() {
  printf 'apt-get %s\n' "$*" >> "$logs"
  if [[ $1 == install ]]; then
    [[ -x "$fixture/usr/sbin/policy-rc.d" ]] || return 1
    [[ ! -e "$fixture/etc/walkie/sshd_config" ]] || return 1
    policy_at_install=1
    if [[ $state == partial ]]; then
      touch "$fixture/enabled-ssh.service" "$fixture/enabled-ssh.socket"
      return 1
    fi
  fi
}
ssh-keygen() { printf 'ssh-keygen %s\n' "$*" >> "$logs"; }
run_case() { count=$((count + 1)); printf 'ok %s - %s\n' "$count" "$1"; }
# A path's mode in octal, on Linux (GNU stat -c) and on macOS (BSD stat -f). GNU's `stat -f` is the FILESYSTEM report: it succeeds
# with the wrong answer, so the BSD spelling is only ever the fallback, after GNU's `-c` has failed.
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

state=socket
if check_existing "$fixture" >/dev/null 2>&1; then echo 'active socket accepted' >&2; exit 1; fi
run_case 'active socket is refused'
state=service
if check_existing "$fixture" >/dev/null 2>&1; then echo 'active service accepted' >&2; exit 1; fi
run_case 'active service is refused'
state=masked
if check_existing "$fixture" >/dev/null 2>&1; then echo 'existing service mask accepted' >&2; exit 1; fi
run_case 'existing service mask is preserved'
state=clean
printf 'person config\n' > "$fixture/etc/ssh/sshd_config"
if check_existing "$fixture" >/dev/null 2>&1; then echo 'existing config accepted' >&2; exit 1; fi
rm "$fixture/etc/ssh/sshd_config"
run_case 'existing server config is refused'
listen_after='LISTEN 0 128 0.0.0.0:22 0.0.0.0:*'
if verify_loopback >/dev/null 2>&1; then echo 'public listener accepted' >&2; exit 1; fi
run_case 'public listener is refused'
listen_after='LISTEN 0 128 127.0.0.1:22 0.0.0.0:*'
WALKIE_SSH_ROOT=$fixture
WALKIE_POLICY_CREATED=0
install_walkie_sshd "$fixture"
[[ $policy_at_install == 1 ]]
[[ -f "$fixture/etc/walkie/sshd_config" ]]
[[ $(mode_of "$fixture/etc/walkie/sshd_config") == 600 ]]
grep -q '^KbdInteractiveAuthentication no$' "$fixture/etc/walkie/sshd_config"
grep -q '^AuthenticationMethods publickey$' "$fixture/etc/walkie/sshd_config"
cleanup
[[ ! -e "$fixture/usr/sbin/policy-rc.d" ]]
run_case 'package start blocked until restricted config, then loopback verified'

# Final review C, F1: `install -d -m 0700 .../etc/systemd/system` re-chmods an EXISTING directory, so on a real machine Walkie's
# install made /etc/systemd/system root-only and the person could no longer see Walkie's own unit. The machine's directories keep
# the mode they had, the unit is an ordinary 0644 file, and only Walkie's own directory is private.
expect_mode() { [[ $(mode_of "$1") == "$2" ]] || { echo "$1 has mode $(mode_of "$1"), expected $2" >&2; exit 1; }; }
expect_mode "$fixture/etc" 755
expect_mode "$fixture/etc/systemd" 755
expect_mode "$fixture/etc/systemd/system" 755
expect_mode "$fixture/usr/sbin" 711
expect_mode "$fixture/etc/systemd/system/walkie-sshd.service" 644
expect_mode "$fixture/etc/walkie" 700
expect_mode "$fixture/etc/walkie/sshd_config" 600
grep -q '^ExecStart=/usr/sbin/sshd -D -e -f /etc/walkie/sshd_config$' "$fixture/etc/systemd/system/walkie-sshd.service"
[[ ! -e "$fixture/etc/walkie/walkie-sshd.service.new" ]] || { echo 'the staged unit was left behind' >&2; exit 1; }
run_case "existing system directories keep their mode, the unit is 0644 and only Walkie's directory is private"

# A fixture that has no systemd directory yet still gets one, made the way a package would (0755), never a private one.
rm -rf "$fixture/etc/systemd" "$fixture/etc/walkie"
: > "$logs"
WALKIE_POLICY_CREATED=0
install_walkie_sshd "$fixture"
expect_mode "$fixture/etc/systemd/system" 755
expect_mode "$fixture/etc/systemd/system/walkie-sshd.service" 644
cleanup
run_case 'a missing systemd directory is created 0755, never private'

state=partial
: > "$logs"
rm -f "$fixture/etc/walkie/sshd_config" "$fixture/etc/systemd/system/walkie-sshd.service"
set +e
(set -e; trap 'cleanup || exit 1' EXIT; install_walkie_sshd "$fixture")
partial_status=$?
set -e
[[ $partial_status -ne 0 ]] || { echo 'partial package install accepted' >&2; exit 1; }
[[ ! -e $fixture/enabled-ssh.service && ! -e $fixture/enabled-ssh.socket ]]
[[ ! -e $fixture/usr/sbin/policy-rc.d ]]
disable_line=$(grep -n '^disable --now ssh.socket$' "$logs" | tail -1 | cut -d: -f1)
unmask_line=$(grep -n '^unmask --runtime' "$logs" | tail -1 | cut -d: -f1)
[[ -n $disable_line && -n $unmask_line && $disable_line -lt $unmask_line ]]
run_case 'partial package failure disables new SSH units before lifting protections'

state=disable_fail
: > "$logs"
touch "$fixture/enabled-ssh.socket"
WALKIE_SSH_PROTECTED=1
WALKIE_SSH_PRE_ENABLED=()
set +e
cleanup_output=$(cleanup 2>&1)
cleanup_status=$?
set -e
[[ $cleanup_status -ne 0 ]] || { echo 'disable failure was accepted' >&2; exit 1; }
[[ -e $fixture/durable-ssh.socket ]] || { echo 'durable socket mask missing' >&2; exit 1; }
[[ $cleanup_output == *'ssh.socket'* ]] || { echo 'failure did not name the socket' >&2; exit 1; }
if grep -q '^unmask --runtime' "$logs"; then echo 'runtime protections were lifted after disable failure' >&2; exit 1; fi
run_case 'disable failure leaves a durable mask and fails loudly'

state=disable_service_fail
: > "$logs"
rm -f "$fixture/durable-ssh.socket"
touch "$fixture/enabled-ssh.service" "$fixture/enabled-ssh.socket"
WALKIE_SSH_PROTECTED=1
WALKIE_SSH_PRE_ENABLED=()
set +e
cleanup_output=$(cleanup 2>&1)
cleanup_status=$?
set -e
[[ $cleanup_status -ne 0 ]] || { echo 'service disable failure was accepted' >&2; exit 1; }
[[ -e $fixture/durable-ssh.service ]] || { echo 'durable service mask missing' >&2; exit 1; }
[[ ! -e $fixture/enabled-ssh.socket || -e $fixture/durable-ssh.socket ]] || { echo 'socket remains enabled after service failure' >&2; exit 1; }
[[ $cleanup_output == *'ssh.service'* ]] || { echo 'failure did not name the service' >&2; exit 1; }
grep -q '^disable --now ssh.socket$' "$logs" || { echo 'socket cleanup was skipped' >&2; exit 1; }
for unit in ssh.service sshd.service ssh.socket sshd.socket; do
  grep -q "^is-active --quiet $unit$" "$logs" || { echo "active state of $unit was not checked" >&2; exit 1; }
  grep -q "^is-enabled --quiet $unit$" "$logs" || { echo "enabled state of $unit was not checked" >&2; exit 1; }
done
grep -q '^ss -ltnH$' "$logs" || { echo 'SSH listeners were not checked' >&2; exit 1; }
if grep -q '^unmask --runtime' "$logs"; then echo 'runtime protections were lifted after service disable failure' >&2; exit 1; fi
run_case 'service disable failure still cleans the newly enabled socket'

state=disable_both_fail
: > "$logs"
rm -f "$fixture/durable-ssh.service"
touch "$fixture/enabled-ssh.service" "$fixture/enabled-ssh.socket"
WALKIE_SSH_PROTECTED=1
set +e
cleanup_output=$(cleanup 2>&1)
cleanup_status=$?
set -e
[[ $cleanup_status -ne 0 ]] || { echo 'two disable failures were accepted' >&2; exit 1; }
[[ -e $fixture/durable-ssh.service && -e $fixture/durable-ssh.socket ]] || { echo 'both failed units were not durably masked' >&2; exit 1; }
[[ $cleanup_output == *'cannot disable ssh.service'* && $cleanup_output == *'cannot disable ssh.socket'* ]] || { echo 'failure did not name both units' >&2; exit 1; }
run_case 'every failed unit is durably masked and named'

state=disable_service_fail
: > "$logs"
touch "$fixture/walkie-active"
touch "$fixture/enabled-ssh.service"
WALKIE_SSH_PROTECTED=1
set +e
cleanup_output=$(cleanup 2>&1)
cleanup_status=$?
set -e
[[ $cleanup_status -ne 0 ]] || { echo 'failed cleanup with active Walkie SSH was accepted' >&2; exit 1; }
[[ ! -e $fixture/walkie-active ]] || { echo 'Walkie SSH listener remained active' >&2; exit 1; }
grep -q '^disable --now walkie-sshd.service$' "$logs" || { echo 'Walkie SSH was not stopped' >&2; exit 1; }
[[ $cleanup_output == *'ssh.service'* ]] || { echo 'service failure was not named' >&2; exit 1; }
run_case 'failed cleanup stops the Walkie SSH listener'

state=disable_fail
: > "$logs"
rm -f "$fixture/walkie-active" "$fixture/durable-ssh.socket"
touch "$fixture/enabled-ssh.socket" "$fixture/active-ssh.socket"
WALKIE_SSH_PROTECTED=1
set +e
cleanup_output=$(cleanup 2>&1)
cleanup_status=$?
set -e
[[ $cleanup_status -ne 0 ]] || { echo 'disable failure was accepted' >&2; exit 1; }
grep -q '^stop ssh.socket$' "$logs" || { echo 'active socket was not stopped separately' >&2; exit 1; }
[[ ! -e $fixture/active-ssh.socket ]] || { echo 'active socket survived cleanup' >&2; exit 1; }
run_case 'package-hook socket is stopped after disable failure'

state=stop_fail
: > "$logs"
rm -f "$fixture/durable-ssh.socket"
touch "$fixture/enabled-ssh.socket" "$fixture/active-ssh.socket"
WALKIE_SSH_PROTECTED=1
set +e
cleanup_output=$(cleanup 2>&1)
cleanup_status=$?
set -e
[[ $cleanup_status -ne 0 && $cleanup_output == *'ssh.socket'* && $cleanup_output == *'active'* ]] || {
  echo 'active socket failure was not named' >&2; exit 1;
}
grep -q '^stop ssh.socket$' "$logs" || { echo 'failed stop was not attempted' >&2; exit 1; }
run_case 'failed stop reports active socket and unsafe listener'
