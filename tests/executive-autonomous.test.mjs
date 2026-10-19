import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {createHash} from 'node:crypto';
const file=readFileSync(resolve('lib/executive/autonomous.ts'),'utf8');
const js=ts.transpileModule(file,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exports={};
vm.runInNewContext(js,{exports,require:(name)=>{
 if(name==='node:crypto')return{createHash:()=>({update:()=>({digest:()=>('a'.repeat(64))})})};
 return {};
}});
const {financeDelegationIntent,developmentDelegationIntent}=exports;
test('routes explicit finance-analysis work only',()=>{
 for(const text of [
  'Analyze the company financial statements and recommend corrective actions.',
  'Review quarterly revenue, COGS and profitability based on the figures provided.',
  'Assess cash flow performance and identify three operating concerns.'
 ])assert.equal(financeDelegationIntent(text),true,text);
});
test('does not steal ordinary chat, operations, software, or privileged requests',()=>{
 for(const text of [
  'How is the weather today?',
  'Build a finance dashboard in my software project.',
  'Analyze financial results and email the report to our customer.',
  'Create a finance orchestrator.',
  'Review the financial code and deploy fixes to production.',
  'Analyze revenue and change the database records.',
  'Analyze cash flow.',
 ])assert.equal(financeDelegationIntent(text),false,text);
});

test('explicit Executive software development requests delegate to existing specialist',()=>{
 for(const text of [
  'Delegate software development to fix the failing checkout integration tests.',
  'Have the software development agent implement a secure audit logging endpoint.',
  'Executive: update the application to display mission review status.'
 ])assert.equal(developmentDelegationIntent(text),true,text);
});
test('ordinary app requests and unrelated content stay with existing project router',()=>{
 for(const text of [
  'Build a new dashboard for my invoices.',
  'Review our software architecture and suggest improvements.',
  'Delegate software development.',
  'Analyze financial statements and cash flow.',
  'Create a specialist orchestrator for operations.'
 ])assert.equal(developmentDelegationIntent(text),false,text);
});

test('incomplete development cues with punctuation never start a mission', async()=>{
 const incomplete=[
  'Delegate software development to   ...?!',
  '  Delegate software development   ...?!  ',
  'Delegate this software development.',
  'Delegate\tsoftware\tdevelopment\tto\t...?!',
  'Delegate software development\n to\n ...?!',
  'Have the software development agent implement',
  'Have the development orchestrator build   ...?!',
  'Please have the software development agent fix   ...?!',
  'Executive: implement                 ...?!',
 ];
 for(const message of incomplete){
  assert.equal(developmentDelegationIntent(message),false,message);
  assert.equal(await exports.startExecutiveDevelopment({actorId:'a',chatId:'b',requestId:'c',activeRepoId:'d',message}),null,message);
 }
 for(const message of [
  'Delegate software development to fix the checkout integration tests.',
  'Please delegate this software development to add regression tests for the Executive router.',
  'Have the development orchestrator build an invoice export endpoint.',
  'Executive: implement an audit logging endpoint.',
 ])assert.equal(developmentDelegationIntent(message),true,message);
});

test('Executive Development saves and starts a connected repository mission only when a repository is selected', async()=>{
 const input={
  actorId:'actor-development',chatId:'chat-development',requestId:'request-development',
  message:'Delegate software development to fix the checkout integration tests.',
 };
 async function route(activeRepoId){
  const calls=[],queries=[];
  let databaseAccesses=0;
  const rows={
   executive_delegations:null,
   executive_orchestrators:[{slug:'saved-development',capabilities:['repository_maintenance','web_application_delivery']}],
   repo_sync_runs:{id:'repo-connected',repository_full_name:'example/checkout'},
   managed_agents:[{id:'lead',config:{name:'Mission Lead'}},{id:'developer',config:{name:'Development Agent',development:true}}],
  };
  const db={
   from(table){
    assert.ok(Object.hasOwn(rows,table),`Unexpected table: ${table}`);
    const query={table,filters:[]};
    queries.push(query);
    const result={data:rows[table],error:null};
    const builder={
     select(){return builder;},
     eq(key,value){query.filters.push([key,value]);return builder;},
     limit(){return builder;},
     async maybeSingle(){return result;},
     async returns(){return result;},
     async update(value){calls.push({name:'link',args:{...value,filters:query.filters}});return {error:null};},
    };
    return builder;
   },
   async rpc(name,args){
    calls.push({name,args:JSON.parse(JSON.stringify(args))});
    switch(name){
     case 'propose_executive_delegation':return {data:{id:'saved-delegation'},error:null};
     case 'create_mission':
     case 'control_mission':return {error:null};
     case 'transition_executive_delegation':return {data:{status:args.p_action==='accept'?'accepted':'running'},error:null};
     default:assert.fail(`Unexpected RPC: ${name}`);
    }
   },
  };
  const isolatedExports={};
  vm.runInNewContext(js,{exports:isolatedExports,require(name){
   if(name==='node:crypto')return {createHash};
   if(name==='@/lib/data/supabase/admin')return {getSupabaseAdminClient(){databaseAccesses++;return db;}};
   if(name==='@/lib/data/persistence-store')return {};
   assert.fail(`Unexpected import: ${name}`);
  }});
  const response=await isolatedExports.startExecutiveDevelopment({...input,activeRepoId});
  return {response,calls,queries,databaseAccesses};
 }
 const {response,calls,queries,databaseAccesses}=await route('repo-connected');
 assert.equal(databaseAccesses,1);
 assert.match(response,/Delegation: saved-delegation\./);
 assert.deepEqual(calls.map(call=>call.name),[
  'propose_executive_delegation','create_mission','link','control_mission',
  'transition_executive_delegation','transition_executive_delegation',
 ]);
 const [proposal,mission,link,start,accept,running]=calls.map(call=>call.args);
 assert.equal(proposal.p_actor,input.actorId);
 assert.equal(proposal.p_chat,input.chatId);
 assert.equal(proposal.p_slug,'saved-development');
 assert.equal(proposal.p_capability,'repository_maintenance');
 assert.equal(proposal.p_request,'exec-dev-'+createHash('sha256').update(input.requestId).digest('hex').slice(0,40));
 assert.ok(proposal.p_objective.startsWith(input.message));
 assert.ok(proposal.p_objective.includes('CONNECTED REPOSITORY: example/checkout'));
 assert.equal(mission.p_objective,proposal.p_objective);
 assert.deepEqual(mission.p_agents,['lead','developer']);
 assert.equal(mission.p_repository,'repo-connected');
 assert.equal(mission.p_minutes,120);
 assert.match(mission.p_id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
 assert.deepEqual(link,{mission_id:mission.p_id,filters:[['id','saved-delegation'],['status','proposed']]});
 assert.deepEqual(start,{p_id:mission.p_id,p_action:'start',p_job:null});
 for(const [transition,action] of [[accept,'accept'],[running,'start']]){
  assert.deepEqual(transition,{p_id:'saved-delegation',p_actor:input.actorId,p_chat:input.chatId,p_action:action,p_evidence:{}});
 }
 assert.deepEqual(queries.map(query=>({table:query.table,filters:query.filters})),[
  {table:'executive_delegations',filters:[['actor_id',input.actorId],['chat_id',input.chatId],['request_key',proposal.p_request]]},
  {table:'executive_orchestrators',filters:[['actor_id',input.actorId],['status','active']]},
  {table:'repo_sync_runs',filters:[['id','repo-connected']]},
  {table:'managed_agents',filters:[['archived',false]]},
  {table:'executive_delegations',filters:[['id','saved-delegation'],['status','proposed']]},
 ]);
 for(const missingRepo of [undefined,null,'']){
  const missing=await route(missingRepo);
  assert.equal(missing.response,'Select a connected repository before delegating software changes to Development.');
  assert.equal(missing.databaseAccesses,0);
  assert.deepEqual(missing.calls,[]);
  assert.deepEqual(missing.queries,[]);
 }
});
