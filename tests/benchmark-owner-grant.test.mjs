import test from 'node:test';import assert from 'node:assert/strict';
import {BenchmarkBudget} from '../scripts/benchmark/usage-ledger.mjs';
import {applyStoredOwnerGrant} from '../scripts/benchmark/owner-grant.mjs';
const row={id:'grant-1',status:'approved',actor_id:'owner-1',project_id:'project-1',purpose:'benchmark_budget_increase',previous_ceiling:100,new_ceiling:200,approved_at:'2026-10-24T12:00:00Z'};
test('verified stored owner approval increases ceiling without resetting spending',async()=>{
 const b=new BenchmarkBudget(100);b.reserve('r1',50);b.finish('r1',{inputTokens:30,outputTokens:10});
 const snapshot=await applyStoredOwnerGrant(b,{ownerActorId:'owner-1',projectId:'project-1',grantId:'grant-1',readGrant:async()=>row});
 assert.equal(snapshot.capTokens,200);assert.equal(snapshot.committedTokens,40);
});
test('forged grant, wrong owner or duplicate denied',async()=>{
 const b=new BenchmarkBudget(100);
 const opts={ownerActorId:'owner-1',projectId:'project-1',grantId:'grant-1'};
 await assert.rejects(applyStoredOwnerGrant(b,{...opts,readGrant:async()=>({...row,actor_id:'other'})}),/OWNER_BUDGET/);
 await applyStoredOwnerGrant(b,{...opts,readGrant:async()=>row});
 await assert.rejects(applyStoredOwnerGrant(b,{...opts,readGrant:async()=>({...row,previous_ceiling:200,new_ceiling:300})}),/OWNER_BUDGET/);
});
test('missing trusted storage rejects',async()=>{
 await assert.rejects(applyStoredOwnerGrant(new BenchmarkBudget(100),{ownerActorId:'owner-1',projectId:'project-1',grantId:'x'}),/TRUSTED_APPROVAL_STORE/);
});
