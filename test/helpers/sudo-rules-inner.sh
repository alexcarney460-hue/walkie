#!/usr/bin/env bash
# Runs INSIDE a throwaway container (started by test/sudo-rules-containers.sh): Walkie's seat-user sudo rules, written by this
# repo's own code, through this image's REAL sudo. Nothing here may run on a real machine: it makes users, groups and sudoers files.
#   sudo-rules-inner.sh rules <apt packages> [alternative]   setup as the person, then the rules through the sudo found (what is
#                                                            checked depends on it); `sudo-rs+sudo /usr/bin/sudo.ws` installs both
#                                                            and picks the original sudo, as a person taking the way out would
#   sudo-rules-inner.sh rerun <apt packages>                 the code from before the fix fails at the sudo check, then the fixed
#                                                            code reruns on the same container (/walkie-old)
set -u
MODE=${1:?mode: rules|rerun}
PKG=${2:?apt packages: sudo, sudo-rs or sudo-rs+sudo}
SELECT=${3:-}
export DEBIAN_FRONTEND=noninteractive
R=/usr/local/libexec/walkie/walkie-seat-runner
A=/usr/local/libexec/walkie/walkie-seat-admin
RULES=/etc/sudoers.d/walkie-seats
GEN=11111111-1111-4111-8111-111111111111
INST=$(printf '0%.0s' $(seq 64))
LOG=/tmp/driver.log
pass=0
fail=0

ok() { echo "  ok:   $*"; pass=$((pass + 1)); }
bad() { echo "  FAIL: $*"; fail=$((fail + 1)); }
heading() { printf '\n-- %s\n' "$*"; }
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; } # $1 >= $2, as versions

person() { runuser -u daemonuser -- env HOME=/home/daemonuser WALKIE_HOME=/home/daemonuser/.walkie PATH=/usr/local/bin:/usr/bin:/bin "$@"; }
driver() { person bun /walkie/test/helpers/sudo-rules-driver.ts "$@"; }                  # <tree root> <mode> [forced sudo]
show() { grep -E "^ *(sudo here|note:|not applied|→|RESULT|seats pointed|failed:|sudo here won't)|unknown setting|syntax error" "$1" | sed 's/^ */    | /'; }
# The person's own sudo for setup (an unattended run can't type a password): everything EXCEPT the helper, which must then work
# through Walkie's rules alone, as it will for a person whose own sudo wants a password.
grant_person() { printf 'daemonuser ALL=(ALL) NOPASSWD: ALL, !%s\n' "$A" >/etc/sudoers.d/00-person; chmod 0440 /etc/sudoers.d/00-person; }
revoke_person() { rm -f /etc/sudoers.d/00-person; }

setup_container() {
  # shellcheck disable=SC2086
  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq ${PKG//+/ } >/dev/null 2>&1 || { echo "apt could not install $PKG"; exit 2; }
  if [ -n "$SELECT" ]; then update-alternatives --set sudo "$SELECT" >/dev/null 2>&1 || { echo "could not select $SELECT"; exit 2; }; fi
  chmod 0440 /etc/sudoers
  useradd -m -s /bin/bash daemonuser && chmod 700 /home/daemonuser
  echo 'daemonuser:hunter2' | chpasswd
  runuser -u daemonuser -- install -d -m 700 /home/daemonuser/.walkie
  useradd -m outsider
  install -d -m 755 /opt/walkie-stub
  cat >/opt/walkie-stub/walkie <<'STUB'
#!/bin/sh
# Stands in for the walkie binary the runner and helper copies are made from: says who ran it and with what. The helper's
# answers are JSON like the real one's, and `create 0` is refused like the real one refuses it (0 is no id).
if [ "$1" = seat-admin ]; then
  if [ "$2 $3" = "create 0" ]; then echo '{"ok":false,"code":"refused","why":"usage: stub"}'; exit 1; fi
  echo "{\"ok\":true,\"stub\":\"as $(id -un) argv: $*\"}"; exit 0
fi
echo "stub as $(id -un) argv: $*"
STUB
  chmod 755 /opt/walkie-stub/walkie
  SUDO_LINE=$(sudo --version 2>&1 | head -1) # sudo-rs 0.2.8 prints its version on stderr
  VISUDO_LINE=$(visudo --version 2>&1 | head -1)
  echo "image: $(. /etc/os-release && echo "$PRETTY_NAME")   sudo --version: $SUDO_LINE   visudo --version: $VISUDO_LINE"
  case "$SUDO_LINE" in
    sudo-rs*) FLAVOR=sudo-rs; VERSION=$(printf '%s' "$SUDO_LINE" | sed -E 's/^sudo-rs ([0-9]+(\.[0-9]+)*).*/\1/') ;;
    Sudo\ version*) FLAVOR=classic; VERSION=$(printf '%s' "$SUDO_LINE" | sed -E 's/^Sudo version ([^ ]+).*/\1/') ;;
    *) echo "unrecognized sudo: $SUDO_LINE"; exit 2 ;;
  esac
}

