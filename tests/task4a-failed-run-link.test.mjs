import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {loadRecoveryDiagnostics} from '../scripts/benchmark/native-wip-recovery.mjs';
import {TASK4A_FAILED_RUN as c,authenticateTask4aFailedRun,task4aLinkedRecoveryTask,loadTask4aLinkedDiagnostics} from '../scripts/benchmark/task4a-failed-run-link.mjs';
const task={id:c.taskId,external:{developerApprovalId:c.approvalId,task4aPostpaidDispatchClaimId:c.consumedClaimId,
 issueNumber:969,receipt:{run_id:c.failedRunId,outcome:'BLOCKED',pr_url:null,repository:'mfackrell/katie',issue_number:969}}};
const host=readFileSync('tests/fixtures/task4a-failed-host-25363d8.txt');
const zip=readFileSync('tests/fixtures/task4a-original-diagnostics.zip');
const root='/repos/mfackrell/katie';
const run=(id,sha)=>({id,run_attempt:1,status:'completed',conclusion:'failure',head_sha:sha,head_branch:'main',event:'workflow_dispatch',
 path:'.github/workflows/autonomous-development.yml',repository:{full_name:'mfackrell/katie'},head_repository:{full_name:'mfackrell/katie'}});
const original=run(c.originalRunId,c.originalReleaseSha);
const failure=run(c.failedRunId,c.failedReleaseSha);
const jobs={total_count:6,jobs:[{id:128470602187,run_id:c.failedRunId,name:'build',conclusion:'failure',steps:[
 ...['Create isolated branch and task','Preserve original task before implementation','Preserve trusted project acceptance tools',
 'Install pinned native SDK for benchmark-bound engineering'].map(name=>({name,conclusion:'success'})),
 {name:'Run approved native Developer through trusted gateway',conclusion:'failure'},
 ...['Autonomous developer','Create draft pull request'].map(name=>({name,conclusion:'skipped'}))]},
 {name:'report',conclusion:'success'},...['review','test','repair','final-review'].map(name=>({name,conclusion:'skipped'}))]};
const archive={id:13448824242,name:'native-execution-diagnostics',expired:false,size_in_bytes:zip.length,
 digest:'sha256:f6eb5bcb6125d46811e41818ca85c7299440062303563cdd017e3cb796e48186',workflow_run:{id:c.originalRunId,head_sha:c.originalReleaseSha}};
