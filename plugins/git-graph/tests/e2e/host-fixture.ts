import type { HostClient } from '@openchamber/sdk';

const unavailable = async (): Promise<never> => { throw new Error('Unexpected fixture host method'); };
const unsubscribe = () => () => undefined;

/** Typed host boundary: tests supply the methods their production surface uses. */
export function createFixtureHost(overrides: Partial<HostClient>): HostClient {
  return {
    listProjects: unavailable, listWorktrees: unavailable, listSessions: unavailable,
    onProjects: unavailable, onWorktrees: unavailable, onSessions: unavailable, openSession: unavailable,
    storage: { get: unavailable, set: unavailable, delete: unavailable, keys: unavailable },
    onReady: unsubscribe, onDirectory: unsubscribe, onSession: unsubscribe, onSessionLifecycle: unsubscribe,
    onConnection: unsubscribe, onSettings: unsubscribe, onItem: unsubscribe, onPopoverClosed: unsubscribe,
    onStatusControl: unsubscribe, setStatusControls: unavailable, setPopoverAnchorActive: unavailable,
    openPopover: unavailable, closePopover: unavailable, onResolve: unsubscribe, onAction: unsubscribe,
    toast: unavailable, openUrl: unavailable, openSurface: unavailable, openCommit: unavailable,
    writeClipboard: unavailable, setHeight: unavailable, compose: unavailable, attach: unavailable,
    startSession: unavailable, prompt: unavailable, sessionLink: unavailable, close: unavailable,
    oauthStart: unavailable, oauthDisconnect: unavailable, request: unavailable, serviceRequest: unavailable,
    serviceStatus: unavailable, readFile: unavailable, writeFile: unavailable, listDir: unavailable,
    stat: unavailable, generate: unavailable, setBadge: unavailable, onFileOpen: unsubscribe,
    onFileSnapshot: unsubscribe, onFileSaved: unsubscribe, reportFileChange: () => undefined,
    requestFileSave: () => undefined, reportFileUnsupported: () => undefined, dispose: () => undefined,
    ...overrides,
  };
}
