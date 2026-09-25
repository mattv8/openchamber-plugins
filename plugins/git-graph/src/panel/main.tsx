import { createRoot } from 'react-dom/client';
import { applyHostReady } from '@openchamber/sdk/ui';
import { GitGraphApp } from './app.js';
import { connectGitGraphHost } from './host-client.js';
import './styles/git-graph.css';

const root = document.querySelector<HTMLElement>('#git-graph-root');
if (!root) throw new Error('Git Graph panel root is missing');
const host = connectGitGraphHost();
host.onReady((context) => applyHostReady(context, document.documentElement));
createRoot(root).render(<GitGraphApp host={host} />);
