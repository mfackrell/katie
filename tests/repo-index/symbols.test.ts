import { describe, expect, it } from 'vitest';
import { extractSymbolsFallback } from '../../packages/indexer/src/symbols';

describe('symbol fallback', () => {
  it('extracts common symbol forms', () => {
    const symbols = extractSymbolsFallback('class A {}\nexport function run(){}\nconst value = 1');
    expect(symbols.map((s) => s.name)).toEqual(['A', 'run', 'value']);
  });
});
