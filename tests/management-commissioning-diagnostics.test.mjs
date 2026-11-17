import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {modules} from './helpers/load-project-modules.mjs';

function fixture(sqlFailure=false){
 const root={id:randomUUID(),kind:'project_director',agent_id:randomUUID(),objective:'Owner objective'};
 const manager={id:randomUUID(),parent_id:root.id,kind:'manager',agent_id:randomUUID(),objective:'Immediate manager objective',tools:['manage','analysis','development']};
 const worker={id:randomUUID(),parent_id:manager.id,kind:'worker',agent_id:randomUUID(),objective:'Worker objective',tools:['analysis','development']};
 const rows={project_organization_nodes:[root,manager,worker],work_projects:{objective:'Owner objective',team:[]}};
 const calls=[];
 const db={from(table){const q={select(){return q;},eq(){return q;},in(){return q;},single(){return q;},then(ok){return Promise.resolve({data:rows[table]??[],error:null}).then(ok);}};return q;}};
 const load=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/missions/store':{rpc:async(name,args)=>{
  calls.push({name,args});
  if(name==='project_org_decide'&&sqlFailure)throw Error('Mission state operation failed: {"code":"P0001","details":null,"hint":null,"message":"SMART estimated workload exceeds single-worker context, resources or execution window; decompose before dispatch"}');
  return true;
 }}});
 const claim={mission:{id:randomUUID(),project_id:randomUUID(),project_kind:'management',calls:0},job:{id:randomUUID(),agent_id:manager.agent_id,lease:randomUUID(),payload:{organizationNodeId:manager.id}}};
 const contract={objective:'Bounded worker objective',deliverable:'One verified artifact',instruction:'Perform the bounded task',parentObjective:manager.objective,capability:'analysis',acceptance:[{criterion:'Criterion',evidence:'Verified evidence'}],inventory:[{item:'Known input',contextChars:123}],estimate:{basis:'declared_inventory',rationale:'Declared work',uncertainty:'Measured estimate only',tokens:100,seconds:30},paths:[],tokens:200,maxAssignments:2,deadline:'2026-11-16T18:00:00Z'};
 const command={action:'assign',nodeId:worker.id,capability:'analysis',smart:contract};
 const run=commands=>load('@/lib/projects/organization').executeManagementClaim(claim,async()=>({text:JSON.stringify(commands)}));
 return {root,manager,worker,rows,calls,load,claim,contract,command,run};
}

test('malformed SMART response records exact field paths before SQL without saving model prose',async()=>{
 const f=fixture(); f.contract.parentObjective='secret model prose';delete f.contract.estimate.uncertainty;
 await assert.rejects(f.run([f.command]),e=>{
  assert.equal(e.evidence?.code,'smart_contract_fields');
  assert.deepEqual(Array.from(e.evidence.smartFields),['smart.parentObjective','smart.estimate.uncertainty']);
  assert.match(e.evidence.proposalHash,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(e.evidence).includes('secret model prose'));
  return true;
 });
 assert.equal(f.calls.filter(c=>c.name==='project_org_decide').length,0);
});

test('ready-only decision cannot abandon an owned open exception; corrective batches still reach SQL',async()=>{
 const f=fixture(); f.rows.project_organization_exceptions=[{id:randomUUID(),origin_id:f.worker.id,owner_id:f.manager.id,status:'open'}];
 await assert.rejects(f.run([{action:'ready'}]),e=>e.evidence?.code==='unresolved_management_exception');
 assert.equal(f.calls.filter(c=>c.name==='project_org_decide').length,0);
 await f.run([{action:'reject',nodeId:f.worker.id,findings:'Return verified correction'},{action:'ready'}]);
 assert.equal(f.calls.filter(c=>c.name==='project_org_decide').length,1);
 f.rows.project_organization_exceptions[0].status='resolved';await f.run([{action:'ready'}]);
});

test('definitive SQL SMART rejection retains bounded diagnostic and proposal hash; no replay',async()=>{
 const f=fixture(true);
 await assert.rejects(f.run([f.command]),e=>{
  assert.equal(e.evidence?.code,'smart_contract_capacity');
  assert.match(e.evidence.proposalHash,/^[a-f0-9]{64}$/);
  assert.equal(e.evidence.action,'assign');assert.equal(e.evidence.position,1);
  return true;
 });
 assert.equal(f.calls.filter(c=>c.name==='project_org_decide').length,1);
});

test('diagnostic preflight checks each structural field without substituting values',()=>{
 const {smartContractFields}=modules()('@/lib/projects/smart-diagnostics');const f=fixture();
 const cases=[
  ['objective',c=>c.objective=f.manager.objective],['deliverable',c=>c.deliverable=''],['instruction',c=>c.instruction=''],
  ['parentObjective',c=>c.parentObjective='Other'],['acceptance',c=>c.acceptance=[]],
  ['acceptance[0].criterion',c=>delete c.acceptance[0].criterion],['acceptance[0].evidence',c=>delete c.acceptance[0].evidence],
  ['inventory',c=>c.inventory=[]],['inventory[0].item',c=>c.inventory[0].item=''],['inventory[0].contextChars',c=>c.inventory[0].contextChars=-1],
  ['estimate.basis',c=>c.estimate.basis='guessed'],['estimate.rationale',c=>delete c.estimate.rationale],['estimate.uncertainty',c=>delete c.estimate.uncertainty],
  ['estimate.tokens',c=>c.estimate.tokens=0],['estimate.seconds',c=>c.estimate.seconds=0],['tokens',c=>c.tokens=0],['maxAssignments',c=>c.maxAssignments=0],['deadline',c=>delete c.deadline],['capability',c=>c.capability='unauthorized'],
 ];
 for(const [field,change] of cases){const c=structuredClone(f.contract);change(c);const before=JSON.stringify(c);assert.deepEqual(Array.from(smartContractFields(c,f.manager.objective,'Owner objective','work',f.worker)),[field]);assert.equal(JSON.stringify(c),before);}
 assert.deepEqual(Array.from(smartContractFields(f.contract,f.manager.objective,'Owner objective','development',f.worker)),[]);
 assert.deepEqual(Array.from(smartContractFields(f.contract,f.manager.objective,'Owner objective','review',{tools:['analysis']})),[]);
 assert.deepEqual(Array.from(smartContractFields(null,f.manager.objective,'Owner objective','work',f.worker)),['contract']);
});

test('unknown SQL outcomes and transport failures are never classified as safe rejection',()=>{
 const {smartSqlRejection}=modules()('@/lib/projects/smart-diagnostics');
 for(const error of [Error('fetch failed'),Error('Mission state operation failed: gateway timeout'),Error('Mission state operation failed: {"code":"P0001","message":"unrecognized failure"}'),Error('Mission state operation failed: {"code":"40001","message":"SMART requires an explicit bounded file inventory within worker scope"}')])assert.equal(smartSqlRejection(error),null);
});
