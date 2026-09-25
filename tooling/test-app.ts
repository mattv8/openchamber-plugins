import { runIsolatedHost } from '../testing/scripts/harness.js';

const target = process.argv.at(2);
if (target !== 'stock' && target !== 'electron') throw new Error('Usage: bun run test:app:<stock|electron>');
await runIsolatedHost(target);
