import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('agent guide does not claim all other setup flows fail without a terminal', () => {
  const guide = readFileSync(new URL('../../site/agents.md', import.meta.url), 'utf8');
  expect(guide).not.toMatch(/other `walkie setup` forms prompt on a terminal and fail with a pointer to the flag when there is none/);
});
