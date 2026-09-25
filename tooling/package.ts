import { cp, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { releaseManifest, validateReleaseTree } from './release.js';

const root = resolve(import.meta.dir, '..');
const plugin = resolve(root, 'plugins/git-graph');
const dist = resolve(plugin, 'dist');

const packagePlugin = async (): Promise<string> => {
  const releaseRoot = resolve(root, 'artifacts/git-graph/package');
  await rm(releaseRoot, { recursive: true, force: true });
  await mkdir(releaseRoot, { recursive: true });
  for (const file of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(resolve(plugin, file), resolve(releaseRoot, file));
  await cp(dist, resolve(releaseRoot, 'dist'), { recursive: true });
  await Bun.write(resolve(releaseRoot, 'package.json'), `${JSON.stringify(releaseManifest(), null, 2)}\n`);
  await validateReleaseTree(releaseRoot);
  const zip = resolve(root, 'artifacts/git-graph/git-graph.zip');
  await rm(zip, { force: true });
  const result = Bun.spawnSync(['zip', '-qr', zip, '.'], { cwd: releaseRoot });
  if (result.exitCode !== 0) throw new Error('zip failed for Git Graph');
  return zip;
};

if (process.argv.at(2) !== 'git-graph') throw new Error('Usage: bun run package -- git-graph');
if (!existsSync(resolve(dist, 'panel/main.js')) || !existsSync(resolve(dist, 'service/index.js'))) throw new Error('Package is blocked: run bun run build -- git-graph first.');
await rm(resolve(root, 'artifacts/git-graph'), { recursive: true, force: true });
const archive = await packagePlugin();
const checksum = `${createHash('sha256').update(Buffer.from(await Bun.file(archive).arrayBuffer())).digest('hex')}  ${archive.split('/').at(-1)}`;
await Bun.write(resolve(root, 'artifacts/git-graph/SHA256SUMS'), `${checksum}\n`);
console.log(`Prepared ${archive}`);
