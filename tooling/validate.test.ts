import { describe, expect, test } from 'bun:test';
import { parseManifestJson } from '@openchamber/sdk/schemas';
import { assertAssetBudget, assertNoUnresolvedPanelImports, releaseManifest, validateReleaseTree } from './release.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

describe('Git Graph release validation', () => {
  test('emits the official v2 manifest with panel metadata, status section, and service entries only', () => {
    const manifest = releaseManifest();
    const parsed = parseManifestJson(JSON.stringify(manifest));
    expect(parsed.ok).toBe(true);
    expect(manifest.openchamber.engines.openchamber).toBe('>=2.0.1');
    expect(manifest.openchamber.contributes.panel).toEqual({ id: 'git-graph', name: 'Git Graph', icon: 'git-branch' });
    expect('entry' in manifest.openchamber.contributes.panel).toBe(false);
    expect('page' in manifest.openchamber.contributes).toBe(false);
    expect(manifest.openchamber.contributes.statusSection).toEqual({ entry: 'dist/panel/status.html', title: 'Git', height: 260 });
  });

  test('rejects a package tree with a missing HTML asset', async () => {
    await expect(validateReleaseTree('/missing/git-graph-package')).rejects.toThrow('Missing release asset');
  });

  test('caps release assets and rejects unresolved panel imports', () => {
    expect(() => assertAssetBudget(Array.from({ length: 501 }, (_, index) => ({ path: `asset-${index}`, bytes: 1 })))).toThrow('500-file');
    expect(() => assertAssetBudget([{ path: 'large.js', bytes: 40 * 1024 * 1024 + 1 }])).toThrow('40 MiB');
    expect(() => assertNoUnresolvedPanelImports('import React from "react";')).toThrow('unresolved');
  });
});

