import type { GraphCommit } from '../domain/index.js';
import type { CommitHoverPayload } from '../popover/payload.js';
import { POPOVER_PAYLOAD_MAX } from '../popover/payload.js';
import type { GitHistoryGraphRef } from '../original/gitGraph.js';

type Summary = NonNullable<CommitHoverPayload['summary']>;
const compact = (value: string, length: number) => value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1))}…`;
const badge = (ref: GitHistoryGraphRef) => ref.id.length <= 200 ? { id: ref.id, name: compact(ref.name, 200), kind: ref.kind, color: ref.color ?? null } : null;

/** Build a valid bounded message payload; refs are preserved so the child can render their true identities. */
export const buildHoverPayload = (commit: GraphCommit, refs: readonly GitHistoryGraphRef[], remoteUrl: string | null, summary: Summary | null): CommitHoverPayload => {
  const payload: CommitHoverPayload = { kind: 'hover', commit: commit.id, subject: compact(commit.subject, 2_000), author: compact(commit.author, 512), authorEmail: compact(commit.authorEmail, 512), timestamp: commit.timestamp, refs: refs.slice(0, 20).map(badge).filter((ref): ref is NonNullable<typeof ref> => ref !== null), summary: summary ? { ...summary, message: compact(summary.message, 8_000) } : null, remoteUrl };
  const size = () => JSON.stringify(payload).length;
  if (payload.summary) {
    while (size() > POPOVER_PAYLOAD_MAX && payload.summary.message.length > 0) payload.summary.message = payload.summary.message.slice(0, Math.max(0, payload.summary.message.length - 512));
    while (size() > POPOVER_PAYLOAD_MAX && payload.subject.length > 0) payload.subject = payload.subject.slice(0, Math.max(0, payload.subject.length - 128));
  }
  if (size() > POPOVER_PAYLOAD_MAX) payload.summary = null;
  return payload;
};

export const commitBody = (subject: string, message: string) => message.startsWith(subject) ? message.slice(subject.length).replace(/^\s+/, '').trim() : message.trim();
export const relativeTime = (timestamp: string, locale: string, now = Date.now()) => {
  const date = Date.parse(timestamp);
  if (Number.isNaN(date)) return timestamp;
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [['year', 365 * 864e5], ['month', 30 * 864e5], ['week', 7 * 864e5], ['day', 864e5], ['hour', 36e5], ['minute', 6e4], ['second', 1e3]];
  const [unit, milliseconds] = units.find(([, value]) => Math.abs(date - now) >= value) ?? units.at(-1)!;
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round((date - now) / milliseconds), unit);
};
export const initials = (author: string) => author.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';
