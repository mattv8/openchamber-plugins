import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { GUEST_SCROLLBAR_CSS } from '@openchamber/sdk';
import { createFixtureHost } from './host-fixture.js';
import '../../src/panel/styles/git-graph.css';
import '../../src/panel/styles/menu.css';
import '../../src/panel/styles/popover.css';
import { CommitHoverProvider, useCommitHoverAnchor } from '../../src/panel/commit-hover/index.js';
import { CommitHoverCard } from '../../src/panel/commit-hover/index.js';
import { CompactHistoryRow } from '../../src/panel/original/CompactHistoryRow.js';
import type { GraphCommit, GitGraphServiceClient } from '../../src/panel/domain/index.js';
import type { GitHistoryGraphRef, GitHistoryItemViewModel } from '../../src/panel/original/gitGraph.js';
import { GitGraphRequestSchema, type GitGraphRequest } from '../../src/shared/protocol.js';
import { defaultT } from '../../src/panel/i18n/index.js';
import { markMenuClosed, markMenuOpen } from '../../src/panel/popover/menu-state.js';

const sha = 'a'.repeat(40);
const requests: GitGraphRequest[] = [];
const popovers: unknown[] = [];
let setAuthor: ((author: string) => void) | null = null;
let setRepository: ((repository: 'repo-a' | 'repo-b') => void) | null = null;
let setEnabled: ((enabled: boolean) => void) | null = null;
let rerender: (() => void) | null = null;
let setAvatarDirectory: ((directory: '/avatar-a' | '/avatar-b') => void) | null = null;
const delayedAuthors: Array<{ directory: string; resolve: (login: string) => void }> = [];

declare global {
  interface Window {
    commitHover: {
      requests(): GitGraphRequest[];
      popovers(): unknown[];
      setAuthor(author: string): void;
      setRepository(repository: 'repo-a' | 'repo-b'): void;
      setEnabled(enabled: boolean): void;
      rerender(): void;
      menuOpen(): void;
      menuClosed(): void;
      setAvatarDirectory(directory: '/avatar-a' | '/avatar-b'): void;
      resolveAvatarAuthor(directory: '/avatar-a' | '/avatar-b', login: string): void;
    };
  }
}

const host = createFixtureHost({
  openPopover: async (popover: unknown) => { popovers.push(popover); },
  closePopover: async () => undefined,
  setPopoverAnchorActive: async () => undefined,
  onPopoverClosed: () => () => undefined,
  setHeight: async () => undefined,
});

const service: GitGraphServiceClient = {
  request(request) {
    GitGraphRequestSchema.parse(request);
    requests.push(request);
    if (request.operation === 'read' && request.read === 'remotes') {
      return Promise.resolve({ version: 1, requestId: request.requestId, operation: 'read', ok: true, data: { read: 'remotes', remotes: [] } });
    }
    if (request.operation === 'read' && request.read === 'commit-summary') {
      const message = request.repositoryId === 'repo-a' ? 'summary from repository A' : 'summary from repository B';
      return Promise.resolve({ version: 1, requestId: request.requestId, operation: 'read', ok: true, data: { read: 'commit-summary', commit: { id: request.commit, parentIds: [], subject: 'Subject', message, author: 'Author', authorEmail: 'author@example.test', timestamp: '2026-01-01T00:00:00.000Z', statistics: { files: 1, insertions: 2, deletions: 0 } }, messageTruncated: false } });
    }
    if (request.operation === 'repo/open') return Promise.resolve({ version: 1, requestId: request.requestId, operation: 'repo/open', ok: true, data: { id: `repo-${request.directory.slice(1)}`, root: request.directory, commonGitDir: `${request.directory}/.git`, head: sha, snapshot: `${request.directory}-snapshot` } });
    if (request.operation === 'read' && request.read === 'commit-author') {
      const scenario = new URL(window.location.href).searchParams.get('scenario');
      if (scenario === 'avatar-error') return Promise.reject(new Error('author unavailable'));
      if (scenario === 'avatar-null') return Promise.resolve({ version: 1, requestId: request.requestId, operation: 'read', ok: true, data: { read: 'commit-author', author: null } });
      if (scenario === 'avatar-unsafe') return Promise.resolve({ version: 1, requestId: request.requestId, operation: 'read', ok: true, data: { read: 'commit-author', author: { login: 'unsafe', avatarUrl: 'https://avatars.githubusercontent.com.evil.test/u/1' } } });
      if (scenario === 'avatar-stale') return new Promise((resolve) => { delayedAuthors.push({ directory: request.repositoryId, resolve: (login) => resolve({ version: 1, requestId: request.requestId, operation: 'read', ok: true, data: { read: 'commit-author', author: { login, avatarUrl: `https://avatars.githubusercontent.com/u/${login === 'broken' ? '404' : '1'}` } } }) }); });
      return Promise.resolve({ version: 1, requestId: request.requestId, operation: 'read', ok: true, data: { read: 'commit-author', author: { login: scenario === 'avatar-failure' ? 'broken' : 'octocat', avatarUrl: `https://avatars.githubusercontent.com/u/${scenario === 'avatar-failure' ? '404' : '1'}` } } });
    }
    throw new Error('Unexpected request');
  },
};

