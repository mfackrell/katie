import test from 'node:test';import assert from 'node:assert/strict';
import {executeBenchmarkMissionProvider} from '../lib/missions/benchmark-provider.mjs';
const baselineSha='a'.repeat(40);
test('orchestrated benchmark requires trusted binding and reserves before inference',async()=>{
 const sequence=[];
 const db={rpc:async(name)=>{sequence.push(name);return{data:name==='benchmark_reserve_call'?'hold-id':true,error:null}}};
 const response=await executeBenchmarkMissionProvider({
 db,missionId:'m1',baselineSha,requestId:'call1',model:'test',maxInputTokens:40,maxOutputTokens:60,
 binding:{verifiedByServer:true,missionId:'m1',arm:'orchestrated',baselineSha,accountId:'account1',experimentId:'experiment1'},
 invoke:async()=>{sequence.push('provider');return{usage:{inputTokens:20,outputTokens:10}}}
 });
 assert.equal(response.usage.inputTokens,20);
 assert.deepEqual(sequence,['benchmark_reserve_call','provider','benchmark_settle_call']);
});
test('unverified mission binding cannot reach provider',async()=>{
 let called=false;
 await assert.rejects(executeBenchmarkMissionProvider({db:{rpc:async()=>{called=true}},missionId:'m1',baselineSha,requestId:'call',model:'test',maxInputTokens:10,maxOutputTokens:10,
 binding:{verifiedByServer:false,missionId:'m1',arm:'orchestrated',baselineSha,accountId:'account',experimentId:'exp'},invoke:async()=>{called=true}}),/BINDING_UNVERIFIED/);
 assert.equal(called,false);
});