describe('Release workflow contracts', () => {
  type WorkflowStep = {
    id?: string;
    name?: string;
    uses?: string;
    run?: string;
    'working-directory'?: string;
    with?: Record<string, string>;
    env?: Record<string, string>;
  };
  type BuildWorkflow = {
    jobs: {
      build: { outputs: { plugin_sha256: string }; steps: WorkflowStep[] };
      'test-host': { needs: string; steps: WorkflowStep[] };
    };
  };
  type ReleaseWorkflow = {
    permissions: { contents: string };
    jobs: {
      build: { needs?: string };
      publish: { needs: string; environment: string; permissions: { contents: string }; steps: WorkflowStep[] };
    };
  };

  const parseBuildWorkflow = (): BuildWorkflow => Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../.github/workflows/build-test-host.yml'), 'utf-8')) as BuildWorkflow;
  const parseReleaseWorkflow = (): ReleaseWorkflow => Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../.github/workflows/release.yml'), 'utf-8')) as ReleaseWorkflow;

  test('parses the build workflow and provisions the OpenCode version pinned by the host', () => {
    const workflow = parseBuildWorkflow();
    const hostSteps = workflow.jobs['test-host'].steps;
    const cliStep = hostSteps.find((step) => step.name === 'Provision the OpenCode version pinned by the host');
    const cliRun = cliStep?.run;

    expect(hostSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({ run: 'bunx playwright install --with-deps chromium' }),
      expect.objectContaining({
        uses: 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
        with: { name: 'git-graph-packed-plugin', path: 'artifacts/git-graph' },
      }),
    ]));
    expect(workflow.jobs.build.outputs.plugin_sha256).toBe('${{ steps.provenance.outputs.plugin_sha256 }}');
    expect(workflow.jobs['test-host'].needs).toBe('build');
    expect(cliRun).toEqual(expect.stringContaining("jq -r '.dependencies[\"@opencode/client\"]' package.json"));
    expect(cliRun).toEqual(expect.stringContaining('npm pack "@opencode/cli-linux-x64-baseline@${OPENCODE_VERSION}"'));
    expect(cliRun).toEqual(expect.stringContaining('--ignore-scripts'));
    expect(cliRun).toEqual(expect.stringContaining('--strip-components=2 package/bin/opencode'));
    expect(cliRun).toEqual(expect.stringContaining('test -x "$OPENCODE_CACHE/opencode"'));
    expect(cliStep).toMatchObject({ 'working-directory': '.cache/stock-host' });
  });

  test('parses the build provenance and archive checksum contracts', () => {
    const workflow = parseBuildWorkflow();
    const provenance = workflow.jobs.build.steps.find((step) => step.id === 'provenance');

    expect(provenance).toMatchObject({
      env: { SOURCE_SHA: '${{ github.sha }}', WORKFLOW_URL: '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}' },
    });
    expect(provenance?.run).toContain('sha256sum git-graph.zip > git-graph.zip.sha256');
    expect(provenance?.run).toContain('sourceSHA: $sourceSHA');
    expect(provenance?.run).toContain('pluginVersion: $pluginVersion');
    expect(provenance?.run).toContain('hostSHA: $hostSHA');
    expect(provenance?.run).toContain('workflowURL: $workflowURL');
    expect(provenance?.run).toContain('git-graph.zip');
  });

  test('parses the protected publisher and verifies the downloaded ZIP', () => {
    const workflow = parseReleaseWorkflow();
    const publisher = workflow.jobs.publish;
    const download = publisher.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
    const checksum = publisher.steps.find((step) => step.name === 'Validate SHA256 checksum');
    const release = publisher.steps.find((step) => step.name === 'Create release and upload artifacts');

    expect(workflow.permissions.contents).toBe('read');
    expect(publisher.needs).toBe('build');
    expect(publisher.environment).toBe('publish');
    expect(publisher.permissions.contents).toBe('write');
    expect(download).toMatchObject({ with: { name: 'git-graph-packed-plugin', path: 'artifacts/git-graph' } });
    expect(checksum).toMatchObject({ env: { EXPECTED_PLUGIN_SHA256: '${{ needs.build.outputs.plugin_sha256 }}' } });
    expect(checksum?.run).toContain('sha256sum -c git-graph.zip.sha256');
    expect(checksum?.run).toContain('test "$actual_plugin_sha256" = "$EXPECTED_PLUGIN_SHA256"');
    expect(release).toMatchObject({ env: { GH_REPO: '${{ github.repository }}', RELEASE_TAG: '${{ github.ref_name }}' } });
    expect(release?.run).toContain('gh release create "$RELEASE_TAG" --repo "$GH_REPO"');
    expect(release?.run).toContain('git-graph.zip#Git Graph plugin');
    expect(release?.run).not.toContain('bun run');
  });

  test('executes the provenance step and puts matching metadata beside the archive', async () => {
    const run = parseBuildWorkflow().jobs.build.steps.find((step) => step.id === 'provenance')?.run;
    if (!run) throw new Error('Missing build provenance step');
    const root = await mkdtemp(resolve(tmpdir(), 'git-graph-provenance-'));
    try {
      await mkdir(resolve(root, 'plugins/git-graph'), { recursive: true });
      await mkdir(resolve(root, 'artifacts/git-graph'), { recursive: true });
      await Bun.write(resolve(root, 'plugins/git-graph/package.json'), JSON.stringify({ version: '0.1.0' }));
      await Bun.write(resolve(root, 'artifacts/git-graph/git-graph.zip'), 'fixture archive');
      const output = resolve(root, 'github-output');
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', run], {
        cwd: root,
        env: { ...process.env, SOURCE_SHA: 'a'.repeat(40), WORKFLOW_URL: 'https://example.com/run', GITHUB_OUTPUT: output },
        encoding: 'utf8',
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const digest = createHash('sha256').update('fixture archive').digest('hex');
      expect(await Bun.file(resolve(root, 'artifacts/git-graph/provenance.json')).json()).toEqual({
        sourceSHA: 'a'.repeat(40), pluginVersion: '0.1.0', hostSHA: 'ffa12ea39b00c0fe1f2b9c9f56b7aefc6ff3fcce',
        workflowURL: 'https://example.com/run', archive: { name: 'git-graph.zip', sha256: digest },
      });
      expect(await Bun.file(output).text()).toBe(`plugin_sha256=${digest}\n`);
      expect(await Bun.file(resolve(root, 'provenance.json')).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
