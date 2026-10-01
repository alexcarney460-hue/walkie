#!/usr/bin/env bash
# Called once from the Linux/WSL installer's root batch, after explicit SSH consent.
set -euo pipefail

fail() { echo "enroll-ssh-linux: $*" >&2; return 1; }
unit_present() { systemctl list-unit-files "$1" --no-legend 2>/dev/null | grep -q "^$1[[:space:]]"; }
# A directory the machine ought to have already (/usr/sbin, /etc/systemd/system). One that exists is never touched: `install -d -m`
# re-chmods an existing directory, which once made /etc/systemd/system root-only and hid Walkie's own unit from the person.
ensure_dir() { [[ -d $2 ]] || install -d -m "$1" "$2"; }

check_existing() {
  local root=$1 unit listeners
  [[ ! -e "$root/etc/ssh/sshd_config" ]] || { fail 'an SSH server is already configured; inspect it manually'; return 1; }
  [[ ! -e "$root/etc/systemd/system/walkie-sshd.service" ]] || { fail 'a Walkie SSH service is already configured; inspect it manually'; return 1; }
  for unit in ssh.service sshd.service ssh.socket sshd.socket; do
    if systemctl is-active --quiet "$unit" || systemctl is-enabled --quiet "$unit"; then
      fail "$unit is already active or enabled; inspect it manually"
      return 1
    fi
    if [[ $(systemctl is-enabled "$unit" 2>/dev/null || true) == masked ]]; then
      fail "$unit is already masked; leave the person's service policy unchanged"
      return 1
    fi
  done
  listeners=$(ss -ltnH) || { fail 'cannot inspect existing SSH listeners'; return 1; }
  if awk '$4 ~ /:22$/ { found=1 } END { exit !found }' <<< "$listeners"; then
    fail 'port 22 already has a listener; inspect it manually'
    return 1
  fi
}

verify_loopback() {
  local listeners
  listeners=$(ss -ltnH) || { fail 'cannot inspect SSH listeners'; return 1; }
  awk '
    $4 ~ /:22$/ {
      addr=$4
      if (addr != "127.0.0.1:22" && addr != "[::1]:22") bad=1
      seen=1
    }
    END { exit (!seen || bad) }
  ' <<< "$listeners" || { fail 'SSH is not listening only on loopback'; return 1; }
  for unit in ssh.socket sshd.socket; do
    if systemctl is-active --quiet "$unit" || systemctl is-enabled --quiet "$unit"; then
      fail "$unit activates SSH outside the Walkie service"
      return 1
    fi
  done
}

install_walkie_sshd() {
  local root=$1 unit
  WALKIE_SSH_PRE_ENABLED=()
  WALKIE_SSH_PROTECTED=0
  for unit in ssh.service sshd.service ssh.socket sshd.socket; do
    if systemctl is-enabled --quiet "$unit"; then WALKIE_SSH_PRE_ENABLED+=("$unit"); fi
  done
  check_existing "$root"
  # Runtime masks plus Debian policy-rc.d stop package hooks from starting a public listener.
  WALKIE_SSH_PROTECTED=1
  systemctl mask --runtime ssh.service sshd.service ssh.socket sshd.socket
  if command -v apt-get >/dev/null 2>&1; then
    if [[ ! -e "$root/usr/sbin/policy-rc.d" ]]; then
      ensure_dir 0755 "$root/usr/sbin"
      printf '#!/bin/sh\nexit 101\n' > "$root/usr/sbin/policy-rc.d"
      chmod 0755 "$root/usr/sbin/policy-rc.d"
      WALKIE_POLICY_CREATED=1
    fi
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y --no-install-recommends openssh-server
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y openssh-server
  else
    fail 'supported package manager absent'
  fi
  for unit in ssh.service sshd.service ssh.socket sshd.socket; do
    if unit_present "$unit"; then systemctl disable --now "$unit"; fi
  done
  install -d -m 0700 "$root/etc/walkie"
  cat > "$root/etc/walkie/sshd_config" <<'EOF'
Port 22
AddressFamily any
ListenAddress 127.0.0.1
ListenAddress ::1
HostKey /etc/ssh/ssh_host_ed25519_key
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
AuthenticationMethods publickey
PermitRootLogin no
AuthorizedKeysFile .ssh/authorized_keys
StrictModes yes
UsePAM yes
Subsystem sftp internal-sftp
EOF
  chmod 0600 "$root/etc/walkie/sshd_config"
  ssh-keygen -A
  "$root/usr/sbin/sshd" -t -f "$root/etc/walkie/sshd_config"
  # The unit is staged in Walkie's own private directory and installed as an ordinary 0644 file into the machine's own systemd
  # directory, which keeps the owner and mode it has (a person's `systemctl` reads units, and Walkie's CLI asks systemd about this one).
  cat > "$root/etc/walkie/walkie-sshd.service.new" <<'EOF'
[Unit]
Description=Walkie loopback SSH server
After=network.target
[Service]
ExecStart=/usr/sbin/sshd -D -e -f /etc/walkie/sshd_config
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
  ensure_dir 0755 "$root/etc/systemd/system"
  install -m 0644 "$root/etc/walkie/walkie-sshd.service.new" "$root/etc/systemd/system/walkie-sshd.service"
  rm -f "$root/etc/walkie/walkie-sshd.service.new"
  systemctl daemon-reload
  systemctl enable --now walkie-sshd.service
  systemctl is-active --quiet walkie-sshd.service || fail 'Walkie SSH service did not start'
  verify_loopback
}

