import { startGitService } from './index.js';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!Number.isInteger(port) || port <= 0 || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exitCode = 1;
} else {
  const running = await startGitService({ port, token });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await running.close(); process.exitCode = 0; }
    catch { process.exitCode = 1; }
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
}
