import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const js=ts.transpileModule(readFileSync('lib/executive/factory-runtime.ts','utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;
function setup({registered=null,agentRows=null,provisionRoute=null,existingDelegation=null}={}){
 const calls=[], saved=[];
 const agents=agentRows??[
  {id:'lead',config:{name:'Mission Lead',research:false,development:true}},
  {id:'analyst',config:{name:'Analysis Agent',research:false,development:false}},
  {id:'researcher',config:{name:'Research Agent',research:true,development:false}},
  {id:'developer',config:{name:'Development Agent',research:false,development:true}},
 ];
 const db={
  from(table){
   const filter=[];
   const builder={
    select(){return this;},eq(...args){filter.push(args);return this;},limit(){return this;},order(){return this;},
    async maybeSingle(){return {data:table==='executive_orchestrators'?registered:table==='executive_delegations'?existingDelegation:null,error:null};},
    async returns(){return {data:table==='managed_agents'?agents:[],error:null};},
    async update(value){calls.push({kind:'update',table,filter,value});return {error:null};}
   };
   return builder;
  },
  async rpc(name,args){
   calls.push({kind:'rpc',name,args});
   if(name==='propose_executive_provisioning')return {data:{id:'provision-id',status:'proposed'},error:null};
   if(name==='propose_executive_delegation')return {data:{id:'delegation-id'},error:null};
   return {data:{id:'configured-or-mission',status:'running'},error:null};
  }
 };
 const exports={};
 vm.runInNewContext(js,{exports,require:name=>{
  if(name==='@/lib/data/supabase/admin')return {getSupabaseAdminClient:()=>db};
  if(name==='@/lib/data/persistence-store')return {saveMessage:async(_id,msg)=>saved.push(msg)};
  if(name==='./source-handoff')return{EXECUTIVE_SOURCE_MARKER:'\nExecutive source handoff: fixture',executiveSourceGroups:()=>[],executiveSourceReports:async input=>{calls.push({kind:'source-validation',input});return[{report:'Reviewed report'}];}};
  if(name==='./delivery')return {factoryReplyId:id=>id};
  if(name==='./provisioning-service')return {planExecutiveProvisioning:async input=>{
   calls.push({kind:'plan',input});
   const route=provisionRoute??(registered?.status==='active'?'reuse':'configure');
   const decision=route==='reuse'?{route,specialistSlug:registered?.slug??input.requirement.proposedSlug}:
    route==='commission'?{route,missingCapabilities:[input.requirement.capability]}:{route};
   return {decision,request:{id:'provision-id',status:'proposed'}};
  }};
  return require(name);
 },Date,console,Buffer});
 return {factory:exports,calls,saved};
}
test('Executive factory creates a real three-agent acceptance mission but does not self-activate',async()=>{
 const {factory,calls}=setup();
 const response=await factory.startSpecialistFactory({
  actorId:'actor',chatId:'chat',requestId:'request',message:'Create an operations orchestrator',
  intent:{domain:'operations',slug:'operations',capability:'operations_analysis'}
 });
 assert.match(response,/independent multi-agent acceptance mission/);
 const make=calls.find(c=>c.name==='create_mission');
 assert.ok(make,'a real mission must be created');
 assert.deepEqual(Array.from(make.args.p_agents),['lead','analyst','researcher']);
 assert.equal(make.args.p_repository,null);
 assert.match(make.args.p_objective,/spare capacity and reopen rate/);
 assert.match(make.args.p_objective,/deterministic calculator/);
 assert.ok(calls.some(c=>c.kind==='update'&&c.table==='agent_missions'&&c.value.token_allowance===120000&&c.value.max_calls===20));
 assert.ok(calls.some(c=>c.name==='control_mission'&&c.args.p_action==='start'));
 assert.ok(calls.some(c=>c.kind==='update'&&c.table==='executive_provisioning_requests'&&c.value.evidence.acceptanceMissionId));
 assert.equal(calls.some(c=>c.name==='transition_executive_provisioning'&&c.args.p_action==='activate'),false);
});
test('active specialists are reusable without duplicate provisioning',async()=>{
 const {factory,calls}=setup({registered:{id:'active',slug:'operations',status:'active'}});
 const response=await factory.startSpecialistFactory({
  actorId:'actor',chatId:'chat',requestId:'request',message:'Create an operations orchestrator',
  intent:{domain:'operations',slug:'operations',capability:'operations_analysis'}
 });
 assert.match(response,/already an active specialist/);
 assert.ok(calls.some(c=>c.kind==='plan'));
 assert.equal(calls.some(c=>c.name==='create_mission'),false);
});
test('specialist dispatch intent is narrow and never takes ordinary requests',()=>{
 const {factory}=setup();
 assert.deepEqual(JSON.parse(JSON.stringify(factory.specialistAssignmentIntent(
  'Ask the operations orchestrator to analyze the plant scheduling backlog.'))),
  {slug:'operations',objective:'analyze the plant scheduling backlog.'});
 for(const message of ['What is an operations orchestrator?','Create an operations orchestrator',
  'Analyze the plant scheduling backlog','Ask the operations orchestrator to fix']){
   assert.equal(factory.specialistAssignmentIntent(message),null,message);
 }
});
test('inactive specialist refuses work rather than claiming completion',async()=>{
 const {factory,calls}=setup({registered:{slug:'operations',status:'registered',capabilities:['operations_analysis']}});
 const response=await factory.startSpecialistAssignment({
  actorId:'actor',chatId:'chat',requestId:'request',message:'Ask the operations orchestrator to analyze plant scheduling.'
 });
 assert.match(response,/not active/);
 assert.equal(calls.some(c=>c.name==='create_mission'),false);
});

test('unverified capability is commissioned, not configured or falsely activated',async()=>{
 const {factory,calls}=setup({provisionRoute:'commission'});
 const response=await factory.startSpecialistFactory({
  actorId:'actor',chatId:'chat',requestId:'request',message:'Create a logistics orchestrator',
  intent:{domain:'logistics',slug:'logistics',capability:'logistics_coordination'}
 });
 assert.match(response,/commissioning is pending/);
 assert.match(response,/logistics_coordination/);
 assert.ok(calls.some(c=>c.kind==='plan'&&c.input.requirement.capability==='logistics_coordination'));
 assert.equal(calls.some(c=>c.name==='create_mission'),false);
 assert.equal(calls.some(c=>c.name==='transition_executive_provisioning'),false);
});
test('dedicated EO is routed outside ordinary Katie chat and project workflows',()=>{
 const route=readFileSync('app/api/chat/route.ts','utf8');
 assert.ok(route.includes("if(actorRole.actor_kind==='executive')return executeExecutiveCommand"));
 assert.match(route,/const executiveReply=null, specialistReply=null, financeReply=null, developmentReply=null/);
 assert.doesNotMatch(route,/const financeReply = !executiveReply/);
});

test('research capability requires real native web-search evidence in acceptance objective',async()=>{
 const {factory,calls}=setup();
 await factory.startSpecialistFactory({
  actorId:'actor',chatId:'chat',requestId:'research-request',message:'Create a research orchestrator',
  intent:{domain:'research',slug:'research',capability:'research_synthesis'}
 });
 const mission=calls.find(c=>c.name==='create_mission');
 assert.match(mission.args.p_objective,/native LIVE public-web search/);
 assert.match(mission.args.p_objective,/Never fabricate a URL/);
});
test('factory refuses unsupported accepted scenarios even if given a bad configure decision',async()=>{
 const {factory,calls}=setup();
 await assert.rejects(()=>factory.startSpecialistFactory({
  actorId:'actor',chatId:'chat',requestId:'unknown-request',message:'Create an unsupported orchestrator',
  intent:{domain:'unsupported',slug:'unsupported',capability:'unverified_coordination'}
 }),/No independently verifiable mission acceptance scenario/);
 assert.equal(calls.some(c=>c.name==='create_mission'),false);
});

test('read-only repository audits use research workers and preserve repository context',async()=>{
 const {factory,calls}=setup({registered:{slug:'software_development',status:'active',capabilities:['repository_maintenance']}});
 const message='Ask the software development orchestrator to inspect the connected repository read-only and report architecture defects without changing any code.';
 const result=await factory.startSpecialistAssignment({actorId:'actor',chatId:'chat',requestId:'audit-1',message,activeRepoId:'repo-id'});
 assert.match(result,/Mission:/);
 const mission=calls.find(c=>c.name==='create_mission');
 assert.deepEqual(Array.from(mission.args.p_agents),['lead','analyst','researcher']);
 assert.equal(mission.args.p_repository,'repo-id');
 const denied=await factory.startSpecialistAssignment({actorId:'actor',chatId:'chat',requestId:'audit-2',message});
 assert.match(denied,/Select a verified connected repository/);
 assert.equal(calls.filter(c=>c.name==='create_mission').length,1);
});

test('source reports are validated and their durable references saved before a synthesis mission is linked or started',async()=>{
 const {factory,calls}=setup({registered:{slug:'synthesis',status:'active',capabilities:['research_synthesis']}});
 const ids=['11111111-1111-4111-8111-111111111111'];
 await factory.startSpecialistAssignment({actorId:'actor',chatId:'chat',requestId:'source-assignment',message:'Ask the synthesis orchestrator to consolidate the independently reviewed reports.',sourceMissionIds:ids});
 const validated=calls.findIndex(c=>c.kind==='source-validation'),bound=calls.findIndex(c=>c.kind==='update'&&c.table==='executive_delegations'&&c.value.result?.sourceMissionIds),created=calls.findIndex(c=>c.name==='create_mission');
 assert.ok(validated>=0&&bound>validated&&created>bound);assert.deepEqual(calls[bound].value.result.sourceMissionIds,ids);
 assert.match(calls[created].args.p_objective,/Executive source handoff/);
});

test('Executive assignments reserve bounded routing and complete review capacity before execution',async()=>{
 const {factory,calls}=setup({registered:{slug:'operations',status:'active',capabilities:['operations_analysis']}});
 await factory.startSpecialistAssignment({actorId:'actor',chatId:'chat',requestId:'capacity-assignment',message:'Ask the operations orchestrator to independently assess the supplied operating results.'});
 const proposal=calls.find(c=>c.name==='propose_executive_delegation');assert.equal(proposal.args.p_budget,120000);
 const capacity=calls.findIndex(c=>c.kind==='update'&&c.table==='agent_missions'&&c.value.max_calls===20),start=calls.findIndex(c=>c.name==='control_mission');
 assert.ok(capacity>=0&&capacity<start);assert.equal(calls[capacity].value.token_allowance,120000);
});

test('an unlinked saved proposal reuses its deadline, budget and criteria rather than changing idempotent values',async()=>{
 const objective='Consolidate the reviewed source reports.',existing={id:'delegation-id',status:'proposed',mission_id:null,deadline:'2099-01-01T00:00:00.000Z',budget_tokens:60000,success_criteria:['Saved original acceptance'],objective,capability:'research_synthesis'};
 const {factory,calls}=setup({registered:{slug:'synthesis',status:'active',capabilities:['research_synthesis']},existingDelegation:existing});
 await factory.startSpecialistAssignment({actorId:'actor',chatId:'chat',requestId:'resume-proposal',message:'Ask the synthesis orchestrator to '+objective});
 const proposal=calls.find(c=>c.name==='propose_executive_delegation');assert.equal(proposal.args.p_deadline,existing.deadline);assert.equal(proposal.args.p_budget,existing.budget_tokens);assert.deepEqual(proposal.args.p_success,existing.success_criteria);
 assert.ok(calls.some(c=>c.name==='create_mission'));assert.ok(calls.some(c=>c.name==='control_mission'));
 assert.equal(calls.find(c=>c.kind==='update'&&c.table==='agent_missions').value.token_allowance,existing.budget_tokens);
});

test('structured repository scope keeps prohibitions from becoming access requirements',async()=>{
 const {factory,calls}=setup({registered:{slug:'operations',status:'active',capabilities:['operations_analysis']}});
 const response=await factory.startSpecialistAssignment({actorId:'actor',chatId:'chat',requestId:'isolated',requiresRepository:false,
  message:'Ask the operations orchestrator to analyze the synthetic service desk. No external research, repository changes, or new specialist creation.'});
 assert.match(response,/Executive assigned operations/);
 const mission=calls.find(c=>c.name==='create_mission');assert.equal(mission.args.p_repository,null);
 assert.match(mission.args.p_objective,/No external research, repository changes/);
 assert.equal(mission.args.p_agents.includes('developer'),false);
 const denied=await factory.startSpecialistAssignment({actorId:'actor',chatId:'chat',requestId:'actual-code',requiresRepository:false,
  message:'Ask the operations orchestrator to implement the backend and deploy the application.'});
 assert.match(denied,/Select a verified connected repository/);
});
