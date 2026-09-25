import { randomUUID } from 'node:crypto';
import { ServiceError } from './contracts.js';

export type JobTerminal<T> = { state: 'completed'; data: T } | { state: 'failed' | 'unknown'; error: ServiceError };
export type Job<T> = { id: string; createdAt: number; state: 'queued' | 'running' } | ({ id: string; createdAt: number } & JobTerminal<T>);

/** A bounded queue: active jobs are never evicted and close prevents queued work. */
export function createJobStore<T>(maximum = 128, retentionMs = 10 * 60_000, concurrency = 4) {
  const jobs = new Map<string, Job<T>>();
  const queued: Array<{ id: string; work: () => Promise<T> }> = [];
  let running = 0;
  let closed = false;
  const cleanup = () => {
    const oldest = Date.now() - retentionMs;
    for (const [id, job] of jobs) if (!['queued', 'running'].includes(job.state) && job.createdAt < oldest) jobs.delete(id);
    while (jobs.size >= maximum) {
      const terminal = [...jobs.entries()].find(([, job]) => !['queued', 'running'].includes(job.state));
      if (!terminal) throw new ServiceError('repository-busy', 'Service job capacity is full', true);
      jobs.delete(terminal[0]);
    }
  };
  const drain = () => {
    while (!closed && running < concurrency && queued.length > 0) {
      const next = queued.shift();
      if (!next) return;
      const job = jobs.get(next.id);
      if (!job || job.state !== 'queued') continue;
      running += 1;
      jobs.set(next.id, { id: next.id, createdAt: job.createdAt, state: 'running' });
      void next.work().then(
        (data) => { if (!closed) jobs.set(next.id, { id: next.id, createdAt: job.createdAt, state: 'completed', data }); },
        (caught: unknown) => { if (!closed) { const error = caught instanceof ServiceError ? caught : new ServiceError('internal', 'Git job failed'); jobs.set(next.id, { id: next.id, createdAt: job.createdAt, state: error.code === 'timeout-unknown' ? 'unknown' : 'failed', error }); } },
      ).finally(() => { running -= 1; drain(); });
    }
  };
  const submit = (work: () => Promise<T>) => {
    if (closed) throw new ServiceError('internal', 'Service is closed');
    cleanup();
    const id = randomUUID().replaceAll('-', '');
    const job = { id, createdAt: Date.now(), state: 'queued' as const };
    jobs.set(id, job); queued.push({ id, work }); drain();
    return { jobId: id, state: 'queued' as const, acceptedAt: job.createdAt };
  };
  const get = (id: string) => jobs.get(id);
  return { submit, get, close: () => { closed = true; queued.length = 0; jobs.clear(); } };
}
