import { useEffect, useMemo, useState } from 'react';
import type { HostClient, HostReadyContext } from '@openchamber/sdk';
import { StatusSection } from './components/index.js';
import { createServiceClient } from './host-client.js';
import { defaultT } from './i18n/index.js';
import { MENU_POPOVER_PREFIX } from './commit-menu/index.js';
import { markMenuClosed } from './popover/menu-state.js';

type AppProps = { host: HostClient };
export function GitGraphApp({ host }: AppProps) {
  const [context, setContext] = useState<HostReadyContext | null>(null);
  const [directory, setDirectory] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const service = useMemo(() => createServiceClient(host), [host]);

  useEffect(() => host.onReady((next) => {
    document.documentElement.lang = next.locale;
    document.documentElement.dataset.surface = next.surface;
    document.documentElement.dataset.theme = next.theme.mode;
    setContext(next);
    setDirectory(next.directory);
  }), [host]);
  useEffect(() => host.onDirectory((next) => setDirectory(next)), [host]);
  useEffect(() => host.onPopoverClosed((event) => {
    if (!event.id.startsWith(MENU_POPOVER_PREFIX)) return;
    markMenuClosed(event.id);
    setRefreshToken((value) => value + 1);
    setRecoveryRevision((value) => value + 1);
  }), [host]);
  useEffect(() => {
    let previous: 'started' | 'completed' | 'failure' | null = null;
    return host.onSessionLifecycle((event) => {
      if (previous === 'started' && event.phase === 'completed') setRefreshToken((value) => value + 1);
      previous = event.phase;
    });
  }, [host]);

  if (!context) return <main id="git-graph-loading" className="git-workspace">{defaultT('workspace.loading')}</main>;
  return <StatusSection directory={directory} service={service} host={host} features={context.features} refreshToken={refreshToken} recoveryRevision={recoveryRevision} />;
}
