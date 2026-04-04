export interface SearchRequest {
  query: string;
}

export interface RetrievalCandidate {
  id: string;
  keywordScore: number;
  vectorScore: number;
}

export interface RankedCandidate extends RetrievalCandidate {
  normalizedKeywordScore: number;
  normalizedVectorScore: number;
  score: number;
}

export interface EmbeddingProvider {
  embedQuery(input: string): Promise<number[]>;
}

function normalize01(values: number[]): number[] {
  if (values.length === 0) {
    return [];
  }

  const min = Math.min(...values);
  const max = Math.max(...values);

  if (min === max) {
    return values.map(() => (max <= 0 ? 0 : 1));
  }

  return values.map((value) => (value - min) / (max - min));
}

export class RetrievalService {
  constructor(private readonly embeddingProvider: EmbeddingProvider) {}

  async rankCandidates(search: SearchRequest, candidates: RetrievalCandidate[]): Promise<RankedCandidate[]> {
    const queryEmbedding = await this.embeddingProvider.embedQuery(search.query);

    if (queryEmbedding.every((value) => value === 0)) {
      throw new Error("query embedding must contain at least one non-zero value");
    }

    const normalizedKeywordScores = normalize01(candidates.map((candidate) => candidate.keywordScore));
    const normalizedVectorScores = normalize01(candidates.map((candidate) => candidate.vectorScore));

    return candidates
      .map((candidate, index) => {
        const normalizedKeywordScore = normalizedKeywordScores[index] ?? 0;
        const normalizedVectorScore = normalizedVectorScores[index] ?? 0;

        return {
          ...candidate,
          normalizedKeywordScore,
          normalizedVectorScore,
          score: 0.45 * normalizedKeywordScore + 0.55 * normalizedVectorScore
        };
      })
      .sort((left, right) => right.score - left.score);
  }
}
