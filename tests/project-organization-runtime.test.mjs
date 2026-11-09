import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {modules} from './helpers/load-project-modules.mjs';
test('executive selection requires verified fresh OpenAI or Anthropic reasoning; no guessed fallback',()=>{
 const {eligibleExecutiveModel}=modules()('@/lib/projects/organization');
 const now=Date.now(),m={provider_name:'openai',model_id:'synthetic-premier',is_active:true,reasoning_tier:'high',capability_status:'verified',pricing_status:'verified',routing_eligibility:'verified',capability_verified_at:new Date(now-1000).toISOString(),pricing_verified_at:new Date(now-1000).toISOString()};
 assert.equal(eligibleExecutiveModel(m,now),true);assert.equal(eligibleExecutiveModel({...m,provider_name:'anthropic'},now),true);
 for(const patch of [{provider_name:'other'},{is_active:false},{reasoning_tier:'medium'},{capability_status:'heuristic'},{pricing_status:'estimated'},{routing_eligibility:'restricted'},{capability_verified_at:null},{pricing_verified_at:new Date(now-86400001).toISOString()},{capability_verified_at:new Date(now+1000).toISOString()}])assert.equal(eligibleExecutiveModel({...m,...patch},now),false);
});
test('management worker dispatches only durable management decisions; never technical execution',async()=>{
 const id=randomUUID(),agent=randomUUID(),project=randomUUID(),calls=[];
 const rows={project_organization_nodes:[{id,agent_id:agent,kind:'project_director'}],project_organization_exceptions:[],project_organization_assignments:[],project_organization_scope_grants:[],work_projects:{objective:'Original project',team:[],phase:'research'}};
 const db={from(table){const q={select(){return q;},eq(){return q;},in(){return q;},single(){return q;},then(ok){return Promise.resolve({data:rows[table],error:null}).then(ok);}};return q;}};
 const load=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/missions/store':{rpc:async(name,args)=>{calls.push({name,args});return true;},readMission:async()=>{throw Error('Technical mission dispatch reached');}}});
 const claim={mission:{id:randomUUID(),project_id:project,project_kind:'management'},job:{id:randomUUID(),agent_id:agent,lease:randomUUID(),payload:{organizationNodeId:id}}};
 let invoked=0;
 await load('@/lib/missions/worker').executeClaim(claim,async(c,instruction,input,tools)=>{invoked++;assert.equal(tools,'none');assert.match(instruction,/Never write code/);assert.equal(JSON.parse(input).project.objective,'Original project');return{text:'[{"action":"ready"}]',model:'synthetic-premier'};});
 assert.equal(invoked,1);assert.equal(calls.length,1);assert.equal(calls[0].name,'project_org_decide');assert.equal(calls[0].args.p_lease,claim.job.lease);
});
test('technical work uses a separate subordinate completion receipt, never project closure',async()=>{
 const calls=[],claim={mission:{project_kind:'organization_work',objective:'Design the interface'},job:{id:randomUUID(),lease:randomUUID(),instruction:'Produce the interface contract',payload:{capability:'analysis'}}};
 const load=modules({'@/lib/missions/store':{rpc:async(name,args)=>{calls.push({name,args});return true;}}});
 await load('@/lib/missions/worker').executeClaim(claim,async()=>({text:'Interface contract artifact',model:'synthetic-worker'}));
 assert.equal(calls.length,1);assert.equal(calls[0].name,'project_org_finish_work');assert.equal(calls[0].args.p_result.text,'Interface contract artifact');
 await assert.rejects(load('@/lib/missions/worker').executeClaim({...claim,job:{...claim.job,payload:{capability:'development'}}}),/Unapproved/);
});
