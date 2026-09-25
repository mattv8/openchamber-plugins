import { readFileSync } from 'node:fs';

export type Git = (args: string[]) => string;
export type ReleasePlan = { shouldRelease: boolean; version?: string; previousTag?: string; reason: string };
export const tagPrefix = 'git-graph/v';
export const isVersion = (value: string): boolean => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
const compare = (a: string, b: string): number => a.split('.').map(Number).reduce((result, part, index) => result || part - Number(b.split('.')[index]!), 0);
export const nextPatch = (version: string): string => {
  if (!isVersion(version)) throw new Error(`Invalid semantic version: ${version}`);
  const parts = version.split('.').map(Number);
  return `${parts[0]!}.${parts[1]!}.${parts[2]! + 1}`;
};
export const sourceVersion = (path = 'plugins/git-graph/package.json'): string => {
  const version = JSON.parse(readFileSync(path, 'utf8')).version;
  if (typeof version !== 'string' || !isVersion(version)) throw new Error(`Invalid source package version: ${version}`);
  return version;
};
export const relevantPath = (path: string): boolean => {
  if (/^(?:docs|\.agents|\.opencode)\//.test(path)) return false;
  if (/\.md$/i.test(path) && path !== 'plugins/git-graph/THIRD_PARTY_NOTICES.md') return false;
  return path.startsWith('plugins/git-graph/') || path.startsWith('tooling/') || path.startsWith('testing/') || path === 'package.json' || path === 'tsconfig.json' || path === 'bun.lock' || path === 'bun.lockb' || path.startsWith('.github/workflows/');
};
export const planRelease = (source: string, git: Git, floor = sourceVersion()): ReleasePlan => {
  if (!isVersion(floor)) throw new Error(`Invalid source package version: ${floor}`);
  const tags = git(['tag', '--list', `${tagPrefix}*`]).trim().split('\n').filter((tag) => isVersion(tag.slice(tagPrefix.length)))
    .sort((a, b) => compare(a.slice(tagPrefix.length), b.slice(tagPrefix.length)));
  const previousTag = tags.at(-1);
  if (!previousTag) return { shouldRelease: true, version: floor, reason: 'bootstrap release' };
  const previousCommit = git(['rev-list', '-n', '1', previousTag]).trim();
  const sourceTag = [...tags].reverse().find((tag) => git(['rev-list', '-n', '1', tag]).trim() === source);
  if (sourceTag && sourceTag !== previousTag) return { shouldRelease: false, previousTag, reason: 'source tag is below the latest release' };
  const sourceHistory = git(['log', '--format=%H %T', source]).trim().split('\n').filter(Boolean)
    .map((line) => line.split(/\s+/, 2));
  const previousTree = git(['show', '-s', '--format=%T', previousCommit]).trim();
  if (!sourceHistory.some(([commit, tree]) => commit === previousCommit || tree === previousTree)) {
    return { shouldRelease: false, previousTag, reason: 'source predates latest release' };
  }
  if (sourceTag) return { shouldRelease: true, version: sourceTag.slice(tagPrefix.length), previousTag, reason: 'retry existing source tag' };
  const changed = git(['diff', '--no-renames', '--name-only', `${previousTag}..${source}`]).trim().split('\n').filter(Boolean);
  if (!changed.some(relevantPath)) return { shouldRelease: false, previousTag, reason: 'no release-relevant changes' };
  const candidate = nextPatch(previousTag.slice(tagPrefix.length));
  return { shouldRelease: true, version: compare(floor, candidate) > 0 ? floor : candidate, previousTag, reason: 'release-relevant changes' };
};
if (import.meta.main) {
  const source = process.env.SOURCE_SHA;
  if (!source) throw new Error('SOURCE_SHA is required');
  const git: Git = (args) => {
    const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout);
  };
  const plan = planRelease(source, git);
  console.log(JSON.stringify(plan));
  if (process.env.GITHUB_OUTPUT) await Bun.write(process.env.GITHUB_OUTPUT, `should_release=${plan.shouldRelease}\nrelease_version=${plan.version ?? ''}\nprevious_tag=${plan.previousTag ?? ''}\nsource_sha=${source}\n`);
}
