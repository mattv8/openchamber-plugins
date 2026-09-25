import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GitGraphRequestSchema, GitGraphResponseSchema } from '../plugins/git-graph/src/shared/protocol.js';
import { assertManifest, releaseManifest, validateReleaseTree } from './release.js';

const root = resolve(import.meta.dir, '..');
const plugin = resolve(root, 'plugins/git-graph');
for (const required of ['package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  if (!existsSync(resolve(plugin, required))) throw new Error(`Missing required release file: ${required}`);
}
assertManifest(releaseManifest());
GitGraphRequestSchema.parse({ version: 1, requestId: 'validation', repositoryId: 'repository', snapshot: 'snapshot', operation: 'refresh' });
GitGraphResponseSchema.parse({ version: 1, requestId: 'validation', operation: 'refresh', ok: true, data: { snapshot: 'snapshot', changed: false } });
const packageRoot = resolve(root, 'artifacts/git-graph/package');
if (existsSync(packageRoot)) await validateReleaseTree(packageRoot);
console.log('Git Graph manifest, protocol schemas, and release assets are valid.');
