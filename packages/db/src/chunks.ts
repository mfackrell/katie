import { randomUUID } from 'crypto';
import type { Db } from './client';

export const replaceFileChunks = async (
  db: Db,
  fileId: string,
  chunks: Array<{ chunkIndex: number; startLine: number; endLine: number; content: string; contentHash: string; tokenEstimate: number; embedding: number[] }>
) => {
  await db.query('delete from file_chunks where file_id = $1', [fileId]);
  for (const chunk of chunks) {
    await db.query(
      `insert into file_chunks (id, file_id, chunk_index, start_line, end_line, content, content_hash, token_estimate, embedding)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        randomUUID(),
        fileId,
        chunk.chunkIndex,
        chunk.startLine,
        chunk.endLine,
        chunk.content,
        chunk.contentHash,
        chunk.tokenEstimate,
        `[${chunk.embedding.join(',')}]`
      ]
    );
  }
};
