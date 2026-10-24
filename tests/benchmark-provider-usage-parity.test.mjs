import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const provider=readFileSync('lib/orchestration/bounded-provider.ts','utf8');
const mission=readFileSync('lib/missions/model.ts','utf8');
test('Anthropic and Google response usage normalizes to total tokens',()=>{
 assert.match(provider,/usage:\{total_tokens:usage\|\|undefined\}/);
 assert.match(provider,/raw\.usageMetadata\?\.totalTokenCount/);
 assert.match(provider,/raw\.usage\?\.input_tokens/);
});
test('benchmark execution uses normalized totals without fabricating an input/output split',()=>{
 assert.match(mission,/benchmark_finish_mission_call'[\s\S]*response\.usage\?\.total_tokens/);
 assert.doesNotMatch(mission,/inputTokens:usage\?\.input_tokens/);
 assert.doesNotMatch(mission,/outputTokens:usage\?\.output_tokens/);
});
