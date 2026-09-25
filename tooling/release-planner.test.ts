import { describe, expect, test } from 'bun:test';
import { nextPatch, planRelease, relevantPath } from './release-planner.js';
const git = (tags: string[], commits: Record<string, string>, changed: string[]) => (args: string[]) => {
  if (args[0] === 'tag') return `${tags.join('\n')}\n`;
  if (args[0] === 'rev-list') return `${commits[args.at(-1)!] ?? ''}\n`;
  if (args[0] === 'merge-base') return `${args[2] === 'old' ? 'older' : (commits[args[1]!] ?? '')}\n`;
  if (args[0] === 'diff') return `${changed.join('\n')}\n`;
  throw new Error(args.join(' '));
};
describe('release planning', () => {
  test('uses the source floor for bootstrap and manually chosen future minor', () => {
    expect(planRelease('a', git([], {}, []), '0.1.0')).toMatchObject({ shouldRelease: true, version: '0.1.0' });
    expect(planRelease('b', git(['git-graph/v0.1.9'], {}, ['tooling/build.ts']), '0.2.0')).toMatchObject({ version: '0.2.0' });
  });
  test('increments only for relevant changes and skips docs', () => {
    expect(planRelease('b', git(['git-graph/v0.1.0'], {}, ['README.md']), '0.1.0').shouldRelease).toBe(false);
    expect(planRelease('b', git(['git-graph/v0.1.0'], {}, ['plugins/git-graph/src/a.ts']), '0.1.0').version).toBe('0.1.1');
    expect(relevantPath('.agents/git-graph.md')).toBe(false);
    expect(relevantPath('plugins/git-graph/README.md')).toBe(false);
    expect(relevantPath('testing/README.md')).toBe(false);
  });
  test('retries an existing source tag at the same version rather than incrementing', () => {
    expect(planRelease('same', git(['git-graph/v0.1.0'], { 'git-graph/v0.1.0': 'same' }, ['tooling/build.ts']), '0.1.0')).toMatchObject({ shouldRelease: true, version: '0.1.0' });
  });
  test('does not let a higher tag release an older source', () => {
    expect(planRelease('old', git(['git-graph/v0.1.0', 'git-graph/v0.2.0'], { 'git-graph/v0.2.0': 'new' }, ['tooling/build.ts']), '0.1.0').shouldRelease).toBe(false);
  });
  test('skips a stale source before the latest release', () => {
    expect(planRelease('old', git(['git-graph/v0.1.1'], { 'git-graph/v0.1.1': 'new' }, ['tooling/build.ts']), '0.1.0').shouldRelease).toBe(false);
  });
  test('rejects invalid semantic versions', () => expect(() => nextPatch('0.1')).toThrow('Invalid semantic version'));
});
