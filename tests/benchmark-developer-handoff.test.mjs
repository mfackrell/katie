import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const dispatch=readFileSync('lib/agents/development.ts','utf8');
const source=readFileSync('supabase/migrations/20261025191500_benchmark_development_dispatches.sql','utf8');
test('benchmark binding is checked at existing engineering dispatch before claim or external issue',()=>{
 const fn=dispatch.slice(dispatch.indexOf('export async function dispatchDevelopment('));
 const gate=fn.indexOf("KATIE_NATIVE_BENCHMARK_DISPATCH");
 const claim=fn.indexOf('claim_project_dispatch');
 const issue=fn.indexOf('client.issues.create');
 assert.ok(gate>=0&&gate<claim&&claim<issue);
 assert.match(fn,/bound\.contract_hash!==project\.contractHash/);
 assert.match(fn,/bound\.baseline_sha!==project\.baselineSha/);
 assert.match(fn,/Benchmark native dispatch requires authenticated spending grant/);
 assert.match(fn,/t\.arm!=='full'/);
 assert.match(fn,/t\.contract_sha256!==project\.contractHash/);
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
});
