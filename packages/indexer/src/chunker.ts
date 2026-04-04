import { createHash } from 'crypto';

export interface Chunk {
  chunkIndex: number;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  tokenEstimate: number;
}

export const shouldIgnorePath = (path: string): boolean =>
  /(\.git\/|node_modules\/|dist\/|build\/|coverage\/|vendor\/|\.lock$|\.min\.(js|css)$)/.test(path);

export const chunkByLines = (content: string, target = 120, overlap = 20): Chunk[] => {
  const lines = content.split('\n');
  const step = target - overlap;
  const chunks: Chunk[] = [];
  for (let start = 0, index = 0; start < lines.length; start += step, index += 1) {
    const end = Math.min(start + target, lines.length);
    const chunkContent = lines.slice(start, end).join('\n');
    chunks.push({
      chunkIndex: index,
      startLine: start + 1,
      endLine: end,
      content: chunkContent,
      contentHash: createHash('sha256').update(chunkContent).digest('hex'),
      tokenEstimate: Math.ceil(chunkContent.length / 4)
    });
    if (end === lines.length) break;
  }
  return chunks;
};
