import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const PROJECT='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const MISSION='b7c2e557-83e1-41cb-b174-bdb0d77d12e5';
const ASSIGNMENT='85e229aa-e571-43ef-9d4a-5cb64f4efcd1';

function fixture(t,{delayOperation=null,advanceMs=0,ownerMs=3_600_000,leaseMs=360_000}={}){
 const actualNow=Date.now;
 let now=Date.parse('2026-11-19T19:00:00.000Z');
 Date.now=()=>now;
 t.after(()=>{Date.now=actualNow;});
 const events=[],sent={catalog:0,inference:0},timeouts=[];
 let stopped=false;
 const agent='11111111-1111-4111-8111-111111111111';
 const claim={
  mission:{id:MISSION,project_id:PROJECT,project_kind:'management',objective:'Original mission79 director decision',
   deadline:new Date(now+ownerMs).toISOString(),team:[{id:agent,config:{research:false}}]},
  job:{id:ASSIGNMENT,agent_id:agent,lease:'22222222-2222-4222-8222-222222222222',
   lease_until:new Date(now+leaseMs).toISOString(),role:'work',payload:{}}
 };
 const load=modules({
  '@/lib/missions/store':{rpc:async(name,args)=>{
   events.push({name,operation:args?.p_operation,receipt:args?.p_receipt,tokens:args?.p_tokens});
   if(name==='project_provider_mode')return true;
   if(name==='project_provider_mission_live')return !stopped;
   if(name==='project_provider_mission_stop'){stopped=true;return true;}
   if(name==='project_provider_request'){
    if(!args.p_receipt&&args.p_operation===delayOperation)now+=advanceMs;
    return !stopped;
   }
   throw Error('Unexpected provider RPC '+name);
  }},
  '@/lib/providers':{getAvailableProviders:()=>[{name:'openai',listModels:async()=>{
   sent.catalog++;return ['gpt-5.4'];
  }}]},
  '@/lib/orchestration/bounded-provider':{boundedProvider:()=>({
   post:async()=>{throw Error('Provider-controlled inference cannot use token counter');},
   responses:{create:async(_request,opts)=>{
    sent.inference++;timeouts.push(opts.timeout);
    return {id:'response-original79',status:'completed',output_text:'Owner-approved director decision',output:[],usage:{total_tokens:120}};
   }}
  })}
 });
 return {run:()=>load('@/lib/missions/model').missionModel(claim,'Return decision','Complete approved task'),
  claim,events,sent,timeouts,clock:()=>now,stopped:()=>stopped};
}

test('positive original mission79 dispatch preserves one admitted inference, receipt and bounded timeout',async t=>{
 const f=fixture(t);
 const result=await f.run();
 assert.equal(result.text,'Owner-approved director decision');
 assert.deepEqual(f.sent,{catalog:1,inference:1});
 assert.equal(f.events.filter(x=>x.name==='project_provider_mission_stop').length,0);
 assert.deepEqual(f.events.filter(x=>x.name==='project_provider_request').map(x=>[x.operation,Boolean(x.receipt)]),
  [['model-list',false],['model-list',true],['inference',false],['inference',true]]);
 assert.equal(f.timeouts.length,1);
 assert.ok(f.timeouts[0]>=1000&&f.timeouts[0]<=90_000);
});

test('delayed model catalog admission past immutable owner cutoff never contacts provider',async t=>{
 const f=fixture(t,{delayOperation:'model-list',advanceMs:70_000,ownerMs:60_000});
 await assert.rejects(f.run(),e=>e.partial?.providerOutcomeUnresolved===true&&/execution time window/.test(e.message));
 assert.deepEqual(f.sent,{catalog:0,inference:0});
 assert.equal(f.events.filter(x=>x.name==='project_provider_request'&&!x.receipt).length,1);
 assert.equal(f.events.filter(x=>x.name==='project_provider_mission_stop').length,1);
 assert.equal(f.stopped(),true);
});

test('delayed admitted inference past original lease expiry cannot initiate paid generation or retry',async t=>{
 const f=fixture(t,{delayOperation:'inference',advanceMs:370_000});
 await assert.rejects(f.run(),e=>e.partial?.providerOutcomeUnresolved===true&&/execution time window/.test(e.message));
 assert.deepEqual(f.sent,{catalog:1,inference:0});
 assert.deepEqual(f.events.filter(x=>x.name==='project_provider_request'&&!x.receipt).map(x=>x.operation),['model-list','inference']);
 assert.equal(f.events.filter(x=>x.name==='project_provider_mission_stop').length,1,
  'Committed unsent request is fail-closed by existing auditable mission stop');
 await assert.rejects(f.run(),/Trial assignment authority is unavailable/);
 assert.equal(f.sent.inference,0,'A second attempt must never buy the original inference');
});

test('post-admission dispatch guard honors earlier execution deadline before lease nominal expiry',async t=>{
 const f=fixture(t,{delayOperation:'inference',advanceMs:245_000,leaseMs:360_000});
 await assert.rejects(f.run(),e=>e.partial?.providerOutcomeUnresolved===true);
 assert.equal(f.sent.inference,0);
 assert.equal(f.events.filter(x=>x.name==='project_provider_mission_stop').length,1);
});