# The rules as installed: parse, and the !requiretty lines only where this sudo knows the setting.
installed_rules_checks() {
  local want=$1 n
  visudo -c -f "$RULES" >/tmp/visudo.out 2>&1 && ok "visudo -c -f $RULES: $(tail -1 /tmp/visudo.out)" || bad "the installed rules don't parse: $(cat /tmp/visudo.out)"
  n=$(grep -c '^Defaults!.* !requiretty$' "$RULES")
  [ "$n" = "$want" ] && ok "the installed rules have $n !requiretty lines" || bad "the installed rules have $n !requiretty lines, expected $want"
}

# What the rules let the daemon's user do through this sudo, with no sudo of its own (the setup-time grant is withdrawn).
allowed() { # description, regex the stub's answer must match, then sudo's arguments
  local desc=$1 want=$2 out rc
  shift 2
  out=$(person sudo -n "$@" 2>&1); rc=$?
  if [ $rc -eq 0 ] && printf '%s' "$out" | grep -Eq "$want"; then ok "$desc"; else bad "$desc (rc=$rc: $out)"; fi
}
refused() { # description, then sudo's arguments: refused, and nothing ran
  local desc=$1 out rc
  shift 1
  out=$(person sudo -n "$@" 2>&1); rc=$?
  if [ $rc -ne 0 ] && ! printf '%s' "$out" | grep -q 'stub'; then ok "$desc"; else bad "$desc (rc=$rc: $out)"; fi
}
answers() { # sudo -k -n <command>: did the helper answer (JSON on stdout, even a refusal)? as setup asks after installing the rules
  local out
  out=$(person sudo -k -n "$@" 2>/dev/null)
  case "$out" in "{"*) return 0 ;; *) return 1 ;; esac
}
twice() { # a password through -S, then at once -n: prints "first=<rc> second=<rc>"
  person bash -c 'printf "hunter2\n" | sudo -S -p "" "$@" >/dev/null 2>&1; a=$?; sudo -n "$@" >/dev/null 2>&1; echo "first=$a second=$?"' _ "$@"
}

