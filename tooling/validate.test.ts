import { describe, expect, test } from 'bun:test';
import { parseManifestJson } from '@openchamber/sdk/schemas';
import { assertAssetBudget, assertNoUnresolvedPanelImports, releaseManifest, releaseVersion, validateReleaseTree } from './release.js';

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

  test('uses the source package version without a RELEASE_VERSION override', () => {
    const previous = process.env.RELEASE_VERSION;
    delete process.env.RELEASE_VERSION;
    expect(releaseVersion()).toBe('0.1.0');
    process.env.RELEASE_VERSION = '';
    expect(releaseVersion()).toBe('0.1.0');
    process.env.RELEASE_VERSION = '0.0.9';
    expect(() => releaseVersion()).toThrow('cannot be below');
    if (previous === undefined) delete process.env.RELEASE_VERSION;
    else process.env.RELEASE_VERSION = previous;
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
