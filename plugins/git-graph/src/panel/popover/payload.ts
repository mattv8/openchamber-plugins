import { z } from 'zod';

/** Data the status frame hands to its host-positioned popover frame. Bounded by the SDK's 16,000-character limit. */
const FullCommit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i);
const RefBadge = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  kind: z.enum(['head', 'local', 'remote', 'tag']),
  color: z.string().max(64).nullable(),
}).strict();
const Statistics = z.object({ files: z.number().int().nonnegative(), insertions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() }).strict();

export const CommitHoverPayloadSchema = z.object({
  kind: z.literal('hover'),
  commit: FullCommit,
  subject: z.string().max(2000),
  author: z.string().max(512),
  authorEmail: z.string().max(512),
  timestamp: z.string().datetime({ offset: true }),
  refs: z.array(RefBadge).max(20),
  /** Preloaded authoritative summary; null when the child must read it itself. */
  summary: z.object({ message: z.string().max(8000), messageTruncated: z.boolean(), statistics: Statistics }).strict().nullable(),
  /** Already-derived https://github.com/<owner>/<repo>/commit/<sha>, or null. */
  remoteUrl: z.string().url().startsWith('https://github.com/').max(2048).nullable(),
}).strict();

export const CommitMenuPayloadSchema = z.object({
  kind: z.literal('menu'),
  commit: FullCommit,
  subject: z.string().max(2000),
  /** Local branch names pointing at this commit, for checkout. */
  branches: z.array(z.string().min(1).max(512)).max(20),
}).strict();

export const CommitPopoverPayloadSchema = z.discriminatedUnion('kind', [CommitHoverPayloadSchema, CommitMenuPayloadSchema]);

export type CommitHoverPayload = z.infer<typeof CommitHoverPayloadSchema>;
export type CommitMenuPayload = z.infer<typeof CommitMenuPayloadSchema>;
export type CommitPopoverPayload = z.infer<typeof CommitPopoverPayloadSchema>;

export const POPOVER_PAYLOAD_MAX = 16_000;
