import { spawn, type ChildProcess } from 'node:child_process';
import { ServiceError, type GitRunner } from './contracts.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_BYTES = 240_000;
export type ManagedGitRunner = GitRunner & { close: () => void };

function gitEnvironment(): NodeJS.ProcessEnv {
  const inherited = process.env;
  return { PATH: inherited.PATH, HOME: inherited.HOME, USERPROFILE: inherited.USERPROFILE, SYSTEMROOT: inherited.SYSTEMROOT, TEMP: inherited.TEMP, TMP: inherited.TMP, LANG: inherited.LANG, LC_ALL: inherited.LC_ALL, SSH_AUTH_SOCK: inherited.SSH_AUTH_SOCK, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' };
}

function stop(child: ChildProcess): void {
  const kill = (signal: NodeJS.Signals) => { if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, signal); return; } catch { /* fall through */ } } child.kill(signal); };
  kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 1_000).unref();
}

/** Executes Git argv with bounded streams and tracks every child until it exits. */
export function createGitRunner(defaultTimeoutMs = DEFAULT_TIMEOUT_MS): ManagedGitRunner {
  const children = new Set<ChildProcess>();
  let closed = false;
  const runner: ManagedGitRunner = (cwd, args, options = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(new ServiceError('internal', 'Service is closed')); return; }
    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const subcommand = /^[a-z0-9-]+$/i.test(args[0] ?? '') ? args[0] : 'command';
    const child = spawn('git', [...args], { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: gitEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let bytes = 0; let settled = false; let termination: ServiceError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => terminate(new ServiceError('timeout-unknown', 'Git operation timed out; its outcome is unknown', true)), options.timeoutMs ?? defaultTimeoutMs);
    const finish = (error?: ServiceError, exitCode = 1) => { if (settled) return; settled = true; children.delete(child); clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); if (error) reject(error); else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode }); };
    const terminate = (error: ServiceError) => { if (termination) return; termination = error; if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } } else child.kill('SIGTERM'); killTimer = setTimeout(() => { if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } else child.kill('SIGKILL'); }, 1_000); };
    const receive = (into: Buffer[]) => (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > maxBytes) terminate(new ServiceError('unsupported', `Git ${subcommand} output exceeded ${maxBytes}-byte limit after observing ${bytes} bytes`)); else into.push(chunk); };
    child.stdout.on('data', receive(stdout)); child.stderr.on('data', receive(stderr));
    child.once('error', () => finish(new ServiceError('internal', 'Unable to start Git')));
    child.once('close', (code) => finish(termination, code ?? 1));
    child.stdin.once('error', () => undefined); child.stdin.end(options.input);
  });
  runner.close = () => { closed = true; for (const child of children) stop(child); };
  return runner;
}
