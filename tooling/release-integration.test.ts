import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { planRelease } from './release-planner.js';

test('release planning follows real git history, tags, and renamed build inputs', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'release-history-'));
  const git = (args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  const commit = (message: string) => { git(['add', '.']); git(['commit', '-m', message]); return git(['rev-parse', 'HEAD']); };
  try {
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Release fixture']);
    git(['config', 'user.email', 'release@example.test']);
    await mkdir(resolve(root, 'plugins/git-graph/src'), { recursive: true });
    await writeFile(resolve(root, 'plugins/git-graph/src/entry.ts'), 'export const version = 1;\n');
    const first = commit('Initial plugin');
    expect(planRelease(first, git, '0.1.0').version).toBe('0.1.0');
    git(['tag', 'git-graph/v0.1.0']);
    await writeFile(resolve(root, 'README.md'), 'Usage notes\n');
    const docs = commit('Document usage');
    expect(planRelease(docs, git, '0.1.0').shouldRelease).toBe(false);
    await writeFile(resolve(root, 'plugins/git-graph/src/entry.ts'), 'export const version = 2;\n');
    const second = commit('Update plugin');
    expect(planRelease(second, git, '0.1.0').version).toBe('0.1.1');
    // An unsuccessful draft has no tag, so rerunning reserves the same version.
    expect(planRelease(second, git, '0.1.0').version).toBe('0.1.1');
    git(['tag', 'git-graph/v0.1.1']);
    expect(planRelease(first, git, '0.1.0').shouldRelease).toBe(false);
    expect(planRelease(second, git, '0.1.0').version).toBe('0.1.1');
    await mkdir(resolve(root, 'docs'));
    git(['mv', 'plugins/git-graph/src/entry.ts', 'docs/retired.md']);
    const renamed = commit('Retire source into documentation');
    expect(planRelease(renamed, git, '0.1.0').version).toBe('0.1.2');
    expect(planRelease(renamed, git, '0.2.0').version).toBe('0.2.0');
    git(['checkout', '-b', 'diverged', first]);
    await writeFile(resolve(root, 'independent.txt'), 'Other branch\n');
    commit('Independent release');
    git(['tag', 'git-graph/v0.9.0']);
    git(['checkout', 'main']);
    expect(planRelease(renamed, git, '0.1.0').shouldRelease).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the executable workflow provenance step uses the packaged version and archive bytes', async () => {
  type Workflow = { jobs: { build: { steps: Array<{ id?: string; run?: string }> } } };
  // SAFETY: this repository-owned YAML shape is asserted below before executing its named step.
  const workflow = Bun.YAML.parse(await readFile(resolve(import.meta.dir, '../.github/workflows/build-test-host.yml'), 'utf8')) as Workflow;
  const script = workflow.jobs.build.steps.find((step) => step.id === 'provenance')?.run;
  if (!script) throw new Error('Missing provenance step');
  const root = await mkdtemp(resolve(tmpdir(), 'release-provenance-'));
  try {
    await mkdir(resolve(root, 'plugins/git-graph'), { recursive: true });
    await mkdir(resolve(root, 'artifacts/git-graph/package'), { recursive: true });
    await writeFile(resolve(root, 'plugins/git-graph/package.json'), JSON.stringify({ version: '0.1.0' }));
    await writeFile(resolve(root, 'artifacts/git-graph/package/package.json'), JSON.stringify({ version: '0.4.2' }));
    await writeFile(resolve(root, 'artifacts/git-graph/git-graph.zip'), 'archive fixture');
    const output = resolve(root, 'github-output');
    const source = 'a'.repeat(40);
    const result = Bun.spawnSync(['bash', '-euo', 'pipefail', '-c', script], {
      cwd: root, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, SOURCE_SHA: source, WORKFLOW_URL: 'https://example.test/run', GITHUB_OUTPUT: output },
    });
    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(result.exitCode).toBe(0);
    const digest = createHash('sha256').update('archive fixture').digest('hex');
    expect(await Bun.file(resolve(root, 'artifacts/git-graph/provenance.json')).json()).toMatchObject({
      sourceSHA: source, pluginVersion: '0.4.2', workflowURL: 'https://example.test/run',
      archive: { name: 'git-graph.zip', sha256: digest },
    });
    expect(await readFile(output, 'utf8')).toBe(`plugin_sha256=${digest}\n`);
    expect(await readFile(resolve(root, 'artifacts/git-graph/git-graph.zip.sha256'), 'utf8')).toBe(`${digest}  git-graph.zip\n`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
