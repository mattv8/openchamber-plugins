import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { publishGitDistribution, type GitDistributionOptions } from './git-distribution.js';
import type { Run } from './publisher.js';
import { releaseManifest } from './release.js';

const git = (directory: string, args: string[]): string => {
  const result = Bun.spawnSync(['git', ...args], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
};

const releaseRun = (sourceSHA: string, publicAssets: string): Run => (command, args) => {
  expect(command).toBe('gh');
  if (args.includes('download')) {
    const destination = args[args.indexOf('--dir') + 1];
    if (!destination) throw new Error('Missing release download directory');
    for (const asset of ['git-graph.zip', 'git-graph.zip.sha256', 'provenance.json']) cpSync(resolve(publicAssets, asset), resolve(destination, asset));
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  expect(args).toContain('view');
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      isDraft: false,
      targetCommitish: sourceSHA,
      assets: ['git-graph.zip', 'git-graph.zip.sha256', 'provenance.json'].map((name) => ({ name, size: 1 })),
    }),
    stderr: '',
  };
};

const writeArtifact = async (directory: string, version: string, sourceSHA: string, includeObsolete: boolean): Promise<void> => {
  const tree = resolve(directory, 'tree');
  await mkdir(resolve(tree, 'dist/manifests'), { recursive: true });
  await mkdir(resolve(tree, 'dist/panel'), { recursive: true });
  await mkdir(resolve(tree, 'dist/service'), { recursive: true });
  const manifest = JSON.stringify({ ...releaseManifest(), version });
  await writeFile(resolve(tree, 'package.json'), manifest);
  await writeFile(resolve(tree, 'dist/manifests/package.json'), manifest);
  await writeFile(resolve(tree, 'dist/panel/main.js'), 'export {}\n');
  await writeFile(resolve(tree, 'dist/panel/main.css'), 'body {}\n');
  await writeFile(resolve(tree, 'dist/panel/status.html'), '<main></main>\n');
  await writeFile(resolve(tree, 'dist/service/index.js'), 'export {}\n');
  if (includeObsolete) await writeFile(resolve(tree, 'obsolete.txt'), 'remove me\n');
  await rm(resolve(directory, 'git-graph.zip'), { force: true });
  const zip = Bun.spawnSync(['zip', '-qr', resolve(directory, 'git-graph.zip'), '.'], { cwd: tree });
  if (zip.exitCode !== 0) throw new Error('Cannot create test release ZIP');
  const digest = createHash('sha256').update(Buffer.from(await Bun.file(resolve(directory, 'git-graph.zip')).arrayBuffer())).digest('hex');
  await writeFile(resolve(directory, 'git-graph.zip.sha256'), `${digest}  git-graph.zip\n`);
  await writeFile(resolve(directory, 'provenance.json'), JSON.stringify({ sourceSHA, pluginVersion: version, archive: { name: 'git-graph.zip', sha256: digest } }));
  await rm(tree, { recursive: true, force: true });
};

const createFixture = async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'git-distribution-'));
  const remote = resolve(root, 'remote.git');
  const source = resolve(root, 'source');
  git(root, ['init', '--bare', remote]);
  git(root, ['init', '-b', 'main', source]);
  git(source, ['config', 'user.name', 'Fixture']);
  git(source, ['config', 'user.email', 'fixture@example.test']);
  await writeFile(resolve(source, 'source.txt'), 'first\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Initial source']);
  const firstSource = git(source, ['rev-parse', 'HEAD']);
  git(source, ['remote', 'add', 'origin', remote]);
  git(source, ['push', 'origin', 'main']);
  return { root, remote, source, firstSource };
};

const options = (publicAssets: string, version: string, sourceSHA: string, remote: string): GitDistributionOptions => ({
  version,
  sourceSHA,
  repo: 'owner/repo',
  remote,
  runGh: releaseRun(sourceSHA, publicAssets),
});

