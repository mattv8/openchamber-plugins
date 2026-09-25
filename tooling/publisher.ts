import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseManifestJson } from '@openchamber/sdk/schemas';
import { tagPrefix, isVersion } from './release-planner.js';
export type Run = (command: string, args: string[]) => { exitCode: number; stdout: string; stderr: string };
type Asset = { name: string; size: number };
type ReleaseView = { isDraft: boolean; targetCommitish: string; body?: string; assets?: Asset[] };
const marker = '<!-- openchamber-automated-git-graph -->';
const sha256 = async (path: string): Promise<string> => createHash('sha256').update(Buffer.from(await Bun.file(path).arrayBuffer())).digest('hex');
const releaseView = (text: string): ReleaseView => {
  const value: unknown = JSON.parse(text); if (!value || typeof value !== 'object') throw new Error('Invalid GitHub release response');
  const record = value as Record<string, unknown>;
  if (typeof record.targetCommitish !== 'string' || !record.targetCommitish) throw new Error('GitHub release is missing its source target');
  if (typeof record.isDraft !== 'boolean' || ('targetCommitish' in record && typeof record.targetCommitish !== 'string') || ('body' in record && typeof record.body !== 'string') || ('assets' in record && (!Array.isArray(record.assets) || !record.assets.every((asset) => asset && typeof asset === 'object' && typeof (asset as Record<string, unknown>).name === 'string' && typeof (asset as Record<string, unknown>).size === 'number')))) throw new Error('Invalid GitHub release response');
  return { isDraft: record.isDraft, targetCommitish: record.targetCommitish, ...(typeof record.body === 'string' ? { body: record.body } : {}), ...(Array.isArray(record.assets) ? { assets: record.assets as Asset[] } : {}) };
};
export const assertPublication = async (directory: string, version: string, expectedSourceSHA: string): Promise<void> => {
  if (!isVersion(version) || !/^[a-f0-9]{40}$/.test(expectedSourceSHA)) throw new Error('Invalid release version or source SHA');
  const zip = resolve(directory, 'git-graph.zip'); const provenance = JSON.parse(await readFile(resolve(directory, 'provenance.json'), 'utf8')) as { sourceSHA?: unknown; pluginVersion?: unknown; archive?: { name?: unknown; sha256?: unknown } };
  const expectedChecksum = (await readFile(resolve(directory, 'git-graph.zip.sha256'), 'utf8')).trim().split(/\s+/)[0]; const checksum = await sha256(zip);
  if (expectedChecksum !== checksum || provenance.sourceSHA !== expectedSourceSHA || provenance.pluginVersion !== version || provenance.archive?.name !== 'git-graph.zip' || provenance.archive.sha256 !== checksum) throw new Error('Provenance, source SHA, or archive checksum does not match');
  const temp = await mkdtemp(resolve(tmpdir(), 'git-graph-release-'));
  try { if (Bun.spawnSync(['unzip', '-qq', zip, '-d', temp]).exitCode !== 0) throw new Error('Cannot read release ZIP'); const root = JSON.parse(await readFile(resolve(temp, 'package.json'), 'utf8')); const dist = JSON.parse(await readFile(resolve(temp, 'dist/manifests/package.json'), 'utf8')); if (!parseManifestJson(JSON.stringify(root)).ok || !parseManifestJson(JSON.stringify(dist)).ok || root.version !== version || dist.version !== version) throw new Error('ZIP root and dist manifests must match the release version'); } finally { await rm(temp, { recursive: true, force: true }); }
};
const missingRelease = (result: ReturnType<Run>) => result.exitCode !== 0 && /(?:not found|404)/i.test(`${result.stdout}\n${result.stderr}`);
const assetsComplete = (assets: Asset[] | undefined) => ['git-graph.zip', 'git-graph.zip.sha256', 'provenance.json'].every((name) => assets?.some((asset) => asset.name === name && asset.size > 0));
export const publish = (run: Run, directory: string, version: string, sourceSHA: string, repo: string, previousTag?: string): void => {
  const fetch = run('git', ['fetch', 'origin', 'main', '--tags']); if (fetch.exitCode) throw new Error(fetch.stderr || 'Unable to refresh main');
  const main = run('git', ['rev-parse', 'origin/main']); if (main.exitCode) throw new Error(main.stderr || 'Unable to resolve main'); if (main.stdout.trim() !== sourceSHA) return;
  const tag = `${tagPrefix}${version}`; const viewArgs = ['release', 'view', tag, '--repo', repo, '--json', 'isDraft,targetCommitish,body,assets'];
  let viewed = run('gh', viewArgs); let release: ReleaseView | undefined;
  if (!viewed.exitCode) release = releaseView(viewed.stdout); else if (!missingRelease(viewed)) throw new Error(viewed.stderr || 'Unable to query release');
  if (release?.targetCommitish && release.targetCommitish !== sourceSHA) {
    if (!release.isDraft || !release.body?.includes(marker)) throw new Error('Existing release tag targets a different source SHA');
    const deleted = run('gh', ['release', 'delete', tag, '--repo', repo, '--yes']); if (deleted.exitCode) throw new Error(deleted.stderr || 'Unable to supersede automated draft'); release = undefined;
  }
  if (release && !release.isDraft) { if (!assetsComplete(release.assets)) throw new Error('Published release is missing required assets'); return; }
  if (!release) {
    const create = ['release', 'create', tag, '--repo', repo, '--target', sourceSHA, '--draft', '--generate-notes', '--notes', marker, '--title', `Git Graph v${version}`]; if (previousTag) create.push('--notes-start-tag', previousTag);
    const created = run('gh', create); viewed = run('gh', viewArgs); if (viewed.exitCode) throw new Error(created.stderr || viewed.stderr || 'Unable to create or find release'); release = releaseView(viewed.stdout);
  }
  if (release.targetCommitish && release.targetCommitish !== sourceSHA) throw new Error('Existing release tag targets a different source SHA');
  // Another publisher may have completed the release between create and view.
  if (!release.isDraft) { if (!assetsComplete(release.assets)) throw new Error('Published release is missing required assets'); return; }
  for (const asset of ['git-graph.zip', 'git-graph.zip.sha256', 'provenance.json']) { const upload = run('gh', ['release', 'upload', tag, resolve(directory, asset), '--repo', repo, '--clobber']); if (upload.exitCode) throw new Error(upload.stderr || `Unable to upload ${asset}`); }
  const edit = run('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']); if (edit.exitCode) throw new Error(edit.stderr || 'Unable to publish release');
};
if (import.meta.main) { const directory = process.env.ARTIFACT_DIRECTORY ?? 'artifacts/git-graph'; const version = process.env.RELEASE_VERSION ?? ''; const sourceSHA = process.env.SOURCE_SHA ?? ''; const repo = process.env.GH_REPO ?? ''; if (!repo) throw new Error('GH_REPO is required'); await assertPublication(directory, version, sourceSHA); const run: Run = (command, args) => { const r = Bun.spawnSync([command, ...args], { stdout: 'pipe', stderr: 'pipe' }); return { exitCode: r.exitCode, stdout: new TextDecoder().decode(r.stdout), stderr: new TextDecoder().decode(r.stderr) }; }; publish(run, directory, version, sourceSHA, repo, process.env.PREVIOUS_TAG || undefined); }
