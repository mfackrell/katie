import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const model=readFileSync('lib/missions/model.ts','utf8');
const reserve=readFileSync('supabase/migrations/20261024224500_benchmark_atomic_mission_admission.sql','utf8');
const settle=readFileSync('supabase/migrations/20261024230000_benchmark_atomic_mission_settlement.sql','utf8');
test('benchmark provider dispatch reserves through one atomic RPC, not the standalone adapter',()=>{
 assert.match(model,/rpc<string\|null>\('benchmark_reserve_mission_call'/);
 assert.match(model,/rpc\('benchmark_finish_mission_call'/);
 assert.doesNotMatch(model,/executeBenchmarkMissionProvider\(/);
});
test('admission preserves existing mission lease, deadline, call and parent guards',()=>{
 assert.match(reserve,/try_reserve_mission_capacity\(p_job,p_lease,p_call,p_model,p_tokens,p_routing\)/);
 assert.match(reserve,/pg_advisory_xact_lock/);
});
test('settlement charges mission and benchmark in same transaction',()=>{
 assert.match(settle,/finish_mission_call\(p_call,p_tokens\)/);
 assert.match(settle,/spent_tokens=spent_tokens\+p_tokens/);
 assert.match(settle,/then 'overrun' else 'settled'/);
 assert.match(settle,/c\.actual_tokens is distinct from p_tokens/);
 assert.match(settle,/c\.status='completed'/);
});
test('uncertain usage retains both liabilities and cannot be replayed as free',()=>{
 assert.match(settle,/if p_tokens is null then/);
 assert.match(settle,/state='unresolved'/);
 assert.match(settle,/c\.status<>'reserved'/);
});
