import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type Redirect = {
  source: string;
  destination: string;
  permanent: boolean;
  has?: { type: string; value: string }[];
};

const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
  redirects: Redirect[];
};

test('alternate hosts redirect both root and paths to the canonical host', () => {
  const hosts = ['sqwaukie.si', 'www.sqwaukie.si', 'www.sqwakie.si'];
  const routes = [
    { source: '/', destination: 'https://sqwakie.si/' },
    { source: '/:path*', destination: 'https://sqwakie.si/:path*' },
  ];

  expect(config.redirects).toHaveLength(hosts.length * routes.length);
  for (const host of hosts) {
    for (const route of routes) {
      const matches = config.redirects.filter(rule =>
        rule.source === route.source && rule.has?.some(condition =>
          condition.type === 'host' && condition.value === host));
      expect(matches).toHaveLength(1);
      expect(matches[0]?.destination).toBe(route.destination);
      expect(matches[0]?.permanent).toBe(true);
    }
    const rootIndex = config.redirects.findIndex(rule =>
      rule.source === '/' && rule.has?.[0]?.value === host);
    const pathIndex = config.redirects.findIndex(rule =>
      rule.source === '/:path*' && rule.has?.[0]?.value === host);
    expect(rootIndex).toBeLessThan(pathIndex);
  }
});

test('no redirect matches the canonical host', () => {
  for (const rule of config.redirects) {
    expect(rule.has).toHaveLength(1);
    expect(rule.has?.[0]?.type).toBe('host');
    expect(rule.has?.[0]?.value).not.toBe('sqwakie.si');
  }
});
