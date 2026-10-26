import test from 'node:test';
import assert from 'node:assert/strict';
import {assertBenchmarkDollarCeiling} from '../scripts/benchmark/paid-dollar-ceiling.mjs';
const approved={armUsdCents:1000,priceCeilingMicrosPerMillion:14_000_000,
 publishedInputUsdPerMillion:'1.75',publishedOutputUsdPerMillion:'14',
 accountTokens:700_000,approvalTokens:700_000};
test('a valid $10 arm ceiling conservatively bounds all tokens at highest rate',()=>{
 const result=assertBenchmarkDollarCeiling(approved);
 assert.equal(result.maxTokens,714285);
});
test('unverified rate, unsupported arm allowance, or underpriced grant denies payment',()=>{
 for(const change of [
 {armUsdCents:3000},{priceCeilingMicrosPerMillion:NaN},
 {publishedOutputUsdPerMillion:'15'},
 {accountTokens:714286},{approvalTokens:714286},
 {publishedInputUsdPerMillion:null}
 ])assert.throws(()=>assertBenchmarkDollarCeiling({...approved,...change}),/BENCHMARK_/);
});
test('no configuration cannot silently create dollar authorization',()=>{
 assert.throws(()=>assertBenchmarkDollarCeiling({}),/BENCHMARK_/);
});
