import { test, expect } from 'bun:test';
import { userData } from '../api/_lib/compute/cloud-init.ts';
import { joinCode } from './compute-helpers.ts';
const script = () => userData({ rentalId: 'r_0123456789abcdef', hostname: 'rent-agent-test', joinCode: joinCode(), heartbeatToken: 'a'.repeat(43), walkieVersion: 'v0.2.0-pre.7', siteOrigin: 'https://site.test', egressRateMbit: 731 });
test('bootstrap installs firewall first and verifies isolation before joining', () => {
  const s = script();
  expect(s.indexOf('apt-get install')).toBeLessThan(s.indexOf('iptables -I'));
  expect(s.includes('iptables -C OUTPUT')).toBe(true);
  expect(s.includes('-j REJECT || true')).toBe(false);
  expect(s.indexOf('iptables -C OUTPUT')).toBeLessThan(s.indexOf('--invite'));
});
test('user-data uses public fair-use bandwidth and durable egress deltas', () => {
  const s = script();
  expect(s.includes('731mbit')).toBe(false);
  expect(s.includes('/proc/sys/kernel/random/boot_id')).toBe(true);
  expect(s.includes('egress-total')).toBe(true);
});
test('metadata isolation is restored before the guest user manager on reboot', () => {
  const s = script();
  expect(s.includes('Requires=walkie-metadata.service')).toBe(true);
  expect(s.includes('iptables-restore')).toBe(true);
  expect(s.includes('ip6tables-restore')).toBe(true);
});
