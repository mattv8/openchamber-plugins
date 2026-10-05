import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompactGraph } from '../../src/panel/components/CompactGraph.js';
import { StatusSection } from '../../src/panel/components/StatusSection.js';
import { CommitHover } from '../../src/panel/components/CommitHover.js';
import { Workspace } from '../../src/panel/components/Workspace.js';
import type { GitGraphServiceClient } from '../../src/panel/domain/index.js';
import type { HostClient } from '@openchamber/sdk';

const t = (key: string) => ({ 'compact.loading': 'Loading graph…', 'compact.empty': 'No commits found.', 'compact.error': 'Unable to load graph.', 'hover.copyHash': 'Copy commit hash', 'hover.openGitGraph': 'Open in Git Graph' }[key] ?? key);
const commit = { id: 'a'.repeat(40), parentIds: [], subject: 'subject', message: '', author: 'author', authorEmail: '', timestamp: '2026-01-01T00:00:00.000Z', statistics: { files: 0, insertions: 0, deletions: 0 }, references: [] };
const service: GitGraphServiceClient = { request: async () => { throw new Error('effects do not run during server rendering'); } };

test('renders compact loading, empty, and error states', () => {
  expect(renderToStaticMarkup(createElement(CompactGraph, { commits: [], head: null, state: 'loading', t }))).toContain('aria-busy="true"');
  expect(renderToStaticMarkup(createElement(CompactGraph, { commits: [], head: null, state: 'empty', t }))).toContain('No commits found.');
  expect(renderToStaticMarkup(createElement(CompactGraph, { commits: [], head: null, state: 'error', t }))).toContain('role="alert"');
});

test('renders a readable status section while the host context is unavailable', () => {
  const unavailable = async (): Promise<never> => { throw new Error('unused server-render host method'); };
  const unsubscribe = () => () => undefined;
  const host: HostClient = { listProjects: unavailable, listWorktrees: unavailable, listSessions: unavailable, onProjects: async () => unsubscribe(), onWorktrees: async () => unsubscribe(), onSessions: async () => unsubscribe(), openSession: unavailable, storage: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] }, onReady: unsubscribe, onDirectory: unsubscribe, onSession: unsubscribe, onSessionLifecycle: unsubscribe, onConnection: unsubscribe, onSettings: unsubscribe, onItem: unsubscribe, onStatusControl: unsubscribe, onPopoverClosed: unsubscribe, setStatusControls: unavailable, openPopover: unavailable, closePopover: unavailable, setPopoverAnchorActive: unavailable, onResolve: unsubscribe, onAction: unsubscribe, toast: unavailable, openUrl: unavailable, openCommit: unavailable, openSurface: unavailable, writeClipboard: unavailable, compose: unavailable, attach: unavailable, startSession: unavailable, prompt: unavailable, sessionLink: unavailable, close: unavailable, oauthStart: unavailable, oauthDisconnect: unavailable, request: unavailable, serviceRequest: unavailable, serviceStatus: unavailable, readFile: unavailable, writeFile: unavailable, listDir: unavailable, stat: unavailable, generate: unavailable, setBadge: unavailable, setHeight: unavailable, onFileOpen: unsubscribe, onFileSnapshot: unsubscribe, onFileSaved: unsubscribe, reportFileChange: () => undefined, requestFileSave: () => undefined, reportFileUnsupported: () => undefined, dispose: () => undefined };
  const html = renderToStaticMarkup(createElement(StatusSection, { directory: null, service, host }));
  expect(html).toContain('data-git-graph-status="true"');
  expect(html).toContain('aria-label="History mode"');
  expect(html).toContain('Open a workspace to see commits.');
});

test('labels hover actions with their Git Graph destination', () => {
  const html = renderToStaticMarkup(createElement(CommitHover, { commit, t, onOpen: () => undefined }));
  expect(html).toContain('aria-label="Open in Git Graph"');
  expect(html).toContain('Open in Git Graph');
});

test('owns the desktop sidebar and diff pane in one split layout', () => {
  const html = renderToStaticMarkup(createElement(Workspace, { directory: '/fixture', service }));
  expect(html).toContain('data-git-graph-layout="split"');
  expect(html).toContain('data-git-graph-sidebar="true"');
  expect(html).toContain('data-git-graph-tabs="true"');
});
