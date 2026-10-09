import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { assertPublication, type Run } from './publisher.js';
import { isVersion, tagPrefix } from './release-planner.js';
import { validateReleaseTree } from './release.js';

const branch = 'git-graph';
const marker = '<!-- openchamber-git-graph-distribution -->';
const packageName = '@openchamber-plugin/git-graph';
const requiredAssets = ['git-graph.zip', 'git-graph.zip.sha256', 'provenance.json'];
const credentialArgs = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];

type Asset = { name: string; size: number };
type ReleaseView = { isDraft: boolean; targetCommitish: string; assets: Asset[] };
type ExistingPackage = { name?: unknown; version?: unknown };

export type GitDistributionOptions = {
  version: string;
  sourceSHA: string;
  repo: string;
  runGh?: Run;
  remote?: string;
};

const output = (value: Uint8Array | undefined): string => new TextDecoder().decode(value);

const runGit = (directory: string, args: string[], remote = false): { exitCode: number; stdout: string; stderr: string } => {
  const result = Bun.spawnSync(['git', ...(remote ? credentialArgs : []), ...args], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  return { exitCode: result.exitCode, stdout: output(result.stdout), stderr: output(result.stderr) };
};

const requireGit = (directory: string, args: string[], remote = false): string => {
  const result = runGit(directory, args, remote);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
};

const defaultGhRun: Run = (command, args) => {
  const result = Bun.spawnSync([command, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { exitCode: result.exitCode, stdout: output(result.stdout), stderr: output(result.stderr) };
};

const compareVersions = (left: string, right: string): number => {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  return leftParts.reduce((comparison, part, index) => comparison || part - rightParts[index]!, 0);
};

const releaseView = (text: string): ReleaseView => {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object') throw new Error('Invalid GitHub release response');
  const record = value as Record<string, unknown>;
  if (typeof record.isDraft !== 'boolean' || typeof record.targetCommitish !== 'string' || !Array.isArray(record.assets)) throw new Error('Invalid GitHub release response');
  const assets = record.assets.map((asset): Asset => {
    if (!asset || typeof asset !== 'object') throw new Error('Invalid GitHub release response');
    const item = asset as Record<string, unknown>;
    if (typeof item.name !== 'string' || typeof item.size !== 'number') throw new Error('Invalid GitHub release response');
    return { name: item.name, size: item.size };
  });
  return { isDraft: record.isDraft, targetCommitish: record.targetCommitish, assets };
};

export const assertPublishedRelease = (run: Run, version: string, sourceSHA: string, repo: string): void => {
  const tag = `${tagPrefix}${version}`;
  const result = run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft,targetCommitish,assets']);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'Unable to query release');
  const release = releaseView(result.stdout);
  if (release.isDraft || release.targetCommitish !== sourceSHA || !requiredAssets.every((name) => release.assets.some((asset) => asset.name === name && asset.size > 0))) {
    throw new Error('Release is not published with the expected source and assets');
  }
};

const validateZipEntries = (zip: string): void => {
  const result = Bun.spawnSync(['unzip', '-Z1', zip], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error('Cannot list release ZIP');
  for (const entry of output(result.stdout).split('\n').filter(Boolean)) {
    const parts = entry.replace(/\/$/, '').split('/');
    if (isAbsolute(entry) || parts.includes('..') || parts.includes('.git')) throw new Error(`Unsafe ZIP entry: ${entry}`);
  }
};

const assertRegularTree = async (directory: string): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const status = await lstat(path);
    if (status.isSymbolicLink() || (!status.isDirectory() && !status.isFile())) throw new Error(`Release contains a non-regular file: ${entry.name}`);
    if (status.isDirectory()) await assertRegularTree(path);
  }
};

const extractRelease = async (zip: string, directory: string): Promise<void> => {
  const result = Bun.spawnSync(['unzip', '-qq', zip, '-d', directory], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error('Cannot extract release ZIP');
  await assertRegularTree(directory);
  await validateReleaseTree(directory);
};

const downloadPublishedAssets = async (run: Run, version: string, repo: string, directory: string): Promise<void> => {
  const result = run('gh', ['release', 'download', `${tagPrefix}${version}`, '--repo', repo, '--dir', directory, '--pattern', 'git-graph.zip', '--pattern', 'git-graph.zip.sha256', '--pattern', 'provenance.json']);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'Unable to download published release assets');
};

const archiveDigest = async (path: string): Promise<string> => createHash('sha256').update(Buffer.from(await Bun.file(path).arrayBuffer())).digest('hex');

const trailer = (message: string, name: string, length: number): string | undefined => message.match(new RegExp(`^${name}: ([a-f0-9]{${length}})$`, 'm'))?.[1];

const validateExistingBranch = (directory: string, version: string, sourceSHA: string, candidateTree: string): boolean => {
  const commit = requireGit(directory, ['show', '-s', '--format=%B', `origin/${branch}`]);
  if (!commit.includes(marker)) throw new Error('Existing distribution branch is not managed');
  const existingSource = trailer(commit, 'Source-SHA', 40);
  const existingArchive = trailer(commit, 'Archive-SHA256', 64);
  if (!existingSource || !existingArchive) throw new Error('Existing distribution branch lacks provenance');
  const packageText = requireGit(directory, ['show', `origin/${branch}:package.json`]);
  const pkg = JSON.parse(packageText) as ExistingPackage;
  if (pkg.name !== packageName || typeof pkg.version !== 'string' || !isVersion(pkg.version)) throw new Error('Existing distribution branch has an invalid package');
  const versionComparison = compareVersions(pkg.version, version);
  if (versionComparison > 0) throw new Error('Refusing to replace a newer distribution version');
  const existingTree = requireGit(directory, ['rev-parse', `origin/${branch}^{tree}`]);
  if (versionComparison === 0) {
    if (existingTree === candidateTree && existingSource === sourceSHA) return true;
    throw new Error('Existing distribution version has different content or source');
  }
  return false;
};

const copyReleaseTree = async (source: string, destination: string): Promise<void> => {
  for (const entry of await readdir(source)) await cp(resolve(source, entry), resolve(destination, entry), { recursive: true });
};

const remoteUrl = (repo: string, override: string | undefined): string => {
  if (override) return override;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('GH_REPO must be an owner/name repository');
  return `https://github.com/${repo}.git`;
};

export const publishGitDistribution = async (options: GitDistributionOptions): Promise<'published' | 'noop'> => {
  if (!isVersion(options.version) || !/^[a-f0-9]{40}$/.test(options.sourceSHA)) throw new Error('Invalid release version or source SHA');
  const runGh = options.runGh ?? defaultGhRun;
  assertPublishedRelease(runGh, options.version, options.sourceSHA, options.repo);
  const root = await mkdtemp(resolve(tmpdir(), 'git-graph-distribution-'));
  try {
    const published = resolve(root, 'published');
    const extracted = resolve(root, 'release');
    const repository = resolve(root, 'repository');
    await mkdir(published);
    await downloadPublishedAssets(runGh, options.version, options.repo, published);
    const zip = resolve(published, 'git-graph.zip');
    validateZipEntries(zip);
    await assertPublication(published, options.version, options.sourceSHA);
    await extractRelease(zip, extracted);
    requireGit(root, ['init', repository]);
    requireGit(repository, ['remote', 'add', 'origin', remoteUrl(options.repo, options.remote)]);
    requireGit(repository, ['fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main'], true);
    if (runGit(repository, ['merge-base', '--is-ancestor', options.sourceSHA, 'origin/main']).exitCode !== 0) throw new Error('Release source is not an ancestor of remote main');
    const listed = requireGit(repository, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], true);
    const branchExists = listed !== '';
    if (branchExists) requireGit(repository, ['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`], true);
    await copyReleaseTree(extracted, repository);
    requireGit(repository, ['-c', 'core.autocrlf=false', '-c', 'core.attributesFile=/dev/null', 'add', '--all', '--force']);
    const candidateTree = requireGit(repository, ['write-tree']);
    if (branchExists && validateExistingBranch(repository, options.version, options.sourceSHA, candidateTree)) return 'noop';
    const digest = await archiveDigest(zip);
    const parent = branchExists ? [`-p`, `origin/${branch}`] : [];
    const commit = requireGit(repository, ['-c', 'user.name=OpenChamber Release Bot', '-c', 'user.email=release-bot@openchamber.dev', 'commit-tree', candidateTree, ...parent, '-m', `Publish Git Graph v${options.version}`, '-m', `${marker}\n\nSource-SHA: ${options.sourceSHA}\nArchive-SHA256: ${digest}`]);
    requireGit(repository, ['update-ref', `refs/heads/${branch}`, commit]);
    requireGit(repository, ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], true);
    return 'published';
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const repo = process.env.GH_REPO ?? '';
  if (!repo) throw new Error('GH_REPO is required');
  await publishGitDistribution({ version: process.env.RELEASE_VERSION ?? '', sourceSHA: process.env.SOURCE_SHA ?? '', repo });
}
