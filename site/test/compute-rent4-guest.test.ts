import { expect, test } from 'bun:test';
import { userData } from '../api/_lib/compute/cloud-init.ts';
import { joinCode } from './compute-helpers.ts';
const script = () => userData({ rentalId: 'r_0123456789abcdef', hostname: 'rent-agent-test', joinCode: joinCode(), heartbeatToken: 'a'.repeat(43), walkieVersion: 'v0.2.0-pre.7', siteOrigin: 'https://site.test', egressRateMbit: 1000 });
test('curl reads credentials from a mode 0600 header file, never argv', () => {
  const s = script();
  for (const line of s.split('\n').filter(l => l.includes('curl '))) {
    expect(line).not.toContain('a'.repeat(43));
    expect(line).not.toContain('--data-binary "$body"');
  }
  expect(s).toContain('--header @/etc/walkie-rental/heartbeat-header');
  expect(s).toContain('chmod 0600 /etc/walkie-rental/heartbeat-header');
});
test('local metadata verification is mandatory before admission and each boot', () => {
  const s = script();
  for (const path of ['/run/cloud-init', '/var/lib/cloud', '/etc/cloud', '/var/log/cloud-init.log', '/var/log/cloud-init-output.log']) expect(s).toContain(path);
  expect(s).toContain('runuser -u nobody');
  expect(s).toContain('ExecStart=/usr/local/lib/walkie-rental/metadata.sh');
  expect(s.indexOf('systemctl enable --now walkie-metadata.service')).toBeLessThan(s.indexOf('--invite'));
});
test('lease watchdog is installed before prerequisites and powers off on expiry', () => {
  const s = script();
  expect(s.indexOf('systemctl enable --now walkie-rental-lease.timer')).toBeGreaterThan(0);
  expect(s.indexOf('systemctl enable --now walkie-rental-lease.timer')).toBeLessThan(s.indexOf('apt-get update'));
  expect(s).toContain('systemctl poweroff');
  expect(s).toContain('/api/compute/lease');
});

test('generated bootstrap and embedded scripts parse as bash', async () => {
  const { METADATA_SCRIPT, LEASE_SCRIPT } = await import('../api/_lib/compute/guest-safety.ts');
  for (const source of [script(), METADATA_SCRIPT, LEASE_SCRIPT]) {
    const proc = Bun.spawn(['bash', '-n'], { stdin: new Blob([source]), stdout: 'pipe', stderr: 'pipe' });
    expect(await new Response(proc.stderr).text()).toBe('');
    expect(await proc.exited).toBe(0);
  }
});

test('isolated guest watchdog shuts down on an expired or unrenewed lease', async () => {
  const { LEASE_SCRIPT } = await import('../api/_lib/compute/guest-safety.ts');
  const { mkdtemp, writeFile, mkdir, rm, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  // Every command capable of external I/O or shutdown is stubbed before execution.
  const dir = await mkdtemp(join(process.cwd(), '.lease-test-'));
  try {
    const bin = join(dir, 'bin'); await mkdir(bin);
    await writeFile(join(dir, 'env'), 'RENTAL_ID=r_0123456789abcdef\nSITE=https://site.test\n');
    await writeFile(join(bin, 'date'), '#!/bin/sh\nprintf 1000\n', { mode: 0o700 });
    await writeFile(join(bin, 'curl'), '#!/bin/sh\ncat >/dev/null\nexit 22\n', { mode: 0o700 });
    await writeFile(join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s' "$1" > '${dir}/action'\n`, { mode: 0o700 });
    const source = LEASE_SCRIPT.replaceAll('/etc/walkie-rental', dir);
    for (const until of [99, 101]) {
      await rm(join(dir, 'action'), { force: true });
      await writeFile(join(dir, 'lease-until'), String(until));
      const proc = Bun.spawn(['bash'], { stdin: new Blob([source]), env: { PATH: `${bin}:/usr/bin:/bin` }, stdout: 'pipe', stderr: 'pipe' });
      expect(await proc.exited).toBe(until === 99 ? 1 : 0);
      if (until === 99) expect(await readFile(join(dir, 'action'), 'utf8')).toBe('poweroff');
      else expect(await readFile(join(dir, 'action'), 'utf8').catch(() => null)).toBeNull();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('generated heartbeat sends valid JSON without a credential in its body', async () => {
  const lines = script().split('\n').filter(line => line.startsWith('gpu_json=') || line.startsWith('body='));
  const source = ['RENTAL_ID=r_0123456789abcdef; busy=1; pool=0; cpu=3; gpu=5; tx=10', ...lines, 'printf \'%s\' "$body"'].join('\n');
  const proc = Bun.spawn(['bash'], { stdin: new Blob([source]), stdout: 'pipe', stderr: 'pipe' });
  const body = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(JSON.parse(body)).toEqual({ rental_id: 'r_0123456789abcdef', busy_seats: 1, pool_jobs: 0, cpu_pct: 3, gpu_pct: 5, egress_bytes: 10 });
});
