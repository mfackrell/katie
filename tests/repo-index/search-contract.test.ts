import { describe, expect, it } from 'vitest';
import { searchInputSchema } from '../../packages/mcp-contract/src/schemas';

describe('search endpoint contract', () => {
  it('validates request payload', () => {
    const parsed = searchInputSchema.parse({ repo: 'owner/repo', query: 'auth middleware', topK: 10 });
    expect(parsed.topK).toBe(10);
  });
});