function reader(overrides={}){
 return async(path,binary)=>{
  if(path in overrides)return overrides[path];
  if(path===`${root}/actions/runs/${c.failedRunId}`)return structuredClone(failure);
  if(path===`${root}/actions/runs/${c.originalRunId}`)return structuredClone(original);
  if(path.includes('/contents/'))return {type:'file',encoding:'base64',content:host.toString('base64')};
  if(path.includes('/jobs?'))return structuredClone(jobs);
  if(path.includes('/jobs/'))return Buffer.from('2026-11-07 Error: NATIVE_HOST_DENIED: Task 4A pregrant recovery unexpectedly contains native WIP\n');
  if(path===`${root}/actions/runs/${c.failedRunId}/artifacts?per_page=100`)return {total_count:0,artifacts:[]};
  if(path.includes('/actions/runs?'))return {total_count:1,workflow_runs:[structuredClone(failure)]};
  if(path===`${root}/actions/runs/${c.originalRunId}/artifacts?per_page=100`)return {total_count:1,artifacts:[structuredClone(archive)]};
  if(binary&&path.endsWith('/13448824242/zip'))return zip;
  throw Error('Unexpected read-only endpoint '+path);
 };
}
test('explicit link authenticates both runs and byte-exact original archive, preserving latest receipt',async()=>{
 const before=structuredClone(task),github=reader();
 const evidence=await authenticateTask4aFailedRun({task,github});
 const {record}=await loadTask4aLinkedDiagnostics({task,evidence,github});
 assert.equal(record.checkpointSha,c.checkpointSha);assert.equal(record.runId,String(c.originalRunId));
 assert.deepEqual(task,before);
 assert.equal(task4aLinkedRecoveryTask(task,evidence).external.receipt.run_id,c.originalRunId);
});
test('foreign, retried, changed or additional failed-run execution cannot authorize an older checkpoint',async()=>{
 const cases=[
  {[`${root}/actions/runs/${c.failedRunId}`]:{...failure,head_sha:'f'.repeat(40)}},
  {[`${root}/actions/runs/${c.failedRunId}`]:{...failure,run_attempt:2}},
  {[`${root}/actions/runs/${c.failedRunId}/jobs?filter=all&per_page=100`]:{...jobs,total_count:7}},
  {[`${root}/actions/jobs/128470602187/logs`]:Buffer.from('Error: a different failure')},
  {[`${root}/actions/jobs/128470602187/logs`]:Buffer.from('Error: NATIVE_HOST_DENIED: Task 4A pregrant recovery unexpectedly contains native WIP\nNATIVE_GATEWAY_INPUT_COUNT')},
  {[`${root}/contents/scripts/benchmark/native-development-host.mjs?ref=${c.failedReleaseSha}`]:{type:'file',encoding:'base64',content:Buffer.from('changed code').toString('base64')}},
  {[`${root}/actions/runs/${c.failedRunId}/artifacts?per_page=100`]:{total_count:1,artifacts:[{name:'native-execution-diagnostics'}]}},
  {[`${root}/actions/runs?event=workflow_dispatch&created=%3E%3D2026-11-07T17%3A11%3A32Z&per_page=100`]:{total_count:2,workflow_runs:[failure,{...failure,id:123}]}}
 ];
 for(const overrides of cases)await assert.rejects(authenticateTask4aFailedRun({task,github:reader(overrides)}),/TASK4A_FAILED_RUN_LINK_DENIED/);
 const evidence=await authenticateTask4aFailedRun({task,github:reader()});
 for(const other of [{...task,id:'foreign'}, {...task,external:{...task.external,developerApprovalId:'foreign'}},
  {...task,external:{...task.external,receipt:{...task.external.receipt,run_id:c.originalRunId}}}])
  assert.throws(()=>task4aLinkedRecoveryTask(other,evidence),/DENIED/);
});
test('missing link, changed original workflow, diagnostic substitution and corrupted archive fail closed',async()=>{
 const evidence=await authenticateTask4aFailedRun({task,github:reader()});
 assert.throws(()=>task4aLinkedRecoveryTask(task,null),/DENIED/);
 for(const overrides of [
  {[`${root}/actions/runs/${c.originalRunId}`]:{...original,head_sha:'f'.repeat(40)}},
  {[`${root}/actions/runs/${c.originalRunId}/artifacts?per_page=100`]:{total_count:1,artifacts:[{...archive,id:123}]}},
  {[`${root}/actions/artifacts/13448824242/zip`]:Buffer.from('corrupted')}
 ])await assert.rejects(loadTask4aLinkedDiagnostics({task,evidence,github:reader(overrides)}),/DENIED/);
});

test('actual native host requires an authentic replacement claim before selecting the older run',async()=>{
 const evidence=await authenticateTask4aFailedRun({task,github:reader()});
 const source=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
 const start=source.indexOf(' let linkedEvidence=null;'),end=source.indexOf(' // Authenticated diagnostics',start);
 assert.ok(start>0&&end>start);
 const block=source.slice(start,end);
 const run=async({ready=true,postpaid=true,link=true}={})=>{
  const current=structuredClone(task);
  if(link){current.external.task4aReplacementClaimId='replacement-claim';current.external.task4aReplacementAuthorizationId='owner-receipt';}
  const context={approval:{developer_authority:{}},task:current,task4aHistory:{postpaid},project:{id:c.projectId},
   process:{env:{GITHUB_SHA:'e'.repeat(40),GITHUB_REPOSITORY:'mfackrell/katie'}},
   denied:reason=>{throw Error(reason);},
   db:{rpc:async(name,args)=>{assert.equal(name,'task4a_replacement_authentic');assert.equal(args.p_release,'e'.repeat(40));return {data:ready,error:null};}},
   readOne:async(table,column,value)=>{assert.equal(table,'project_events');assert.equal(column,'id');assert.equal(value,'owner-receipt');
    return {event:'task4a_replacement_authorized',project_id:c.projectId,data:{proposal:{evidence}}};},
   githubRecoveryReader:()=>reader(),loadTask4aLinkedDiagnostics,loadRecoveryDiagnostics,
   priorRefs:[{}],wipContext:{},};
  const result=await vm.runInNewContext('(async()=>{'+block+';return record;})()',context);
  return result;
 };
 assert.equal((await run()).checkpointSha,c.checkpointSha);
 await assert.rejects(run({ready:false}),/Exact replacement owner claim required/);
 await assert.rejects(run({postpaid:false}),/only valid for original post-paid/);
 await assert.rejects(run({link:false}),/missing, expired or ambiguous trusted diagnostics/);
 assert.match(readFileSync('.github/workflows/autonomous-development.yml','utf8'),/native-wip-recovery,task4a-verifier-recovery,task4a-failed-run-link,/);
});
