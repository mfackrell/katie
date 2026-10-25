import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const migration=readFileSync('supabase/migrations/20261024224500_benchmark_atomic_mission_admission.sql','utf8');
test('benchmark admission delegates all legacy mission admission predicates in same RPC',()=>{
 assert.match(migration,/try_reserve_mission_capacity\(p_job,p_lease,p_call,p_model,p_tokens,p_routing\)/);
 assert.match(migration,/pg_advisory_xact_lock/);
 assert.match(migration,/benchmark_budget_calls\(account_id,request_key,model,reserved_tokens\)/);
 assert.doesNotMatch(migration,/exception\s+when\s+others\s+then/i);
});
test('benchmark admission requires same experiment, correct arm and capacity',()=>{
 assert.match(migration,/b\.experiment_id<>a\.experiment_id/);
 assert.match(migration,/a\.arm<>'orchestrated'/);
 assert.match(migration,/a\.spent_tokens\+hold\+p_tokens>a\.cap_tokens/);
 assert.match(migration,/state='overrun'/);
});
test('untrusted roles cannot call admission RPC',()=>{
 assert.match(migration,/revoke all on function public\.benchmark_reserve_mission_call/);
 assert.match(migration,/to service_role/);
});
