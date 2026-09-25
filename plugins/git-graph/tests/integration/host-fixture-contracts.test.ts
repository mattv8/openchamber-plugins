import { describe, expect, test } from 'bun:test';
import { SessionIdentitySchema } from './host-fixture-contracts.js';

describe('real-host fixture contracts', () => {
  test('extracts a created session from the OpenCode 2 response envelope', () => {
    expect(SessionIdentitySchema.parse({
      data: {
        id: 'ses_fixture',
        title: 'Git Graph verification',
        location: { directory: '/fixture' },
      },
    })).toEqual({ id: 'ses_fixture' });
  });

  test('rejects a successful response envelope without a session identity', () => {
    expect(SessionIdentitySchema.safeParse({ data: {} }).success).toBe(false);
  });
});