rules_behave() {
  heading "the rules through this sudo, as the daemon's user with no sudo of its own"
  revoke_person
  getent group walkie-seats >/dev/null || groupadd --system walkie-seats
  id seatuser >/dev/null 2>&1 || useradd -m -G walkie-seats seatuser
  allowed "the runner as a seat user (a member of walkie-seats), no password" '^stub as seatuser argv: seat-runner$' -u seatuser "$R" seat-runner
  allowed "the dedicated-user runner as a seat user, no password" '^stub as seatuser argv: talkie-runner$' -u seatuser "$R" talkie-runner
  refused "the runner as someone who is not in walkie-seats" -u outsider "$R" seat-runner
  refused "the runner as root" "$R" seat-runner
  refused "the runner with another argument" -u seatuser "$R" seat-runner extra
  local verb
  # `destroy 7 idle` (WALK-103): a leftover found in the helper's list, removed only while idle, under the same `destroy *` rule.
  for verb in "create 7" "destroy 7" "destroy 7 idle" "talkie-create $GEN $INST" "talkie-reconcile $GEN $INST" "talkie-destroy $GEN" "talkie-status" "talkie-lock-init"; do
    # shellcheck disable=SC2086
    allowed "the helper's '${verb%% *}' as root, no password" "\"stub\":\"as root argv: seat-admin $verb\"" "$A" seat-admin $verb
  done
  allowed "the helper's 'pending' as root, no password" '"ok":true' "$A" seat-admin pending
  refused "the helper's 'pending' with an argument (its rule has no wildcard)" "$A" seat-admin pending idle
  refused "an unknown helper verb" "$A" seat-admin bogus
  refused "another command of the walkie binary through the helper's path" "$A" accounts list
  refused "a command outside the rules (/bin/true as root)" /bin/true
  refused "a shell as a seat user" -u seatuser /bin/sh -c id

  local out rc
  out=$(person sudo -n "$A" seat-admin talkie-repair legacy 2>&1); rc=$?
  if [ $rc -ne 0 ] && printf '%s' "$out" | grep -Eqi 'password|authentication'; then ok "talkie-repair asks for a password (-n refused: $(printf '%s' "$out" | head -1))"; else bad "talkie-repair without a password (rc=$rc: $out)"; fi
  out=$(twice "$A" seat-admin talkie-repair legacy)
  case "$out" in
    "first=0 second=0") bad "talkie-repair: the password was remembered for the next call ($out)" ;;
    "first=0 "*) ok "talkie-repair runs with the password and asks again at once (timestamp_timeout=0): $out" ;;
    *) bad "talkie-repair with the password: $out" ;;
  esac
  # Control: without that one default the second call would be served from the cache, if a cache is observable here at all.
  cp "$RULES" /root/walkie-seats.keep
  grep -v '^Defaults!WALKIE_TALKIE_REPAIR' /root/walkie-seats.keep >/root/walkie-seats.nodefault
  install -m 0440 -o root -g root /root/walkie-seats.nodefault "$RULES"
  out=$(twice "$A" seat-admin talkie-repair legacy)
  install -m 0440 -o root -g root /root/walkie-seats.keep "$RULES"
  case "$out" in
    "first=0 second=0") ok "control: without timestamp_timeout=0 the second call IS served from the cache ($out), so the default does its job" ;;
    *) echo "  note: control: no cache to defeat without a terminal here ($out): timestamp_timeout=0 is shown accepted, not shown effective" ;;
  esac
}

# Why the original sudo keeps the two !requiretty lines: on a system whose sudo wants a terminal for everything (Defaults
# requiretty) seats, which have none, would be refused without them.
requiretty_matters() {
  heading "why the original sudo keeps !requiretty: a system that wants a terminal for every sudo (Defaults requiretty)"
  printf 'Defaults requiretty\n' >/etc/sudoers.d/00-requiretty; chmod 0440 /etc/sudoers.d/00-requiretty
  allowed "with Defaults requiretty the runner still runs as a seat user without a terminal" '^stub as seatuser argv: seat-runner$' -u seatuser "$R" seat-runner
  allowed "and the helper still runs as root without a terminal" '"ok":true' "$A" seat-admin pending
  cp "$RULES" /root/walkie-seats.keep
  grep -v ' !requiretty$' /root/walkie-seats.keep >/root/walkie-seats.nolines
  install -m 0440 -o root -g root /root/walkie-seats.nolines "$RULES"
  local out rc
  out=$(person sudo -n -u seatuser "$R" seat-runner 2>&1); rc=$?
  if [ $rc -ne 0 ] && printf '%s' "$out" | grep -qi 'tty'; then ok "control: without the two !requiretty lines this system refuses the runner: $(printf '%s' "$out" | head -1)"; else bad "control: expected a no-terminal refusal (rc=$rc: $out)"; fi
  out=$(person sudo -n "$A" seat-admin pending 2>&1); rc=$?
  if [ $rc -ne 0 ] && printf '%s' "$out" | grep -qi 'tty'; then ok "control: ... and the helper"; else bad "control: expected a no-terminal refusal for the helper (rc=$rc: $out)"; fi
  install -m 0440 -o root -g root /root/walkie-seats.keep "$RULES"
  rm -f /etc/sudoers.d/00-requiretty
}

