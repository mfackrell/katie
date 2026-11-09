// Read-only authentication of the exact pre-admission host failure. A missing
// diagnostics archive is never a generic reason to select an older run.
import {createHash} from 'node:crypto';
import {loadRecoveryDiagnostics} from './native-wip-recovery.mjs';
export const TASK4A_FAILED_RUN=Object.freeze({
 projectId:'6d1c29f1-b31e-47a5-aabb-cbcf1326f388',
 taskId:'d0e41ff5-149e-4319-9e65-dcc605fb75da',
 approvalId:'d1f7d69c-850f-4ce4-88de-a70d4222e157',
 consumedClaimId:'f105fde0-1e35-4aaf-80c6-b80645701325',
 failedRunId:42395083318,originalRunId:42102615797,
 failedReleaseSha:'25363d8cd0906e7915c4e0aa6443142a95a76c20',
 originalReleaseSha:'d530aa94dd8d9c2bc442b43b324ace312d0d62b9',
 checkpointSha:'8e53ce01693303fc50daf5da1567e93e725f9b2d',
 hostSha256:'87555681d7546761b8014179b7a1e19258fc57ec84bed3b82eacf7e23bff3904'
});
const fail=()=>{throw Error('TASK4A_FAILED_RUN_LINK_DENIED');};
const hash=value=>createHash('sha256').update(value).digest('hex');
export function task4aLinkedRecoveryTask(task,evidence){
 const c=TASK4A_FAILED_RUN,r=task.external?.receipt;
 if(task.id!==c.taskId||task.external?.developerApprovalId!==c.approvalId||
    task.external?.task4aPostpaidDispatchClaimId!==c.consumedClaimId||
    r?.run_id!==c.failedRunId||r.outcome!=='BLOCKED'||r.pr_url!==null||
    r.repository!=='mfackrell/katie'||r.issue_number!==969||
    !evidence||Object.entries(c).some(([k,v])=>evidence[k]!==v)||
    evidence.version!=='task4a-failed-run-link-v1'||
    evidence.noProviderCalls!==true||evidence.noSourceModifications!==true||
    !/^[a-f0-9]{64}$/.test(evidence.buildLogSha256??''))fail();
 // Explicit ephemeral selection only. The stored receipt and consumed claim
 // remain untouched; the authenticated link accompanies every later use.
 return {...task,external:{...task.external,receipt:{...r,run_id:c.originalRunId}}};
}
export async function authenticateTask4aFailedRun({task,github}){
 const c=TASK4A_FAILED_RUN,root='/repos/mfackrell/katie';
 const run=await github(`${root}/actions/runs/${c.failedRunId}`);
 if(run.id!==c.failedRunId||run.run_attempt!==1||run.status!=='completed'||run.conclusion!=='failure'||
    run.head_sha!==c.failedReleaseSha||run.head_branch!=='main'||run.event!=='workflow_dispatch'||
    run.path!=='.github/workflows/autonomous-development.yml'||
    run.repository?.full_name!=='mfackrell/katie'||run.head_repository?.full_name!=='mfackrell/katie')fail();
 const source=await github(`${root}/contents/scripts/benchmark/native-development-host.mjs?ref=${c.failedReleaseSha}`);
 if(source.type!=='file'||source.encoding!=='base64'||hash(Buffer.from(source.content,'base64'))!==c.hostSha256)fail();
 const jobs=await github(`${root}/actions/runs/${c.failedRunId}/jobs?filter=all&per_page=100`);
 if(!Array.isArray(jobs.jobs)||jobs.total_count!==jobs.jobs.length||jobs.jobs.length!==6)fail();
 const build=jobs.jobs.find(j=>j.name==='build');
 if(build?.id!==128470602187||build.run_id!==c.failedRunId||build.conclusion!=='failure')fail();
 const step=name=>build.steps?.find(s=>s.name===name);
 for(const name of ['Create isolated branch and task','Preserve original task before implementation',
  'Preserve trusted project acceptance tools','Install pinned native SDK for benchmark-bound engineering'])
  if(step(name)?.conclusion!=='success')fail();
 if(step('Run approved native Developer through trusted gateway')?.conclusion!=='failure'||
    step('Autonomous developer')?.conclusion!=='skipped'||step('Create draft pull request')?.conclusion!=='skipped'||
    jobs.jobs.some(j=>!['build','report'].includes(j.name)&&j.conclusion!=='skipped'))fail();
 const bytes=await github(`${root}/actions/jobs/${build.id}/logs`,true);
 const log=Buffer.from(bytes).toString('utf8');
 const fatal='Error: NATIVE_HOST_DENIED: Task 4A pregrant recovery unexpectedly contains native WIP';
 if(log.length>8*1024*1024||log.split(fatal).length!==2||
    /NATIVE_GATEWAY_INPUT_COUNT|NATIVE_GATEWAY_DENIAL_CODE|NATIVE_LIFECYCLE_CAPACITY=/.test(log))fail();
 // At this pinned host SHA the positive fatal is before diagnostics, WIP
 // restoration, native grant creation and any provider/child invocation.
 const artifacts=await github(`${root}/actions/runs/${c.failedRunId}/artifacts?per_page=100`);
 if(artifacts.total_count!==artifacts.artifacts?.length||artifacts.total_count>100||
    artifacts.artifacts.some(a=>['native-execution-diagnostics','native-metered-review'].includes(a.name)))fail();
 const inventory=await github(`${root}/actions/runs?event=workflow_dispatch&created=%3E%3D2026-11-07T17%3A11%3A32Z&per_page=100`);
 if(inventory.total_count!==inventory.workflow_runs?.length||inventory.total_count>100||
    inventory.workflow_runs.filter(r=>r.id===c.failedRunId).length!==1||
    inventory.workflow_runs.some(r=>r.path==='.github/workflows/autonomous-development.yml'&&r.id!==c.failedRunId))fail();
 const evidence={version:'task4a-failed-run-link-v1',...c,buildLogSha256:hash(bytes),
  noProviderCalls:true,noSourceModifications:true};
 task4aLinkedRecoveryTask(task,evidence);
 return evidence;
}

export async function loadTask4aLinkedDiagnostics({task,evidence,github}){
 const linked=task4aLinkedRecoveryTask(task,evidence),c=TASK4A_FAILED_RUN;
 const reader=async(path,binary=false)=>{
  const data=await github(path,binary);
  if(path.endsWith('/actions/runs/'+c.originalRunId)&&data.head_sha!==c.originalReleaseSha)fail();
  if(path.includes('/actions/runs/'+c.originalRunId+'/artifacts')){
   const matches=data.artifacts?.filter(a=>a.name==='native-execution-diagnostics');
   if(matches?.length!==1||matches[0].id!==13448824242||
     matches[0].digest!=='sha256:f6eb5bcb6125d46811e41818ca85c7299440062303563cdd017e3cb796e48186')fail();
  }
  if(binary&&path.endsWith('/actions/artifacts/13448824242/zip')&&
    hash(data)!=='f6eb5bcb6125d46811e41818ca85c7299440062303563cdd017e3cb796e48186')fail();
  return data;
 };
 const result=await loadRecoveryDiagnostics({task:linked,repository:'mfackrell/katie',github:reader});
 if(result.record?.checkpointSha!==c.checkpointSha)fail();
 return result;
}
