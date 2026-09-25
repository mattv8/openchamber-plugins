import { useEffect, useMemo, useState } from 'react';
import type { HostClient, HostReadyContext } from '@openchamber/sdk';
import { StatusSection } from './components/index.js';
import { createServiceClient } from './host-client.js';
import { defaultT } from './i18n/index.js';

type AppProps = { host: HostClient };
export function GitGraphApp({ host }: AppProps) {
  const [context, setContext] = useState<HostReadyContext | null>(null);
  const [directory, setDirectory] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const service = useMemo(() => createServiceClient(host), [host]);

  useEffect(() => host.onReady((next) => {
    document.documentElement.lang = next.locale;
    document.documentElement.dataset.surface = next.surface;
    document.documentElement.dataset.theme = next.theme.mode;
    setContext((current) => current ?? next);
    setDirectory((current) => current ?? next.directory);
  }), [host]);
  useEffect(() => host.onDirectory((next) => setDirectory(next)), [host]);
  useEffect(() => {
    let previous: 'started' | 'completed' | 'failure' | null = null;
    return host.onSessionLifecycle((event) => {
      if (previous === 'started' && event.phase === 'completed') setRefreshToken((value) => value + 1);
      previous = event.phase;
    });
  }, [host]);

  if (!context) return <main id="git-graph-loading" className="git-workspace">{defaultT('workspace.loading')}</main>;
  return <StatusSection directory={directory} service={service} host={host} refreshToken={refreshToken} />;
}
