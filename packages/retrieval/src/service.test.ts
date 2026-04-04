import test from "node:test";
import assert from "node:assert/strict";
import { RetrievalService, type DbClient } from "./service.ts";

type DocumentRow = {
  id: string;
  content: string;
  keyword_score: number;
  embedding: number[];
};

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, value, idx) => sum + value * b[idx], 0);
  const normA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
  const normB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
  return dot / (normA * normB);
}

test("search sends embedding provider vector into pgvector cosine expression", async () => {
  const embeddedQuery = [0.2, 0.8, 0.4];
  const executed: { sql?: string; params?: readonly unknown[] } = {};

  const db: DbClient = {
    async query(sql, params) {
      executed.sql = sql;
      executed.params = params;
      return { rows: [] };
    }
  };

  const service = new RetrievalService(db, {
    async embed(text) {
      assert.equal(text, "capital cities");
      return embeddedQuery;
    }
  });

  await service.search("capital cities", 5);

  assert.ok(executed.sql?.includes("embedding <=> $2::vector"));
  assert.deepEqual(executed.params, ["capital cities", embeddedQuery, 5]);
  assert.notEqual((executed.params?.[1] as number[]).every((n) => n === 0), true);
});

test("search keeps hybrid ranking formula at 0.45 keyword + 0.55 vector", async () => {
  const queryVector = [0, 1];
  const docs: DocumentRow[] = [
    { id: "keyword-heavy", content: "", keyword_score: 0.95, embedding: [1, 0] },
    { id: "vector-heavy", content: "", keyword_score: 0.2, embedding: [0, 1] },
    { id: "balanced", content: "", keyword_score: 0.85, embedding: [1, 0.1] }
  ];

  const db: DbClient = {
    async query(_sql, params) {
      const embedding = params[1] as number[];
      const rows = docs
        .map((doc) => {
          const vectorScore = cosineSimilarity(doc.embedding, embedding);
          const hybrid = 0.45 * doc.keyword_score + 0.55 * vectorScore;
          return {
            id: doc.id,
            content: doc.content,
            keyword_score: doc.keyword_score,
            vector_score: vectorScore,
            hybrid_score: hybrid
          };
        })
        .sort((a, b) => b.hybrid_score - a.hybrid_score);
      return { rows };
    }
  };

  const service = new RetrievalService(db, {
    async embed() {
      return queryVector;
    }
  });

  const results = await service.search("ocean currents", 3);

  assert.deepEqual(
    results.map((row) => row.id),
    ["vector-heavy", "balanced", "keyword-heavy"]
  );
  assert.ok(results[0].vector_score > 0.99);
});
