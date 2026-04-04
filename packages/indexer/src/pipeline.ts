import { metrics } from '../../core/src/metrics';
import { chunkByLines, shouldIgnorePath } from './chunker';
import { extractSymbolsFallback } from './symbols';
import type { EmbeddingProvider } from './embeddings';
import type { Db } from '../../db/src/client';
import { replaceFileChunks } from '../../db/src/chunks';
import { upsertFile } from '../../db/src/repositories';

export const runFullIndex = async (
  db: Db,
  repositoryId: string,
  files: Array<{ path: string; sha: string; size: number; content: string }>,
  embedder: EmbeddingProvider
) => {
  let filesIndexed = 0;
  let chunksIndexed = 0;
  for (const file of files) {
    if (file.size > 1_500_000 || shouldIgnorePath(file.path)) continue;
    const fileRow = await upsertFile(db, {
      repositoryId,
      path: file.path,
      language: file.path.split('.').pop() ?? null,
      sha: file.sha,
      sizeBytes: file.size,
      isBinary: false
    });
    const chunks = chunkByLines(file.content);
    const embeds = await embedder.embed(chunks.map((c) => c.content));
    await replaceFileChunks(
      db,
      fileRow.id,
      chunks.map((c, i) => ({ ...c, embedding: embeds[i] }))
    );
    const symbols = extractSymbolsFallback(file.content);
    await db.query('delete from symbols where file_id = $1', [fileRow.id]);
    for (const s of symbols) {
      await db.query(
        `insert into symbols (id, file_id, name, kind, start_line, end_line, signature)
         values (gen_random_uuid(), $1,$2,$3,$4,$5,$6)
         on conflict (file_id, name, start_line) do update set kind = excluded.kind, end_line = excluded.end_line, signature = excluded.signature`,
        [fileRow.id, s.name, s.kind, s.startLine, s.endLine, s.signature ?? null]
      );
    }
    filesIndexed += 1;
    chunksIndexed += chunks.length;
  }
  metrics.filesIndexedTotal.inc(filesIndexed);
  metrics.chunksIndexedTotal.inc(chunksIndexed);
  return { filesIndexed, chunksIndexed };
};
