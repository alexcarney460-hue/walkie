/** Root-only scripts: no provider identifiers or credentials in process arguments. */
export const METADATA_PATHS = ['/run/cloud-init', '/var/lib/cloud', '/etc/cloud', '/var/log/cloud-init.log',
  '/var/log/cloud-init-output.log', '/run/motd.dynamic', '/etc/machine-info'] as const;
export const METADATA_SCRIPT = `#!/bin/bash
set -euo pipefail
umask 077
# Prove the unprivileged probe can run; a missing/broken probe must fail closed.
command -v runuser >/dev/null
runuser -u nobody -- test -r /etc/passwd
iptables-restore < /etc/walkie-rental/firewall-v4
ip6tables-restore < /etc/walkie-rental/firewall-v6
iptables -C OUTPUT -d 169.254.0.0/16 -m owner ! --uid-owner 0 -j REJECT
iptables -C FORWARD -d 169.254.0.0/16 -j REJECT
ip6tables -C OUTPUT -d fe80::/10 -m owner ! --uid-owner 0 -j REJECT
ip6tables -C FORWARD -d fe80::/10 -j REJECT
# Restrict parent directories too: newly written caches inherit an inaccessible path.
for path in ${METADATA_PATHS.join(' ')}; do
  [ ! -e "$path" ] && continue
  chown -R root:root "$path"
  chmod -R go-rwx "$path"
  if runuser -u nobody -- test -r "$path"; then exit 1; fi
  if [ -d "$path" ]; then
    find -L "$path" -type f -print0 > /etc/walkie-rental/metadata-files
    while IFS= read -r -d '' file; do
      if runuser -u nobody -- test -r "$file"; then exit 1; fi
    done < /etc/walkie-rental/metadata-files
  fi
done
`;

export const LEASE_SCRIPT = String.raw`#!/bin/bash
set -u
umask 077
. /etc/walkie-rental/env
# The server returns an absolute, paid deadline. Successful heartbeats never renew it.
until=$(cat /etc/walkie-rental/lease-until 2>/dev/null || printf '0')
case "$until" in ''|*[!0-9]*) until=0;; esac
now=$(date +%s)
if [ "$now" -ge "$((until + 900))" ]; then systemctl poweroff; exit 1; fi
response=$(printf '{"rental_id":"%s"}' "$RENTAL_ID" | curl -fsS --max-time 10 --header @/etc/walkie-rental/heartbeat-header -H 'content-type: application/json' --data-binary @- "$SITE/api/compute/lease" 2>/dev/null) || response=''
next=$(printf '%s' "$response" | sed -n 's/.*"covered_until":\([0-9][0-9]*\).*/\1/p')
case "$next" in ''|*[!0-9]*) ;; *)
  next=$((next / 1000))
  # Never accept an unbounded lease, even from an invalid response.
  if [ "$next" -gt "$until" ] && [ "$next" -le "$(( $(date +%s) + 900 ))" ]; then
    until=$next
    printf '%s' "$until" > /etc/walkie-rental/lease-until
  fi;;
esac
if [ "$(date +%s)" -ge "$((until + 900))" ]; then systemctl poweroff; exit 1; fi
`;

export function leaseUnits(until: number): string {
  return `install -d -m 0700 /usr/local/lib/walkie-rental
printf '%s' '${Math.floor(until / 1000)}' > /etc/walkie-rental/lease-until
cat > /usr/local/lib/walkie-rental/lease.sh <<'LEASE'
${LEASE_SCRIPT}LEASE
chmod 0700 /usr/local/lib/walkie-rental/lease.sh
cat > /etc/systemd/system/walkie-rental-lease.service <<'UNIT'
[Unit]
Description=Walkie paid lease watchdog
[Service]
Type=oneshot
ExecStart=/usr/local/lib/walkie-rental/lease.sh
TimeoutStartSec=20
UNIT
cat > /etc/systemd/system/walkie-rental-lease.timer <<'UNIT'
[Unit]
Description=Walkie paid lease expiry
[Timer]
OnBootSec=5
OnUnitActiveSec=15
AccuracySec=1
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now walkie-rental-lease.timer
`;
}
