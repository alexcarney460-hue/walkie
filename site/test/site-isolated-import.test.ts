import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const site = join(import.meta.dir, '..');
const entrypoints = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(item => {
  const path = join(dir, item.name);
  return item.isDirectory() ? entrypoints(path) : item.name.endsWith('.ts') ? [path] : [];
});

test('every API entrypoint loads from a site-only frozen install', () => {
  const temp = mkdtempSync(join(tmpdir(), 'walkie-site-only-'));
  try {
    cpSync(site, temp, { recursive: true, filter: path => !path.split('/').includes('node_modules') });
    const installed = Bun.spawnSync(['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], {
      cwd: temp, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_PATH: '' },
    });
    expect(installed.exitCode, new TextDecoder().decode(installed.stderr)).toBe(0);
    const loader = join(temp, 'load-entry.mjs');
    writeFileSync(loader, "await import(process.argv[2]);\n");
    for (const entry of entrypoints(join(temp, 'api')).filter(path => !path.includes('/_lib/'))) {
      const loaded = Bun.spawnSync(['bun', '--no-install', loader, entry], {
        cwd: temp, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_PATH: '' },
      });
      const name = relative(join(temp, 'api'), entry);
      const error = new TextDecoder().decode(loaded.stderr);
      console.log(`${name}: ${loaded.exitCode === 0 ? 'LOADED' : `FAILED ${error.split('\n')[0]}`}`);
      expect(loaded.exitCode, `${name}: ${error}`).toBe(0);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 120_000);
