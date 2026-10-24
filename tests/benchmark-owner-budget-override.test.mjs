import test from 'node:test';
import assert from 'node:assert/strict';
import {BenchmarkBudget} from '../scripts/benchmark/usage-ledger.mjs';
test('owner-approved budget increase preserves incurred costs and reservations',async()=>{
 const budget=new BenchmarkBudget(100);
 budget.reserve('spent',60);budget.finish('spent',{inputTokens:30,outputTokens:20});
 budget.reserve('pending',40);
 const receipt=await budget.approveIncrease('trusted-record',async record=>{
  assert.equal(record,'trusted-record');
  return {verified:true,actorRole:'owner',scope:'take-eleven-benchmark',approvalId:'approval-1',newCeiling:200};
 });
 assert.equal(receipt.capTokens,200);assert.equal(receipt.committedTokens,50);
 assert.equal(receipt.reservedTokens,40);assert.equal(receipt.availableTokens,110);
 assert.equal(receipt.approvals.length,1);
});
test('unverified caller approval and non-owner cannot override',async()=>{
 const budget=new BenchmarkBudget(100);
 await assert.rejects(budget.approveIncrease({approved:true,newCeiling:999},null),/OWNER_VERIFIER_REQUIRED/);
 await assert.rejects(budget.approveIncrease({},async()=>({verified:true,actorRole:'agent',scope:'take-eleven-benchmark',approvalId:'x',newCeiling:999})),/INVALID_OWNER/);
 assert.equal(budget.capTokens,100);
});
test('duplicate authorization may not be replayed',async()=>{
 const budget=new BenchmarkBudget(100);
 const approval={verified:true,actorRole:'owner',scope:'take-eleven-benchmark',approvalId:'once',newCeiling:150};
 await budget.approveIncrease({},async()=>approval);
 await assert.rejects(budget.approveIncrease({},async()=>({...approval,newCeiling:200})),/INVALID_OWNER/);
});