function HoverRow({ author }: { author: string }) {
  const [expanded, setExpanded] = useState(false);
  const references: GitHistoryGraphRef[] = [{ id: 'refs/tags/plain', name: 'plain-tag', revision: sha, kind: 'tag', category: 'tags' }, { id: 'refs/tags/colored', name: 'colored-tag', revision: sha, kind: 'tag', category: 'tags', color: '#ff00ff' }];
  const commit: GraphCommit = { id: sha, parentIds: [], subject: 'Subject', message: '', author, authorEmail: 'author@example.test', timestamp: '2026-01-01T00:00:00.000Z', statistics: { files: 1, insertions: 2, deletions: 0 }, references };
  const hoverAnchor = useCommitHoverAnchor(commit, references);
  const viewModel: GitHistoryItemViewModel = { historyItem: commit, inputSwimlanes: [], outputSwimlanes: [], nodeColor: '#fff', kind: 'HEAD' };
  return <><CompactHistoryRow viewModel={viewModel} expanded={expanded} onToggle={() => setExpanded((value) => !value)} hoverAnchor={hoverAnchor} t={defaultT} />{expanded && <div id={`git-status-files-${sha}`} role="region" aria-label="Changed files">fixture.txt</div>}</>;
}

function Fixture() {
  const [author, updateAuthor] = useState('Author');
  const [repository, updateRepository] = useState<'repo-a' | 'repo-b'>('repo-a');
  const [enabled, updateEnabled] = useState(true);
  const [, updateRender] = useState(0);
  setAuthor = updateAuthor;
  setRepository = updateRepository;
  setEnabled = updateEnabled;
  rerender = () => updateRender((value) => value + 1);
  return <CommitHoverProvider host={host} service={service} repository={{ directory: '/fixture', repositoryId: repository, snapshot: `${repository}-snapshot` }} enabled={enabled}><HoverRow author={author} /></CommitHoverProvider>;
}

const avatarPayload = { kind: 'hover' as const, commit: sha, subject: 'Subject', author: 'Author', authorEmail: 'author@example.test', timestamp: '2026-01-01T00:00:00.000Z', refs: [], summary: { message: 'preloaded summary', messageTruncated: false, statistics: { files: 1, insertions: 2, deletions: 0 } }, remoteUrl: null };
function AvatarFixture() {
  const [directory, updateDirectory] = useState<'/avatar-a' | '/avatar-b'>('/avatar-a');
  setAvatarDirectory = updateDirectory;
  return <CommitHoverCard host={host} service={service} directory={directory} payload={avatarPayload} />;
}

window.commitHover = {
  requests: () => [...requests], popovers: () => [...popovers], setAuthor: (author) => setAuthor?.(author), setRepository: (repository) => setRepository?.(repository), setEnabled: (enabled) => setEnabled?.(enabled), rerender: () => rerender?.(), menuOpen: () => markMenuOpen('menu-fixture'), menuClosed: () => markMenuClosed('menu-fixture'), setAvatarDirectory: (directory) => setAvatarDirectory?.(directory), resolveAvatarAuthor: (directory, login) => { const pending = delayedAuthors.findIndex((entry) => entry.directory === `repo-${directory.slice(1)}`); if (pending < 0) throw new Error(`No author request for ${directory}`); delayedAuthors.splice(pending, 1)[0]!.resolve(login); },
};

const avatarScenario = new URL(window.location.href).searchParams.has('scenario');
if (avatarScenario) {
  // Mirror a host-served popover document: surface marker plus the host's injected scrollbar rules.
  document.body.dataset.surface = 'popover';
  const hostStyle = document.createElement('style');
  hostStyle.textContent = GUEST_SCROLLBAR_CSS;
  document.head.prepend(hostStyle);
}
createRoot(document.querySelector('#root')!).render(avatarScenario ? <AvatarFixture /> : <Fixture />);
