import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertManifest, releaseManifest } from './release.js';

const root = resolve(import.meta.dir, '..');
const plugin = resolve(root, 'plugins/git-graph');
const dist = resolve(plugin, 'dist');

async function buildGitGraph(): Promise<void> {
  await rm(dist, { recursive: true, force: true });
  await mkdir(resolve(dist, 'panel'), { recursive: true });
  await mkdir(resolve(dist, 'service'), { recursive: true });
  const [panel, service] = await Promise.all([
    Bun.build({ entrypoints: [resolve(plugin, 'src/panel/main.tsx')], outdir: resolve(dist, 'panel'), naming: '[name].[ext]', format: 'iife', target: 'browser', minify: true, splitting: false }),
    Bun.build({ entrypoints: [resolve(plugin, 'src/service/main.ts')], outdir: resolve(dist, 'service'), naming: 'index.js', format: 'esm', target: 'node', minify: true, splitting: false }),
  ]);
  if (!panel.success || !service.success) throw new Error('Git Graph bundling failed.');
  await Promise.all([
    cp(resolve(plugin, 'panel/status.html'), resolve(dist, 'panel/status.html')),
  ]);
  const manifest = releaseManifest();
  assertManifest(manifest);
  await mkdir(resolve(dist, 'manifests'), { recursive: true });
  await Bun.write(resolve(dist, 'manifests/package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Built ${dist}`);
}

const target = process.argv.at(2);
if (target !== 'git-graph' && target !== '--all' && target !== undefined) throw new Error(`Unknown plugin: ${target}`);
await buildGitGraph();
