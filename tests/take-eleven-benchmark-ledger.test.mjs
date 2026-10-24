import test from 'node:test';
import assert from 'node:assert/strict';
import {BenchmarkBudget} from '../scripts/benchmark/usage-ledger.mjs';
test('reserves worst-case before call and reconciles actual provider usage',()=>{
 const b=new BenchmarkBudget(100);b.reserve('a',70);
 assert.equal(b.available,30);
 assert.throws(()=>b.reserve('b',31),/BUDGET_EXHAUSTED/);
 assert.deepEqual(b.finish('a',{inputTokens:20,outputTokens:15}),{actual:35,remaining:65});
 b.reserve('b',65);assert.equal(b.available,0);
});
test('failed requests keep reservations until provider accounting known',()=>{
 const b=new BenchmarkBudget(80);b.reserve('a',60);
 assert.throws(()=>b.finish('a',{inputTokens:NaN,outputTokens:0}),/unverified/);
 assert.equal(b.available,20);
});
test('provider reporting beyond reserved cap fails closed',()=>{
 const b=new BenchmarkBudget(30);b.reserve('a',10);
 assert.throws(()=>b.finish('a',{inputTokens:8,outputTokens:4}),/CAP_VIOLATION/);
 assert.equal(b.available,20);
});
test('invalid admission and duplicate requests are denied',()=>{
 const b=new BenchmarkBudget(40);
 assert.throws(()=>b.reserve('a',41),/BUDGET_EXHAUSTED/);
 b.reserve('a',10);
 assert.throws(()=>b.reserve('a',5),/duplicate/);
 assert.throws(()=>b.finish('missing',{inputTokens:0,outputTokens:0}),/unknown/);
});
