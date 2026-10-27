import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const dispatch=readFileSync('lib/agents/development.ts','utf8');
const source=readFileSync('supabase/migrations/20261027180744_benchmark_full_do_execution_binding.sql','utf8');
test('benchmark binding is checked at existing engineering dispatch before claim or external issue',()=>{
 const fn=dispatch.slice(dispatch.indexOf('export async function dispatchDevelopment('));
 const gate=fn.indexOf("KATIE_NATIVE_BENCHMARK_DISPATCH");
 const claim=fn.indexOf('claim_project_dispatch');
 const issue=fn.indexOf('client.issues.create');
 assert.ok(gate>=0&&gate<claim&&claim<issue);
 assert.match(fn,/bound\.contract_hash!==project\.contractHash/);
 assert.match(fn,/bound\.baseline_sha!==project\.baselineSha/);
 assert.match(fn,/Benchmark native dispatch denied: no live task-specific owner spending approval/);
 assert.match(fn,/encodeNativeHandoff/);
 assert.match(fn,/benchmark_native_spending_approvals/);
 assert.match(fn,/benchmarkRepository!==binding\.fullName/);
 assert.match(fn,/t\.arm!=='full'/);
 assert.match(fn,/t\.contract_sha256!==bound\.benchmark_contract_hash/);
 assert.match(fn,/benchmark_bind_full_development_dispatch/);
 assert.match(fn,/a\.owner_actor_id!==t\.owner_actor_id/);
 assert.match(fn,/a\.frozen_at/);
});
test('ordinary projects default to original authorized GitHub path',()=>{
 assert.match(dispatch,/process\.env\.KATIE_NATIVE_BENCHMARK_DISPATCH==='enabled'/);
 assert.match(dispatch,/claim_project_dispatch/);
 assert.match(dispatch,/client\.issues\.create/);
});
test('binding table cannot be controlled by ordinary clients',()=>{
 assert.match(source,/enable row level security/);
 assert.match(source,/from public,anon,authenticated/);
 assert.match(source,/references public\.benchmark_three_arm_trials/);
 assert.match(source,/benchmark_bind_full_development_dispatch/);
 assert.match(source,/benchmark_contract_hash/);
 assert.match(source,/benchmark_reserve_mission_call/);
});
