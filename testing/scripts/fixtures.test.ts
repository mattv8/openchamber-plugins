import { expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitFixture, removeFixture } from './fixtures.js';

test('creates a real repository with committed history and an unstaged change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-graph-fixture-'));
  try {
    const repository = await createGitFixture(root);
    expect(await readFile(join(repository, 'README.md'), 'utf8')).toContain('Changed');
    expect(await Bun.$`git -C ${repository} rev-list --count HEAD`.text()).toBe('2\n');
    expect(await Bun.$`git -C ${repository} status --porcelain`.text()).toBe('?? uncommitted.txt\n');
  } finally {
    await removeFixture(root);
  }
});
