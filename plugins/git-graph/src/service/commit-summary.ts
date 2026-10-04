import type { Repository, ServiceContext } from './contracts.js';
import { ServiceError, requireGit } from './contracts.js';
import { z } from 'zod';

const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_COMMIT_METADATA_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_STATS_OUTPUT_BYTES = 240_000;
const MAX_SERIALIZED_BYTES = 200_000;
const MAX_MESSAGE_CHARACTERS = 65_536;
const Timestamp = z.string().datetime({ offset: true });

type Summary = { read: 'commit-summary'; commit: { id: string; parentIds: string[]; subject: string; message: string; author: string; authorEmail: string; timestamp: string; statistics: { files: number; insertions: number; deletions: number } }; messageTruncated: boolean };

function boundedMessage(value: string, summary: Summary): { message: string; truncated: boolean } {
  const base = Buffer.byteLength(JSON.stringify({ ...summary, commit: { ...summary.commit, message: '' } }));
  let bytes = base;
  let message = '';
  for (const character of value) {
    const serialized = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (message.length + character.length > MAX_MESSAGE_CHARACTERS || bytes + serialized > MAX_SERIALIZED_BYTES) return { message, truncated: true };
    message += character;
    bytes += serialized;
  }
  return { message, truncated: false };
}

function statistics(raw: Buffer) {
  let files = 0; let insertions = 0; let deletions = 0;
  const tokens = raw.toString('utf8').split('\0');
  if (tokens.length === 1 && tokens[0] === '') return { files, insertions, deletions };
  if (tokens.at(-1) !== '') throw new ServiceError('internal', 'Git returned malformed numeric statistics');
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const entry = tokens[index] ?? '';
    const firstTab = entry.indexOf('\t'); const secondTab = firstTab < 0 ? -1 : entry.indexOf('\t', firstTab + 1);
    if (firstTab <= 0 || secondTab < 0) throw new ServiceError('internal', 'Git returned malformed numeric statistics');
    const added = entry.slice(0, firstTab); const removed = entry.slice(firstTab + 1, secondTab); const path = entry.slice(secondTab + 1);
    if (!/^(?:\d+|-)$/.test(added) || !/^(?:\d+|-)$/.test(removed)) throw new ServiceError('internal', 'Git returned malformed numeric statistics');
    const addedCount = added === '-' ? 0 : Number(added); const removedCount = removed === '-' ? 0 : Number(removed);
    if (!Number.isSafeInteger(addedCount) || !Number.isSafeInteger(removedCount)) throw new ServiceError('internal', 'Git returned malformed numeric statistics');
    if (!path) {
      const previousPath = tokens[++index]; const currentPath = tokens[++index];
      if (!previousPath || !currentPath) throw new ServiceError('internal', 'Git returned malformed numeric statistics');
    }
    files += 1;
    insertions += addedCount;
    deletions += removedCount;
  }
  return { files, insertions, deletions };
}

function metadataFields(raw: Buffer, expectedCommit: string) {
  const fields = raw.toString('utf8').split('\0');
  if (fields.length !== 8 || fields[7] !== '\n') throw new ServiceError('internal', 'Git returned invalid commit metadata');
  const [id = '', rawParents = '', author = '', authorEmail = '', timestamp = '', subject = '', message = ''] = fields;
  const parentIds = rawParents ? rawParents.split(' ') : [];
  if (subject.length > 8192 || author.length > 512 || authorEmail.length > 512) throw new ServiceError('unsupported', 'Commit metadata exceeds the maximum length');
  if (id !== expectedCommit || !HASH.test(id) || !Timestamp.safeParse(timestamp).success || parentIds.length > 32 || parentIds.some((parent) => !HASH.test(parent))) throw new ServiceError('internal', 'Git returned invalid commit metadata');
  return { id, parentIds, author, authorEmail, timestamp, subject, message };
}

export async function readCommitSummary(context: ServiceContext, repository: Repository, requestedCommit: string): Promise<Summary> {
  if (!HASH.test(requestedCommit)) throw new ServiceError('invalid-request', 'Commit summary requires a full commit ID');
  const verified = await context.runGit(repository.root, ['rev-parse', '--verify', '--end-of-options', `${requestedCommit}^{commit}`]);
  const commit = verified.stdout.toString('utf8').trim();
  if (verified.exitCode !== 0) {
    if (/unknown revision|bad revision|Needed a single revision|not a valid object name/i.test(verified.stderr.toString('utf8'))) throw new ServiceError('not-found', `Unknown commit reference: ${requestedCommit}`);
    await requireGit(context.runGit, repository.root, ['rev-parse', '--verify', '--end-of-options', `${requestedCommit}^{commit}`]);
  }
  if (!HASH.test(commit)) throw new ServiceError('not-found', `Unknown commit reference: ${requestedCommit}`);

  const metadata = metadataFields(await requireGit(context.runGit, repository.root, ['show', '--no-patch', '--no-show-signature', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%B%x00', commit, '--'], { maxOutputBytes: MAX_COMMIT_METADATA_OUTPUT_BYTES }), commit);
  const { id, parentIds, author, authorEmail, timestamp, subject, message: fullMessage } = metadata;
  const parent = parentIds[0] ?? (await requireGit(context.runGit, repository.root, ['hash-object', '-t', 'tree', '--stdin'])).toString('utf8').trim();
  const rawStats = await requireGit(context.runGit, repository.root, ['diff', '--numstat', '-z', '-M', '-C', '--no-ext-diff', '--no-textconv', parent, id, '--'], { maxOutputBytes: MAX_STATS_OUTPUT_BYTES });
  const initial: Summary = { read: 'commit-summary', commit: { id, parentIds, subject, message: '', author, authorEmail, timestamp, statistics: statistics(rawStats) }, messageTruncated: false };
  const message = boundedMessage(fullMessage, initial);
  return { ...initial, commit: { ...initial.commit, message: message.message }, messageTruncated: message.truncated };
}