# The state the fixed code needs on a rerun, as the failed first run left it.
partial_state() {
  getent group walkie-seats >/dev/null && ok "the group walkie-seats exists (gid $(getent group walkie-seats | cut -d: -f3))" || bad "no group walkie-seats"
  local p
  for p in /var/lib/walkie-seats /var/lib/walkie /usr/local/libexec/walkie "$R" "$A" /usr/local/libexec/walkie/seat-owner /usr/local/libexec/walkie/seat-roots.json; do
    [ -e "$p" ] && ok "$(stat -c '%U:%G %a %n' "$p")" || bad "missing: $p"
  done
  [ ! -e "$RULES" ] && ok "no $RULES yet (the sudo rules were never installed)" || bad "$RULES exists"
}

flow_classic() {
  heading "setup-user (the plan): which sudo it found"
  driver /walkie plan >"$LOG" 2>&1; show "$LOG"
  grep -q "sudo here is the original sudo $VERSION" "$LOG" && ok "the plan names the original sudo $VERSION" || bad "the plan does not name the original sudo $VERSION"
  [ "$(grep -c 'Defaults!.* !requiretty' "$LOG")" = 2 ] && ok "the printed rules keep both !requiretty lines" || bad "the printed rules lack the !requiretty lines"
  heading "setup-user --apply, as the person (sudo -n: no terminal here)"
  grant_person
  driver /walkie apply >"$LOG" 2>&1; local rc=$?; show "$LOG"
  [ $rc -eq 0 ] && ok "setup applied" || bad "setup failed (rc=$rc)"
  installed_rules_checks 2
  rules_behave
  requiretty_matters
}

flow_sudo_rs_new() {
  heading "setup with the sudo NOT recognized (forced): the rules keep !requiretty, visudo refuses them, they are written again"
  grant_person
  driver /walkie apply unknown >"$LOG" 2>&1; local rc=$?; show "$LOG"
  [ $rc -eq 0 ] && ok "setup applied through the fallback" || bad "setup failed (rc=$rc)"
  grep -q "written again without it" "$LOG" && ok "it said the rules were written again without requiretty" || bad "no note that the rules were written again"
  installed_rules_checks 0
  rules_behave
  heading "rerun with the sudo detected (the group, directories and copies exist already)"
  rm -f "$RULES"; grant_person
  driver /walkie apply >"$LOG" 2>&1; rc=$?; show "$LOG"
  [ $rc -eq 0 ] && ok "the rerun applied" || bad "the rerun failed (rc=$rc)"
  grep -q "sudo here is sudo-rs $VERSION" "$LOG" && ok "the plan names sudo-rs $VERSION" || bad "the plan does not name sudo-rs $VERSION"
  ! grep -q "→ the seats' group" "$LOG" && ok "the existing group was reused, not made again" || bad "the group step ran again"
  installed_rules_checks 0
  rules_behave
}

