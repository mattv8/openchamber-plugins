import type { HostClient, HostReadyContext } from '@openchamber/sdk';
import { CommitHoverCard } from '../commit-hover/index.js';
import { CommitMenuView } from '../commit-menu/index.js';
import { createServiceClient } from '../host-client.js';
import { defaultT } from '../i18n/index.js';
import { CommitPopoverPayloadSchema } from './payload.js';

export function PopoverApp({ host, ready }: { host: HostClient; ready: HostReadyContext }) {
  const parsed = CommitPopoverPayloadSchema.safeParse(ready.popover?.data);
  if (!parsed.success || !ready.directory) return <main id="git-graph-popover-error" className="git-popover-error">{defaultT('hover.unavailable')}</main>;
  const service = createServiceClient(host);
  return parsed.data.kind === 'hover'
    ? <CommitHoverCard host={host} service={service} directory={ready.directory} payload={parsed.data} />
    : <CommitMenuView host={host} service={service} directory={ready.directory} payload={parsed.data} />;
}
