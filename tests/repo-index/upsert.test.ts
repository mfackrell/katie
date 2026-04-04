import { describe, expect, it, vi } from 'vitest';
import { upsertFile } from '../../packages/db/src/repositories';

describe('idempotent upsert behavior', () => {
  it('uses on conflict clause', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: '1' }] });
    const db: any = { query };
    await upsertFile(db, { repositoryId: 'r', path: 'a.ts', language: 'ts', sha: '1', sizeBytes: 1, isBinary: false });
    expect(String(query.mock.calls[0][0]).toLowerCase()).toContain('on conflict');
  });
});
