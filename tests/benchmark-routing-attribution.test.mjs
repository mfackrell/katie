import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const worker=readFileSync('lib/missions/model.ts','utf8');
const admission=readFileSync('supabase/migrations/20261024224500_benchmark_atomic_mission_admission.sql','utf8');
test('model router reserves and settles benchmark routing operations atomically',()=>{
 assert.match(worker,/if\(routingBench\)\{/);
 assert.match(worker,/p_routing:true/);
 assert.match(worker,/if\(routingBench\)await rpc\('benchmark_finish_mission_call'/);
 assert.match(worker,/else await rpc\('finish_mission_call'/);
});
test('legacy routing remains unchanged for ordinary missions',()=>{
 assert.match(worker,/reserve_mission_routing_call/);
 assert.match(worker,/routingBenchError\)throw Error/);
});
test('shared admission retains mission routing-call limits',()=>{
 assert.match(admission,/try_reserve_mission_capacity\(p_job,p_lease,p_call,p_model,p_tokens,p_routing\)/);
});
