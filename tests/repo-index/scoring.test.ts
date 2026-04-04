import { describe, expect, it } from 'vitest';
import { mergeHybridScores } from '../../packages/retrieval/src/scoring';

describe('hybrid scoring', () => {
  it('applies weighted merge', () => {
    const scores = mergeHybridScores(
      [{ chunkId: 'a', score: 1 }, { chunkId: 'b', score: 0.5 }],
      [{ chunkId: 'b', score: 1 }]
    );
    expect(scores[0].chunkId).toBe('b');
    expect(scores[0].finalScore).toBeGreaterThan(scores[1].finalScore);
  });
});