cleanup() {
  [[ ${WALKIE_SSH_PROTECTED:-0} == 1 ]] || return 0
  local unit preexisting saved listeners
  local -a failures=()
  # A package hook can enable a default service even when installation fails. Disable it
  # while policy-rc.d and the runtime masks still prevent public startup.
  for unit in ssh.service sshd.service ssh.socket sshd.socket; do
    preexisting=0
    for saved in "${WALKIE_SSH_PRE_ENABLED[@]-}"; do
      if [[ $saved == "$unit" ]]; then preexisting=1; break; fi
    done
    if [[ $preexisting == 0 ]] && unit_present "$unit"; then
      if ! systemctl disable --now "$unit"; then
        # A runtime mask is lost on reboot. Keep policy-rc.d and runtime masks in
        # place, add a persistent mask, and stop the already-running unit separately.
        failures+=("cannot disable $unit")
        if ! systemctl mask "$unit" || [[ $(systemctl is-enabled "$unit" 2>/dev/null || true) != masked ]]; then
          failures+=("cannot durably mask $unit")
        fi
        if ! systemctl stop "$unit"; then failures+=("cannot stop $unit"); fi
      fi
    fi
  done
  if (( ${#failures[@]} == 0 )); then
    if ! systemctl unmask --runtime ssh.service sshd.service ssh.socket sshd.socket >/dev/null 2>&1; then
      failures+=("cannot remove runtime SSH masks")
    fi
  fi
  for unit in ssh.service sshd.service ssh.socket sshd.socket; do
    if systemctl is-active --quiet "$unit"; then failures+=("$unit is active after cleanup"); fi
    if systemctl is-enabled --quiet "$unit"; then failures+=("$unit is enabled after cleanup"); fi
  done
  if (( ${#failures[@]} > 0 )) && { systemctl is-active --quiet walkie-sshd.service || systemctl is-enabled --quiet walkie-sshd.service; }; then
    if ! systemctl disable --now walkie-sshd.service; then
      failures+=("cannot stop Walkie SSH after failed cleanup")
    fi
  fi
  if ! listeners=$(ss -ltnH); then
    failures+=("cannot verify SSH listeners after cleanup")
  elif systemctl is-active --quiet walkie-sshd.service && (( ${#failures[@]} == 0 )); then
    if ! verify_loopback; then failures+=("Walkie SSH listener is not loopback-only"); fi
  elif awk '$4 ~ /:22$/ { found=1 } END { exit !found }' <<< "$listeners"; then
    failures+=("unsafe port 22 listener remains after cleanup")
  fi
  if (( ${#failures[@]} > 0 )); then
    systemctl mask --runtime ssh.service sshd.service ssh.socket sshd.socket >/dev/null 2>&1 || true
    fail "cleanup failed: ${failures[*]}"
    return 1
  fi
  if [[ ${WALKIE_POLICY_CREATED:-0} == 1 ]]; then rm -f "${WALKIE_SSH_ROOT}/usr/sbin/policy-rc.d"; fi
  WALKIE_SSH_PROTECTED=0
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  if [[ ${EUID} -ne 0 || $(uname -s) != Linux ]]; then
    fail 'run as root on Linux/WSL in the installer root batch'
    exit 1
  fi
  if ! command -v systemctl >/dev/null 2>&1 || [[ $(systemctl is-system-running 2>/dev/null || true) == offline ]]; then
    fail 'systemd is required before enabling the SSH service'
    exit 1
  fi
  WALKIE_SSH_ROOT=/
  trap 'cleanup || exit 1' EXIT
  install_walkie_sshd "$WALKIE_SSH_ROOT"
fi
