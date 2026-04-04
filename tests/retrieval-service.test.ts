import test from "node:test";
import assert from "node:assert/strict";
import { RetrievalService, type EmbeddingProvider, type RetrievalCandidate } from "../packages/retrieval/src/service";

class StubEmbeddingProvider implements EmbeddingProvider {
  public calls: string[] = [];

  constructor(private readonly embedding: number[]) {}

  async embedQuery(input: string): Promise<number[]> {
    this.calls.push(input);
    return this.embedding;
  }
}

test("retrieval service requests query embedding from provider", async () => {
  const provider = new StubEmbeddingProvider([0.12, 0.9, 0.4]);
  const service = new RetrievalService(provider);

  await service.rankCandidates({ query: "neural search" }, []);

  assert.deepEqual(provider.calls, ["neural search"]);
});

test("retrieval service normalizes scores and ranks with weighted merge", async () => {
  const provider = new StubEmbeddingProvider([0.3, 0.1, 0.2]);
  const service = new RetrievalService(provider);
  const candidates: RetrievalCandidate[] = [
    { id: "doc-a", keywordScore: 10, vectorScore: 0.2 },
    { id: "doc-b", keywordScore: 30, vectorScore: 0.8 },
    { id: "doc-c", keywordScore: 20, vectorScore: 0.5 }
  ];

  const ranked = await service.rankCandidates({ query: "rank candidates" }, candidates);

  assert.deepEqual(
    ranked.map((candidate) => candidate.id),
    ["doc-b", "doc-c", "doc-a"]
  );

  const docB = ranked.find((candidate) => candidate.id === "doc-b");
  const docC = ranked.find((candidate) => candidate.id === "doc-c");
  const docA = ranked.find((candidate) => candidate.id === "doc-a");

  assert.equal(docB?.normalizedKeywordScore, 1);
  assert.equal(docB?.normalizedVectorScore, 1);
  assert.equal(docB?.score, 1);

  assert.equal(docC?.normalizedKeywordScore, 0.5);
  assert.ok(Math.abs((docC?.normalizedVectorScore ?? 0) - 0.5) < 1e-12);
  assert.ok(Math.abs((docC?.score ?? 0) - 0.5) < 1e-12);

  assert.equal(docA?.normalizedKeywordScore, 0);
  assert.equal(docA?.normalizedVectorScore, 0);
  assert.equal(docA?.score, 0);
});

test("retrieval service rejects zero query embedding", async () => {
  const provider = new StubEmbeddingProvider([0, 0, 0]);
  const service = new RetrievalService(provider);

  await assert.rejects(
    () => service.rankCandidates({ query: "bad embedding" }, []),
    /query embedding must contain at least one non-zero value/
  );
});
