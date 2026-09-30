import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

test('site tests import by relative path and never hard-code a workstation or worktree path', () => {
  const dir = new URL('.', import.meta.url);
  const offenders = readdirSync(dir).filter(name => name.endsWith('.ts') &&
    /\/Users\/|\.claude\/worktrees/.test(readFileSync(new URL(name, dir), 'utf8')));
  expect(offenders).toEqual([]);
});