test('publishes a validated archive to a bare remote and removes obsolete files on upgrade', async () => {
  const fixture = await createFixture();
  const first = resolve(fixture.root, 'first');
  const second = resolve(fixture.root, 'second');
  try {
    await mkdir(first);
    await writeArtifact(first, '0.1.0', fixture.firstSource, true);
    await expect(publishGitDistribution(options(first, '0.1.0', fixture.firstSource, fixture.remote))).resolves.toBe('published');
    expect(git(fixture.root, ['--git-dir', fixture.remote, 'show', 'git-graph:obsolete.txt'])).toBe('remove me');

    await writeFile(resolve(fixture.source, 'source.txt'), 'second\n');
    git(fixture.source, ['commit', '-am', 'Update source']);
    const secondSource = git(fixture.source, ['rev-parse', 'HEAD']);
    git(fixture.source, ['push', 'origin', 'main']);
    await mkdir(second);
    await writeArtifact(second, '0.1.1', secondSource, false);
    await expect(publishGitDistribution(options(second, '0.1.1', secondSource, fixture.remote))).resolves.toBe('published');
    const missing = Bun.spawnSync(['git', '--git-dir', fixture.remote, 'show', 'git-graph:obsolete.txt'], { stdout: 'pipe', stderr: 'pipe' });
    expect(missing.exitCode).not.toBe(0);
    expect(JSON.parse(git(fixture.root, ['--git-dir', fixture.remote, 'show', 'git-graph:package.json']))).toMatchObject({ version: '0.1.1' });
    expect(git(fixture.source, ['status', '--porcelain'])).toBe('');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('retries the same verified release without creating another branch commit', async () => {
  const fixture = await createFixture();
  const artifact = resolve(fixture.root, 'artifact');
  try {
    await mkdir(artifact);
    await writeArtifact(artifact, '0.1.0', fixture.firstSource, false);
    await publishGitDistribution(options(artifact, '0.1.0', fixture.firstSource, fixture.remote));
    const before = git(fixture.root, ['--git-dir', fixture.remote, 'rev-parse', 'git-graph']);
    await writeFile(resolve(fixture.source, 'notes.md'), 'Documentation changed after publication.\n');
    git(fixture.source, ['add', 'notes.md']);
    git(fixture.source, ['commit', '-m', 'Update documentation']);
    git(fixture.source, ['push', 'origin', 'main']);
    await expect(publishGitDistribution(options(artifact, '0.1.0', fixture.firstSource, fixture.remote))).resolves.toBe('noop');
    expect(git(fixture.root, ['--git-dir', fixture.remote, 'rev-parse', 'git-graph'])).toBe(before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects incompatible existing versions and unpublished release status', async () => {
  const fixture = await createFixture();
  const artifact = resolve(fixture.root, 'artifact');
  try {
    await mkdir(artifact);
    await writeArtifact(artifact, '0.1.1', fixture.firstSource, false);
    await publishGitDistribution(options(artifact, '0.1.1', fixture.firstSource, fixture.remote));
    await writeArtifact(artifact, '0.1.0', fixture.firstSource, false);
    await expect(publishGitDistribution(options(artifact, '0.1.0', fixture.firstSource, fixture.remote))).rejects.toThrow('newer distribution');
    await writeArtifact(artifact, '0.1.1', fixture.firstSource, true);
    await expect(publishGitDistribution(options(artifact, '0.1.1', fixture.firstSource, fixture.remote))).rejects.toThrow('different content');
    const unpublished = { ...options(artifact, '0.1.1', fixture.firstSource, fixture.remote), runGh: () => ({ exitCode: 0, stdout: JSON.stringify({ isDraft: true, targetCommitish: fixture.firstSource, assets: [] }), stderr: '' }) };
    await expect(publishGitDistribution(unpublished)).rejects.toThrow('not published');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('leaves the branch unchanged when its normal fast-forward push is rejected', async () => {
  const fixture = await createFixture();
  const first = resolve(fixture.root, 'first');
  const second = resolve(fixture.root, 'second');
  try {
    await mkdir(first);
    await writeArtifact(first, '0.1.0', fixture.firstSource, false);
    await publishGitDistribution(options(first, '0.1.0', fixture.firstSource, fixture.remote));
    const before = git(fixture.root, ['--git-dir', fixture.remote, 'rev-parse', 'git-graph']);
    await writeFile(resolve(fixture.source, 'source.txt'), 'second\n');
    git(fixture.source, ['commit', '-am', 'Update source']);
    const secondSource = git(fixture.source, ['rev-parse', 'HEAD']);
    git(fixture.source, ['push', 'origin', 'main']);
    await mkdir(second);
    await writeArtifact(second, '0.1.1', secondSource, false);
    const hook = resolve(fixture.remote, 'hooks/pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);
    await expect(publishGitDistribution(options(second, '0.1.1', secondSource, fixture.remote))).rejects.toThrow();
    expect(git(fixture.root, ['--git-dir', fixture.remote, 'rev-parse', 'git-graph'])).toBe(before);
    await rm(hook);
    await expect(publishGitDistribution(options(second, '0.1.1', secondSource, fixture.remote))).resolves.toBe('published');
    expect(JSON.parse(git(fixture.root, ['--git-dir', fixture.remote, 'show', 'git-graph:package.json']))).toMatchObject({ version: '0.1.1' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a release source that is not reachable from remote main', async () => {
  const fixture = await createFixture();
  const artifact = resolve(fixture.root, 'artifact');
  try {
    await mkdir(artifact);
    const staleSource = 'b'.repeat(40);
    await writeArtifact(artifact, '0.1.0', staleSource, false);
    await expect(publishGitDistribution(options(artifact, '0.1.0', staleSource, fixture.remote))).rejects.toThrow('ancestor');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects downloaded public assets with mismatched checksum or provenance', async () => {
  const fixture = await createFixture();
  const publicAssets = resolve(fixture.root, 'public');
  try {
    await mkdir(publicAssets);
    await writeArtifact(publicAssets, '0.1.0', fixture.firstSource, false);
    await writeFile(resolve(publicAssets, 'git-graph.zip.sha256'), `${'0'.repeat(64)}  git-graph.zip\n`);
    await expect(publishGitDistribution(options(publicAssets, '0.1.0', fixture.firstSource, fixture.remote))).rejects.toThrow('checksum');
    await writeArtifact(publicAssets, '0.1.0', fixture.firstSource, false);
    await writeFile(resolve(publicAssets, 'provenance.json'), JSON.stringify({ sourceSHA: 'b'.repeat(40), pluginVersion: '0.1.0', archive: { name: 'git-graph.zip', sha256: '0'.repeat(64) } }));
    await expect(publishGitDistribution(options(publicAssets, '0.1.0', fixture.firstSource, fixture.remote))).rejects.toThrow('source SHA');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('does not change the branch when public asset download fails', async () => {
  const fixture = await createFixture();
  const publicAssets = resolve(fixture.root, 'public');
  try {
    await mkdir(publicAssets);
    await writeArtifact(publicAssets, '0.1.0', fixture.firstSource, false);
    const failingDownload: Run = (command, args) => args.includes('view')
      ? releaseRun(fixture.firstSource, publicAssets)(command, args)
      : { exitCode: 1, stdout: '', stderr: 'download failed' };
    await expect(publishGitDistribution({ ...options(publicAssets, '0.1.0', fixture.firstSource, fixture.remote), runGh: failingDownload })).rejects.toThrow('download failed');
    const branch = Bun.spawnSync(['git', '--git-dir', fixture.remote, 'show-ref', '--verify', '--quiet', 'refs/heads/git-graph']);
    expect(branch.exitCode).not.toBe(0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
