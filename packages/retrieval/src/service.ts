import type { Db } from '../../db/src/client';
import { mergeHybridScores } from './scoring';

export class RetrievalService {
  constructor(private readonly db: Db) {}

  async search(repositoryId: string, query: string, topK = 10, pathPrefix?: string) {
    const keywordRows = await this.db.query(
      `select fc.id, similarity(fc.content, $2) as score from file_chunks fc
       join files f on f.id = fc.file_id
       where f.repository_id = $1 and ($3::text is null or f.path like ($3 || '%'))
       order by score desc limit $4`,
      [repositoryId, query, pathPrefix ?? null, topK * 3]
    );
    const vectorRows = await this.db.query(
      `select fc.id, 1 - (fc.embedding <=> $2::vector) as score
       from file_chunks fc join files f on f.id = fc.file_id
       where f.repository_id = $1 and ($3::text is null or f.path like ($3 || '%'))
       order by score desc limit $4`,
      [repositoryId, `[${Array.from({ length: 1536 }, () => 0).join(',')}]`, pathPrefix ?? null, topK * 3]
    );
    return mergeHybridScores(
      keywordRows.rows.map((r) => ({ chunkId: r.id, score: Number(r.score) })),
      vectorRows.rows.map((r) => ({ chunkId: r.id, score: Number(r.score) }))
    ).slice(0, topK);
  }
}
