import test from "node:test";
import assert from "node:assert/strict";
import { RetrievalService, type DbClient, type QueryResultRow } from "../packages/retrieval/src/service";

test("retrieval embeds the query and binds the vector and default limit", async () => {
  const vector = [0.12, 0.9, 0.4];
  const calls: string[] = [];
  const db: DbClient = {
    async query(sql, params) {
      assert.match(sql, /embedding <=> \$2::vector/);
      assert.deepEqual(params, ["neural search", vector, 10]);
      return { rows: [] };
    },
  };
  const service = new RetrievalService(db, {
    async embed(query) { calls.push(query); return vector; },
  });
  assert.deepEqual(await service.search("neural search"), []);
  assert.deepEqual(calls, ["neural search"]);
});

test("retrieval delegates weighted ranking to SQL and preserves database rows and scores", async () => {
  const rows: QueryResultRow[] = [
    { id: "doc-b", content: "B", keyword_score: 0.2, vector_score: 0.8, hybrid_score: 0.53 },
    { id: "doc-a", content: "A", keyword_score: 0.9, vector_score: 0.1, hybrid_score: 0.46 },
  ];
  const db: DbClient = {
    async query<T>(sql: string, params: readonly unknown[]) {
      assert.match(sql, /0\.45 \* keyword_score/);
      assert.match(sql, /0\.55 \* vector_score/);
      assert.match(sql, /ts_rank_cd/);
      assert.match(sql, /ORDER BY hybrid_score DESC/);
      assert.match(sql, /LIMIT \$3/);
      assert.equal(params[2], 2);
      // Generic DB adapters trust the caller's row type; this fixture does the same.
      return { rows: rows as T[] };
    },
  };
  const service = new RetrievalService(db, { async embed() { return [0.3, 0.1, 0.2]; } });
  assert.strictEqual(await service.search("rank candidates", 2), rows);
});

test("retrieval binds a positive limit of seven and returns database rows unmodified", async () => {
  const vector = [0.3, 0.1, 0.2];
  const rows: QueryResultRow[] = [
    { id: "doc-b", content: "B", keyword_score: 0.2, vector_score: 0.8, hybrid_score: 0.53 },
    { id: "doc-a", content: "A", keyword_score: 0.9, vector_score: 0.1, hybrid_score: 0.46 },
  ];
  const expectedRows = rows.map(row => ({ ...row }));
  const db: DbClient = {
    async query<T>(sql: string, params: readonly unknown[]) {
      assert.match(sql, /LIMIT \$3/);
      assert.deepEqual(params, ["seven candidates", vector, 7]);
      // Generic DB adapters trust the caller's row type; this fixture does the same.
      return { rows: rows as T[] };
    },
  };
  const service = new RetrievalService(db, { async embed() { return vector; } });
  assert.strictEqual(await service.search("seven candidates", 7), rows);
  assert.deepEqual(rows, expectedRows);
});

test("retrieval propagates embedding failures without querying the database", async () => {
  const failure = new Error("embedding unavailable");
  const service = new RetrievalService({
    async query() { assert.fail("database must not be queried after embedding failure"); },
  }, { async embed() { throw failure; } });
  await assert.rejects(service.search("bad embedding"), error => error === failure);
});

test("retrieval passes zero vectors to the database without adding application validation", async () => {
  let queried = false;
  const service = new RetrievalService({
    async query(_sql, params) { queried = true; assert.deepEqual(params[1], [0, 0, 0]); return { rows: [] }; },
  }, { async embed() { return [0, 0, 0]; } });
  assert.deepEqual(await service.search("zero embedding"), []);
  assert.equal(queried, true);
});

test("retrieval propagates database failures", async () => {
  const failure = new Error("database unavailable");
  const service = new RetrievalService({ async query() { throw failure; } }, {
    async embed() { return [1]; },
  });
  await assert.rejects(service.search("query"), error => error === failure);
});