flow_sudo_rs_old() {
  heading "setup-user (the plan) and --apply with the sudo detected: refused before anything changes"
  grant_person
  driver /walkie plan >"$LOG" 2>&1; show "$LOG"
  grep -q "not applied: sudo-rs $VERSION" "$LOG" && ok "the plan says sudo-rs $VERSION can't be used, and how out" || bad "no refusal in the plan"
  driver /walkie apply >"$LOG" 2>&1; local rc=$?
  [ $rc -ne 0 ] && grep -q "Nothing was changed" "$LOG" && ok "--apply stopped (rc=$rc): $(grep -o 'Update sudo-rs.*' "$LOG" | head -1)" || bad "--apply was not refused (rc=$rc)"
  if ! getent group walkie-seats >/dev/null && [ ! -e /usr/local/libexec/walkie ] && [ ! -e "$RULES" ] && [ ! -e /var/lib/walkie ]; then
    ok "nothing was changed (no group, no /usr/local/libexec/walkie, no rules)"
  else bad "the refused setup changed something"; fi

  heading "why: the same rules (as for sudo-rs), installed by hand, asked through this sudo (the helper's create with an id it refuses: nothing is made)"
  revoke_person
  groupadd --system walkie-seats
  install -d -m 755 /usr/local/libexec/walkie
  install -m 755 /opt/walkie-stub/walkie "$R"; install -m 755 /opt/walkie-stub/walkie "$A"
  driver /walkie rules sudo-rs >/tmp/rules.txt
  install -m 0440 -o root -g root /tmp/rules.txt "$RULES"
  local pending create
  answers "$A" seat-admin pending && pending=allowed || pending=refused
  answers "$A" seat-admin create 0 && create=allowed || create=refused
  echo "    | seat-admin pending (no argument): $pending    seat-admin create 0 (the rule ends in *): $create"
  [ "$pending" = allowed ] && ok "a rule without a wildcard matches" || bad "a rule without a wildcard was refused"
  if ver_ge "$VERSION" 0.2.13; then
    [ "$create" = allowed ] && ok "sudo-rs $VERSION (0.2.13 or later) matches the trailing *" || bad "sudo-rs $VERSION refuses the trailing *"
  else
    [ "$create" = refused ] && ok "sudo-rs $VERSION (before 0.2.13) refuses it: the same verdict as the plan's refusal" || bad "sudo-rs $VERSION matched the trailing * though setup refuses it"
  fi
  rm -f "$RULES" "$R" "$A"; rmdir /usr/local/libexec/walkie; groupdel walkie-seats

  heading "the backstop: setup with the sudo NOT recognized (forced) goes on, then asks this sudo and refuses with the way out"
  grant_person
  driver /walkie apply unknown >"$LOG" 2>&1; rc=$?; show "$LOG"
  [ $rc -ne 0 ] && grep -q "sudo here won't run" "$LOG" && ok "setup failed at the question to sudo (rc=$rc), not by saying done" || bad "the backstop did not refuse (rc=$rc)"
  grep -q "written again without it" "$LOG" && ok "and the requiretty fallback ran first" || bad "no fallback note"
}

flow_rerun() {
  [ -d /walkie-old/src ] || { echo "skipped: no code from before the fix mounted at /walkie-old"; exit 0; }
  ver_ge "$VERSION" 0.2.13 || { echo "skipped: a sudo-rs before 0.2.13 is refused by setup, so there is no rerun to complete"; exit 0; }
  heading "the code from before the fix, applied as on the machine that hit this: it stops at the sudo check"
  grant_person
  person bun /walkie/test/helpers/sudo-rules-driver.ts /walkie-old apply >"$LOG" 2>&1; local rc=$?; show "$LOG"
  [ $rc -ne 0 ] && grep -q "unknown setting: 'requiretty'" "$LOG" && grep -q "failed: sudo visudo -c -f" "$LOG" && ok "it failed at 'check the sudo rules' with unknown setting: 'requiretty' (rc=$rc)" || bad "the old code did not fail as expected (rc=$rc)"
  heading "what that left behind (the steps before the check ran)"
  partial_state
  local gid_before
  gid_before=$(getent group walkie-seats | cut -d: -f3)
  heading "the fixed code, the same command again"
  driver /walkie apply >"$LOG" 2>&1; rc=$?; show "$LOG"
  [ $rc -eq 0 ] && ok "the rerun completed" || bad "the rerun failed (rc=$rc)"
  [ "$(getent group walkie-seats | cut -d: -f3)" = "$gid_before" ] && ok "the group was reused (gid $gid_before unchanged)" || bad "the group changed"
  ! grep -q "→ the seats' group" "$LOG" && ok "no step made the group again" || bad "the group step ran again"
  [ -e "$RULES" ] && ok "$(stat -c '%U:%G %a %n' "$RULES") installed" || bad "no rules installed"
  installed_rules_checks 0
  rules_behave
}

setup_container
grant_person
case "$MODE" in
  rules)
    if [ "$FLAVOR" = classic ]; then flow_classic
    elif ver_ge "$VERSION" 0.2.13; then flow_sudo_rs_new
    else flow_sudo_rs_old; fi ;;
  rerun) flow_rerun ;;
  *) echo "unknown mode $MODE"; exit 2 ;;
esac
printf '\nRESULT %s %s %s: %d passed, %d failed\n' "$MODE" "$FLAVOR" "$VERSION" "$pass" "$fail"
[ "$fail" -eq 0 ]
