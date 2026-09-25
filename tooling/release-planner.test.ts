import { describe, expect, test } from 'bun:test';
import { nextPatch, planRelease, relevantPath } from './release-planner.js';
const git = (tags: string[], commits: Record<string, string>, changed: string[], history: Record<string, string[]> = {}, trees: Record<string, string> = {}) => (args: string[]) => {
  if (args[0] === 'tag') return `${tags.join('\n')}\n`;
  if (args[0] === 'rev-list') return `${commits[args.at(-1)!] ?? ''}\n`;
  if (args[0] === 'log') return `${(history[args.at(-1)!] ?? []).map((commit) => `${commit} ${trees[commit] ?? `${commit}-tree`}`).join('\n')}\n`;
  if (args[0] === 'show') return `${trees[args.at(-1)!] ?? `${args.at(-1)!}-tree`}\n`;
  if (args[0] === 'diff') return `${changed.join('\n')}\n`;
  throw new Error(args.join(' '));
};
describe('release planning', () => {
  test('uses the source floor for bootstrap and manually chosen future minor', () => {
    expect(planRelease('a', git([], {}, []), '0.1.0')).toMatchObject({ shouldRelease: true, version: '0.1.0' });
    expect(planRelease('b', git(['git-graph/v0.1.9'], { 'git-graph/v0.1.9': 'release' }, ['tooling/build.ts'], { b: ['b', 'release'] }), '0.2.0')).toMatchObject({ version: '0.2.0' });
  });
  test('increments only for relevant changes and skips docs', () => {
    const release = { 'git-graph/v0.1.0': 'release' };
    const history = { b: ['b', 'release'] };
    expect(planRelease('b', git(['git-graph/v0.1.0'], release, ['README.md'], history), '0.1.0').shouldRelease).toBe(false);
    expect(planRelease('b', git(['git-graph/v0.1.0'], release, ['plugins/git-graph/src/a.ts'], history), '0.1.0').version).toBe('0.1.1');
    expect(relevantPath('.agents/git-graph.md')).toBe(false);
    expect(relevantPath('plugins/git-graph/README.md')).toBe(false);
    expect(relevantPath('testing/README.md')).toBe(false);
  });
  test('retries an existing source tag at the same version rather than incrementing', () => {
    expect(planRelease('same', git(['git-graph/v0.1.0'], { 'git-graph/v0.1.0': 'same' }, ['tooling/build.ts'], { same: ['same'] }), '0.1.0')).toMatchObject({ shouldRelease: true, version: '0.1.0' });
  });
  test('does not let a higher tag release an older source', () => {
    expect(planRelease('old', git(['git-graph/v0.1.0', 'git-graph/v0.2.0'], { 'git-graph/v0.1.0': 'old', 'git-graph/v0.2.0': 'new' }, ['tooling/build.ts'], { old: ['old', 'new'] }), '0.1.0')).toMatchObject({ shouldRelease: false, reason: 'source tag is below the latest release' });
  });
  test('skips a stale source before the latest release', () => {
    expect(planRelease('old', git(['git-graph/v0.1.1'], { 'git-graph/v0.1.1': 'new' }, ['tooling/build.ts'], { old: ['old'] }), '0.1.0').shouldRelease).toBe(false);
  });
  test('accepts a disconnected source with an ancestor tree identical to the latest release', () => {
    const release = { 'git-graph/v0.1.0': 'published' };
    expect(planRelease('source', git(['git-graph/v0.1.0'], release, ['plugins/git-graph/src/a.ts'], { source: ['source', 'replayed'] }, { published: 'published-tree', replayed: 'published-tree' }), '0.1.0').version).toBe('0.1.1');
  });
  test('skips a disconnected source that is itself tree-identical to the latest release', () => {
    const release = { 'git-graph/v0.1.0': 'published' };
    expect(planRelease('replayed', git(['git-graph/v0.1.0'], release, [], { replayed: ['replayed'] }, { published: 'published-tree', replayed: 'published-tree' }), '0.1.0')).toMatchObject({ shouldRelease: false, reason: 'no release-relevant changes' });
  });
  test('rejects invalid semantic versions', () => expect(() => nextPatch('0.1')).toThrow('Invalid semantic version'));
});
