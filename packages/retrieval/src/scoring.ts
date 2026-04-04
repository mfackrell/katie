export interface Scored {
  chunkId: string;
  keywordScore: number;
  vectorScore: number;
}

const normalize = (values: number[]) => {
  const max = Math.max(...values, 1);
  return values.map((v) => v / max);
};

export const mergeHybridScores = (keyword: Array<{ chunkId: string; score: number }>, vector: Array<{ chunkId: string; score: number }>) => {
  const all = new Map<string, Scored>();
  const kn = normalize(keyword.map((k) => k.score));
  keyword.forEach((k, i) => all.set(k.chunkId, { chunkId: k.chunkId, keywordScore: kn[i], vectorScore: 0 }));
  const vn = normalize(vector.map((k) => k.score));
  vector.forEach((v, i) => {
    const prev = all.get(v.chunkId) ?? { chunkId: v.chunkId, keywordScore: 0, vectorScore: 0 };
    prev.vectorScore = vn[i];
    all.set(v.chunkId, prev);
  });

  return Array.from(all.values())
    .map((s) => ({ ...s, finalScore: 0.45 * s.keywordScore + 0.55 * s.vectorScore }))
    .sort((a, b) => b.finalScore - a.finalScore);
};
