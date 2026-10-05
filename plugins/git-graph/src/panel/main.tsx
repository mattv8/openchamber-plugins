import { createRoot } from 'react-dom/client';
import { applyHostReady } from '@openchamber/sdk/ui';
import { GitGraphApp } from './app.js';
import { connectGitGraphHost } from './host-client.js';
import { PopoverApp } from './popover/PopoverApp.js';
import './styles/git-graph.css';
import './styles/menu.css';
import './styles/popover.css';

const root = document.querySelector<HTMLElement>('#git-graph-root');
if (!root) throw new Error('Git Graph panel root is missing');
const host = connectGitGraphHost();
const reactRoot = createRoot(root);
let started = false;
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (started) return;
  started = true;
  reactRoot.render(context.surface === 'popover' ? <PopoverApp host={host} ready={context} /> : <GitGraphApp host={host} />);
});
