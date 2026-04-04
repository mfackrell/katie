export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export interface QueryResultRow {
  id: string;
  content: string;
  keyword_score: number;
  vector_score: number;
  hybrid_score: number;
}

export interface DbClient {
  query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
}

export class RetrievalService {
  private readonly db: DbClient;
  private readonly embeddingProvider: EmbeddingProvider;

  constructor(db: DbClient, embeddingProvider: EmbeddingProvider) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
  }

  async search(queryText: string, limit = 10): Promise<QueryResultRow[]> {
    const queryEmbedding = await this.embeddingProvider.embed(queryText);

    const sql = `
      SELECT
        id,
        content,
        keyword_score,
        vector_score,
        ((0.45 * keyword_score) + (0.55 * vector_score)) AS hybrid_score
      FROM (
        SELECT
          id,
          content,
          ts_rank_cd(to_tsvector('english', content), plainto_tsquery('english', $1)) AS keyword_score,
          (1 - (embedding <=> $2::vector)) AS vector_score
        FROM documents
      ) ranked
      ORDER BY hybrid_score DESC
      LIMIT $3
    `;

    const result = await this.db.query<QueryResultRow>(sql, [queryText, queryEmbedding, limit]);
    return result.rows;
  }
}
