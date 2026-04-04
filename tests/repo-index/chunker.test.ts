import { describe, expect, it } from 'vitest';
import { chunkByLines, shouldIgnorePath } from '../../packages/indexer/src/chunker';

describe('chunking logic', () => {
  it('chunks with overlap and stable lines', () => {
    const content = Array.from({ length: 250 }, (_, i) => `line-${i + 1}`).join('\n');
    const chunks = chunkByLines(content, 120, 20);
    expect(chunks.length).toBe(3);
    expect(chunks[1].startLine).toBe(101);
    expect(chunks[0].endLine).toBe(120);
  });

  it('ignores locked and minified assets', () => {
    expect(shouldIgnorePath('yarn.lock')).toBe(true);
    expect(shouldIgnorePath('public/app.min.js')).toBe(true);
  });
});
