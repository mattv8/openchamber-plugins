import { parseManifestJson } from '@openchamber/sdk/schemas';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export const releaseManifest = () => ({
  name: '@openchamber-plugin/git-graph',
  version: '0.1.0',
  type: 'module',
  main: './dist/service/index.js',
  openchamber: {
    apiVersion: 1 as const,
    engines: { openchamber: '>=2.0.1' },
    contributes: {
      panel: { id: 'git-graph', name: 'Git Graph', icon: 'git-branch' },
      statusSection: { entry: 'dist/panel/status.html', title: 'Git', height: 260 },
      service: { entry: 'dist/service/index.js', runtime: 'host' as const, permissions: { exec: ['git'] } },
    },
  },
});

type ReleaseManifest = ReturnType<typeof releaseManifest>;

export const assertManifest = (manifest: ReleaseManifest): void => {
  const parsed = parseManifestJson(JSON.stringify(manifest));
  if (!parsed.ok) throw new Error(`Invalid OpenChamber manifest: ${parsed.code}: ${parsed.message}`);
};

export const assertAssetBudget = (assets: readonly { path: string; bytes: number }[]): void => {
  if (assets.length > 500) throw new Error('Release exceeds the 500-file asset limit');
  const bytes = assets.reduce((total, asset) => total + asset.bytes, 0);
  if (bytes > 40 * 1024 * 1024) throw new Error('Release exceeds the 40 MiB fetched asset limit');
};

export const assertNoUnresolvedPanelImports = (source: string): void => {
  if (/(?:^|[;])\s*import\s+(?:[\w*{])/.test(source) || /from\s+['"](?:react|react-dom)['"]/.test(source)) {
    throw new Error('Panel bundle contains unresolved chunks or external React imports');
  }
};

const listAssets = async (directory: string): Promise<{ path: string; bytes: number }[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const assets = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listAssets(path);
    return [{ path, bytes: (await stat(path)).size }];
  }));
  return assets.flat();
};

export const validateReleaseTree = async (releaseRoot: string): Promise<void> => {
  const packagePath = resolve(releaseRoot, 'package.json');
  if (!existsSync(packagePath)) throw new Error(`Missing release asset: ${packagePath}`);
  const manifest = await Bun.file(packagePath).json();
  assertManifest(manifest);
  const contributions = manifest.openchamber.contributes;
  const entries = [contributions.statusSection === true ? contributions.statusSection.entry : contributions.statusSection?.entry, contributions.service.entry].filter(Boolean);
  for (const entry of new Set(entries)) {
    if (!entry || !existsSync(resolve(releaseRoot, entry))) throw new Error(`Missing release asset: ${entry}`);
  }
  const statusJs = resolve(releaseRoot, 'dist/panel/main.js');
  const stylesheet = resolve(releaseRoot, 'dist/panel/main.css');
  if (!existsSync(statusJs) || !existsSync(stylesheet)) throw new Error(`Missing release asset: ${statusJs}`);
  const source = await Bun.file(statusJs).text();
  assertNoUnresolvedPanelImports(source);
  assertAssetBudget(await listAssets(releaseRoot));
};
