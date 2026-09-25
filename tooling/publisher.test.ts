import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { releaseManifest } from './release.js';
import { assertPublication, publish, type Run } from './publisher.js';
const source = 'a'.repeat(40);
const fixture = async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'publisher-'));
  await mkdir(resolve(root, 'tree/dist/manifests'), { recursive: true });
  const manifest = JSON.stringify(releaseManifest());
  await Bun.write(resolve(root, 'tree/package.json'), manifest);
  await Bun.write(resolve(root, 'tree/dist/manifests/package.json'), manifest);
  Bun.spawnSync(['zip', '-qr', resolve(root, 'git-graph.zip'), '.'], { cwd: resolve(root, 'tree') });
  const digest = createHash('sha256').update(Buffer.from(await Bun.file(resolve(root, 'git-graph.zip')).arrayBuffer())).digest('hex');
  await Bun.write(resolve(root, 'git-graph.zip.sha256'), `${digest}  git-graph.zip\n`);
  await Bun.write(resolve(root, 'provenance.json'), JSON.stringify({ sourceSHA: source, pluginVersion: '0.1.0', archive: { name: 'git-graph.zip', sha256: digest } }));
  return root;
};
test('publication validates ZIP manifests, source, and both checksums', async () => {
  const root = await fixture();
  try {
    await expect(assertPublication(root, '0.1.0', source)).resolves.toBeUndefined();
    await expect(assertPublication(root, '0.1.0', 'b'.repeat(40))).rejects.toThrow('source SHA');
    await Bun.write(resolve(root, 'git-graph.zip.sha256'), '0'.repeat(64));
    await expect(assertPublication(root, '0.1.0', source)).rejects.toThrow('checksum');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('publication rejects mismatched root and dist manifest versions', async () => {
  const root = await fixture();
  try {
    await Bun.write(resolve(root, 'tree/dist/manifests/package.json'), JSON.stringify({ ...releaseManifest(), version: '0.1.1' }));
    Bun.spawnSync(['zip', '-qr', resolve(root, 'git-graph.zip'), '.'], { cwd: resolve(root, 'tree') });
    const digest = createHash('sha256').update(Buffer.from(await Bun.file(resolve(root, 'git-graph.zip')).arrayBuffer())).digest('hex');
    await Bun.write(resolve(root, 'git-graph.zip.sha256'), `${digest}  git-graph.zip`);
    await Bun.write(resolve(root, 'provenance.json'), JSON.stringify({ sourceSHA: source, pluginVersion: '0.1.0', archive: { name: 'git-graph.zip', sha256: digest } }));
    await expect(assertPublication(root, '0.1.0', source)).rejects.toThrow('root and dist');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a completed release is immutable and a missing release is created then resumed as a draft', () => {
  const calls: string[][] = [];
  const completed: Run = (command, args) => { if (command === 'git') return { exitCode: 0, stdout: args[0] === 'rev-parse' ? `${source}\n` : '', stderr: '' }; calls.push(args); return { exitCode: 0, stdout: `{"isDraft":false,"targetCommitish":"${source}","assets":[{"name":"git-graph.zip","size":1},{"name":"git-graph.zip.sha256","size":1},{"name":"provenance.json","size":1}]}`, stderr: '' }; };
  publish(completed, 'assets', '0.1.0', source, 'owner/repo');
  expect(calls).toHaveLength(1);
  let views = 0;
  const draft: Run = (command, args) => {
    if (command === 'git') return { exitCode: 0, stdout: args[0] === 'rev-parse' ? `${source}\n` : '', stderr: '' };
    calls.push(args);
    if (args[1] === 'view' && views++ === 0) return { exitCode: 1, stdout: '', stderr: 'release not found' };
    if (args[1] === 'view') return { exitCode: 0, stdout: `{"isDraft":true,"targetCommitish":"${source}"}`, stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  publish(draft, 'assets', '0.1.1', source, 'owner/repo', 'git-graph/v0.1.0');
  expect(calls.some((args) => args.includes('--generate-notes') && args.includes('--notes-start-tag'))).toBe(true);
  expect(calls.filter((args) => args[1] === 'upload')).toHaveLength(3);
});
test('a same-version release pointing at another source fails', () => {
  const wrong: Run = (command, args) => command === 'git' ? { exitCode: 0, stdout: args[0] === 'rev-parse' ? `${source}\n` : '', stderr: '' } : ({ exitCode: 0, stdout: `{"isDraft":false,"targetCommitish":"${'b'.repeat(40)}"}`, stderr: '' });
  expect(() => publish(wrong, 'assets', '0.1.0', source, 'owner/repo')).toThrow('different source SHA');
});
test('publisher never creates after a non-404 release lookup failure', () => {
  const calls: string[][] = [];
  const run: Run = (command, args) => {
    if (command === 'git') return { exitCode: 0, stdout: args[0] === 'rev-parse' ? `${source}\n` : '', stderr: '' };
    calls.push(args); return { exitCode: 1, stdout: '', stderr: 'GitHub unavailable' };
  };
  expect(() => publish(run, 'assets', '0.1.0', source, 'owner/repo')).toThrow('GitHub unavailable');
  expect(calls.some((args) => args[1] === 'create')).toBe(false);
});
test('publisher stops on an upload failure without publishing', () => {
  const calls: string[][] = [];
  const run: Run = (command, args) => {
    if (command === 'git') return { exitCode: 0, stdout: args[0] === 'rev-parse' ? `${source}\n` : '', stderr: '' };
    calls.push(args);
    if (args[1] === 'view') return { exitCode: 0, stdout: `{"isDraft":true,"targetCommitish":"${source}","body":"<!-- openchamber-automated-git-graph -->"}`, stderr: '' };
    if (args[1] === 'upload') return { exitCode: 1, stdout: '', stderr: 'upload failed' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  expect(() => publish(run, 'assets', '0.1.0', source, 'owner/repo')).toThrow('upload failed');
  expect(calls.some((args) => args[1] === 'edit')).toBe(false);
});
test('an automated stale draft is superseded only at current main', () => {
  const calls: string[][] = [];
  let views = 0;
  const run: Run = (command, args) => {
    if (command === 'git') return { exitCode: 0, stdout: args[0] === 'rev-parse' ? `${source}\n` : '', stderr: '' };
    calls.push(args);
    if (args[1] === 'view') return { exitCode: 0, stdout: views++ === 0 ? `{"isDraft":true,"targetCommitish":"${'b'.repeat(40)}","body":"<!-- openchamber-automated-git-graph -->"}` : `{"isDraft":true,"targetCommitish":"${source}","body":"<!-- openchamber-automated-git-graph -->"}`, stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  publish(run, 'assets', '0.1.0', source, 'owner/repo');
  expect(calls.some((args) => args[1] === 'delete')).toBe(true);
});

test('a superseded source cannot change a newer draft', () => {
  const calls: string[][] = [];
  const run: Run = (command, args) => {
    if (command === 'git') return { exitCode: 0, stdout: args[0] === 'rev-parse' ? `${'b'.repeat(40)}\n` : '', stderr: '' };
    calls.push(args);
    throw new Error('A stale source must not call GitHub');
  };
  publish(run, 'assets', '0.1.0', source, 'owner/repo');
  expect(calls).toHaveLength(0);
});

test('a foreign draft is preserved and incomplete published releases fail', () => {
  for (const release of [
    { isDraft: true, targetCommitish: 'b'.repeat(40), body: 'Manually prepared release' },
    { isDraft: false, targetCommitish: source, assets: [{ name: 'git-graph.zip', size: 1 }] },
  ]) {
    const calls: string[][] = [];
    const run: Run = (command, args) => {
      if (command === 'git') return { exitCode: 0, stdout: args[0] === 'rev-parse' ? `${source}\n` : '', stderr: '' };
      calls.push(args);
      return { exitCode: 0, stdout: JSON.stringify(release), stderr: '' };
    };
    expect(() => publish(run, 'assets', '0.1.0', source, 'owner/repo')).toThrow();
    expect(calls).toHaveLength(1);
  }
});

test('a concurrently completed release is never overwritten after create', () => {
  const calls: string[][] = [];
  let views = 0;
  const run: Run = (command, args) => {
    if (command === 'git') return { exitCode: 0, stdout: args[0] === 'rev-parse' ? `${source}\n` : '', stderr: '' };
    calls.push(args);
    if (args[1] === 'view' && views++ === 0) return { exitCode: 1, stdout: '', stderr: 'release not found' };
    return { exitCode: 0, stdout: JSON.stringify({ isDraft: false, targetCommitish: source, assets: ['git-graph.zip', 'git-graph.zip.sha256', 'provenance.json'].map((name) => ({ name, size: 1 })) }), stderr: '' };
  };
  publish(run, 'assets', '0.1.0', source, 'owner/repo');
  expect(calls.some((args) => args[1] === 'upload' || args[1] === 'edit')).toBe(false);
});
