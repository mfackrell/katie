// Disposable PostgreSQL + actual pinned SDK/host/checkpoint path. Provider text,
// owner identity and GitHub artifact transport are synthetic, never production consent.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,rmSync,cpSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createLifecycleCheckpoint,qualifyLifecycleContinuation,archive} from './qualify-lifecycle-continuation.mjs';
import {loadRecoveryDiagnostics,validateRecoveryRecords,prepareRecovery,recoveryRefs} from '../../scripts/benchmark/native-wip-recovery.mjs';
import {lifecycleProposalFromSnapshot} from '../../scripts/benchmark/lifecycle-owner-proposal.mjs';
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const quote=v=>"'"+v.replaceAll("'","'\"'\"'")+"'";
const correct=[
 'export const total= (rows=[{cents:120},{cents:80},{cents:999,void:true}])=>rows.filter(r=>!r.void).reduce((n,r)=>n+r.cents,0);',
 'export const count= (rows=[{cents:120},{cents:80},{cents:999,void:true}])=>rows.filter(r=>!r.void).length;',
 'export const largest= (rows=[{cents:120},{cents:80},{cents:999,void:true}])=>rows.filter(r=>!r.void).reduce((n,r)=>Math.max(n,r.cents),0);'
];
const broken=[correct[0].replace('cents,0','cents,1'),correct[1].replace('rows.filter(r=>!r.void)','rows'),correct[2].replace('rows.filter(r=>!r.void)','rows')];
const page='import {total,count,largest} from "./state"; export default function Page(){const rows=[{cents:120},{cents:80},{cents:999,void:true}];return <div id="state">{total(rows)===200&&count(rows)===2&&largest(rows)===120?"Recovered":"Broken"}</div>}\n';
const checks=`const f=require('node:fs'),a=require('node:assert/strict');(async()=>{const api=await import('data:text/javascript;base64,'+f.readFileSync('app/pilot/state.ts').toString('base64'));const rows=[{cents:120},{cents:80},{cents:999,void:true}],fail=[];for(const [key,want,empty] of [['total',200,0],['count',2,0],['largest',120,0]]){try{a.equal(api[key](rows),want);a.equal(api[key]([]),empty);}catch{fail.push(key);}}console.log('CHECKS:'+(fail.join(',')||'none'));})();`;
export async function qualifyAdaptiveRecovery(db,rival,ids,authority){
 const fixture=await createLifecycleCheckpoint(db,ids,{initial:true}),{root,remote,context,baseline,one,repo}=fixture;
 const report={version:1,syntheticOnly:true,paidInference:0,taskId:ids.task,projectId:ids.project,baseline,contract:context.contract,checks,attempts:[],trace:[],authorizations:[],limitations:['Synthetic nonbillable provider and owner identities; real host, SDK, PostgreSQL, Git and verifier.','Seven-day diagnostics required; source not checkpointed before abrupt termination is not recoverable.']};
 const output=join(process.env.RUNNER_TEMP??root,'task3b-qualification');mkdirSync(output,{recursive:true});
 const ledger=async()=>(await db.query("select jsonb_build_object('calls',(select coalesce(jsonb_agg(to_jsonb(c) order by id),'[]') from benchmark_budget_calls c where account_id=$1),'exposures',(select coalesce(jsonb_agg(to_jsonb(e) order by call_id),'[]') from benchmark_dollar_exposures e where account_id=$1)) v",[ids.account])).rows[0].v;
 const assertHistory=async old=>{const now=await ledger();for(const key of ['calls','exposures'])for(const row of old[key])assert.deepEqual(now[key].find(r=>(r.id??r.call_id)===(row.id??row.call_id)),row);};
 let run=131,repair=0,pending=null,requests=0,lines=[...broken],currentAuthority=authority;
 const source=()=>lines.join('\n')+'\n';
 const provider=async(body,path)=>{
  if(path.endsWith('/input_tokens'))return {type:'application/json',body:JSON.stringify({object:'response.input_tokens',input_tokens:3})};
  const text=JSON.stringify(body.input),phase=text.includes('prior findings remain')?'final-review':text.includes('Fix only the independent reviewer')?'repair':text.includes('fresh independent reviewer')?'review':'implementation';
  const result=body.input.findLast(i=>i.type==='function_call_output');
  let item;
  if(!result){
   assert.equal(pending,null,'No duplicate provider phase');
   let cmd;
   if(phase==='implementation'){
    assert.equal(run,131);cmd=`const f=require('node:fs');f.mkdirSync('app/pilot',{recursive:true});f.writeFileSync('app/pilot/state.ts',${JSON.stringify(source())});f.writeFileSync('app/pilot/page.tsx',${JSON.stringify(page)});`;
   }else if(phase==='repair'){
    if(run===132&&repair===2){
     cmd=`const f=require('node:fs'),a=require('node:assert/strict');a.equal(f.readFileSync('app/pilot/state.ts','utf8'),${JSON.stringify(source())});a.equal(f.readFileSync('app/pilot/page.tsx','utf8'),${JSON.stringify('// Repair 2 retained WIP\n'+page)});a.equal(f.readFileSync('app/pilot/added.ts','utf8'),'export const repairEvidence = "second repair";\\n');a.match(f.readFileSync('/trusted/review-findings.txt','utf8'),/count/);console.log('EXACT_REPAIR_2_RESTORED');`;
    }else{
     repair++;assert.ok(repair<=3);lines[repair-1]=correct[repair-1];
     cmd=`const f=require('node:fs');f.writeFileSync('app/pilot/state.ts',${JSON.stringify(source())});`;
     if(repair===2)cmd+=`f.writeFileSync('app/pilot/page.tsx',${JSON.stringify('// Repair 2 retained WIP\n'+page)});f.writeFileSync('app/pilot/added.ts','export const repairEvidence = "second repair";\\n');`;
    }
   }else cmd=checks;
   pending={phase,run,repair};report.trace.push({...pending,event:'started'});
   item={id:'fc_'+(++requests),type:'function_call',namespace:'functions',name:'exec_command',call_id:'call_'+requests,status:'completed',arguments:JSON.stringify({cmd:'node -e '+quote(cmd),workdir:'/work'})};
  }else{
   assert.equal(pending?.phase,phase);let message='DONE';
   if(['review','final-review'].includes(phase)){
    const found=JSON.stringify(result.output).match(/CHECKS:([a-z,]+)/);assert.ok(found,'Reviewer must execute frozen assertions: '+JSON.stringify(result.output));
    const findings=found[1];message=findings==='none'?'PASS Frozen total, count and largest assertions independently passed.':'CHANGES_REQUESTED Correct '+findings+' against frozen non-void transaction assertions.';
    report.trace.push({...pending,event:'reviewed',findings});
   }
   report.trace.push({...pending,event:'completed'});pending=null;
   item={id:'msg_'+(++requests),type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:message,annotations:[],logprobs:[]}]};
  }
  const response={id:'task3b-synthetic-'+requests,object:'response',model:body.model,created_at:1,status:'completed',service_tier:'default',output:[item],usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
  return {type:'text/event-stream',body:[['response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}}],['response.output_item.added',{type:'response.output_item.added',output_index:0,item}],['response.output_item.done',{type:'response.output_item.done',output_index:0,item}],['response.completed',{type:'response.completed',response}]].map(([e,d])=>'event: '+e+'\ndata: '+JSON.stringify(d)+'\n\n').join('')+'data: [DONE]\n\n'};
 };
 try{
  for(run=131;run<=133;run++){
   assert.equal((await db.query('select developer_claim_dispatch($1,$2) ok',[currentAuthority.approval_id,authority.release_sha])).rows[0].ok,true);
   const historical=await ledger();
   const result=await qualifyLifecycleContinuation(db,ids,fixture,currentAuthority,{runId:run,provider,keepRoot:true,interruption:run===131?'repair2':run===132?'verification3':null,afterRun:async r=>r});
   const retained=join(output,String(run));mkdirSync(retained,{recursive:true});
   writeFileSync(join(retained,'host.log'),result.log);for(const name of ['native-metered-review.json','native-metered-review.json.diagnostics.json','qualification-browser-acceptance.json','qualification-verifier-tail.json'])if(existsSync(join(result.runtime,name)))cpSync(join(result.runtime,name),join(retained,name));
   assert.ok(result.diagnostics,result.log);await assertHistory(historical);
   const d=result.diagnostics,record=d.wipCheckpoint;
   report.attempts.push({run,code:result.code,recovery:d.recovery,verification:d.verification,iterations:d.repairIterations,checkpoint:record,phases:d.phases.map(p=>({phase:p.phase,outcome:p.outcome})),historicalBefore:hash(historical),historicalAfter:hash(await ledger())});
   if(run===133){
    assert.equal(result.code,0,result.log);const receipt=JSON.parse(readFileSync(result.evidence));assert.equal(receipt.taskId,ids.task);assert.equal(receipt.repairIterations,3);assert.equal(receipt.finalReview.verdict,'pass');
    assert.deepEqual(d.phases.map(p=>p.phase),['final-review']);assert.equal(d.repairIterations.length,3);
    assert.equal(JSON.parse(readFileSync(join(result.runtime,'qualification-browser-acceptance.json'))).passed,true);
    report.completion=receipt;report.finalSourceHash=hash(readFileSync(join(result.workspace,'app/pilot/state.ts'),'utf8'));break;
   }
   assert.notEqual(result.code,0,result.log);assert.ok(record,result.log);
   assert.equal(record.lastCompleted.adaptiveRepair.iteration,run===131?1:3);
   assert.equal(record.lastCompleted.adaptiveRepair.nextAction,run===131?'repair':'verification');
   assert.ok(record.lastCompleted.review.findings.includes(run===131?'count':'largest'));
   const files=['state.ts','page.tsx','added.ts'];report.attempts.at(-1).files=Object.fromEntries(files.map(p=>[p,hash(readFileSync(join(result.workspace,'app/pilot',p),'utf8'))]));
   pending=null;
   writeFileSync(join(root,'artifact.zip'),archive(d));
   const workflow={id:run,status:'completed',conclusion:'failure',event:'workflow_dispatch',path:'.github/workflows/autonomous-development.yml',head_branch:'main',head_sha:authority.release_sha,run_attempt:1,repository:{full_name:'mfackrell/katie'},head_repository:{full_name:'mfackrell/katie'}};
   const artifacts={total_count:1,artifacts:[{id:run,name:'native-execution-diagnostics',expired:false,size_in_bytes:readFileSync(join(root,'artifact.zip')).length,workflow_run:{id:run,head_sha:authority.release_sha}}]};
   writeFileSync(join(root,'workflow.json'),JSON.stringify(workflow));writeFileSync(join(root,'artifacts.json'),JSON.stringify(artifacts));
   await db.query("update agent_tasks set status='blocked',external=external||jsonb_build_object('issueNumber',829,'receipt',jsonb_build_object('outcome','BLOCKED','run_id',$2::int,'repository','mfackrell/katie','issue_number',829)) where id=$1",[ids.task,run]);
   const task=await one('agent_tasks','id',ids.task),project=await one('work_projects','id',ids.project);
   const github=async(path,binary)=>binary?readFileSync(join(root,'artifact.zip')):path.includes('/artifacts?')?artifacts:workflow;
   const loaded=await loadRecoveryDiagnostics({task,repository:'mfackrell/katie',github});
   await validateRecoveryRecords({record:loaded.record,task,context,project,authorityKind:'ordinary-developer',trialId:null,accountId:ids.account,readOne:one});
   // Destroy both environments. Only remote Git and trusted diagnostics survive.
   rmSync(result.workspace,{recursive:true,force:true});rmSync(result.runtime,{recursive:true,force:true});
   writeFileSync(join(root,'check-request.md'),result.request);
   const check=join(root,'restore-check-'+run);execFileSync('git',['clone','-q','--branch','baseline',remote,check]);
   const beforeRestore=await ledger();
   const restored=prepareRecovery({workspace:check,tempRoot:root,toolsRoot:join(repo,'scripts'),requestFile:join(root,'check-request.md'),context,record,refs:recoveryRefs(check,ids.task)});
   restored.restore();
   for(const p of files)assert.equal(hash(readFileSync(join(check,'app/pilot',p),'utf8')),report.attempts.at(-1).files[p]);
   assert.deepEqual(await ledger(),beforeRestore);rmSync(check,{recursive:true,force:true});
   const snapshot=(await db.query('select benchmark_lifecycle_snapshot($1) s',[ids.task])).rows[0].s;
   const plan=lifecycleProposalFromSnapshot({snapshot,record,observations:d.capacityObservations});
   const proposed=plan;assert.ok(plan.assessment.shortages.includes('executionAuthority'),'Real adapter must identify consumed attempt authority');
   assert.equal(proposed.state,'awaiting_owner_approval',JSON.stringify(proposed));
   const offered=(await db.query('select benchmark_lifecycle_offer($1,$2,$3) o',[ids.task,proposed.proposal,{...record,scopeHash:ids.scopeHash,releaseSha:authority.release_sha}])).rows[0].o;
   const args=[ids.owner,ids.task,offered.id,'approved',authority.release_sha];
   await assert.rejects(db.query('select benchmark_lifecycle_decide($1,$2,$3,$4,$5)',[randomUUID(),...args.slice(1)]),/owner|denied/i);
   const decisions=await Promise.all([db,rival].map(c=>c.query('select benchmark_lifecycle_decide($1,$2,$3,$4,$5) d',args)));
   assert.equal(decisions[0].rows[0].d.approvalId,decisions[1].rows[0].d.approvalId);
   await assertHistory(beforeRestore);report.authorizations.push({syntheticConsentOnly:true,proposal:offered.proposal,result:decisions[0].rows[0].d});
   currentAuthority={approval_id:decisions[0].rows[0].d.approvalId,release_sha:authority.release_sha};
  }
  assert.equal(repair,3);assert.equal(report.trace.filter(t=>t.phase==='implementation'&&t.event==='completed').length,1);
  assert.equal(report.trace.filter(t=>t.phase==='review'&&t.event==='completed').length,1);
  const calls=await ledger();assert.ok(calls.calls.every(c=>c.state==='settled'));assert.equal(new Set(calls.calls.map(c=>c.id)).size,calls.calls.length);
  report.finalLedger=calls;report.passed=true;console.log('TASK3B_MULTI_INTERRUPTION_PASS');
 }finally{writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));rmSync(root,{recursive:true,force:true});}
}
